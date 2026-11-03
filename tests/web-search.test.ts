// A paid web search as a scheduled source: only organic results are kept, a result's date is never
// invented (its page states it or the material stays undated), a query is paid for once a day, and
// each failure keeps its own meaning for the source's health and for the next run.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";
import { searchWeb } from "@aihot/backend/providers/fathom";
import { collectSource } from "@aihot/backend/sources/collect";

const T = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const SUFFIX = T();
const API_KEY = "dummy-test-fathom-key";
/** A page states its own publication date; the other one never does. */
const DATED_AT = new Date(Date.now() - 3 * 3_600_000);

const paragraph = (topic: string) => `<p>${`${topic}：这是一条供测试使用的正文段落，用来确认网页正文可以被读取并保留足够长度的文字。`.repeat(6)}</p>`;
const page = (title: string, head: string) => `<html><head><title>${title}</title>${head}</head><body><article><h1>${title}</h1>${paragraph(title)}</article></body></html>`;

const hits = new Map<string, number>();
/** Answers that are not a normal search response, only for the first call of a named query. */
const breach = { unknown: "", outage: "" };
/** Content-type and body live here: a stub() reply is always JSON, which no article page is. */
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  const reply = (status: number, type: string, body: string) => { res.writeHead(status, { "content-type": type }); res.end(body); };
  if (url.pathname === "/search") {
    const query = url.searchParams.get("text") ?? "";
    const hit = (hits.get(query) ?? 0) + 1;
    hits.set(query, hit);
    if (!req.headers["x-api-key"]) return reply(401, "text/plain", "missing key");
    if (query === breach.unknown && hit === 1) return reply(200, "text/html", "<html><body>checking your browser</body></html>");
    if (query === breach.outage && hit === 1) return reply(504, "text/plain", "error code: 504");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return reply(200, "application/json", JSON.stringify({ pagination: { count: 3 }, results: [
      { id: "s_1", rank: 1, type: "organic", title: "人工智能赋能职业院校课程改革", url: `${base}/p/dated`, snippet: "摘要一", engine: "bing" },
      { id: "s_2", rank: 2, type: "organic", title: "高职院校人工智能教学案例", url: `${base}/p/undated`, snippet: "摘要二", engine: "google" },
      { id: "s_3", rank: 3, type: "ad", title: "推广位", url: `${base}/p/promo`, snippet: "广告" },
    ] }));
  }
  if (url.pathname === "/p/dated") return reply(200, "text/html", page("人工智能赋能职业院校课程改革", `<meta property="article:published_time" content="${DATED_AT.toISOString()}">`));
  if (url.pathname === "/p/undated") return reply(200, "text/html", page("高职院校人工智能教学案例", ""));
  return reply(404, "text/plain", "not found");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const PORT = (server.address() as { port: number }).port;

process.env.FATHOM_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.FATHOM_API_KEY = API_KEY;
config.allowPrivateNetworkFetch = true;

const ids = { organic: `ws-${SUFFIX}-organic`, missing: `ws-${SUFFIX}-missing`, budget: `ws-${SUFFIX}-budget`, unknown: `ws-${SUFFIX}-unknown`, outage: `ws-${SUFFIX}-outage` };
const queries: Record<string, string> = {
  organic: "人工智能 职业教育 动态",
  missing: "缺少密钥的查询",
  budget: "预算熔断查询",
  unknown: `结果未知查询 ${SUFFIX}`,
  outage: `网关超时查询 ${SUFFIX}`,
};
breach.unknown = queries.unknown!;
breach.outage = queries.outage!;

/** A source already past its first import: later runs judge the listing on its own, and an undated entry is no import. */
async function addSource(key: keyof typeof ids, query: string) {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, interval_minutes, enabled, next_fetch_at)
            VALUES (${ids[key]}, ${`Test search ${key}`}, 'web_search', ${sql.json({ query, lang: "zh-CN", region: "CN", limit: 10 })}, 'T2', 'editorial',
                    ${sql.json({ initializedAt: new Date().toISOString() })}, 1440, true, '2100-01-01')`;
}

const run = async (key: keyof typeof ids) => collectSource(ids[key]!, { force: true });
const rows = async (key: keyof typeof ids) => sql<{ url: string; published_at: Date | null; backfill: boolean; backfill_reason: string | null; body_status: string }[]>`
  SELECT url, published_at, backfill, backfill_reason, body_status FROM articles WHERE source_id = ${ids[key]} ORDER BY url`;
const source = async (key: keyof typeof ids) => (await sql<{ health: string; fail_count: number; next_fetch_at: Date }[]>`
  SELECT health, fail_count, next_fetch_at FROM sources WHERE id = ${ids[key]}`)[0]!;
const lastRun = async (key: keyof typeof ids) => (await sql<{ status: string; found_count: number; new_count: number; error: string | null; detail: Record<string, number> | null }[]>`
  SELECT status, found_count, new_count, error, detail FROM fetch_runs WHERE source_id = ${ids[key]} ORDER BY id DESC LIMIT 1`)[0]!;
const receipts = async (key: keyof typeof ids) => sql<{ status: string; error: string | null; attempts: number }[]>`
  SELECT status, error, attempts FROM receipts WHERE service = 'fathom' AND subject = ${`source:${ids[key]}`}`;

before(async () => {
  for (const [key, query] of Object.entries(queries)) await addSource(key as keyof typeof ids, query);
  // Every search below is a distinct query with its own receipt; the runs are counted, not budgeted.
  await sql`DELETE FROM budgets WHERE service = 'fathom'`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sql`DELETE FROM budgets WHERE service = 'fathom'`;
  await stopBoss();
  await closeDb();
});

test("a run keeps organic results only, and records what it left out", async () => {
  const result = await run("organic");
  const stored = await rows("organic");
  assert.equal(result.status, "ok");
  assert.deepEqual(stored.map((r) => r.url).sort(), [`http://127.0.0.1:${PORT}/p/dated`, `http://127.0.0.1:${PORT}/p/undated`], "the advertisement is not stored");
  const run0 = await lastRun("organic");
  assert.deepEqual([run0.detail!.organic, run0.detail!.ads], [2, 1]);
});

test("a search result is never dated by the search, and its page's date is filled in later", async () => {
  const collected = await rows("organic");
  assert.deepEqual(collected.map((r) => r.published_at), [null, null], "the search itself dated neither result");
  assert.deepEqual(collected.map((r) => [r.backfill, r.backfill_reason]), [[true, "unknown-publication-time"], [true, "unknown-publication-time"]], "an undated result is held back until its page states a date");
  assert.deepEqual(collected.map((r) => r.body_status), ["pending", "pending"], "each page is still to be read for the body and the date");

  const [article] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id = ${ids.organic} AND url = ${`http://127.0.0.1:${PORT}/p/dated`}`;
  assert.equal(await extractArticleBody(article!.id), "ok");
  const after0 = await rows("organic");
  const dated = after0.find((r) => r.url === `http://127.0.0.1:${PORT}/p/dated`)!;
  assert.equal(dated.published_at?.getTime(), DATED_AT.getTime());
  assert.deepEqual([dated.backfill, dated.backfill_reason], [false, null], "a date from the page is news, not a backfill");
  assert.equal(after0.find((r) => r.url === `http://127.0.0.1:${PORT}/p/undated`)!.published_at, null, "a page without a date leaves material undated");
});

test("the same query is paid for once a day, and asked again on the next day", async () => {
  const query = queries.organic!;
  assert.equal(hits.get(query), 1, "the collection above paid once");
  const again = await run("organic");
  assert.equal(again.status, "ok");
  assert.equal(hits.get(query), 1, "a second run the same day reuses the answer without paying");
  assert.equal((await receipts("organic")).length, 1, "one receipt, not one per run");

  const tomorrow = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10);
  const next = await searchWeb(query, { lang: "zh-CN", region: "CN", limit: 10, subject: "test:next-day", window: tomorrow });
  assert.equal(next.reused, false);
  assert.equal(hits.get(query), 2, "the next day's first call is a new paid search");
  const reused = await searchWeb(query, { lang: "zh-CN", region: "CN", limit: 10, subject: "test:next-day", window: tomorrow });
  assert.equal(reused.reused, true, "a repeat within that day reuses it too");
  assert.equal(hits.get(query), 2);
});

test("an unconfigured key fails the run without a receipt or a request", async () => {
  process.env.FATHOM_API_KEY = "";
  try {
    const before = hits.get(queries.missing!);
    const result = await run("missing");
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /FATHOM_API_KEY is not configured/);
    assert.equal(hits.get(queries.missing!) ?? 0, before ?? 0, "nothing was sent");
    assert.equal((await receipts("missing")).length, 0, "no receipt is created for a request never made");
  } finally {
    process.env.FATHOM_API_KEY = API_KEY;
  }
});

test("a spent budget fails the run without counting against the source's health", async () => {
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES ('fathom', 0, 0, 0, 'test')`;
  try {
    const result = await run("budget");
    assert.equal(result.status, "failed");
    const state = await source("budget");
    assert.equal(state.fail_count, 0, "a budget is not the source's failure");
    assert.equal(state.health, "unknown", "health is left as it was");
    assert.ok(state.next_fetch_at.getTime() - Date.now() > 10 * 60_000, "the run is retried after the window");
    assert.equal(hits.get(queries.budget!), undefined, "nothing was sent");
    assert.equal((await lastRun("budget")).error !== null, true);
  } finally {
    await sql`DELETE FROM budgets WHERE service = 'fathom'`;
  }
});

test("an unknown outcome stops the run, is released once, then calls again", async () => {
  const query = queries.unknown!;
  const result = await run("unknown");
  assert.equal(result.status, "failed");
  assert.deepEqual((await receipts("unknown")).map((r) => [r.status, r.attempts]), [["unknown", 1]]);
  const state = await source("unknown");
  assert.equal(state.health, "degraded");

  // The outcome is unknown: the request may have been billed, so it is not sent again on its own.
  assert.equal((await run("unknown")).status, "failed");
  assert.equal(hits.get(query), 1, "no second request");
  assert.equal((await receipts("unknown"))[0]!.attempts, 1);

  const released = await autoReleaseUnknownReceipts(Date.now() + 31 * 60_000);
  assert.equal(released.released, 1);
  breach.unknown = ""; // the query answers normally from here
  assert.equal((await run("unknown")).status, "ok");
  assert.equal(hits.get(query), 2, "a released request may be sent again");
  assert.equal((await receipts("unknown"))[0]!.attempts, 2);
});

test("a server error is a failed request the next run may retry", async () => {
  const query = queries.outage!;
  const result = await run("outage");
  assert.equal(result.status, "failed");
  assert.match((await lastRun("outage")).error ?? "", /504/, "the provider's own words are kept");
  assert.deepEqual((await receipts("outage")).map((r) => r.status), ["failed"]);
  assert.equal(hits.get(query), 1);

  breach.outage = "";
  assert.equal((await run("outage")).status, "ok");
  assert.equal(hits.get(query), 2, "a request the provider refused is retried");
});
