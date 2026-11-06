import { createHmac } from "node:crypto";
import { config } from "@aihot/backend/config";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { createSource, updateSource } from "@aihot/backend/admin/sources";
import { contentChain, searchContent, overrideFields, rerun, setSeoIndexed, setVisibility } from "@aihot/backend/admin/content";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { getBoss, stopBoss, QUEUES } from "@aihot/backend/jobs/queue";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { sha256 } from "@aihot/backend/lib/ids";
import { buildApp } from "../apps/api/src/app.ts";
import { DEFAULT_CATEGORIES } from "@aihot/contracts/taxonomy";
import { updateCategories } from "@aihot/backend/admin/settings";
import { loadCategories } from "@aihot/backend/taxonomy";
import { previewSourcePrefilter, requeueSourcePrefilter } from "@aihot/backend/admin/source-prefilter";

const T = tag();
const sourceId = `admin-${T}`;
await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${sourceId}, 'Admin review', 'rss', 'T1')`;
const app = await buildApp();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

async function article() {
  return (await upsertMaterial({ sourceId, url: `https://example.com/${tag()}`, title: "审查材料", bodyText: "正文", bodyStatus: "ok", via: "fetch", publishedAt: new Date() })).articleId;
}

test("source-policy backfill is scoped, skips busy jobs, preserves evidence and withdrawal, and queues once", async () => {
  const direct = ["weblist-aixzd-tools", "catalog-aihot-tip", "catalog-aibase", "catalog-360-student", "catalog-360-teacher"];
  const accepted: string[] = [];
  for (const source of direct) {
    await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES (${source},${source},'rss','T2','editorial')`;
    for (const label of ["UNKNOWN", "BLOCK"]) {
      const id = await article();
      await sql`UPDATE articles SET source_id=${source},processing_state='blocked' WHERE id=${id}`;
      await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,output)
        VALUES (${id},1,'model','block',${sql.json({ prefilter: { label, reason: "旧规则" } })})`;
      accepted.push(id);
    }
  }
  const busy = accepted.pop()!;
  await queueProcessing(busy, { step: "analyze" });
  const withdrawn = accepted[0]!;
  await publishArticle(withdrawn);
  await setVisibility(withdrawn, { visibility: "withdrawn", version: 0, reason: "不要解除人工下架" }, "test");
  const excluded: string[] = [];
  await sql`INSERT INTO sources (id,name,kind,participation_mode) VALUES ('catalog-360-topics','360 专题','external','editorial')`;
  for (const mode of ["other", "stale", "passed", "processed", "directory"]) {
    const id = await article();
    await sql`UPDATE articles SET source_id=${mode === "other" ? sourceId : mode === "directory" ? "catalog-360-topics" : direct[0]!},processing_state='blocked',revision=${mode === "stale" ? 2 : 1} WHERE id=${id}`;
    await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,output)
      VALUES (${id},1,'model','block',${sql.json({ prefilter: { label: mode === "passed" ? "PASS" : "UNKNOWN" }, ...(mode === "processed" ? { sourcePrefilter: { sourceId: direct[0], revision: 1 } } : {}) })})`;
    excluded.push(id);
  }
  const evidence = await sql`SELECT * FROM analyses ORDER BY id`;
  const preview = await previewSourcePrefilter();
  assert.deepEqual(preview.map(entry => entry.articleId).sort(), accepted.slice().sort());
  const applied = await requeueSourcePrefilter(preview, "test", "使用者批准六个来源预筛直通");
  assert.equal(applied.filter(entry => entry.status === "queued").length, accepted.length);
  assert.equal((await previewSourcePrefilter()).length, 0);
  const replay = await requeueSourcePrefilter(preview, "test", "重试不重复投递");
  assert.ok(replay.every(entry => entry.status === "skipped"));
  assert.deepEqual(await sql`SELECT * FROM analyses ORDER BY id`, evidence);
  assert.equal((await sql`SELECT visibility FROM editorial_overrides WHERE article_id=${withdrawn}`)[0]!.visibility, "withdrawn");
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${withdrawn}`)[0]!.visibility, "withdrawn");
  for (const id of accepted) {
    assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${id}`)[0]!.processing_state, "new");
    assert.equal((await sql`SELECT count(*)::int AS count FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${id}`)[0]!.count, 1);
    assert.equal((await sql`SELECT count(*)::int AS count FROM audit_log WHERE action='content.source-prefilter' AND subject=${`content:${id}`}`)[0]!.count, 1);
  }
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${busy}`)[0]!.processing_state, "blocked");
  for (const id of excluded) assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE data->>'articleId'=${id}`).length, 0);
});

test("source backfill rechecks a changed revision and rolls back state, publication and jobs when auditing fails", async () => {
  const ids = [await article(), await article()];
  for (const id of ids) {
    await sql`UPDATE articles SET source_id='catalog-aihot-tip',processing_state='blocked' WHERE id=${id}`;
    await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,output)
      VALUES (${id},1,'model','block','{"prefilter":{"label":"UNKNOWN"}}')`;
    await publishArticle(id);
  }
  const preview = (await previewSourcePrefilter()).filter(entry => ids.includes(entry.articleId));
  await sql`UPDATE articles SET revision=2 WHERE id=${ids[0]!}`;
  const before = (await sql`SELECT * FROM publications WHERE article_id=${ids[1]!}`)[0]!;
  await sql`CREATE FUNCTION reject_source_prefilter_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action='content.source-prefilter' THEN RAISE EXCEPTION 'test audit failure'; END IF;
      RETURN NEW;
    END $$`;
  await sql`CREATE TRIGGER reject_source_prefilter_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_source_prefilter_audit()`;
  try {
    const result = await requeueSourcePrefilter(preview, "test", "验证失败不误报成功");
    assert.equal(result.find(entry => entry.articleId === ids[0])!.status, "skipped");
    assert.equal(result.find(entry => entry.articleId === ids[1])!.status, "failed");
    assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${ids[1]!}`)[0]!.processing_state, "blocked");
    assert.deepEqual((await sql`SELECT * FROM publications WHERE article_id=${ids[1]!}`)[0], before);
    assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE data->>'articleId'=${ids[1]!}`).length, 0);
  } finally {
    await sql`DROP TRIGGER reject_source_prefilter_audit ON audit_log`;
    await sql`DROP FUNCTION reject_source_prefilter_audit()`;
    await sql`UPDATE articles SET revision=2 WHERE id=${ids[1]!}`;
  }
});

test("admin status distinguishes waiting, failures, rule blocks and manual withdrawal", async () => {
  const id = await article();
  assert.equal((await contentChain(id))!.article.status_reason, "待分析");
  await sql`UPDATE articles SET processing_state='failed' WHERE id=${id}`;
  assert.equal((await searchContent(id))[0]!.status_reason, "分析失败");
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,tags,selected)
    VALUES (${id},1,'rule','block',ARRAY['其他'],false)`;
  await sql`UPDATE articles SET processing_state='blocked' WHERE id=${id}`;
  await publishArticle(id);
  assert.equal((await contentChain(id))!.article.status_reason, "规则拦截");
  await setVisibility(id, { visibility: "withdrawn", version: 0, reason: "人工审核撤下" }, "test");
  assert.equal((await searchContent(id))[0]!.status_reason, "人工下架");
});

test("only analyzed passing content is public, even without a summary or source publication date", async () => {
  const id = await article();
  await sql`UPDATE articles SET processing_state='analyzed',body_status='unconfirmed' WHERE id=${id}`;
  await publishArticle(id);
  assert.equal((await contentChain(id))!.publication!.visibility, "withdrawn");
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,summary_zh,selected)
    VALUES (${id},1,'rule','pass',NULL,false)`;
  await sql`UPDATE articles SET published_at=NULL,backfill=true WHERE id=${id}`;
  await publishArticle(id);
  assert.equal((await contentChain(id))!.article.status_reason, "公开");
  await sql`UPDATE articles SET body_status='ok' WHERE id=${id}`;
  assert.equal((await searchContent(id))[0]!.status_reason, "公开");
});

test("ineffective publication commands return conflicts without saving overrides, indexing marks or successful audits", async () => {
  const headers = await adminHeaders();
  for (const label of ["UNKNOWN", "BLOCK"]) {
    const id = await article();
    await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,summary_zh,selected,output)
      VALUES (${id},1,'model','block','已有摘要',false,${sql.json({ prefilter: { label }, writer: "summarize" })})`;
    await sql`UPDATE articles SET processing_state='blocked' WHERE id=${id}`;
    await publishArticle(id);
    const [before] = await sql`SELECT * FROM publications WHERE article_id=${id}`;
    for (const [command, payload] of [
      ["visibility", { visibility: "public", version: 0, reason: "尝试公开" }],
      ["visibility", { visibility: "summary-only", version: 0, reason: "尝试仅摘要" }],
      ["seo", { indexed: true, reason: "尝试收录" }],
      ["override", { fields: { category: "tip", selected: true }, version: 0, reason: "尝试强制精选" }],
    ] as const) {
      const response = await app.inject({ method: "POST", url: `/api/admin/content/${id}/${command}`, headers, payload });
      assert.equal(response.statusCode, 409, response.body);
      assert.ok(response.json().detail.includes(label), response.body);
      assert.deepEqual((await sql`SELECT * FROM publications WHERE article_id=${id}`)[0], before);
      assert.equal((await sql`SELECT 1 FROM editorial_overrides WHERE article_id=${id}`).length, 0);
      assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${id}`}`).length, 0);
    }
    await overrideFields(id, { fields: { category: "tip", title: "已保存但未公开的标题" }, version: 0, reason: "只校正内容" }, "test");
    const chain = (await contentChain(id))!;
    assert.equal(chain.override!.fields.title, "已保存但未公开的标题");
    assert.equal(chain.publication!.title, "已保存但未公开的标题");
    assert.equal(chain.publication!.visibility, "withdrawn");
    await sql`UPDATE editorial_overrides SET fields=fields || '{"selected":true}'::jsonb WHERE article_id=${id}`;
    await overrideFields(id, { fields: { title: "保留旧精选意图的普通修正" }, version: 1, reason: "不重新要求强制精选" }, "test");
    const retained = (await contentChain(id))!;
    assert.equal(retained.override!.fields.selected, true);
    assert.equal(retained.publication!.title, "保留旧精选意图的普通修正");
    assert.equal(retained.publication!.visibility, "withdrawn");
    assert.equal(retained.publication!.selected, false);
  }
});

test("indexing requires a public editorial page with a summary, while queued selection is saved without claiming admission", async () => {
  const id = await article();
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,selected) VALUES (${id},1,'rule','pass',false)`;
  await publishArticle(id);
  await assert.rejects(setSeoIndexed(id, { indexed: true, reason: "无摘要" }, "test"), { code: "conflict" });
  assert.equal((await sql`SELECT seo_indexed_at FROM publications WHERE article_id=${id}`)[0]!.seo_indexed_at, null);
  await sql`UPDATE analyses SET summary_zh='可阅读摘要' WHERE article_id=${id}`;
  await publishArticle(id);
  const correction = await overrideFields(id, { fields: { selected: true }, version: 0, reason: "等待归组" }, "test");
  assert.equal(correction!.selected, false);
  assert.equal((await sql`SELECT selection_candidate FROM publications WHERE article_id=${id}`)[0]!.selection_candidate, true);
  await setVisibility(id, { visibility: "withdrawn", version: 1, reason: "人工下架" }, "test");
  await assert.rejects(setSeoIndexed(id, { indexed: true, reason: "下架不能收录" }, "test"), { code: "conflict" });
  await assert.rejects(overrideFields(id, { fields: { selected: true }, version: 2, reason: "下架不能强制精选" }, "test"), { code: "conflict" });
  await setVisibility(id, { visibility: "public", version: 2, reason: "恢复公开" }, "test");
  await setSeoIndexed(id, { indexed: true, reason: "恢复后收录" }, "test");
  assert.equal((await sql`SELECT indexable FROM publications WHERE article_id=${id}`)[0]!.indexable, true);
});

test("UNKNOWN bulk review previews a fixed scope, records manual PASS without publishing, and replays exactly once", async () => {
  const headers = await adminHeaders();
  const id = await article();
  await sql`UPDATE articles SET title=${`bulk-${T}`},processing_state='blocked' WHERE id=${id}`;
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,output)
    VALUES (${id},1,'model','block','{"prefilter":{"label":"UNKNOWN","reason":"证据不确定"}}')`;
  await publishArticle(id);
  const listed = await app.inject({ method: "GET", url: `/api/admin/content?prefilter=UNKNOWN&q=bulk-${T}`, headers });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().rows[0].prefilter_label, "UNKNOWN");
  const preview = await app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass/preview", headers,
    payload: { q: `bulk-${T}`, all: true } });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().total, 1);
  const payload = { token: preview.json().token, reason: "已核对原文，属于可复现的 AI 实践" };
  const anonymous = await app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass", payload });
  assert.equal(anonymous.statusCode, 401);
  const denied = await app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass", headers: { cookie: headers.cookie }, payload });
  assert.equal(denied.statusCode, 403);
  const submit = () => app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass", headers, payload });
  const applied = await submit();
  assert.equal(applied.statusCode, 200, applied.body);
  assert.deepEqual([applied.json().succeeded, applied.json().skipped, applied.json().failed], [1, 0, 0]);
  assert.deepEqual((await submit()).json(), applied.json());
  const changedReason = await app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass", headers,
    payload: { ...payload, reason: "重复请求不可更改理由" } });
  assert.equal(changedReason.statusCode, 409);
  const chain = (await contentChain(id))!;
  assert.equal(chain.override!.fields.manualPrefilter && (chain.override!.fields.manualPrefilter as Record<string, unknown>).revision, 1);
  assert.equal(chain.article.processing_state, "new");
  assert.equal(chain.publication!.visibility, "withdrawn");
  assert.equal((await sql`SELECT output->'prefilter'->>'label' AS label FROM analyses WHERE article_id=${id}`)[0]!.label, "UNKNOWN");
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${id}`} AND action='content.prefilter-pass'`).length, 1);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name='content.analyze' AND data->>'articleId'=${id}`).length, 1);
  await assert.rejects(overrideFields(id, { fields: {}, clear: ["manualPrefilter"], reason: "不能经普通修正篡改", version: 1 }, "test"));
});

test("bulk review skips changed items and never includes later arrivals or BLOCK", async () => {
  const headers = { ...await adminHeaders(), "idempotency-key": `changed-${T}` };
  const ids = [await article(), await article(), await article()];
  for (const id of ids) {
    await sql`UPDATE articles SET title=${`changed-${T}`},processing_state='blocked' WHERE id=${id}`;
    await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,output)
      VALUES (${id},1,'model','block','{"prefilter":{"label":"UNKNOWN"}}')`;
  }
  const preview = await app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass/preview", headers, payload: { all: true, q: `changed-${T}` } });
  assert.equal(preview.statusCode, 200, preview.body);
  await sql`UPDATE articles SET revision=2 WHERE id=${ids[0]!}`;
  await sql`UPDATE articles SET processing_state='new' WHERE id=${ids[1]!}`;
  const busyJob = await queueProcessing(ids[2]!, { step: "analyze", attemptTag: `already-queued-${T}` });
  assert.ok(busyJob);
  const later = await article();
  await sql`UPDATE articles SET title=${`changed-${T}`},processing_state='blocked' WHERE id=${later}`;
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,output)
    VALUES (${later},1,'model','block','{"prefilter":{"label":"UNKNOWN"}}')`;
  const response = await app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass", headers,
    payload: { token: preview.json().token, reason: "核对批次" } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual([response.json().succeeded, response.json().skipped, response.json().failed], [0, 3, 0]);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${ids[2]!}`).length, 1);
  assert.equal((await sql`SELECT 1 FROM editorial_overrides WHERE article_id=${later}`).length, 0);
  await sql`UPDATE analyses SET output='{"prefilter":{"label":"BLOCK"}}' WHERE article_id=${later}`;
  const blocked = await app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass/preview", headers, payload: { ids: [later] } });
  assert.equal(blocked.statusCode, 200, blocked.body);
  assert.equal(blocked.json().eligible, 0);
});

test("bulk review returns individual failures and rolls their writes back without losing successful items", async () => {
  const headers = { ...await adminHeaders(), "idempotency-key": `partial-${T}` };
  const ids = [await article(), await article()];
  for (const id of ids) {
    await sql`UPDATE articles SET processing_state='blocked' WHERE id=${id}`;
    await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,output)
      VALUES (${id},1,'model','block','{"prefilter":{"label":"UNKNOWN"}}')`;
  }
  await sql.unsafe(`CREATE FUNCTION refuse_prefilter_override() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.article_id = '${ids[1]}' THEN RAISE EXCEPTION 'refuse review'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER refuse_prefilter_override BEFORE INSERT ON editorial_overrides FOR EACH ROW EXECUTE FUNCTION refuse_prefilter_override()");
  try {
    const preview = await app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass/preview", headers, payload: { ids } });
    const response = await app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass", headers,
      payload: { token: preview.json().token, reason: "人工核验" } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual([response.json().succeeded, response.json().skipped, response.json().failed], [1, 0, 1]);
    assert.equal((await contentChain(ids[0]!))!.article.processing_state, "new");
    assert.equal((await contentChain(ids[1]!))!.override, null);
    assert.equal((await contentChain(ids[1]!))!.article.processing_state, "blocked");
    assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE data->>'articleId'=${ids[1]!}`).length, 0);
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${ids[1]}`} AND action='content.prefilter-pass'`).length, 0);
  } finally { await sql.unsafe("DROP TRIGGER refuse_prefilter_override ON editorial_overrides; DROP FUNCTION refuse_prefilter_override()"); }
});

test("UNKNOWN filtering paginates raw prefilter decisions and previews every matching page, not final unknown", async () => {
  const headers = await adminHeaders();
  for (let index = 0; index < 52; index++) {
    const id = await article();
    await sql`UPDATE articles SET title=${`paged-${T}`},processing_state='blocked' WHERE id=${id}`;
    await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,output)
      VALUES (${id},1,'model','block','{"prefilter":{"label":"UNKNOWN"}}')`;
  }
  const finalUnknown = await article();
  await sql`UPDATE articles SET title=${`paged-${T}`},processing_state='analyzed' WHERE id=${finalUnknown}`;
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,output)
    VALUES (${finalUnknown},1,'model','unknown','{"prefilter":{"label":"PASS"},"writer":"none"}')`;
  for (const [page, count] of [[1, 50], [2, 2]]) {
    const response = await app.inject({ method: "GET", url: `/api/admin/content?q=paged-${T}&prefilter=UNKNOWN&page=${page}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().rows.length, count);
    assert.equal(response.json().total, 52);
    assert.ok(!response.json().rows.some((row: { id: string }) => row.id === finalUnknown));
  }
  const preview = await app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass/preview", headers, payload: { all: true, q: `paged-${T}` } });
  assert.equal(preview.json().total, 52);
  assert.equal(preview.json().eligible, 52);
  const invalid = await app.inject({ method: "POST", url: "/api/admin/content/prefilter-pass", headers,
    payload: { token: `${preview.json().token}x`, reason: "禁止篡改范围" } });
  assert.equal(invalid.statusCode, 409);
});

test("concurrent source intake creates one source for the same feed", async () => {
  const blocker = await sql.reserve();
  await blocker`BEGIN`;
  await blocker`LOCK TABLE sources IN SHARE MODE`;
  const pending = Promise.all(Array.from({ length: 4 }, (_, i) => createSource({
    id: `intake-${T}-${i}`, name: "Same feed", kind: "rss", config: { feedUrl: `https://example.com/feed-${T}` },
  }, "test")));
  try {
    // Hold inserts until all four requests have reached a lock: reproduce simultaneous clicks,
    // independently of how quickly the database happens to execute their duplicate checks.
    for (let i = 0; ; i++) {
      const [waiting] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (waiting!.n === 4) break;
      assert.ok(i < 200, "all concurrent requests reached the database");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await blocker`ROLLBACK`;
    blocker.release();
  }
  const results = await pending;
  assert.equal(results.filter((r) => r.created).length, 1);
  const created = results.find((r) => r.created)!;
  assert.ok(created.created);
  for (const result of results) if (!result.created) assert.equal(result.duplicate.id, created.source.id);
});

test("a source transaction rolled back at commit leaves no successful audit entry", async () => {
  await sql.unsafe(`CREATE FUNCTION refuse_admin_source_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.name = 'refuse-admin-commit' THEN RAISE EXCEPTION 'refused at commit'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE CONSTRAINT TRIGGER refuse_admin_source_commit AFTER UPDATE ON sources
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_admin_source_commit()`);
  try {
    const [before] = await sql`SELECT updated_at FROM sources WHERE id = ${sourceId}`;
    await assert.rejects(updateSource(sourceId, { patch: { name: "refuse-admin-commit" }, version: (before!.updated_at as Date).toISOString() }, "test-rollback"), /refused at commit/);
    const rows = await sql`SELECT 1 FROM audit_log WHERE actor = 'test-rollback'`;
    assert.equal(rows.length, 0);
  } finally {
    await sql.unsafe("DROP TRIGGER refuse_admin_source_commit ON sources; DROP FUNCTION refuse_admin_source_commit()");
  }
});

test("content corrections, public projection and audit either commit together or remain retryable", async () => {
  const id = await article();
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,selected) VALUES (${id},1,'rule','pass',false)`;
  await publishArticle(id);
  await sql.unsafe(`CREATE FUNCTION refuse_admin_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.actor = 'test-refuse-audit' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER refuse_admin_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_admin_audit()");
  try {
    for (const write of [
      () => overrideFields(id, { fields: { title: "更正标题" }, version: 0, reason: "校正" }, "test-refuse-audit"),
      () => setVisibility(id, { visibility: "withdrawn", version: 0, reason: "校正" }, "test-refuse-audit"),
    ]) {
      await assert.rejects(write(), /audit unavailable/);
      assert.equal((await sql`SELECT 1 FROM editorial_overrides WHERE article_id = ${id}`).length, 0);
      const [p] = await sql`SELECT title, visibility FROM publications WHERE article_id = ${id}`;
      assert.equal(p!.title, "审查材料");
      assert.equal(p!.visibility, "public");
    }
  } finally {
    await sql.unsafe("DROP TRIGGER refuse_admin_audit ON audit_log; DROP FUNCTION refuse_admin_audit()");
  }
  await overrideFields(id, { fields: { title: "更正标题" }, version: 0, reason: "校正" }, "test");
  await assert.rejects(setVisibility(id, { visibility: "withdrawn", version: 0, reason: "过期页面" }, "test"), { code: "conflict" });
  const [p] = await sql`SELECT title, visibility FROM publications WHERE article_id = ${id}`;
  assert.equal(p!.title, "更正标题");
  assert.equal(p!.visibility, "public");
});

test("repeating a completed command returns its job without resetting newer processing or a manual detach", async () => {
  await getBoss();
  for (const step of ["analyze", "extract", "group"] as const) {
    const id = await article();
    const key = `request-${step}-${T}`;
    const first = await rerun(id, step, key, "test");
    assert.ok(first?.jobId);
    await sql`UPDATE pgboss.job SET state = 'completed', completed_on = now() WHERE id = ${first.jobId}`;
    await sql`UPDATE articles SET processing_state = 'analyzed', revision = revision + 1 WHERE id = ${id}`;
    await sql`INSERT INTO grouping_overrides (article_id, reason, actor) VALUES (${id}, 'later manual detach', 'test')`;
    const again = await rerun(id, step, key, "test");
    assert.deepEqual(again, first);
    const [state] = await sql`SELECT processing_state FROM articles WHERE id = ${id}`;
    assert.equal(state!.processing_state, "analyzed");
    assert.equal((await sql`SELECT 1 FROM grouping_overrides WHERE article_id = ${id}`).length, 1);
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE request_id = ${key}`).length, 1);
  }
});

test("a rejected SEO correction leaves both the decision and public indexing unchanged", async () => {
  const id = await article();
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, summary_zh, selected)
            VALUES (${id}, 1, 'rule', 'pass', '可收录的正文摘要', false)`;
  await publishArticle(id);
  const [before] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
  await sql.unsafe(`CREATE FUNCTION refuse_admin_seo_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.actor = 'test-refuse-seo' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER refuse_admin_seo_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_admin_seo_audit()");
  try {
    await assert.rejects(setSeoIndexed(id, { indexed: true, reason: "人工收录" }, "test-refuse-seo"), /audit unavailable/);
    const [after] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
    assert.deepEqual(after, before);
  } finally {
    await sql.unsafe("DROP TRIGGER refuse_admin_seo_audit ON audit_log; DROP FUNCTION refuse_admin_seo_audit()");
  }
  await setSeoIndexed(id, { indexed: true, reason: "人工收录" }, "test");
  const [indexed] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
  assert.ok(indexed!.seo_indexed_at);
  assert.equal(indexed!.seo_excluded_at, null);
  assert.equal(indexed!.indexable, true);
  await setSeoIndexed(id, { indexed: false, reason: "取消收录" }, "test");
  const [excluded] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
  assert.equal(excluded!.seo_indexed_at, null);
  assert.ok(excluded!.seo_excluded_at);
  assert.equal(excluded!.indexable, false);
});

async function adminHeaders() {
  const token = `admin-session-${tag()}`;
  const [user] = await sql`INSERT INTO admin_users (display_name) VALUES ('Review') RETURNING id`;
  const claims = { appId: "test-session-app", unionId: "test-session-user", email: null };
  process.env.FEISHU_LOGIN_APP_ID = claims.appId;
  process.env.FEISHU_LOGIN_APP_SECRET = "test-app-secret";
  config.adminUnionIds = [claims.unionId];
  const binding = createHmac("sha256", process.env.SESSION_SECRET!).update(JSON.stringify(["admin-session-v1", "feishu", claims])).digest("hex");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, auth_method, auth_binding, auth_claims) VALUES (${sha256(token)}, ${user!.id}, 'review-csrf', now() + interval '1 hour', 'feishu', ${binding}, ${sql.json(claims)})`;
  return { cookie: `aihot_admin=${token}`, "x-csrf-token": "review-csrf", "idempotency-key": `invalid-${T}` };
}

test("bad admin input is a client error and never starts processing", async () => {
  const headers = await adminHeaders();
  const source = await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "bad" } });
  assert.equal(source.statusCode, 400);
  const id = await article();
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${id}`;
  const response = await app.inject({ method: "POST", url: `/api/admin/content/${id}/rerun`, headers, payload: { step: "typo" } });
  assert.equal(response.statusCode, 400);
  const [state] = await sql`SELECT processing_state FROM articles WHERE id = ${id}`;
  assert.equal(state!.processing_state, "analyzed");
});

test("category settings require admin and CSRF, preserve identities and audit the saved snapshot", async () => {
  const headers = await adminHeaders();
  const url = "/api/admin/settings/categories";
  const extra = { key: "new-category", label: "测试分类", tag: "测试首标签", section: "测试栏目", guide: "仅供测试的归类规则", tagColor: "gray", enabled: true };
  const categories = [extra, ...DEFAULT_CATEGORIES.map(c => ({ ...c, enabled: false }))];
  const payload = { categories, reason: "测试分类管理" };
  assert.equal((await app.inject({ method: "PUT", url, payload })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url, payload, headers: { cookie: headers.cookie } })).statusCode, 403);
  for (const invalid of [
    { ...payload, reason: 123 }, { ...payload, reason: " " }, { ...payload, unknown: true },
    { ...payload, categories: [extra] },
    { ...payload, categories: categories.map(c => ({ ...c, enabled: false })) },
    { ...payload, categories: [...categories, extra] },
    { ...payload, categories: [{ ...extra, key: "all" }, ...DEFAULT_CATEGORIES] },
    { ...payload, categories: [{ ...extra, key: "bad--key" }, ...DEFAULT_CATEGORIES] },
    { ...payload, categories: [{ ...extra, extra: true }, ...DEFAULT_CATEGORIES] },
    { ...payload, categories: DEFAULT_CATEGORIES.map(c => ({ ...c, tag: `${c.tag}改名` })) },
  ]) {
    const response = await app.inject({ method: "PUT", url, headers, payload: invalid });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.deepEqual(await loadCategories(), DEFAULT_CATEGORIES);
  const saved = await app.inject({ method: "PUT", url, headers, payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.headers["cache-control"], "no-store");
  assert.deepEqual((await app.inject({ url: "/api/admin/settings", headers })).json().categories, categories);
  const [audit] = await sql`SELECT reason, before, after FROM audit_log WHERE action = 'settings.categories' ORDER BY id DESC LIMIT 1`;
  assert.equal(audit!.reason, payload.reason);
  assert.deepEqual(audit!.before, DEFAULT_CATEGORIES);
  assert.deepEqual(audit!.after, categories);
  const id = await article();
  await publishArticle(id);
  const unknown = await app.inject({ method: "POST", url: `/api/admin/content/${id}/override`, headers,
    payload: { fields: { category: "unknown-category" }, version: 0, reason: "不存在的分类" } });
  assert.equal(unknown.statusCode, 400, unknown.body);
  assert.equal((await sql`SELECT 1 FROM editorial_overrides WHERE article_id = ${id}`).length, 0, "an unknown category cannot create an override");
  await overrideFields(id, { fields: { category: extra.key }, version: 0, reason: "使用新分类" }, "test");
  assert.equal((await sql`SELECT category FROM publications WHERE article_id = ${id}`)[0]!.category, extra.key);
  await sql`DELETE FROM settings WHERE key = 'categories'`;
});

test("a failed category audit rolls back the settings too", async () => {
  await sql.unsafe(`CREATE FUNCTION refuse_category_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'settings.categories' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER refuse_category_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_category_audit()");
  const before = await loadCategories();
  try {
    await assert.rejects(updateCategories({ categories: before.map(c => ({ ...c, label: `${c.label}测试` })), reason: "rollback" }, "test"), /audit unavailable/);
    assert.deepEqual(await loadCategories(), before);
  } finally {
    await sql.unsafe("DROP TRIGGER refuse_category_audit ON audit_log; DROP FUNCTION refuse_category_audit()");
  }
});
