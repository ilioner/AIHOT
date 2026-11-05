// Finding a WeChat account through WeRead: by name (the store's account search) or by an article link
// (the link's __biz, WeRead's resolver, then the page itself). Only the id, name, cover and intro are
// kept — the rest is the platform's data and the framework stores articles, not accounts.
import { WEB_UA } from "./endpoints.ts";
import { call } from "./http.ts";
import { callApi, withAccount, type Session } from "./pool.ts";
import { bookIdFromBiz, isWereadBookId } from "./wechat.ts";

export interface BookResult {
  bookId: string;
  nickname: string;
  cover: string;
  intro: string;
}

interface BookInfo extends Record<string, unknown> {
  bookId?: unknown;
  title?: unknown;
  cover?: unknown;
  intro?: unknown;
  author?: unknown;
  type?: unknown;
}

function asBookInfo(value: unknown): BookInfo {
  return value && typeof value === "object" ? (value as BookInfo) : {};
}

function result(bookId: string, info: BookInfo): BookResult {
  return {
    bookId,
    nickname: typeof info.title === "string" && info.title.trim() ? info.title.trim() : "微信公众号",
    cover: typeof info.cover === "string" ? info.cover : "",
    intro: typeof info.intro === "string" ? info.intro : "",
  };
}

async function searchStore(session: Session, keyword: string, scoped: boolean): Promise<BookResult[]> {
  const params = new URLSearchParams({ keyword, v: "2", count: "20", ...(scoped ? { scope: "2" } : {}) });
  const json = await callApi(session, `/store/search?${params.toString()}`, { timeoutMs: 15_000 });
  const books = Array.isArray(json.books) ? json.books : [];
  const found: BookResult[] = [];
  const seen = new Set<string>();
  for (const entry of books) {
    const info = asBookInfo((entry as Record<string, unknown>)?.bookInfo);
    const bookId = typeof info.bookId === "string" ? info.bookId : "";
    if (!isWereadBookId(bookId) || seen.has(bookId)) continue;
    seen.add(bookId);
    found.push(result(bookId, info));
  }
  return found;
}

/** Accounts matching a name; an empty first search falls back to the store's general search. */
export async function searchAccounts(keyword: string): Promise<BookResult[]> {
  return withAccount(async (session) => {
    const scoped = await searchStore(session, keyword, true);
    if (scoped.length) return scoped;
    return searchStore(session, keyword, false);
  });
}

/** One account's metadata, by its WeRead book id. */
export async function bookInfo(bookId: string): Promise<BookResult> {
  return withAccount(async (session) => {
    const json = await callApi(session, `/book/info?bookId=${encodeURIComponent(bookId)}`, { timeoutMs: 15_000 });
    const info = asBookInfo(json);
    return result(bookId, info);
  });
}

function bizInUrl(value: string): string {
  try {
    return new URL(value).searchParams.get("__biz")?.trim() ?? "";
  } catch {
    return "";
  }
}

function bizInPage(text: string): string {
  const match = /__biz=([A-Za-z0-9+/=]{10,})/.exec(text) ?? /var\s+biz\s*=\s*"([A-Za-z0-9+/=]{10,})"/.exec(text);
  return match ? match[1]! : "";
}

/** The WeRead book id behind an article link or a biz: the link's own __biz first, then WeRead's resolver. */
export async function resolveBookId(input: string): Promise<string> {
  const clean = input.replace(/^biz:/i, "").trim();
  if (isWereadBookId(clean)) return clean;
  const direct = bookIdFromBiz(bizInUrl(clean));
  if (isWereadBookId(direct)) return direct;
  if (!/^https?:\/\//i.test(clean)) return bookIdFromBiz(clean);

  const resolved = await withAccount(async (session) => {
    const json = await callApi(session, "/mp/getreviewid", { method: "POST", body: { urls: [clean] }, timeoutMs: 15_000 });
    const ids = Array.isArray(json.reviewIds) ? json.reviewIds : [];
    const first = ids[0] && typeof ids[0] === "object" ? (ids[0] as Record<string, unknown>).bookId : undefined;
    const bookId = typeof json.bookId === "string" ? json.bookId : typeof first === "string" ? first : "";
    return isWereadBookId(bookId) ? bookId : "";
  }).catch(() => "");
  if (resolved) return resolved;

  // Last resort: the article page itself still names the account, unless it asks for verification.
  const page = await call(clean, { headers: { "user-agent": WEB_UA }, timeoutMs: 15_000, maxBytes: 1024 * 1024 }).catch(() => null);
  const fromPage = page ? bookIdFromBiz(bizInPage(page.text)) : "";
  return isWereadBookId(fromPage) ? fromPage : "";
}

/** Whether the admin's input is a link or a biz rather than a name. */
export function isLinkOrBiz(input: string): boolean {
  const value = input.trim();
  return /^https?:\/\//i.test(value) || /^biz:/i.test(value) || isWereadBookId(value) || /^[A-Za-z0-9+/]{10,}={0,2}$/.test(value);
}
