// Outbound calls to WeRead. Every request goes through the engine's guardedFetch (public addresses only,
// bounded time and size), and a non-200 answer is classified here: the login loop and the collector act
// on those classes instead of reading status codes in two places.
import { guardedFetch } from "@aihot/backend/lib/http-fetch";

export type FailureKind = "auth" | "throttled" | "verify" | "network" | "other";

/** A request WeRead refused, or that could not be made. */
export class WereadError extends Error {
  readonly kind: FailureKind;
  readonly status: number;
  readonly errcode: number | null;

  constructor(message: string, kind: FailureKind, status = 0, errcode: number | null = null) {
    super(message);
    this.name = "WereadError";
    this.kind = kind;
    this.status = status;
    this.errcode = errcode;
  }
}

export interface Answer {
  status: number;
  text: string;
  json: unknown;
}

function errcodeOf(json: unknown, text: string): number | null {
  const fromJson = json && typeof json === "object" ? (json as Record<string, unknown>).errcode : undefined;
  if (typeof fromJson === "number" && Number.isFinite(fromJson)) return fromJson;
  const match = /-2\d{3}/.exec(text);
  return match ? Number(match[0]) : null;
}

/** What a non-200 answer means for the caller. */
export function classify(answer: Answer): FailureKind {
  if (answer.status === 401) return "auth";
  const errcode = errcodeOf(answer.json, answer.text);
  if (errcode === -2041 || /-2041/.test(answer.text)) return "verify";
  if (errcode === -2014 || /-2014/.test(answer.text) || answer.status === 429) return "throttled";
  return "other";
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function call(url: string, opts: RequestOptions = {}): Promise<Answer> {
  let res;
  try {
    res = await guardedFetch(url, {
      method: opts.method ?? "GET",
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      headers: opts.headers,
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxBytes: opts.maxBytes ?? 4 * 1024 * 1024,
      truncate: true,
    });
  } catch (error) {
    throw new WereadError(String(error instanceof Error ? error.message : error).slice(0, 300), "network");
  }
  const text = res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

/** A 200 answer as an object; anything else becomes the classified refusal. */
export async function callJson(url: string, opts: RequestOptions = {}): Promise<Record<string, unknown>> {
  const answer = await call(url, opts);
  if (answer.status !== 200) {
    const kind = classify(answer);
    const errcode = errcodeOf(answer.json, answer.text);
    throw new WereadError(`weread HTTP ${answer.status}${errcode === null ? "" : ` (${errcode})`}`, kind, answer.status, errcode);
  }
  return (answer.json ?? {}) as Record<string, unknown>;
}

export { errcodeOf };
