import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { parseCatalog, SOURCE_IDS } from "../backend/adapters.ts";
import { collectCatalog, collectQueue, readCatalog, scheduleCollect } from "../backend/collect.ts";
import { installModules } from "@aihot/backend/modules";
import { fetchNow } from "@aihot/backend/admin/sources";
import module from "../server.ts";
import { processArticle, queueProcessing } from "@aihot/backend/jobs/content";
import { setVisibility } from "@aihot/backend/admin/content";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";

const teacher = { code: 0, data: { id: 44, name: "教师的AI辅助", sites: [
  { id: 1, name: "工具甲", tool_name: "制作课件", des: "把文档转成课件", url: "https://tools.example/one" },
  { id: 2, name: "工具乙", des: "辅助生成教案", url: "https://tools.example/two" },
] } };
const response = (data: unknown, status = 200) => async () => ({ status, url: "https://fixture.example", headers: new Headers(), body: Buffer.from(JSON.stringify(data)), truncated: false, text: () => JSON.stringify(data) });

before(async () => {
  for (const id of SOURCE_IDS) await sql`INSERT INTO sources (id, name, kind, participation_mode, interval_minutes) VALUES (${id}, ${id}, 'external', 'editorial', 1440) ON CONFLICT DO NOTHING`;
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
  assert.equal(forward[0]!.url, "https://original.example/news");
  assert.equal(forward[0]!.sourceMetadata!.itemUrl, "https://original.example/news");
  assert.equal(forward[0]!.publishedAt?.getTime(), 1793836800000);
  assert.equal((forward[0]!.raw as any).independentUrl, true);
  assert.equal(forward[1]!.url, "https://www.uisdc.com/news");
  assert.equal((forward[1]!.raw as any).independentUrl, false);
  assert.equal(forward[0]!.identityKey, parse([{ ...items[0], content: "无全文链接" }])[0]!.identityKey);
  assert.equal(parse([{ ...items[0], url: "https://publisher.example/story" }])[0]!.url, "https://publisher.example/story");
  assert.equal(parse([{ title: "无原文", content: "[[体验:https://tool.example/]][[全文:javascript:alert(1)]]" }])[0]!.url, "https://www.uisdc.com/news");
  assert.equal(forward[0]!.sourceMetadata!.originalUrl, "https://original.example/news");
  assert.deepEqual(forward[0]!.sourceMetadata!.tags, ["产品更新"]);
  assert.equal(forward[0]!.media!.length, 1);
});

test("news recollection replaces a catalog fallback without changing identity, analysis, time or withdrawal", async () => {
  const homepage = "https://www.uisdc.com/news";
  const data = { data: [{ id: 78, time: Math.floor(Date.now() / 1000) - 60, dubao: [
    { title: "公开新闻", content: "具体方法[[全文:https://original.example/public]]" },
    { title: "下架新闻", content: "具体方法[[全文:https://original.example/withdrawn]]" },
  ] }] };
  const ids: string[] = [];
  for (const item of parseCatalog("catalog-uisdc", JSON.stringify(data))) {
    const { articleId } = await upsertMaterial({ ...item, sourceId: "catalog-uisdc", via: "source-catalogs", url: homepage,
      sourceMetadata: { ...item.sourceMetadata!, itemUrl: homepage }, raw: { ...item.raw as object, independentUrl: false } });
    ids.push(articleId);
    await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,selected)
      VALUES (${articleId},1,'rule','pass','tip',${item.title},'具体方法',false)`;
    await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  }
  await setVisibility(ids[1]!, { visibility: "withdrawn", reason: "保留人工下架", version: 0 }, "test");
  const snapshot = async () => ({
    articles: await sql`SELECT id,identity_key,revision,content_hash,discovered_at,timeline_at,published_at,processing_state FROM articles WHERE id IN ${sql(ids)} ORDER BY id`,
    analyses: await sql`SELECT * FROM analyses WHERE article_id IN ${sql(ids)} ORDER BY id`,
    receipts: await sql`SELECT * FROM receipts ORDER BY id`,
    jobs: await sql`SELECT id FROM pgboss.job WHERE data->>'articleId' IN ${sql(ids)} ORDER BY id`,
  });
  await getBoss();
  const before = await snapshot();
  const result = await collectCatalog("catalog-uisdc", response(data));
  assert.equal(result.status, "ok");
  assert.equal(result.created, 0);
  assert.equal(result.revised, 0);
  assert.deepEqual(await snapshot(), before);
  for (const [index, id] of ids.entries()) {
    const [row] = await sql`SELECT a.url,a.raw,p.url AS published_url,p.visibility FROM articles a JOIN publications p ON p.article_id=a.id WHERE a.id=${id}`;
    const expected = index === 0 ? "https://original.example/public" : "https://original.example/withdrawn";
    assert.equal(row!.url, expected);
    assert.equal(row!.published_url, expected);
    assert.equal(row!.raw.sourceMetadata.itemUrl, expected);
    assert.equal(row!.raw.independentUrl, true);
    assert.equal(row!.visibility, index === 0 ? "public" : "withdrawn");
  }
  const publications = await sql`SELECT * FROM publications WHERE article_id IN ${sql(ids)} ORDER BY article_id`;
  await collectCatalog("catalog-uisdc", response(data));
  assert.deepEqual(await sql`SELECT * FROM publications WHERE article_id IN ${sql(ids)} ORDER BY article_id`, publications);
  assert.deepEqual(await snapshot(), before);
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

test("navigation blocks keep every category, first labels per resource and no invented dates", () => {
  const nav = `
    <div class="part-cat-block part-cat-block-ai"><h2 class="c-title" id="hot"><div class="l"><strong>热门推荐</strong></div><div class="r"></div></h2>
      <div class="c-content"><div class="c-loop c-loop-ai flex">
        <div class="part-item-website f-item p-item"><a class="f-box" href="https://jimeng.jianying.com/ai-tool/home" target="_blank">
          <h3 class="item-title"><i class="item-ico"><i class="thumb thumb-img">
            <img data-src="https://image.example/jimeng.webp" src="data:image/gif;base64,R0lGOD" alt="即梦">
          </i></i><strong class="title">  即梦  </strong></h3>
          <div class="item-desc">推荐！人人都能用的全能AI创意神器</div>
          <div class="item-tag"><span class="tag tag-1"> 推荐 </span><span class="tag tag-2">CN</span></div></a>
        </div>
        <div class="part-item-website f-item p-item"><a class="f-box" href="https://www.example.com/tool?utm_source=nav&amp;spm=home">
          <h3 class="item-title"><strong class="title">AI &amp; 设计  助手</strong></h3>
          <div class="item-desc">  批量
            处理图片  </div></a>
        </div>
      </div></div>
    </div>
    <div class="part-cat-block part-cat-block-ai"><h2 class="c-title" id="smart"><div class="l"><strong>AI绘画</strong></div><div class="r"></div></h2>
      <div class="c-content"><div class="c-loop c-loop-ai flex">
        <div class="part-item-website f-item p-item"><a class="f-box" href="https://example.com/tool/">
          <strong class="title">同一资源的另一个分类</strong><div class="item-desc">只保留第一次出现的分类</div>
          <div class="item-tag"><span class="tag tag-3">绘画</span></div></a>
        </div>
      </div></div>
    </div>`;
  const result = parseCatalog("catalog-uisdc-nav", nav);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(item => item.sourceMetadata!.categories), [["热门推荐"], ["热门推荐"]]);
  assert.deepEqual(result[0]!.sourceMetadata!.tags, ["推荐", "CN"]);
  assert.deepEqual(result[1]!.sourceMetadata!.tags, []);
  assert.equal(result[1]!.title, "AI & 设计 助手");
  assert.equal(result[1]!.excerpt, "批量 处理图片");
  assert.equal(result[1]!.url, "https://www.example.com/tool?utm_source=nav&spm=home");
  assert.equal(result[1]!.identityKey, "url:https://example.com/tool");
  assert.notEqual(result[0]!.identityKey, result[1]!.identityKey);
  assert.equal(result[0]!.sourceMetadata!.iconUrl, "https://image.example/jimeng.webp");
  assert.equal(result[0]!.sourceMetadata!.coverUrl, "https://image.example/jimeng.webp");
  assert.equal(result[0]!.sourceMetadata!.catalogUrl, "https://hao.uisdc.com/ai/");
  assert.equal(result[0]!.media!.length, 1);
  assert.equal(result[0]!.publishedAt, null);
  assert.equal(result[0]!.undatedPolicy, "discovery");
  assert.equal((result[0]!.raw as any).contentKind, "tool-directory");
  assert.equal((result[0]!.raw as any).blockId, "hot");
  assert.equal((result[0]!.raw as any).blockName, "热门推荐");
  assert.equal((result[0]!.raw as any).groupId, 0);
  assert.match((result[0]!.raw as any).externalId, /^[0-9a-f]{64}$/);
  assert.notEqual((result[0]!.raw as any).externalId, (result[1]!.raw as any).externalId);
  assert.equal((result[0]!.raw as any).publicationTimeKnown, false);
  assert.throws(() => parseCatalog("catalog-uisdc-nav", "<html><body>改版</body></html>"), /为空或页面结构变化/);
});

test("navigation reader identifies itself as a browser instead of a bare client", async () => {
  const html = `<div class="part-cat-block"><h2 class="c-title" id="hot"><div class="l"><strong>热门推荐</strong></div></h2>
    <div class="part-item-website"><a class="f-box" href="https://example.com/tool"><strong class="title">工具</strong><div class="item-desc">简介</div></a></div></div>`;
  let request: { url: string; options: { headers?: Record<string, string> } } | null = null;
  const items = await readCatalog("catalog-uisdc-nav", async (url, options) => {
    request = { url, options };
    return { status: 200, url, headers: new Headers(), body: Buffer.from(html), truncated: false, text: () => html };
  });
  assert.equal(items.length, 1);
  assert.equal(request!.url, "https://hao.uisdc.com/ai/");
  assert.match(request!.options.headers!["user-agent"]!, /^Mozilla\/5\.0/);
  assert.match(request!.options.headers!.accept!, /^text\/html/);
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

test("topic collection publishes new and revised cards without paid analysis or grouping and keeps withdrawals", async () => {
  const pack = { code: 0, data: { list: [{ id: "directory-new", name: "新专题", des: "简短简介" }, { id: "directory-bare", name: "只有名称" }] } };
  const before = await sql`SELECT * FROM receipts ORDER BY id`;
  const initial = await collectCatalog("catalog-360-topics", response(pack));
  assert.equal(initial.status, "ok");
  assert.equal(initial.created, 2);
  const rows = await sql`SELECT a.id,a.revision,a.discovered_at,a.timeline_at,a.processing_state,p.visibility,p.title,p.summary,p.selected
    FROM articles a JOIN publications p ON p.article_id=a.id WHERE a.source_id='catalog-360-topics' ORDER BY a.id`;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.processing_state === "skipped" && row.visibility === "public" && !row.selected));
  const card = rows.find(row => row.title === "新专题")!;
  assert.equal(card.summary, "简短简介");
  assert.equal((await sql`SELECT count(*) AS n FROM analyses WHERE article_id IN ${sql(rows.map(row => row.id))}`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*) AS n FROM pgboss.job WHERE name IN ('content.analyze','content.extract-body','events.group')
    AND data->>'articleId' IN ${sql(rows.map(row => row.id))}`)[0]!.n, 0);
  assert.deepEqual(await processArticle(card.id, { attemptTag: "old-queued-analysis" }), { state: "skipped" });
  assert.equal(await queueProcessing(card.id, { step: "extract" }), null);
  await collectCatalog("catalog-360-topics", response(pack));
  const [repeat] = await sql`SELECT discovered_at,timeline_at FROM articles WHERE id=${card.id}`;
  assert.deepEqual(repeat, { discovered_at: card.discovered_at, timeline_at: card.timeline_at });
  const revised = { ...pack, data: { list: [{ ...pack.data.list[0], name: "新专题已更新", des: "更新简介" }] } };
  assert.equal((await collectCatalog("catalog-360-topics", response(revised))).revised, 1);
  assert.equal((await sql`SELECT title FROM publications WHERE article_id=${card.id}`)[0]!.title, "新专题已更新");
  await setVisibility(card.id, { visibility: "withdrawn", reason: "人工下架", version: 0 }, "test");
  revised.data.list[0]!.des = "再次更新";
  await collectCatalog("catalog-360-topics", response(revised));
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${card.id}`)[0]!.visibility, "withdrawn");
  assert.deepEqual(await sql`SELECT * FROM receipts ORDER BY id`, before);
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

test("paused sources and collection valve stay closed; tutorials enter editorial review", async () => {
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
  const tutorial = await collectCatalog("catalog-aihot-tip", response({ items: [
    { id: "review-tutorial", category: "tip", title: "教学教程", summary: "教学应用方法", links: { aihot: "https://aihot.news/items/review-tutorial", original: "https://original.example/tutorial" } },
  ] }));
  assert.equal(tutorial.created, 1);
  const [pending] = await sql`SELECT a.processing_state,p.visibility FROM articles a LEFT JOIN publications p ON p.article_id=a.id WHERE a.source_id='catalog-aihot-tip'`;
  assert.equal(pending!.processing_state, "new");
  assert.notEqual(pending!.visibility, "public");
  installModules([module]);
  assert.deepEqual(await fetchNow("catalog-aibase", "test-admin"), { jobId: null });
  assert.equal((await collectCatalog("unrelated-external-source", neverRead)).status, "unmanaged");
});
