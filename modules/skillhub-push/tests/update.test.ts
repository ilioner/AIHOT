// Re-sending a tool that is already in skillhub. skillhub accepts a full-body PUT of the create payload
// (PATCH answers 405, a partial body answers 500), so an update is the whole body again, with the codes
// the model chose. A refused update never marks the tool as gone: the row stays 'sent' with its remote id,
// and the failure is recorded for the admin. 'exists' rows are someone else's entries and are never touched.
import { Reply, pointModels, stub, tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { clearDictionaryCache } from "../backend/client.ts";
import { sentToolRows, updateSent } from "../backend/push.ts";

const T = tag();
const SOURCE = `skillhub-update-${T}`;

type Answer = "ok" | "not-found" | "server-error" | "unauthorized";
const answers = new Map<number, Answer>();
const puts: Array<{ id: number; body: Record<string, unknown> }> = [];

function dictionary(code: string) {
  if (code === "aitool.category") {
    return [
      { id: 15, code: "software-development", status: "ACTIVE" },
      { id: 19, code: "office-productivity", status: "ACTIVE" },
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
  if (url.pathname === "/v1/chat/completions") {
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
    const asked = [...body.messages.map((message) => message.content).join("\n").matchAll(/"articleId":"([^"]+)"/g)].map((match) => match[1]!);
    const items = asked.map((articleId) => ({ articleId, categoryCode: "software-development", audienceCode: "teacher-research", featureCode: "editorial-pick", reason: "更新用的分类" }));
    return { id: "chatcmpl-update", choices: [{ message: { role: "assistant", content: JSON.stringify({ items }) }, finish_reason: "stop" }], usage: null };
  }
  const put = /^\/api\/v1\/admin\/ai-tools\/(\d+)$/.exec(url.pathname);
  // The stub gives no method, but only an update has an id in the path.
  if (put) {
    const id = Number(put[1]);
    puts.push({ id, body: JSON.parse(req.body) as Record<string, unknown> });
    const answer = answers.get(id) ?? "ok";
    if (answer === "unauthorized") return new Reply(401, { code: 401, msg: "未登录" });
    if (answer === "not-found") return new Reply(404, { code: 404, msg: "AI 工具不存在" });
    if (answer === "server-error") return new Reply(500, { code: 500, msg: "服务器内部错误" });
    return { code: 0, msg: "Updated successfully", data: { id } };
  }
  return new Reply(404, { code: 404, msg: "没有这个地址" });
});

before(async () => {
  process.env.SKILLHUB_BASE_URL = skillhub.url;
  process.env.SKILLHUB_COOKIE = "{{SECRET_3zuqyf6y}}; other=1";
  process.env.SKILLHUB_XSRF_TOKEN = "{{SECRET_i2t6hvqm}}";
  process.env.SKILLHUB_CLASSIFY_MODEL = "deepseek-flash";
  config.allowPrivateNetworkFetch = true;
  installModules(SERVER_MODULES);
  clearDictionaryCache();
  pointModels(skillhub.url, ["deepseek-flash"]);
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, ${`skillhub 更新测试 ${T}`}, 'external', 'T2', 'editorial', '2100-01-01')`;
});

after(async () => {
  await skillhub.close();
  await closeDb();
});

let seq = 0;
/** A published tool that skillhub already has: status 'sent', a remote id, and the body of the old push. */
async function sentTool(name: string, remoteId: number, status: "sent" | "exists" = "sent"): Promise<string> {
  seq += 1;
  const id = `upd-${T}-${String(seq).padStart(3, "0")}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, timeline_at, discovered_at, raw, media)
    VALUES (${id}, ${SOURCE}, ${id}, ${`https://tools.example/${id}`}, ${name}, now(), now(),
      ${sql.json({ contentKind: "tool-directory", blockName: "AI办公", sourceMetadata: { categories: ["AI办公"], tags: [] } })}, ${sql.json([])})`;
  await sql`INSERT INTO publications (article_id, source_id, title, summary, url, timeline_at, discovered_at, sort_at,
      selected, eligible, visible_after, tags, channel, category)
    VALUES (${id}, ${SOURCE}, ${name}, ${`简介 ${name}`}, ${`https://tools.example/${id}`}, now(), now(), now(),
      true, true, now() - interval '1 minute', ARRAY['AI工具'], 'news', 'ai-tools')`;
  await sql`INSERT INTO skillhub_pushes (article_id, status, attempts, remote_id, pushed_at, payload)
    VALUES (${id}, ${status}, 1, ${status === "sent" ? remoteId : null}, now(), ${sql.json({ name: `旧内容 ${name}` })})`;
  return id;
}

async function state(articleId: string) {
  const [row] = await sql<{ status: string; remote_id: string | null; last_error: string | null; payload: Record<string, unknown> | null }[]>`
    SELECT status, remote_id, last_error, payload FROM skillhub_pushes WHERE article_id = ${articleId}`;
  return row;
}

test("an update sends the complete create body and leaves the row sent with its remote id", async () => {
  const id = await sentTool(`更新-成功-${T}`, 5101);
  const summary = await updateSent({ articleIds: [id] });
  assert.equal(summary.attempted, 1);
  assert.equal(summary.updated, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.stopped, false);

  const sent = puts.find((entry) => entry.id === 5101);
  assert.ok(sent, "the PUT reached the tool's own address");
  const body = sent.body;
  for (const field of ["name", "slug", "url", "canonicalUrl", "description", "aiNote", "iconUrl", "categoryDictItemId", "audienceDictItemId", "featureDictItemId"]) {
    assert.ok(field in body, `the full create body is sent, and ${field} is part of it`);
  }
  assert.equal(body.name, `更新-成功-${T}`);
  assert.equal(body.categoryDictItemId, 15, "the model's category, not the block-name rule");

  const row = await state(id);
  assert.equal(row?.status, "sent", "an update never changes the row's status");
  assert.equal(Number(row?.remote_id), 5101);
  assert.equal(row?.last_error, null);
  assert.equal(row?.payload?.categoryDictItemId, 15, "the stored body is the one that is now in skillhub");
});

test("a refused update is recorded and the next tool is still updated", async () => {
  answers.set(5102, "not-found");
  answers.set(5103, "server-error");
  const missing = await sentTool(`更新-没了-${T}`, 5102);
  const broken = await sentTool(`更新-失败-${T}`, 5103);
  const fine = await sentTool(`更新-继续-${T}`, 5104);

  const summary = await updateSent({ articleIds: [missing, broken, fine] });
  assert.equal(summary.attempted, 3);
  assert.equal(summary.failed, 2);
  assert.equal(summary.updated, 1);
  assert.equal(summary.stopped, false, "one refused tool does not stop the batch");

  const missingRow = await state(missing);
  assert.equal(missingRow?.status, "sent", "a 404 keeps the tool counted as sent");
  assert.equal(Number(missingRow?.remote_id), 5102);
  assert.match(String(missingRow?.last_error), /404/);
  assert.equal(missingRow?.payload?.name, `旧内容 更新-没了-${T}`, "the old body is kept when the update fails");

  assert.match(String((await state(broken))?.last_error), /500/);
  assert.equal((await state(fine))?.last_error, null);
  assert.equal((await state(fine))?.status, "sent");
});

test("a refused session stops the update batch and changes nothing locally", async () => {
  answers.set(5105, "unauthorized");
  const denied = await sentTool(`更新-未授权-${T}`, 5105);
  const untouched = await sentTool(`更新-没轮到-${T}`, 5106);

  const summary = await updateSent({ articleIds: [denied, untouched] });
  assert.equal(summary.stopped, true);
  assert.match(String(summary.error), /401/);
  assert.equal(summary.updated, 0);
  assert.equal(summary.attempted, 1, "the rows after the refused session are not attempted");

  const row = await state(denied);
  assert.equal(row?.status, "sent");
  assert.equal(row?.last_error, null, "a session problem is not this tool's fault");
  assert.equal(row?.payload?.name, `旧内容 更新-未授权-${T}`);
  assert.equal((await state(untouched))?.last_error, null);
});

test("'exists' rows have no remote id and are never updated", async () => {
  const exists = await sentTool(`更新-已存在-${T}`, 0, "exists");
  const rows = await sentToolRows({ articleIds: [exists], limit: 10 });
  assert.equal(rows.length, 0, "someone else's entry stays out of the update");
  const summary = await updateSent({ articleIds: [exists] });
  assert.equal(summary.attempted, 0);
  assert.equal((await state(exists))?.payload?.name, `旧内容 更新-已存在-${T}`);
});
