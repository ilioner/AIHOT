// Collecting one WeChat account through WeRead: its recent posts (the account's "chapters"), each post's
// canonical short link and publication time, and the article body from WeRead's reader endpoint, which
// avoids fetching mp.weixin.qq.com itself. Every WeRead request goes through the account pool's
// pooledCaller, so a check is paced, rotates between logins and stops while the whole pool cools down.
// Articles enter the framework through upsertMaterial like every other source, so identity, timeline and
// analysis rules stay the engine's.
import * as cheerio from "cheerio";
import { sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { sanitizeBody } from "@aihot/backend/content/sanitize";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { stripTags } from "@aihot/backend/lib/text";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn } from "@aihot/backend/jobs/queue";
import { dajialaConfigured } from "@aihot/backend/providers/dajiala";
import { ENDPOINTS, WEB_UA } from "./endpoints.ts";
import { call, classify, errcodeOf, WereadError } from "./http.ts";
import { callApi, cookieOf, pooledCaller, type PooledCaller } from "./pool.ts";
import { isWereadBookId, normalizeWechatShortUrl, shortUrlForReview } from "./wechat.ts";

const MAX_NEW_PER_CHECK = 8;
const PAGE_SIZE = 20;
/** On an account's first check, older posts are history, not news. */
const FIRST_CHECK_WINDOW_MS = 7 * 86400_000;
/** A body that failed for a passing reason is fetched again this many times, while the post is recent. */
const BODY_RETRIES = 3;
const BODY_RETRY_WINDOW_MS = 3 * 86400_000;
/** Scheduler stagger: each queued check starts up to this many seconds late, so they spread out. */
const STAGGER_SECONDS = 120;

export interface CollectJob {
  sourceId: string;
  reason: "schedule" | "manual";
}

export const collectQueue = defineQueue<CollectJob>({
  name: "weread-mp.collect",
  options: { policy: "short", retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 },
  worker: { batchSize: 1 },
  run: async (jobs) => {
    const results = [];
    for (const job of jobs) results.push(await collectSource(job.sourceId, job.reason));
    return results;
  },
});

export interface CollectResult {
  sourceId: string;
  /** "cooling": the account pool had nothing to give this cycle, so the source was not checked. */
  status: "ok" | "missing" | "paused" | "unconfigured" | "failed" | "cooling";
  found?: number;
  created?: number;
  error?: string;
}

interface SourceRow {
  id: string;
  name: string;
  config: Record<string, unknown>;
  cursor: Record<string, unknown> | null;
  enabled: boolean;
}

interface Post {
  reviewId: string;
  title: string;
  url: string;
  publishedAt: Date | null;
  excerpt: string;
  author: string;
  cover: string;
}

function secondsOf(value: unknown): Date | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 0;
  if (!number || !Number.isFinite(number) || number <= 0) return null;
  const ms = number > 1e12 ? number : number * 1000;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date : null;
}

function firstTime(item: Record<string, unknown>, info: Record<string, unknown>): Date | null {
  for (const value of [
    item.createTime, item.updateTime, item.publishTime, item.create_time, item.update_time,
    info.time, info.create_time, info.update_time, info.publish_time,
  ]) {
    const date = secondsOf(value);
    if (date) return date;
  }
  return null;
}

function postOf(item: unknown, accountName: string): Post | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const info = raw.mpInfo && typeof raw.mpInfo === "object" ? (raw.mpInfo as Record<string, unknown>) : {};
  const reviewId = typeof raw.reviewId === "string" ? raw.reviewId : "";
  const url = shortUrlForReview(reviewId) || normalizeWechatShortUrl(typeof info.doc_url === "string" ? info.doc_url : "");
  const title = String(info.title ?? raw.title ?? "").trim();
  if ((!url && !reviewId) || !title) return null;
  return {
    reviewId,
    title,
    url,
    publishedAt: firstTime(raw, info),
    excerpt: String(info.digest ?? raw.digest ?? "").trim().slice(0, 500),
    author: String(info.author ?? "").trim() || accountName,
    cover: String(info.pic_url ?? info.thumbUrl ?? raw.cover ?? raw.pic ?? "").trim(),
  };
}

/** A refusal that ends the whole check: another login cannot cure a cooling pool or a dead token. */
function endsCheck(error: unknown): boolean {
  return error instanceof WereadError && (error.kind === "auth" || error.kind === "verify" || error.kind === "throttled");
}

async function page(caller: PooledCaller, path: string): Promise<Record<string, unknown>[]> {
  const json = await caller((session) => callApi(session, path, { timeoutMs: 20_000 }));
  for (const key of ["data", "chapters", "list", "reviews"]) {
    const value = json[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** A post whose listing lacked its link or time: WeRead's review object carries both. */
async function resolveMissing(caller: PooledCaller, post: Post): Promise<Post> {
  if ((post.url && post.publishedAt) || !post.reviewId) return post;
  const json = await caller((session) => callApi(session, `/review/single?reviewId=${encodeURIComponent(post.reviewId)}`, { timeoutMs: 10_000 }))
    .catch((error) => {
      if (endsCheck(error)) throw error;
      return null;
    });
  if (!json) return post;
  const info = (json.review && typeof json.review === "object" ? json.review : json) as Record<string, unknown>;
  return {
    ...post,
    url: post.url || normalizeWechatShortUrl(typeof info.doc_url === "string" ? info.doc_url : ""),
    publishedAt: post.publishedAt ?? secondsOf(info.create_time ?? info.createTime),
    excerpt: post.excerpt || String(info.digest ?? "").trim().slice(0, 500),
    author: post.author || String(info.author ?? "").trim(),
    cover: post.cover || String(info.cover ?? "").trim(),
  };
}

/** The account's latest posts, with the two fallbacks the app itself uses. */
async function listPosts(caller: PooledCaller, bookId: string, accountName: string): Promise<Post[]> {
  const posts: Post[] = [];
  const seen = new Set<string>();
  const add = (items: Record<string, unknown>[]) => {
    for (const item of items) {
      const post = postOf(item, accountName);
      if (!post) continue;
      const key = post.reviewId || post.url;
      if (seen.has(key)) continue;
      seen.add(key);
      posts.push(post);
    }
  };

  let items = await page(caller, `/mp/chapters?bookId=${encodeURIComponent(bookId)}&count=${PAGE_SIZE}&offset=0&pf=android&synckey=0`);
  add(items);
  if (!items.length) add(await page(caller, `/article/list?bookId=${encodeURIComponent(bookId)}&synckey=0`));
  if (!posts.length) {
    const cover = await caller((session) => callApi(session, `/mp/cover?bookId=${encodeURIComponent(bookId)}`, { timeoutMs: 15_000 }))
      .catch((error) => {
        if (endsCheck(error)) throw error;
        return null;
      });
    const reviewId = typeof cover?.reviewId === "string" ? cover.reviewId : "";
    if (reviewId) add([{ reviewId, title: cover?.title, createTime: cover?.createTime, cover: cover?.pic ?? cover?.avatar }]);
  }
  const resolved: Post[] = [];
  for (const post of posts) {
    const filled = await resolveMissing(caller, post);
    if (filled.url) resolved.push(filled);
  }
  return resolved;
}

/** The article HTML WeRead's reader shows, reduced to the article's own content. */
async function articleHtml(caller: PooledCaller, reviewId: string): Promise<string | null> {
  if (!reviewId) return null;
  // The reader's page takes the mobile login's cookie, so it is one of that login's paced requests.
  const answer = await caller((session) => call(`${ENDPOINTS.web}/web/mp/content?reviewId=${encodeURIComponent(reviewId)}`, {
    headers: {
      "user-agent": WEB_UA,
      cookie: cookieOf(session),
      referer: `${ENDPOINTS.web}/`,
      origin: ENDPOINTS.web,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    timeoutMs: 20_000,
    maxBytes: 8 * 1024 * 1024,
  }));
  if (answer.status !== 200) {
    // A refusal here is classified like any other: auth/verify/throttle end the check, other answers
    // leave the body to be asked for again while the post is recent.
    throw new WereadError(`weread web HTTP ${answer.status}${errcodeOf(answer.json, answer.text) === null ? "" : ` (${errcodeOf(answer.json, answer.text)})`}`,
      classify(answer), answer.status, errcodeOf(answer.json, answer.text));
  }
  const html = answer.text;
  if (!html.includes('id="js_content"') && !html.includes("rich_media_content")) return null;
  const $ = cheerio.load(html);
  const byClass = $(".rich_media_content").first();
  const node = byClass.length ? byClass : $("#js_content").first();
  if (!node.length) return null;
  node.find("img").each((_, image) => {
    const source = $(image).attr("data-src");
    if (source) $(image).attr("src", source);
    $(image).removeAttr("data-src");
  });
  return node.html();
}

/** The body, and when it is missing for a reason that may pass, that reason. */
async function fetchBody(caller: PooledCaller, post: Post): Promise<{ html: string | null; text: string | null; passing: string | null }> {
  try {
    const raw = await articleHtml(caller, post.reviewId);
    if (!raw) return { html: null, text: null, passing: null };
    const html = sanitizeBody(raw, post.url);
    const text = stripTags(html).trim();
    return text ? { html, text, passing: null } : { html: null, text: null, passing: null };
  } catch (error) {
    if (endsCheck(error)) throw error;
    return { html: null, text: null, passing: String(error instanceof Error ? error.message : error).slice(0, 200) };
  }
}

export async function collectSource(sourceId: string, reason: "schedule" | "manual"): Promise<CollectResult> {
  const [source] = await sql<SourceRow[]>`SELECT id, name, config, cursor, enabled FROM sources WHERE id = ${sourceId} AND kind = 'mp_account'`;
  if (!source) return { sourceId, status: "missing" };
  if (!source.enabled && reason !== "manual") return { sourceId, status: "paused" };
  const bookId = source.config.ghid;
  if (!isWereadBookId(bookId)) return { sourceId, status: "unconfigured" };

  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id, detail) VALUES (${sourceId}, ${sql.json({ reason, via: "weread" })}) RETURNING id`;
  const firstCheck = !source.cursor?.lastCheckedAt;
  let created = 0;
  try {
    const caller = pooledCaller();
    const posts = await listPosts(caller, bookId, source.name);
    let fetched = 0;
    for (const post of posts) {
      if (fetched >= MAX_NEW_PER_CHECK) break;
      if (firstCheck && post.publishedAt && Date.now() - post.publishedAt.getTime() > FIRST_CHECK_WINDOW_MS) continue;
      const key = identityKeyForUrl(post.url);
      const [known] = key
        ? await sql<{ id: string; body_status: string; discovered_at: Date; retry: { attempts: number } | null }[]>`
            SELECT id, body_status, discovered_at, raw->'weread'->'bodyRetry' AS retry FROM articles WHERE identity_key = ${key} LIMIT 1`
        : [];
      const retryBody = !!known?.retry && known.body_status === "none" && known.retry.attempts < BODY_RETRIES
        && Date.now() - known.discovered_at.getTime() < BODY_RETRY_WINDOW_MS;
      if (known && !retryBody) continue;
      fetched += 1;
      const body = await fetchBody(caller, post);
      if (known && !body.text) {
        const retry = body.passing
          ? sql`jsonb_set(raw, '{weread,bodyRetry}', ${sql.json({ attempts: known.retry!.attempts + 1, error: body.passing })})`
          : sql`raw #- '{weread,bodyRetry}'`;
        await sql`UPDATE articles SET raw = ${retry} WHERE id = ${known.id}`;
        continue;
      }
      const res = await upsertMaterial({
        sourceId,
        url: post.url,
        title: post.title,
        author: post.author,
        language: "zh",
        publishedAt: post.publishedAt,
        excerpt: post.excerpt || null,
        bodyHtml: body.html,
        bodyText: body.text,
        bodyStatus: body.text ? "ok" : "none",
        via: "weread-mp",
        backfill: firstCheck ? "first-import" : null,
        raw: {
          weread: {
            reviewId: post.reviewId,
            bookId,
            cover: post.cover || null,
            ...(body.passing ? { bodyRetry: { attempts: 1, error: body.passing } } : {}),
          },
        },
      });
      if (known) await sql`UPDATE articles SET raw = raw #- '{weread,bodyRetry}' WHERE id = ${known.id}`;
      if (res.created) created += 1;
      if (res.created || res.revised || res.processingNeeded) await queueProcessing(res.articleId);
    }
    const cursor = { ...(source.cursor ?? {}), lastCheckedAt: new Date().toISOString(), lastReviewId: posts[0]?.reviewId ?? null };
    await sql`
      UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL, health = 'ok',
        cursor = ${sql.json(cursor as never)}, next_fetch_at = now() + make_interval(mins => interval_minutes), updated_at = now()
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${posts.length}, new_count = ${created} WHERE id = ${run!.id}`;
    return { sourceId, status: "ok", found: posts.length, created };
  } catch (error) {
    const text = String(error instanceof Error ? error.message : error).slice(0, 500);
    // The pool had nothing to give this cycle (every login cooling or out of its hour budget). That is
    // not the source failing: keep its health, record why this check was skipped, and check again next
    // scheduling cycle instead of retrying into the cooldown.
    if (error instanceof WereadError && error.kind === "throttled") {
      await sql`UPDATE sources SET last_fetch_at = now(), last_error = ${text}, updated_at = now() WHERE id = ${sourceId}`;
      await sql`UPDATE fetch_runs SET status = 'skipped', finished_at = now(), new_count = ${created}, error = ${text} WHERE id = ${run!.id}`;
      return { sourceId, status: "cooling", error: text };
    }
    const passing = error instanceof WereadError && (error.kind === "network" || error.kind === "verify");
    await sql`
      UPDATE sources SET last_fetch_at = now(), last_error = ${text},
        fail_count = CASE WHEN ${passing} THEN fail_count ELSE fail_count + 1 END,
        health = CASE WHEN ${passing} THEN health WHEN fail_count + 1 >= 3 THEN 'failing' ELSE 'degraded' END, updated_at = now()
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), new_count = ${created}, error = ${text} WHERE id = ${run!.id}`;
    if (passing) throw error;
    return { sourceId, status: "failed", error: text };
  }
}

/** Every enabled WeRead-managed account is checked once per its interval, each queued with a random
 * 0–120s delay so a round of due sources does not land on one login in the same minute. */
export async function scheduleCollect(
  now = new Date(),
  random: () => number = Math.random,
): Promise<{ enqueued: number; skipped?: string }> {
  // Dajiala already collects mp_account sources when it is configured; two collectors would double-read.
  if (dajialaConfigured()) return { enqueued: 0, skipped: "dajiala" };
  const rows = await sql<{ id: string; last: string | null; interval_minutes: number; config: Record<string, unknown> }[]>`
    SELECT id, cursor->>'lastCheckedAt' AS last, interval_minutes, config FROM sources WHERE kind = 'mp_account' AND enabled`;
  let enqueued = 0;
  for (const source of rows) {
    if (!isWereadBookId(source.config.ghid)) continue;
    const since = source.last ? now.getTime() - Date.parse(source.last) : Infinity;
    if (since <= source.interval_minutes * 60_000) continue;
    await enqueueOn(collectQueue, { sourceId: source.id, reason: "schedule" }, {
      singletonKey: `weread-mp:${source.id}`,
      startAfter: Math.floor(random() * STAGGER_SECONDS),
    });
    enqueued += 1;
  }
  return { enqueued };
}

export interface ManagedSource {
  id: string;
  name: string;
  bookId: string;
  health: string;
  enabled: boolean;
  intervalMinutes: number;
  lastFetchAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  articles: number;
}

/** The sources this module collects, for the admin page. */
export async function listManagedSources(): Promise<ManagedSource[]> {
  const rows = await sql<{
    id: string; name: string; book_id: string; health: string; enabled: boolean; interval_minutes: number;
    last_fetch_at: Date | null; last_ok_at: Date | null; last_error: string | null; articles: number;
  }[]>`
    SELECT s.id, s.name, COALESCE(s.config->>'ghid', '') AS book_id, s.health, s.enabled, s.interval_minutes,
           s.last_fetch_at, s.last_ok_at, s.last_error,
           (SELECT count(*)::int FROM articles a WHERE a.source_id = s.id) AS articles
    FROM sources s
    WHERE s.kind = 'mp_account' AND s.config->>'ghid' LIKE 'MP_WXS_%'
    ORDER BY s.enabled DESC, s.name`;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    bookId: row.book_id,
    health: row.health,
    enabled: row.enabled,
    intervalMinutes: row.interval_minutes,
    lastFetchAt: row.last_fetch_at?.toISOString() ?? null,
    lastOkAt: row.last_ok_at?.toISOString() ?? null,
    lastError: row.last_error,
    articles: row.articles,
  }));
}
