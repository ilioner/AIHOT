// An AI-extracted list: the operator names a page and a prompt, and the site's structure model picks
// the entries out of that page's link inventory. Reading the page is free; the extraction is one paid
// request per run, through chatJson (receipts, budget and the model circuit breaker). The model only
// gets anchors that were actually on the page, and every URL it returns must match one of them (or an
// allowUrlPrefixes rule): an invented address is dropped rather than fetched later.
import * as cheerio from "cheerio";
import { z } from "zod";
import { languageHeaders, guardedFetch, requireOk } from "../lib/http-fetch.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { normalizeUrl } from "../lib/url.ts";
import { modelFor } from "../editorial/models.ts";
import { chatJson } from "../providers/llm.ts";
import { ModelOutputError } from "../providers/receipts.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

export const AI_LIST_PROMPT_VERSION = "ai-list-v1";
export const DEFAULT_MAX_LINKS = 400;
export const DEFAULT_MAX_ITEMS = 60;
const MAX_ITEMS = 200;
/** One anchor's text is a label and maybe a one-line description; the model does not need a page. */
const LINK_TEXT_CHARS = 300;
/** The whole inventory, serialized into the prompt. A large directory still fits in one call. */
const INVENTORY_CHARS = 48_000;
const SUMMARY_CHARS = 2_000;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

export interface LinkInventoryEntry {
  /** Absolute http(s) address in normalizeUrl's canonical form (no tracking parameters or fragment). */
  url: string;
  /** Anchor text (or its title/aria-label), whitespace collapsed and length-capped. */
  text: string;
}

export interface LinkInventoryOptions {
  /** `config.baseUrl`, or the page URL's origin when the source has none. */
  baseUrl: string;
  maxLinks?: number;
  maxChars?: number;
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Prefix rules ignore the scheme, like web-list's, because a site may link the same host over http. */
const overHttps = (url: string) => url.replace(/^http:\/\//i, "https://");

/**
 * Pure: the links we hand to the model, in page order. Relative hrefs resolve against `baseUrl`,
 * tracking parameters and fragments are removed for deduplication, anchors without text are not
 * candidates at all, and the list is capped by both `maxLinks` and `maxChars`.
 */
export function buildLinkInventory(html: string, opts: LinkInventoryOptions): LinkInventoryEntry[] {
  let base: string;
  try {
    const parsed = new URL(opts.baseUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("not http");
    base = parsed.toString();
  } catch {
    throw new FetchError("链接基准地址无效：baseUrl 必须是 http/https 地址");
  }
  const maxLinks = clamp(opts.maxLinks, 1, 2_000, DEFAULT_MAX_LINKS);
  const maxChars = clamp(opts.maxChars, 1, 1_000_000, INVENTORY_CHARS);
  const $ = cheerio.load(html);
  const out: LinkInventoryEntry[] = [];
  const seen = new Set<string>();
  let used = 0;
  $("a[href]").each((_index, node) => {
    if (out.length >= maxLinks) return false;
    const el = $(node);
    const href = (el.attr("href") ?? "").trim();
    if (!href) return undefined;
    let absolute: string;
    try {
      const parsed = new URL(href, base);
      if (!/^https?:$/.test(parsed.protocol)) return undefined;
      absolute = parsed.toString();
    } catch {
      return undefined;
    }
    // The canonical address drops tracking parameters and fragments; deduplication uses the same form.
    const url = normalizeUrl(absolute);
    if (!url || seen.has(url)) return undefined;
    const text = collapseWhitespace(el.text() || el.attr("title") || el.attr("aria-label") || "");
    if (!text) return undefined;
    const clipped = text.slice(0, LINK_TEXT_CHARS);
    if (used + clipped.length + url.length > maxChars) return false;
    seen.add(url);
    out.push({ url, text: clipped });
    used += clipped.length + url.length;
    return undefined;
  });
  return out;
}

const AiListItemSchema = z.object({
  url: z.string(),
  title: z.string(),
  summary: z.string().nullable().optional(),
});

/** The extraction's stated shape. `title` may be blank here; a blank title is dropped after parsing. */
export const AiListOutputSchema = z.object({ items: z.array(AiListItemSchema) });
export type AiListOutput = z.infer<typeof AiListOutputSchema>;

export interface ParseAiListOptions {
  maxItems?: number;
  allowUrlPrefixes?: string[];
  receiptId?: number | null;
  pageUrl?: string | null;
}

export interface ParsedAiList {
  candidates: Candidate[];
  /** Entries left out: invented addresses, allow-list misses, blank titles and duplicates. */
  dropped: number;
}

/**
 * Pure: turn the model's answer into candidates. The model sees a link inventory; it may only return
 * one of those addresses (matched after normalization) or one under `allowUrlPrefixes`. Anything else
 * is counted as dropped. The entry keeps no publication date and no body: the listing line is the
 * material, so nothing reads the linked page afterwards.
 */
export function parseAiListOutput(data: unknown, inventory: LinkInventoryEntry[], opts: ParseAiListOptions = {}): ParsedAiList {
  const parsed = AiListOutputSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "输出"}: ${issue.message}`).join("；");
    throw new FetchError(`模型输出不合格式：${issues}`);
  }
  const maxItems = clamp(opts.maxItems, 1, MAX_ITEMS, DEFAULT_MAX_ITEMS);
  const byUrl = new Map<string, string>();
  for (const entry of inventory) {
    const normalized = normalizeUrl(entry.url);
    if (normalized && !byUrl.has(normalized)) byUrl.set(normalized, entry.url);
  }
  const allow = (opts.allowUrlPrefixes ?? []).map((prefix) => overHttps(prefix));
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let dropped = 0;
  for (const item of parsed.data.items) {
    const title = collapseWhitespace(item.title);
    if (!title) {
      dropped += 1;
      continue;
    }
    const claimed = item.url.trim();
    const normalized = normalizeUrl(claimed);
    const known = normalized ? byUrl.get(normalized) : undefined;
    const allowed = normalized && allow.some((prefix) => overHttps(claimed).startsWith(prefix));
    const url = known ?? (allowed ? normalized : null);
    if (!url || !normalized || seen.has(normalized)) {
      dropped += 1;
      continue;
    }
    seen.add(normalized);
    const summary = typeof item.summary === "string" ? collapseWhitespace(item.summary).slice(0, SUMMARY_CHARS) : "";
    candidates.push({
      url,
      title,
      excerpt: summary || null,
      // The directory entry itself is the material: its target page is never fetched for a body.
      bodyStatus: "none",
      // No publishedAt and no backfill story: a directory is undated by nature, like an external catalog.
      undatedPolicy: "discovery",
      raw: { via: "ai-list", receiptId: opts.receiptId ?? null, pageUrl: opts.pageUrl ?? null },
    });
    if (candidates.length >= maxItems) break;
  }
  return { candidates, dropped };
}

export interface AiListFetch {
  candidates: Candidate[];
  receiptIds: number[];
  /** How many links were handed to the model. */
  links: number;
  /** How many model entries were discarded (invented URL, blank title, duplicate). */
  dropped: number;
}

const SYSTEM = [
  "你在为一个资讯站从网页的链接清单里抽取条目。",
  "只能从用户给出的 links 里选择 URL：url 必须与清单中的某一项完全一致，不得编造、猜测或拼接地址。",
  "只输出 JSON：{\"items\":[{\"url\":\"...\",\"title\":\"...\",\"summary\":\"...\"}]}。",
  "title 用页面上该条目的名称；summary 是页面上的一句简介，页面没有就省略。",
  "没有合适条目时输出 {\"items\":[]}。",
].join("\n");

export async function fetchAiList(source: SourceRow): Promise<AiListFetch> {
  const url = String(source.config.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) throw new FetchError("AI 抽取列表需要有效的 url（http 或 https 地址）");
  const prompt = String(source.config.prompt ?? "").trim();
  if (!prompt) throw new FetchError("AI 抽取列表需要填写抽取提示词 prompt");
  const maxLinks = clamp(source.config.maxLinks, 20, 800, DEFAULT_MAX_LINKS);
  const maxItems = clamp(source.config.maxItems, 1, MAX_ITEMS, DEFAULT_MAX_ITEMS);

  const res = requireOk(await guardedFetch(url, {
    maxBytes: 4 * 1024 * 1024,
    timeoutMs: 30_000,
    redirectPolicy: "same-origin",
    headers: {
      "user-agent": BROWSER_UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...languageHeaders(source.config.acceptLanguage),
    },
  }), url);
  const pageUrl = res.url;
  const configuredBase = String(source.config.baseUrl ?? "").trim();
  const baseUrl = configuredBase || new URL(pageUrl).origin;
  const inventory = buildLinkInventory(res.text(), { baseUrl, maxLinks });
  if (inventory.length === 0) {
    throw new FetchError("页面上没有可用的链接（需要带文字的 http/https 锚点），本次不调用模型");
  }

  const model = await modelFor("structure");
  let extracted;
  try {
    extracted = await chatJson({
      model,
      purpose: "source-list",
      promptVersion: AI_LIST_PROMPT_VERSION,
      subject: `source:${source.id}`,
      system: SYSTEM,
      user: JSON.stringify({ pageUrl, prompt, links: inventory }),
      schema: AiListOutputSchema,
      temperature: 0.1,
      maxTokens: Math.min(16_384, 2_048 + maxItems * 80),
    });
  } catch (error) {
    // A schema-invalid or unparsable answer is this run's failure, stated as such. Budget and provider
    // availability errors keep their own meaning for the source's health (collect.ts).
    if (error instanceof ModelOutputError) throw new FetchError(`模型输出不合格式，无法抽取列表：${error.message.slice(0, 300)}`);
    throw error;
  }

  const { candidates, dropped } = parseAiListOutput(extracted.data, inventory, {
    maxItems,
    allowUrlPrefixes: source.config.allowUrlPrefixes,
    receiptId: extracted.receiptId,
    pageUrl,
  });
  return { candidates, receiptIds: [extracted.receiptId], links: inventory.length, dropped };
}
