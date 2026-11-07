// ai_list: the operator gives a page and a prompt; one paid model call turns that page's own link
// inventory into list entries. The pure helpers are checked without a database or model: relative
// links are made absolute, no-text anchors and tracking duplicates disappear, and an address the model
// invented never becomes a candidate. The collection test then runs the whole path against local stubs.
import { pointModels, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildLinkInventory, fetchAiList, parseAiListOutput, type LinkInventoryEntry } from "@aihot/backend/sources/ai-list";
import { collectSource } from "@aihot/backend/sources/collect";
import { FetchError, type SourceRow } from "@aihot/backend/sources/types";

const inventory: LinkInventoryEntry[] = [
  { url: "https://example.com/a", text: "条目 A" },
  { url: "https://example.com/b", text: "条目 B" },
];

test("buildLinkInventory absolutizes links, drops anchors without text, and deduplicates after normalization", () => {
  const html = `<ul>
    <li><a href="/tools/a?utm_source=nav">工具 A</a></li>
    <li><a href="https://example.com/tools/a">工具 A 的另一种写法</a></li>
    <li><a href="/tools/b"><img src="/b.png"></a></li>
    <li><a href="mailto:hi@example.com">邮件</a></li>
    <li><a href="/tools/c" title="工具 C"></a></li>
  </ul>`;
  const links = buildLinkInventory(html, { baseUrl: "https://example.com/ai/" });
  assert.deepEqual(links, [
    { url: "https://example.com/tools/a", text: "工具 A" },
    { url: "https://example.com/tools/c", text: "工具 C" },
  ], "the canonical address drops the tracking parameter and the duplicate");
  assert.equal(buildLinkInventory(html, { baseUrl: "https://example.com/ai/", maxLinks: 1 }).length, 1, "maxLinks caps the inventory");
});

test("parseAiListOutput drops invented addresses and blank titles, deduplicates, and truncates summaries", () => {
  const parsed = parseAiListOutput({
    items: [
      { url: "https://example.com/a?utm_source=x", title: "条目 A", summary: "长".repeat(2_100) },
      { url: "https://evil.example/invented", title: "模型编造的地址" },
      { url: "https://example.com/b", title: "   " },
      { url: "https://example.com/a", title: "重复的条目 A" },
      { url: "https://mirror.example/extra", title: "允许前缀的条目" },
      { url: "https://example.com/b", title: "条目 B" },
    ],
  }, inventory, {
    maxItems: 10,
    allowUrlPrefixes: ["https://mirror.example/"],
    receiptId: 42,
    pageUrl: "https://example.com/ai/",
  });
  assert.deepEqual(parsed.candidates.map((c) => [c.url, c.title]), [
    ["https://example.com/a", "条目 A"],
    ["https://mirror.example/extra", "允许前缀的条目"],
    ["https://example.com/b", "条目 B"],
  ]);
  assert.equal(parsed.dropped, 3, "the invented address, the blank title and the duplicate are counted");
  assert.equal(parsed.candidates[0]!.excerpt!.length, 2_000);
  assert.equal(parsed.candidates[0]!.bodyStatus, "none", "the directory entry is the material; its target page is not fetched");
  assert.equal(parsed.candidates[0]!.undatedPolicy, "discovery", "an undated directory is not treated as an UNKNOWN_TIME backfill");
  assert.equal("publishedAt" in parsed.candidates[0]!, false, "neither the page nor the model dates an entry");
  assert.deepEqual(parsed.candidates[0]!.raw, { via: "ai-list", receiptId: 42, pageUrl: "https://example.com/ai/" });
  assert.equal(parseAiListOutput({ items: [] }, inventory, { maxItems: 1 }).candidates.length, 0);
});

test("parseAiListOutput rejects output that does not match the schema with a Chinese FetchError", () => {
  for (const bad of [{ items: [{ title: "缺少地址" }] }, { notItems: [] }, "not json"]) {
    assert.throws(() => parseAiListOutput(bad, inventory), (error) =>
      error instanceof FetchError && /模型输出不合格式/.test(error.message), JSON.stringify(bad));
  }
});

// ---- The full collection path: a local HTML page, a local model stub, a throwaway database. ----

const modelCalls: string[] = [];
const paragraph = "这是一条测试条目的简介。";
let base = "";
const site = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://site").pathname;
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (path === "/list") {
    res.end(`<html><body><h1>AI 资源</h1><ul>
      <li><a href="/entry/one">条目一：工具</a></li>
      <li><a href="/entry/two">条目二：模型</a></li>
      <li><a href="/entry/three">条目三：课程</a></li>
    </ul></body></html>`);
    return;
  }
  if (path === "/empty") {
    // A common navigation card: the text lives in the image's alt, not in the anchor.
    res.end(`<html><body><a href="/entry/one"><img src="/one.png" alt="条目一"></a></body></html>`);
    return;
  }
  res.end(`<html><body><article><h1>${path}</h1><p>${paragraph}</p></article></body></html>`);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
  const user = JSON.parse(body.messages.find((message) => message.role === "user")!.content) as { prompt: string };
  modelCalls.push(user.prompt);
  const content = user.prompt.includes("坏输出")
    ? { items: [{ title: "缺少地址" }] }
    : { items: [
      { url: `${base}/entry/one`, title: "条目一", summary: paragraph },
      { url: `${base}/entry/one?utm_source=list`, title: "条目一（重复）" },
      { url: `${base}/entry/invented`, title: "模型编造的条目" },
      { url: `${base}/entry/two`, title: "  " },
      { url: `${base}/entry/two`, title: "条目二", summary: "长".repeat(2_100) },
    ] };
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
});
pointModels(provider.url, ["qwen3.8-flash"]);
config.allowPrivateNetworkFetch = true;

const T = tag();
const ids = { ok: `ai-list-ok-${T}`, bad: `ai-list-bad-${T}`, empty: `ai-list-empty-${T}` };

async function addSource(id: string, page: string, prompt: string) {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, interval_minutes, enabled, next_fetch_at)
    VALUES (${id}, ${id}, 'ai_list', ${sql.json({ url: `${base}${page}`, prompt, maxItems: 10 })}, 'T2', 'editorial',
            ${sql.json({ initializedAt: new Date().toISOString() })}, 1440, true, '2100-01-01')`;
}
await addSource(ids.ok, "/list", "抽出侧栏分类下的全部资源，保留名称和一句简介");
await addSource(ids.bad, "/list", "坏输出测试");
await addSource(ids.empty, "/empty", "抽出列表");

after(async () => {
  await new Promise<void>((resolve) => site.close(() => resolve()));
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("collectSource stores the extracted entries once, records what it dropped, and completes its one receipt", async () => {
  const result = await collectSource(ids.ok, { force: true });
  assert.equal(result.status, "ok");
  assert.equal(result.created, 2, "the duplicate model entry and the invented address are not stored");

  // The inventory (and so the stored address) is canonical: http becomes https and a trailing slash or
  // tracking parameter cannot create a second identity.
  const canonical = (path: string) => `https://${base.replace(/^http:\/\//, "")}${path}`;
  const rows = await sql<{ url: string; title: string; excerpt: string | null; body_status: string; published_at: Date | null; backfill: boolean; backfill_reason: string | null; raw: Record<string, unknown> }[]>`
    SELECT url, title, excerpt, body_status, published_at, backfill, backfill_reason, raw FROM articles WHERE source_id = ${ids.ok} ORDER BY url`;
  assert.deepEqual(rows.map((row) => [row.url, row.title]), [
    [canonical("/entry/one"), "条目一"],
    [canonical("/entry/two"), "条目二"],
  ], "one article per identity: the tracked duplicate collapsed, the invented address is gone");
  assert.ok(rows.every((row) => row.published_at === null && row.body_status === "none"), "no date is invented and no target page is fetched for a body");
  assert.ok(rows.every((row) => row.backfill === false && row.backfill_reason === null), "an undated directory entry is not an UNKNOWN_TIME backfill");
  const jobs = await sql<{ name: string }[]>`
    SELECT j.name FROM pgboss.job j JOIN articles a ON a.id = j.data->>'articleId' WHERE a.source_id = ${ids.ok}`;
  assert.ok(jobs.length > 0 && jobs.every((job) => job.name !== "content.extract-body"), "collection queues analysis, never a body extraction");
  assert.equal(rows[1]!.excerpt!.length, 2_000);
  assert.deepEqual([rows[0]!.raw.via, rows[0]!.raw.pageUrl], ["ai-list", `${base}/list`]);

  const [run] = await sql<{ status: string; found_count: number; new_count: number; detail: Record<string, unknown> }[]>`
    SELECT status, found_count, new_count, detail FROM fetch_runs WHERE source_id = ${ids.ok} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual([run!.status, run!.found_count, run!.new_count], ["ok", 2, 2]);
  assert.deepEqual([run!.detail.links, run!.detail.items, run!.detail.dropped], [3, 2, 3], "the run says how many links it gave the model and what it discarded");
  assert.equal((run!.detail.receiptIds as number[]).length, 1);

  const receipts = await sql<{ status: string; purpose: string }[]>`
    SELECT status, purpose FROM receipts WHERE subject = ${`source:${ids.ok}`}`;
  assert.deepEqual(receipts.map((receipt) => [receipt.purpose, receipt.status]), [["source-list", "completed"]],
    "the one paid extraction is recorded and completed with the run");
});

test("a schema-invalid model answer fails the run in Chinese and writes no partial articles", async () => {
  const before = modelCalls.length;
  const result = await collectSource(ids.bad, { force: true });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /模型输出不合格式/);
  assert.equal(modelCalls.length, before + 1, "the model was called once");
  assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE source_id = ${ids.bad}`)[0]!.n, 0);
  const [run] = await sql<{ status: string; error: string }[]>`
    SELECT status, error FROM fetch_runs WHERE source_id = ${ids.bad} ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.status, "failed");
  assert.match(run!.error, /模型输出不合格式/);
  const [failedReceipt] = await sql<{ status: string }[]>`
    SELECT status FROM receipts WHERE subject = ${`source:${ids.bad}`} ORDER BY id DESC LIMIT 1`;
  assert.equal(failedReceipt?.status, "failed", "an unusable answer is not left as a completed paid request");
});

test("a page without any usable link fails with a Chinese FetchError before paying for a model call", async () => {
  const draft = { id: ids.empty, config: { url: `${base}/empty`, prompt: "抽出列表" } } as unknown as SourceRow;
  await assert.rejects(fetchAiList(draft), (error) =>
    error instanceof FetchError && /页面上没有可用的链接/.test(error.message));
  const before = modelCalls.length;
  const result = await collectSource(ids.empty, { force: true });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /页面上没有可用的链接/);
  assert.equal(modelCalls.length, before, "no model call is made for an empty inventory");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE subject = ${`source:${ids.empty}`}`)[0]!.n, 0);
});
