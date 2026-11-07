// The skillhub admin API: three dictionaries read once by `code`, then one create call per tool.
// Every answer is classified into what the pusher does next, so a signed-out session stops the batch
// while one bad row does not (admin-ai-tool-create-api.md: 400 with 已存在 is a duplicate, 401/403 mean
// the session is gone, 5xx and network failures are worth retrying).
import { guardedFetch, type GuardedFetchOptions, type GuardedResponse } from "@aihot/backend/lib/http-fetch";
import { resolveCredentials, type Credentials } from "./credentials.ts";
import type { Dictionaries, ToolPayload } from "./mapping.ts";

/** Where the admin API lives; a deployment may point it elsewhere with SKILLHUB_BASE_URL. */
export const DEFAULT_BASE_URL = "https://skillhub.aefree.com";
/** The three dictionaries and the request field each one fills. */
export const DICTIONARIES = {
  category: "aitool.category",
  audience: "aitool.audience",
  feature: "aitool.feature",
} as const;
export type DictionaryName = keyof typeof DICTIONARIES;
/** Dictionary IDs do not change while the worker runs; ten minutes keeps a batch to three lookups. */
const CACHE_MS = 10 * 60_000;

/** What one create call came to. */
export type PushResult =
  | { kind: "success"; remoteId: number | null }
  | { kind: "exists" }
  | { kind: "config"; error: string }
  | { kind: "invalid"; error: string }
  | { kind: "retry"; error: string };

/** An HTTP client, replaceable in tests; guardedFetch is the production one. */
export type Transport = (url: string, options: GuardedFetchOptions) => Promise<GuardedResponse>;

export function baseUrl(): string {
  return (process.env.SKILLHUB_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

interface CachedDictionary {
  at: number;
  items: Map<string, number>;
}
const cache = new Map<string, CachedDictionary>();

export function clearDictionaryCache(): void {
  cache.clear();
}

/** The envelope every skillhub answer uses. */
interface Envelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

function messageOf(body: unknown, fallback: string): string {
  const msg = (body as Envelope | null)?.msg;
  return typeof msg === "string" && msg.trim() ? msg.trim().slice(0, 300) : fallback;
}

function jsonOf(response: GuardedResponse): unknown {
  try {
    return JSON.parse(response.text());
  } catch {
    return null;
  }
}

/**
 * What a create call's answer means. Known Chinese and English duplicate messages stop automatic
 * retries; they do not identify the matching remote record or prove its content matches.
 */
export function classifyCreate(status: number, body: unknown): PushResult {
  const code = (body as Envelope | null)?.code;
  const accepted = status >= 200 && status < 300 && (code === 0 || code === undefined);
  if (accepted) {
    const id = (body as { data?: { id?: unknown } } | null)?.data?.id;
    return { kind: "success", remoteId: typeof id === "number" ? id : null };
  }
  if (status === 400 && /已存在|重复|\b(?:slug|canonical URL) already exists\b/i.test(messageOf(body, ""))) return { kind: "exists" };
  if (status === 401 || status === 403) return { kind: "config", error: `skillhub 拒绝了这次调用（HTTP ${status}）：${messageOf(body, "登录已过期或没有 aitool:write 权限")}` };
  if (status >= 200 && status < 300) return { kind: "invalid", error: `skillhub 返回了失败的响应：${messageOf(body, `code ${String(code)}`)}` };
  if (status === 429 || status >= 500) return { kind: "retry", error: `skillhub 暂时不可用（HTTP ${status}）：${messageOf(body, "服务端错误")}` };
  return { kind: "invalid", error: `skillhub 拒绝了这条工具（HTTP ${status}）：${messageOf(body, "参数不合法")}` };
}

function headers(credentials: Credentials, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: credentials.cookie, "x-xsrf-token": credentials.xsrf, accept: "application/json", ...extra };
}

/** One dictionary's items, `code` → id. A failure here is not about one tool, so it stops the batch. */
async function dictionary(
  name: DictionaryName,
  credentials: Credentials,
  options: { transport: Transport; now: number; fresh?: boolean },
): Promise<{ ok: true; items: Map<string, number> } | { ok: false; kind: "config" | "retry"; error: string }> {
  const root = baseUrl();
  const cacheKey = `${root}|${DICTIONARIES[name]}`;
  const hit = cache.get(cacheKey);
  if (!options.fresh && hit && options.now - hit.at < CACHE_MS) return { ok: true, items: hit.items };

  const url = `${root}/api/v1/admin/dicts/${encodeURIComponent(DICTIONARIES[name])}/items?activeOnly=true`;
  let response: GuardedResponse;
  try {
    response = await options.transport(url, { headers: headers(credentials), timeoutMs: 20_000, maxBytes: 1024 * 1024, redirectPolicy: "same-origin" });
  } catch (error) {
    return { ok: false, kind: "retry", error: `读取字典 ${DICTIONARIES[name]} 失败：${String(error instanceof Error ? error.message : error).slice(0, 200)}` };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, kind: "config", error: `skillhub 拒绝了字典查询（HTTP ${response.status}）：请重新登录后台并粘贴新的 Cookie 与 XSRF Token` };
  }
  if (response.status !== 200) {
    return { ok: false, kind: "retry", error: `读取字典 ${DICTIONARIES[name]} 失败（HTTP ${response.status}）` };
  }
  const body = jsonOf(response);
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { ok: false, kind: "retry", error: `字典 ${DICTIONARIES[name]} 的响应不是列表` };
  const items = new Map<string, number>();
  for (const item of data) {
    const row = item as { id?: unknown; code?: unknown; status?: unknown };
    if (typeof row.id !== "number" || typeof row.code !== "string") continue;
    if (row.status !== undefined && row.status !== "ACTIVE") continue;
    items.set(row.code, row.id);
  }
  if (items.size === 0) return { ok: false, kind: "config", error: `字典 ${DICTIONARIES[name]} 没有启用的字典项` };
  cache.set(cacheKey, { at: options.now, items });
  return { ok: true, items };
}

/** A session that can send tools: the dictionary IDs, one create call, and one update call. */
export interface Skillhub {
  ids: Dictionaries;
  push: (payload: ToolPayload) => Promise<PushResult>;
  /**
   * PUT /api/v1/admin/ai-tools/{id} with the whole create body. skillhub has no PATCH (405) and answers
   * 500 to a partial body, so a tool that was already pushed can only be re-sent in full.
   */
  updateTool: (remoteId: number, payload: ToolPayload) => Promise<PushResult>;
}

export type OpenResult = { ok: true; skillhub: Skillhub } | { ok: false; kind: "config" | "retry"; error: string };

/**
 * Reads the session and the three dictionaries. A missing session is a configuration problem, not a
 * failure of any one tool, so the caller stops the batch instead of marking rows failed.
 */
export async function openSkillhub(options: { transport?: Transport; now?: number; fresh?: boolean } = {}): Promise<OpenResult> {
  const transport = options.transport ?? guardedFetch;
  const now = options.now ?? Date.now();
  const credentials = await resolveCredentials();
  if (!credentials) return { ok: false, kind: "config", error: "还没有配置 skillhub 的 Cookie 与 XSRF Token：请在后台填写，或设置 SKILLHUB_COOKIE / SKILLHUB_XSRF_TOKEN" };

  const ids = { category: new Map(), audience: new Map(), feature: new Map() } as Record<DictionaryName, Map<string, number>>;
  for (const name of Object.keys(DICTIONARIES) as DictionaryName[]) {
    const loaded = await dictionary(name, credentials, { transport, now, fresh: options.fresh });
    if (!loaded.ok) return loaded;
    ids[name] = loaded.items;
  }

  const send = async (method: "POST" | "PUT", path: string, payload: ToolPayload): Promise<PushResult> => {
    let response: GuardedResponse;
    try {
      response = await transport(`${baseUrl()}${path}`, {
        method,
        headers: headers(credentials, { "content-type": "application/json" }),
        body: JSON.stringify(payload),
        timeoutMs: 30_000,
        maxBytes: 1024 * 1024,
        redirectPolicy: "same-origin",
      });
    } catch (error) {
      return { kind: "retry", error: `请求 skillhub 失败：${String(error instanceof Error ? error.message : error).slice(0, 200)}` };
    }
    return classifyCreate(response.status, jsonOf(response));
  };

  return {
    ok: true,
    skillhub: {
      ids,
      push: (payload) => send("POST", "/api/v1/admin/ai-tools", payload),
      updateTool: (remoteId, payload) => send("PUT", `/api/v1/admin/ai-tools/${Math.trunc(remoteId)}`, payload),
    },
  };
}
