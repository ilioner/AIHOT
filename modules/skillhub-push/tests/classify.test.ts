// The classification the push depends on: the model's answer is adopted when its codes exist in the
// dictionaries, and when it does not (an invented code, an outage, a timeout) the keyword rules decide
// and the push still goes out — a model is never allowed to stop a batch. The answer is cached per
// article, so the second run does not pay for the same question again.
import { Reply, pointModels, stub, tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { closeDb, sql } from "@aihot/backend/db";
import { clearDictionaryCache } from "../backend/client.ts";
import { ensureTypes, loadTypes } from "../backend/classify.ts";
import { publishedToolRows, pushCandidates } from "../backend/push.ts";
import { rulesFor } from "../backend/mapping.ts";

const T = tag();
const SOURCE = `skillhub-classify-${T}`;

/** How the stub answers the next classification calls. */
type Mode = "valid" | "invalid-code" | "server-error" | "garbage";
let mode: Mode = "valid";
let chatHits = 0;
/** When set, the next create call is refused with a 500 so the row stays pending. */
let failCreates = 0;
const created: Array<Record<string, unknown>> = [];

function dictionary(code: string) {
  if (code === "aitool.category") {
    return [
      { id: 15, code: "software-development", status: "ACTIVE" },
      { id: 19, code: "office-productivity", status: "ACTIVE" },
      { id: 20, code: "image-video", status: "ACTIVE" },
      { id: 21, code: "policy-regulations", status: "ACTIVE" },
    ];
  }
  if (code === "aitool.audience") {
    return [
      { id: 23, code: "administrative-office", status: "ACTIVE" },
      { id: 24, code: "student-learning", status: "ACTIVE" },
      { id: 25, code: "teacher-research", status: "ACTIVE" },
    ];
  }
  if (code === "aitool.feature") {
    return [
      { id: 26, code: "authoritative-release", status: "ACTIVE" },
      { id: 27, code: "editorial-pick", status: "ACTIVE" },
    ];
  }
  return [];
}

/** The article ids the prompt asked about, so the stub answers exactly those rows. */
function idsIn(prompt: string): string[] {
  return [...prompt.matchAll(/"articleId":"([^"]+)"/g)].map((match) => match[1]!);
}

const skillhub = await stub((_hit, req) => {
  const url = new URL(req.url, "http://stub");
  const dict = /^\/api\/v1\/admin\/dicts\/([^/]+)\/items$/.exec(url.pathname);
  if (dict) return { code: 0, data: dictionary(decodeURIComponent(dict[1]!)) };
  if (url.pathname === "/v1/chat/completions") {
    chatHits += 1;
    if (mode === "server-error") return new Reply(500, { error: { message: "分类服务挂了" } });
    // An answer that is not the JSON we asked for (a truncated or reasoning-only reply behaves the same).
    if (mode === "garbage") return { choices: [{ message: { role: "assistant", content: "我觉得这条工具挺不错的。" }, finish_reason: "stop" }] };
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
    const asked = idsIn(body.messages.map((message) => message.content).join("\n"));
    const items = asked.map((articleId) => ({
      articleId,
      // A code the dictionaries do not have: the row must fall back to the rules.
      categoryCode: mode === "invalid-code" ? "ai-tool-of-the-future" : "software-development",
      audienceCode: "teacher-research",
      featureCode: "editorial-pick",
      reason: "测试用的分类理由",
    }));
    return { id: `chatcmpl-${chatHits}`, choices: [{ message: { role: "assistant", content: JSON.stringify({ items }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } };
  }
  if (url.pathname === "/api/v1/admin/ai-tools") {
    const body = JSON.parse(req.body) as Record<string, unknown>;
    created.push(body);
    if (failCreates > 0) {
      failCreates -= 1;
      return new Reply(500, { code: 500, msg: "服务器内部错误" });
    }
    return { code: 0, msg: "创建成功", data: { id: 9000 + created.length } };
  }
  return new Reply(404, { code: 404, msg: "没有这个地址" });
});

before(async () => {
  process.env.SKILLHUB_BASE_URL = skillhub.url;
  process.env.SKILLHUB_COOKIE = "{{SECRET_jyz4gzw3}}; other=1";
  process.env.SKILLHUB_XSRF_TOKEN = "{{SECRET_vrjrtden}}";
  process.env.SKILLHUB_CLASSIFY_MODEL = "deepseek-flash";
  config.allowPrivateNetworkFetch = true;
  // The model steps of the installed modules (this one included) are what modelRoute can choose.
  installModules(SERVER_MODULES);
  clearDictionaryCache();
  pointModels(skillhub.url, ["deepseek-flash"]);
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, ${`skillhub 分类测试 ${T}`}, 'external', 'T2', 'editorial', '2100-01-01')`;
});

after(async () => {
  await skillhub.close();
  await closeDb();
});

let seq = 0;
/** A published tool entry whose block name is「AI办公」, so the rules alone also pick a category. */
async function tool(name: string): Promise<string> {
  seq += 1;
  const id = `cls-${T}-${String(seq).padStart(3, "0")}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, timeline_at, discovered_at, raw, media)
    VALUES (${id}, ${SOURCE}, ${id}, ${`https://tools.example/${id}`}, ${name}, now(), now(),
      ${sql.json({ contentKind: "tool-directory", blockName: "AI办公", sourceMetadata: { categories: ["AI办公"], tags: [] } })}, ${sql.json([])})`;
  await sql`INSERT INTO publications (article_id, source_id, title, summary, url, timeline_at, discovered_at, sort_at,
      selected, eligible, visible_after, tags, channel, category)
    VALUES (${id}, ${SOURCE}, ${name}, ${`简介 ${name}`}, ${`https://tools.example/${id}`}, now(), now(), now(),
      true, true, now() - interval '1 minute', ARRAY['AI工具'], 'news', 'ai-tools')`;
  return id;
}

async function storedType(articleId: string) {
  const [row] = await sql<{ category_code: string; audience_code: string; feature_code: string | null; decided_by: string; model: string | null; reason: string | null }[]>`
    SELECT category_code, audience_code, feature_code, decided_by, model, reason FROM skillhub_tool_types WHERE article_id = ${articleId}`;
  return row;
}

test("the model's own codes are used and stored with the model's name", async () => {
  mode = "valid";
  const id = await tool(`分类-模型-${T}`);
  const summary = await pushCandidates({ articleIds: [id] });
  assert.equal(summary.sent, 1, "the tool went out");

  const stored = await storedType(id);
  assert.equal(stored?.decided_by, "model");
  assert.equal(stored?.category_code, "software-development");
  assert.equal(stored?.audience_code, "teacher-research");
  assert.equal(stored?.feature_code, "editorial-pick");
  assert.ok(stored?.model, "the model that decided is recorded");

  const body = created.find((entry) => entry.name === `分类-模型-${T}`);
  assert.equal(body?.categoryDictItemId, 15, "the model's category code, translated to the dictionary's id");
  assert.equal(body?.audienceDictItemId, 25);
  assert.equal(body?.featureDictItemId, 27);
});

test("a code the dictionary does not have falls back to the rules and still pushes", async () => {
  mode = "invalid-code";
  const id = await tool(`分类-无效代码-${T}`);
  const summary = await pushCandidates({ articleIds: [id] });
  assert.equal(summary.sent, 1, "an unusable answer is not a reason to hold the tool back");

  const stored = await storedType(id);
  assert.equal(stored?.decided_by, "rules");
  assert.equal(stored?.category_code, "office-productivity", "the block name's rule");
  assert.match(String(stored?.reason), /不在字典里/);
  const body = created.find((entry) => entry.name === `分类-无效代码-${T}`);
  assert.equal(body?.categoryDictItemId, 19);
});

test("a model outage falls back to the rules and still pushes", async () => {
  mode = "server-error";
  const id = await tool(`分类-模型挂了-${T}`);
  const summary = await pushCandidates({ articleIds: [id] });
  assert.equal(summary.sent, 1);
  const stored = await storedType(id);
  assert.equal(stored?.decided_by, "rules");
  assert.equal(stored?.model, null);
  assert.match(String(stored?.reason), /模型不可用/);
});

test("an unusable answer falls back to the rules and still pushes", async () => {
  mode = "garbage";
  const id = await tool(`分类-乱码-${T}`);
  const summary = await pushCandidates({ articleIds: [id] });
  assert.equal(summary.sent, 1, "a model that answers nonsense does not hold the tool back");
  const stored = await storedType(id);
  assert.equal(stored?.decided_by, "rules");
  assert.equal(stored?.category_code, "office-productivity");
});

test("the second run reuses the stored answer instead of calling the model again", async () => {
  mode = "valid";
  const id = await tool(`分类-缓存-${T}`);
  const before = chatHits;
  failCreates = 1;
  const first = await pushCandidates({ articleIds: [id] });
  assert.equal(first.sent, 0, "the create was refused, so the row is still pending");
  assert.equal(first.failed, 1);
  assert.equal(chatHits, before + 1, "the first run paid for one classification call");

  const second = await pushCandidates({ articleIds: [id] });
  assert.equal(second.sent, 1, "the retry goes out once skillhub accepts it");
  assert.equal(chatHits, before + 1, "the cached codes mean no second call");
  assert.equal((await storedType(id))?.decided_by, "model");
});

test("a forced re-classification asks the model again and replaces the stored answer", async () => {
  mode = "valid";
  const id = await tool(`分类-强制-${T}`);
  await pushCandidates({ articleIds: [id] });

  // As if the stored answer had come from an outage: forcing must consult the model again and replace it.
  await sql`UPDATE skillhub_tool_types SET category_code = 'office-productivity', audience_code = 'administrative-office',
    feature_code = NULL, decided_by = 'rules', model = NULL, reason = '模型不可用，改用规则：旧记录' WHERE article_id = ${id}`;
  const row = await publishedRow(id);
  assert.equal((await ensureTypes([row], dictionaryIds())).get(id)?.decidedBy, "rules", "without force the stored answer is trusted");

  const types = await ensureTypes([row], dictionaryIds(), { force: true });
  assert.equal(types.get(id)?.decidedBy, "model", "force ignores the cache");
  assert.equal((await loadTypes([id])).get(id)?.categoryCode, "software-development");
});

test("a row with no model answer still gets the rules' three codes", async () => {
  const row = await publishedRow(await tool(`分类-规则-${T}`));
  const types = rulesFor(row);
  assert.equal(types.decidedBy, "rules");
  assert.equal(types.categoryCode, "office-productivity");
  assert.equal(types.featureCode, null);
});

/** One published row as the pusher sees it, for the helpers that take a row. */
async function publishedRow(articleId: string) {
  const rows = await publishedToolRows(2000);
  const row = rows.find((entry) => entry.articleId === articleId);
  assert.ok(row, `no published row for ${articleId}`);
  return row;
}

/** The dictionaries the stub serves, as ensureTypes wants them. */
function dictionaryIds() {
  return {
    category: new Map([[ "software-development", 15], ["office-productivity", 19], ["image-video", 20], ["policy-regulations", 21]]),
    audience: new Map([["administrative-office", 23], ["student-learning", 24], ["teacher-research", 25]]),
    feature: new Map([["authoritative-release", 26], ["editorial-pick", 27]]),
  };
}
