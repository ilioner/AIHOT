import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { parseCatalog, SOURCE_IDS } from "../backend/adapters.ts";
import { collectCatalog, collectQueue, scheduleCollect } from "../backend/collect.ts";
import { installModules } from "@aihot/backend/modules";
import { fetchNow } from "@aihot/backend/admin/sources";
import module from "../server.ts";

const teacher = { code: 0, data: { id: 44, name: "教师的AI辅助", sites: [
  { id: 1, name: "工具甲", tool_name: "制作课件", des: "把文档转成课件", url: "https://tools.example/one" },
  { id: 2, name: "工具乙", des: "辅助生成教案", url: "https://tools.example/two" },
] } };
const response = (data: unknown, status = 200) => async () => ({ status, url: "https://fixture.example", headers: new Headers(), body: Buffer.from(JSON.stringify(data)), truncated: false, text: () => JSON.stringify(data) });

before(async () => {
  for (const id of SOURCE_IDS) await sql`INSERT INTO sources (id, name, kind, participation_mode, interval_minutes) VALUES (${id}, ${id}, 'external', ${id === "catalog-aihot-tip" ? "isolated" : "editorial"}, 1440) ON CONFLICT DO NOTHING`;
});
after(async () => { installModules([]); await stopBoss(); await closeDb(); });

test("daily packs expand every item, inherit time, and keep identities on reorder", () => {
  const items = [{ title: "新闻甲", content: "甲的内容[[全文:https://original.example/news]]", url: "", tag: "产品更新", images: "||https://image.example/a.webp|javascript:alert(1)|https://image.example/a.webp|" }, { title: "新闻乙", content: "乙的内容", url: "" }];
  const parse = (dubao: unknown[]) => parseCatalog("catalog-uisdc", JSON.stringify({ data: [{ id: 77, time: 1793836800, dubao }] }));
  const forward = parse(items);
  const reversed = parse([...items].reverse());
  assert.equal(forward.length, 2);
  assert.notEqual(forward[0]!.identityKey, forward[1]!.identityKey);
  assert.equal(forward[0]!.identityKey, reversed[1]!.identityKey);
  assert.equal(forward[0]!.url, "https://www.uisdc.com/news");
  assert.equal(forward[0]!.publishedAt?.getTime(), 1793836800000);
  assert.equal((forward[0]!.raw as any).independentUrl, false);
  assert.equal(forward[0]!.sourceMetadata!.originalUrl, "https://original.example/news");
  assert.deepEqual(forward[0]!.sourceMetadata!.tags, ["产品更新"]);
  assert.equal(forward[0]!.media!.length, 1);
});

test("hash topics stay separate and overlapping products converge across topics", () => {
  const topics = parseCatalog("catalog-360-topics", JSON.stringify({ code: 0, data: { list: [{ id: 38, name: "办公工具" }, { id: 40, name: "教学工具" }] } }));
  assert.notEqual(topics[0]!.identityKey, topics[1]!.identityKey);
  assert.ok(topics[0]!.url.includes("#/subjectdetail?id=38"));
  const first = parseCatalog("catalog-360-teacher", JSON.stringify(teacher));
  const other = parseCatalog("catalog-360-student", JSON.stringify({ ...teacher, data: { ...teacher.data, id: 45 } }));
  assert.equal(first[0]!.identityKey, other[0]!.identityKey);
  assert.equal(first[0]!.publishedAt, null);
});

test("product cards are mapped without inventing publication dates", () => {
  const result = parseCatalog("catalog-aibase", '<a href="/zh/details/42"><img src="https://image.example/tool.png"><div class="truncate1">AI 课件工具</div><div class="truncate2">文档转课件</div><span class="activeColor">课件生成</span></a>');
  assert.equal(result[0]!.title, "AI 课件工具");
  assert.equal(result[0]!.publishedAt, null);
  assert.equal(result[0]!.undatedPolicy, "discovery");
  assert.deepEqual(result[0]!.sourceMetadata!.categories, ["课件生成"]);
  assert.equal(result[0]!.sourceMetadata!.coverUrl, "https://image.example/tool.png");
  assert.throws(() => parseCatalog("catalog-aibase", "<html>请稍后再试</html>"), /卡片为空/);
});

test("tutorial feed retains attribution and only the requested category", () => {
  const result = parseCatalog("catalog-aihot-tip", JSON.stringify({ items: [
    { id: "a", category: "tip", title: "教程", originalTitle: "Tutorial", summary: "方法", links: { aihot: "https://aihot.news/items/a", original: "https://original.example/a" }, attribution: { name: "AIHOT" } },
    { id: "b", category: "industry", title: "不属于教程" },
  ] }));
  assert.equal(result.length, 1);
  assert.equal((result[0]!.raw as any).attribution.name, "AIHOT");
  assert.equal((result[0]!.raw as any).originalUrl, "https://original.example/a");
  assert.equal(result[0]!.sourceMetadata!.originalTitle, "Tutorial");
  assert.deepEqual(result[0]!.sourceMetadata!.categories, ["tip"]);
});

test("collection persists first observation without time bumps or cross-topic duplicates", async () => {
  const initial = await collectCatalog("catalog-360-teacher", response(teacher));
  assert.equal(initial.created, 2);
  const beforeRows = await sql`SELECT id, published_at, discovered_at, timeline_at, revision, backfill FROM articles WHERE identity_key LIKE '360-tool:%' ORDER BY id`;
  assert.ok(beforeRows.every(row => row.published_at === null && !row.backfill && row.discovered_at.getTime() === row.timeline_at.getTime()));
  const repeat = await collectCatalog("catalog-360-teacher", response(teacher));
  assert.equal(repeat.created, 0);
  assert.equal(repeat.revised, 0);
  const student = await collectCatalog("catalog-360-student", response(teacher));
  assert.equal(student.created, 0);
  const afterRows = await sql`SELECT id, published_at, discovered_at, timeline_at, revision, backfill FROM articles WHERE identity_key LIKE '360-tool:%' ORDER BY id`;
  assert.deepEqual(afterRows, beforeRows);
  const enriched = { ...teacher, data: { ...teacher.data, sites: teacher.data.sites.map(tool => ({ ...tool, img: "https://image.example/tool.png", level0_word: "AI工具", level1_word: "教学" })) } };
  assert.equal((await collectCatalog("catalog-360-teacher", response(enriched))).revised, 0);
  const [stored] = await sql`SELECT raw->'sourceMetadata' AS metadata,media FROM articles WHERE identity_key='360-tool:1'`;
  assert.deepEqual(stored!.metadata.categories, ["AI工具", "教学"]);
  assert.equal(stored!.media[0].url, "https://image.example/tool.png");
  const discoveries = await sql`SELECT source_id FROM article_discoveries WHERE source_id IN ('catalog-360-teacher', 'catalog-360-student')`;
  assert.equal(discoveries.length, 4);
});

test("failures remain visible and defer the next scheduled request", async () => {
  const result = await collectCatalog("catalog-360-topics", response({ code: 429, msg: "限流" }));
  assert.equal(result.status, "failed");
  const [source] = await sql`SELECT last_error, fail_count, next_fetch_at > now() AS deferred FROM sources WHERE id = 'catalog-360-topics'`;
  assert.match(source!.last_error, /429/);
  assert.ok(source!.deferred);
  assert.equal(source!.fail_count, 1);
  assert.throws(() => parseCatalog("catalog-uisdc", '{"data":[{"id":1,"time":100}]}'), /dubao/);
  assert.throws(() => parseCatalog("catalog-uisdc", JSON.stringify({ data: [{ id: 1, time: 1e20, dubao: [{ title: "日期损坏" }] }] })), /日期无效/);
});

test("paused sources, collection valve and unauthorized tutorial publication stay closed", async () => {
  await sql`UPDATE sources SET enabled = false WHERE id = 'catalog-aibase'`;
  const neverRead = async (): Promise<never> => { throw new Error("must not fetch"); };
  assert.equal((await collectCatalog("catalog-aibase", neverRead)).status, "paused");
  const previous = process.env.COLLECT_ENABLED;
  process.env.COLLECT_ENABLED = "false";
  try {
    assert.deepEqual(await scheduleCollect(), { enqueued: 0 });
    const before = await sql`SELECT count(*) FROM fetch_runs`;
    await collectQueue.run([{ sourceId: "catalog-360-teacher" }]);
    assert.deepEqual(await sql`SELECT count(*) FROM fetch_runs`, before);
  } finally {
    if (previous === undefined) delete process.env.COLLECT_ENABLED;
    else process.env.COLLECT_ENABLED = previous;
  }
  await sql`UPDATE sources SET participation_mode = 'editorial' WHERE id = 'catalog-aihot-tip'`;
  await assert.rejects(() => collectCatalog("catalog-aihot-tip", neverRead), /isolated/);
  installModules([module]);
  assert.deepEqual(await fetchNow("catalog-aibase", "test-admin"), { jobId: null });
  assert.equal((await collectCatalog("unrelated-external-source", neverRead)).status, "unmanaged");
});
