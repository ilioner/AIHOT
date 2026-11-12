// The pusher against a local stub of the skillhub admin: success, an existing slug treated as success, a
// single failure skipped so the rest still go out, a refused session recorded as a configuration
// problem, and the attempt limit that stops the sweep from retrying a broken row forever. Nothing here
// reaches the network; SKILLHUB_BASE_URL points at the stub.
import { Reply, pointModels, stub, tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { clearDictionaryCache } from "../backend/client.ts";
import { enqueueRepush, listPushes, MAX_ATTEMPTS, overviewCounts, pendingToolRows, pushCandidates, resetFailed } from "../backend/push.ts";

const T = tag();
const SOURCE = `skillhub-${T}`;

/** How the stub answers one create call, by the tool's name. */
type Answer = "ok" | "exists" | "exists-english" | "invalid" | "server-error" | "unauthorized";
const answers = new Map<string, Answer>();
const sent: Array<Record<string, unknown>> = [];

function dictionary(code: string) {
  if (code === "aitool.category") {
    return [
      { id: 15, code: "software-development", status: "ACTIVE" },
      { id: 19, code: "office-productivity", status: "ACTIVE" },
      { id: 20, code: "image-video", status: "ACTIVE" },
    ];
  }
  if (code === "aitool.audience") return [{ id: 25, code: "teacher-research", status: "ACTIVE" }];
  if (code === "aitool.feature") return [{ id: 27, code: "editorial-pick", status: "ACTIVE" }];
  return [];
}

const skillhub = await stub((_hit, req) => {
  const url = new URL(req.url, "http://stub");
  const dict = /^\/api\/v1\/admin\/dicts\/([^/]+)\/items$/.exec(url.pathname);
  if (dict) return { code: 0, data: dictionary(decodeURIComponent(dict[1]!)) };
  if (url.pathname === "/api/v1/admin/ai-tools") {
    const body = JSON.parse(req.body) as Record<string, unknown>;
    sent.push(body);
    const answer = answers.get(String(body.name)) ?? "ok";
    if (answer === "unauthorized") return new Reply(401, { code: 401, msg: "未登录" });
    if (answer === "server-error") return new Reply(500, { code: 500, msg: "服务器内部错误" });
    if (answer === "exists") return new Reply(400, { code: 400, msg: "AI 工具的 slug 或标准地址已存在" });
    if (answer === "exists-english") return new Reply(400, { code: 400, msg: "An AI tool with this slug or canonical URL already exists" });
    if (answer === "invalid") return new Reply(400, { code: 400, msg: "Invalid category" });
    return { code: 0, msg: "创建成功", data: { id: 4321 } };
  }
  return new Reply(404, { code: 404, msg: "没有这个地址" });
});

before(async () => {
  process.env.SKILLHUB_BASE_URL = skillhub.url;
  process.env.SKILLHUB_COOKIE = "session=cookie-value; other=1";
  process.env.SKILLHUB_XSRF_TOKEN = "xsrf-value";
  process.env.SKILLHUB_CLASSIFY_MODEL = "deepseek-flash";
  config.allowPrivateNetworkFetch = true;
  installModules(SERVER_MODULES);
  // The classification call goes to the same stub, whose catch-all answers 404: the rules decide and the
  // push tests keep exercising the push, not the model.
  pointModels(skillhub.url, ["deepseek-flash"]);
  clearDictionaryCache();
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, ${`skillhub 测试 ${T}`}, 'external', 'T2', 'editorial', '2100-01-01')`;
});

after(async () => {
  await skillhub.close();
  await stopBoss();
  await closeDb();
});

let seq = 0;
/** A published tool directory entry, with no push state yet. */
async function tool(name: string, url: string): Promise<string> {
  seq += 1;
  const id = `shp-${T}-${String(seq).padStart(3, "0")}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, timeline_at, discovered_at, raw, media)
    VALUES (${id}, ${SOURCE}, ${id}, ${url}, ${name}, now(), now(),
      ${sql.json({ contentKind: "tool-directory", blockName: "AI办公", sourceMetadata: { categories: ["AI办公"], tags: ["推荐"], iconUrl: null } })},
      ${sql.json([{ url: "https://cdn.example/icon.png", kind: "image" }])})`;
  await sql`INSERT INTO publications (article_id, source_id, title, summary, url, timeline_at, discovered_at, sort_at,
      selected, eligible, visible_after, tags, channel, category)
    VALUES (${id}, ${SOURCE}, ${name}, ${`简介 ${name}`}, ${url}, now(), now(), now(), true, true, now() - interval '1 minute',
      ARRAY['AI工具'], 'news', 'ai-tools')`;
  return id;
}

async function state(articleId: string) {
  const [row] = await sql<{ status: string; attempts: number; remote_id: string | null; last_error: string | null; pushed_at: Date | null; payload: Record<string, unknown> | null }[]>`
    SELECT status, attempts, remote_id, last_error, pushed_at, payload FROM skillhub_pushes WHERE article_id = ${articleId}`;
  return row;
}

test("a created tool is marked sent with the remote id and the body that was sent", async () => {
  answers.set(`工具-成功-${T}`, "ok");
  const id = await tool(`工具-成功-${T}`, "https://tools.example/success");

  const summary = await pushCandidates({ articleIds: [id] });
  assert.equal(summary.attempted, 1);
  assert.equal(summary.sent, 1);
  assert.equal(summary.stopped, false);

  const row = await state(id);
  assert.equal(row?.status, "sent");
  assert.equal(row?.attempts, 1);
  assert.equal(Number(row?.remote_id), 4321);
  assert.ok(row?.pushed_at);
  assert.equal(row?.payload?.name, `工具-成功-${T}`);
  assert.equal(row?.payload?.categoryDictItemId, 19, "AI办公 maps to office-productivity, whose ID came from the dictionary");
  assert.equal(row?.payload?.audienceDictItemId, 25);
  assert.equal(row?.payload?.featureDictItemId, 27);
  assert.match(String(row?.payload?.slug), /^tools-example-[0-9a-f]{8}$/);
  assert.equal(row?.payload?.canonicalUrl, "https://tools.example/success");
  assert.equal(row?.payload?.iconUrl, "https://cdn.example/icon.png", "the media image stands in for a missing icon");
  assert.ok(sent.some((body) => body.name === `工具-成功-${T}`), "the request reached the create endpoint");
});

test("recreating a deleted remote tool keeps prior-day history and reuses cached classification", async () => {
  const name = `历史重推-${T}`;
  const id = await tool(name, "https://tools.example/recreate");
  await sql`INSERT INTO skillhub_pushes (article_id, status, attempts, remote_id, pushed_at, payload)
    VALUES (${id}, 'sent', 3, 999, '2026-01-01T15:59:59Z', ${sql.json({ name: "旧名称" })})`;
  await sql`INSERT INTO skillhub_tool_types (article_id, category_code, audience_code, decided_by)
    VALUES (${id}, 'office-productivity', 'teacher-research', 'rules')`;
  const [classification] = await sql`SELECT * FROM skillhub_tool_types WHERE article_id = ${id}`;
  assert.equal((await listPushes({ date: "2026-01-01" })).rows.find(r => r.articleId === id)?.title, "旧名称");
  const first = await pushCandidates({ articleIds: [id], repush: true });
  assert.equal(first.sent, 1);
  assert.equal((await state(id))?.attempts, 1, "explicit recreation starts a fresh attempt budget");
  assert.equal((await listPushes({ date: "2026-01-01" })).rows.find(r => r.articleId === id)?.title, "旧名称");
  assert.deepEqual((await sql`SELECT * FROM skillhub_tool_types WHERE article_id = ${id}`)[0], classification);
  answers.set(name, "exists");
  assert.equal((await pushCandidates({ articleIds: [id], repush: true })).exists, 1);
  const history = await sql`SELECT operation, snapshot FROM skillhub_push_events WHERE article_id = ${id} ORDER BY id`;
  assert.deepEqual(history.map(r => r.operation), ["legacy", "create", "create"]);
  assert.deepEqual(history.map(r => r.snapshot.status), ["sent", "sent", "exists"]);
  assert.equal(history[0]!.snapshot.title, "旧名称");
  assert.equal((await state(id))?.remote_id, null, "exists never retains a deleted old remote ID");
  assert.equal(sent.filter(r => r.name === name).length, 2);
  const before = sent.length;
  assert.equal((await pushCandidates({ articleIds: [], repush: true })).attempted, 0);
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
  assert.equal((await pushCandidates({ articleIds: [id], repush: true })).attempted, 0);
  assert.equal(sent.length, before);
});

test("a 400 saying the slug or address already exists counts as done", async () => {
  answers.set(`工具-已存在-${T}`, "exists");
  const id = await tool(`工具-已存在-${T}`, "https://tools.example/exists");

  const summary = await pushCandidates({ articleIds: [id] });
  assert.equal(summary.exists, 1);
  assert.equal(summary.failed, 0);

  const row = await state(id);
  assert.equal(row?.status, "exists");
  assert.equal(row?.last_error, null);
  assert.ok(row?.pushed_at, "a tool already in the directory is not left looking unpushed");
});

test("the documented English duplicate response completes the push, but an ordinary 400 does not", async () => {
  const duplicate = await tool(`英文重复-${T}`, "https://tools.example/english-duplicate");
  const invalid = await tool(`无效分类-${T}`, "https://tools.example/invalid-category");
  answers.set(`英文重复-${T}`, "exists-english");
  answers.set(`无效分类-${T}`, "invalid");
  const summary = await pushCandidates({ articleIds: [duplicate, invalid] });
  assert.equal(summary.exists, 1);
  assert.equal(summary.failed, 1);
  assert.equal((await state(duplicate))?.status, "exists");
  assert.equal((await state(duplicate))?.last_error, null);
  assert.equal((await state(invalid))?.status, "pending");
  assert.match((await state(invalid))?.last_error ?? "", /Invalid category/);
});

test("pushing hash-routed topics preserves the identities stored by collection", async () => {
  const articleIds: string[] = [];
  for (const topicId of [36, 38, 39, 40]) {
    const url = `https://aistore.360.cn/#/subjectdetail?id=${topicId}`;
    const id = await tool(`专题-${topicId}-${T}`, url);
    await sql`UPDATE articles SET identity_key = ${`url:${url}`} WHERE id = ${id}`;
    if (topicId === 39) {
      await sql`UPDATE articles SET raw = raw || ${sql.json({ contentKind: "tool-collection" })} WHERE id = ${id}`;
      await sql`UPDATE publications SET category = 'tip' WHERE article_id = ${id}`;
    }
    articleIds.push(id);
  }
  const summary = await pushCandidates({ articleIds });
  assert.equal(summary.sent, 4);
  const records = await Promise.all(articleIds.map(state));
  for (const record of records) assert.equal(record?.payload?.canonicalUrl, record?.payload?.url);
  assert.equal(new Set(records.map((record) => record?.payload?.slug)).size, 4);
});

test("one refusal is skipped and the next tool is still pushed", async () => {
  answers.set(`工具-失败-${T}`, "server-error");
  answers.set(`工具-继续-${T}`, "ok");
  const broken = await tool(`工具-失败-${T}`, "https://tools.example/broken");
  const fine = await tool(`工具-继续-${T}`, "https://tools.example/fine");

  const summary = await pushCandidates({ articleIds: [broken, fine] });
  assert.equal(summary.attempted, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.sent, 1, "the failure does not stop the rest of the batch");
  assert.equal(summary.stopped, false);

  const brokenRow = await state(broken);
  assert.equal(brokenRow?.status, "pending", "still pending: the sweep may try it again");
  assert.equal(brokenRow?.attempts, 1);
  assert.match(String(brokenRow?.last_error), /500/);
  assert.equal((await state(fine))?.status, "sent");
});

test("a refused session is recorded as a configuration problem and stops the batch", async () => {
  answers.set(`工具-未授权-${T}`, "unauthorized");
  answers.set(`工具-未推-${T}`, "ok");
  const denied = await tool(`工具-未授权-${T}`, "https://tools.example/denied");
  const untouched = await tool(`工具-未推-${T}`, "https://tools.example/untouched");

  const summary = await pushCandidates({ articleIds: [denied, untouched] });
  assert.equal(summary.stopped, true);
  assert.match(String(summary.error), /401/);
  assert.equal(summary.sent, 0);

  const row = await state(denied);
  assert.equal(row?.status, "pending");
  assert.match(String(row?.last_error), /401/);
  assert.equal(row?.attempts, 0, "a session problem is not this row's fault, so no attempt is spent");
  assert.ok((await pendingToolRows({ limit: 500 })).some((entry) => entry.articleId === denied), "still swept once the session is back");
  assert.equal(await state(untouched), undefined, "the rows after a refused session are not marked");
});

test("a row that keeps failing stops at the attempt limit and leaves the sweep alone", async () => {
  answers.set(`工具-总是失败-${T}`, "server-error");
  const id = await tool(`工具-总是失败-${T}`, "https://tools.example/never");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const summary = await pushCandidates({ articleIds: [id] });
    assert.equal(summary.failed, 1, `attempt ${attempt}`);
  }

  const row = await state(id);
  assert.equal(row?.status, "failed");
  assert.equal(row?.attempts, MAX_ATTEMPTS);
  const pending = await pendingToolRows({ limit: 500 });
  assert.ok(!pending.some((entry) => entry.articleId === id), "a failed row is not swept again");

  // The admin's retry gives it a fresh budget, and a stub that now accepts it finishes the row.
  answers.set(`工具-总是失败-${T}`, "ok");
  assert.equal(await resetFailed(), 1);
  const retried = await pushCandidates({ articleIds: [id] });
  assert.equal(retried.sent, 1);
  assert.equal((await state(id))?.status, "sent");
});

test("all-candidate recreation queues more than 500 without losing chunks or sending in the request", async () => {
  for (let n = 0; n < 501; n += 1) await tool(`全量-${n}`, `https://tools.example/bulk/${n}`);
  const { candidates } = await overviewCounts();
  const before = sent.length;
  const result = await enqueueRepush({ all: true });
  assert.equal(result.pending, candidates);
  assert.equal(result.enqueued, Math.ceil(candidates / 500));
  const jobs = await sql`SELECT data FROM pgboss.job WHERE name = 'skillhub-push.push' AND data->>'mode' = 'repush'`;
  const ids = jobs.flatMap(r => r.data.articleIds as string[]);
  assert.equal(new Set(ids).size, candidates);
  assert.equal(ids.length, candidates);
  assert.ok(jobs.every(r => r.data.articleIds.length <= 500));
  assert.equal(sent.length, before, "only the worker performs network calls");
});

test("a run of retryable failures stops the batch instead of spending a timeout on every row", async () => {
  const broken: string[] = [];
  for (const suffix of ["甲", "乙", "丙"]) {
    answers.set(`工具-连败-${suffix}-${T}`, "server-error");
    broken.push(await tool(`工具-连败-${suffix}-${T}`, `https://tools.example/run-of-${suffix}`));
  }
  answers.set(`工具-连败后的-${T}`, "ok");
  const after = await tool(`工具-连败后的-${T}`, "https://tools.example/after-run");

  const summary = await pushCandidates({ articleIds: [...broken, after] });
  assert.equal(summary.attempted, 3);
  assert.equal(summary.stopped, true);
  assert.match(String(summary.error), /连续 3 条/);
  assert.equal(summary.sent, 0);
  assert.equal(await state(after), undefined, "the row after the run is left for the next sweep");

  for (const id of broken) {
    const row = await state(id);
    assert.equal(row?.status, "pending");
    assert.equal(row?.attempts, 1, "each row that was tried keeps its own attempt");
  }
});
