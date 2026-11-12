// The admin API behind the page: a signed-in admin (and a CSRF token for every write) is required, the
// model classifies on demand, and — the point of this file — no response ever carries the pasted session
// back: the page only learns whether each half is configured. The audit rows record counts and the
// model's name, never a cookie.
import { pointModels, stub, tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { buildApp } from "../../../apps/api/src/app.ts";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";
import { overviewCounts } from "../backend/push.ts";

const T = tag();
const SOURCE = `skillhub-api-${T}`;
const COOKIE = `{{SECRET_zzgnhpna}}; other=1`;
const XSRF = "{{SECRET_o7gobvsi}}";

const dictionaries: Record<string, Array<{ id: number; code: string }>> = {
  "aitool.category": [
    { id: 15, code: "software-development" },
    { id: 19, code: "office-productivity" },
  ],
  "aitool.audience": [{ id: 25, code: "teacher-research" }],
  "aitool.feature": [{ id: 27, code: "editorial-pick" }],
};

const skillhub = await stub((_hit, req) => {
  const url = new URL(req.url, "http://stub");
  const dict = /^\/api\/v1\/admin\/dicts\/([^/]+)\/items$/.exec(url.pathname);
  if (dict) return { code: 0, data: (dictionaries[decodeURIComponent(dict[1]!)] ?? []).map((item) => ({ ...item, status: "ACTIVE" })) };
  if (url.pathname === "/v1/chat/completions") {
    const body = JSON.parse(req.body) as { messages: Array<{ content: string }> };
    const asked = [...body.messages.map((message) => message.content).join("\n").matchAll(/"articleId":"([^"]+)"/g)].map((match) => match[1]!);
    return {
      id: "chatcmpl-api",
      choices: [{ message: { role: "assistant", content: JSON.stringify({ items: asked.map((articleId) => ({ articleId, categoryCode: "software-development", audienceCode: "teacher-research", featureCode: null, reason: "接口测试" })) }) }, finish_reason: "stop" }],
      usage: null,
    };
  }
  return { code: 0, msg: "创建成功", data: { id: 7001 } };
});

let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  process.env.SKILLHUB_BASE_URL = skillhub.url;
  process.env.SKILLHUB_COOKIE = COOKIE;
  process.env.SKILLHUB_XSRF_TOKEN = XSRF;
  process.env.SKILLHUB_CLASSIFY_MODEL = "deepseek-flash";
  config.allowPrivateNetworkFetch = true;
  pointModels(skillhub.url, ["deepseek-flash"]);
  // buildApp mounts the installed modules' routes; the real api entry installs the site's modules first.
  installModules(SERVER_MODULES);
  app = await buildApp();
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, ${`skillhub 接口测试 ${T}`}, 'external', 'T2', 'editorial', '2100-01-01')`;
});

after(async () => {
  await app.close();
  await stopBoss();
  await skillhub.close();
  await closeDb();
});

/** One published tool, so the classifier has something to work on. */
async function tool(name: string): Promise<string> {
  const id = `api-${T}-${name.length}-${Math.random().toString(36).slice(2, 6)}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, timeline_at, discovered_at, raw, media)
    VALUES (${id}, ${SOURCE}, ${id}, ${`https://tools.example/${id}`}, ${name}, now(), now(),
      ${sql.json({ contentKind: "tool-directory", blockName: "AI办公" })}, ${sql.json([])})`;
  await sql`INSERT INTO publications (article_id, source_id, title, summary, url, timeline_at, discovered_at, sort_at,
      selected, eligible, visible_after, tags, channel, category)
    VALUES (${id}, ${SOURCE}, ${name}, ${"简介"}, ${`https://tools.example/${id}`}, now(), now(), now(),
      true, true, now() - interval '1 minute', ARRAY['AI工具'], 'news', 'ai-tools')`;
  return id;
}

/** A signed-in admin session with a CSRF token, as the login flow would leave it. */
async function adminHeaders() {
  const token = `admin-session-${tag()}`;
  const [user] = await sql`INSERT INTO admin_users (display_name) VALUES ('Skillhub') RETURNING id`;
  const claims = { appId: "test-session-app", unionId: "test-session-user", email: null };
  process.env.FEISHU_LOGIN_APP_ID = claims.appId;
  process.env.FEISHU_LOGIN_APP_SECRET = "{{SECRET_cnhukf4p}}";
  config.adminUnionIds = [claims.unionId];
  const binding = createHmac("sha256", process.env.SESSION_SECRET!).update(JSON.stringify(["admin-session-v1", "feishu", claims])).digest("hex");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, auth_method, auth_binding, auth_claims)
    VALUES (${sha256(token)}, ${user!.id}, 'skillhub-csrf', now() + interval '1 hour', 'feishu', ${binding}, ${sql.json(claims)})`;
  return { cookie: `aihot_admin=${token}`, "x-csrf-token": "skillhub-csrf" };
}

/** Nothing that looks like the session may leave the server. */
function assertNoSecrets(text: string) {
  for (const secret of [COOKIE, XSRF, "{{SECRET_zzgnhpna}}", "{{SECRET_o7gobvsi}}", "other=1"]) {
    assert.ok(!text.includes(secret), `the response must not echo ${secret.slice(0, 6)}…`);
  }
}

test("the overview needs an admin session and answers with counts, the model and no credentials", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/skillhub/overview" })).statusCode, 401);
  const headers = await adminHeaders();
  const response = await app.inject({ method: "GET", url: "/api/admin/skillhub/overview", headers });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    enabled: boolean; model: string | null;
    configured: Record<string, unknown>;
    counts: Record<string, number>;
    rows: Array<{ types: unknown }>;
  };
  assert.equal(typeof body.enabled, "boolean");
  assert.equal(typeof body.configured.cookie, "boolean", "only whether it is configured, never the value");
  assert.equal(typeof body.configured.xsrf, "boolean");
  assert.equal(typeof body.counts.unclassified, "number");
  assert.equal(typeof body.counts.classified, "number");
  assert.ok("model" in body, "the page shows the step's model");
  assertNoSecrets(response.body);
});

test("the overview includes tools without push records in both pending counts and the list", async () => {
  const before = await overviewCounts();
  const id = await tool(`尚未推送-${T}`);
  await sql`UPDATE articles SET raw = raw || ${sql.json({ contentKind: "tool-collection" })} WHERE id = ${id}`;
  await sql`UPDATE publications SET category = 'tip' WHERE article_id = ${id}`;
  const headers = await adminHeaders();
  const response = await app.inject({ method: "GET", url: "/api/admin/skillhub/overview", headers });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.counts.pending, before.pending + 1);
  const items = await app.inject({ method: "GET", url: "/api/admin/skillhub/items", headers });
  assert.equal(items.statusCode, 200);
  const pending = items.json().rows.find((entry: { articleId: string }) => entry.articleId === id);
  assert.ok(pending, "new candidates must be visible before their first push");
  assert.equal(pending.status, "pending");
  assert.equal(pending.attempts, 0);
  assert.equal(pending.remoteId, null);
  assert.equal(pending.lastError, null);
  assert.equal(pending.pushedAt, null);
  assert.equal((await sql`SELECT 1 FROM skillhub_pushes WHERE article_id = ${id}`).length, 0);
});

test("classified counts use the current candidate scope and retain excluded historical caches", async () => {
  const before = await overviewCounts();
  const ids = await Promise.all([tool("当前模型分类"), tool("当前规则分类"), tool("当前未分类"), tool("下架的历史分类"), tool("教程历史分类"), tool("不合格历史分类")]);
  for (const i of [0, 1, 3, 4, 5]) {
    await sql`INSERT INTO skillhub_tool_types (article_id, category_code, audience_code, decided_by)
      VALUES (${ids[i]!}, 'office-productivity', 'teacher-research', ${i === 1 ? 'rules' : 'model'})`;
  }
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${ids[3]!}`;
  await sql`UPDATE articles SET raw = raw || ${sql.json({ contentKind: "tutorial" })} WHERE id = ${ids[4]!}`;
  await sql`UPDATE publications SET eligible = false WHERE article_id = ${ids[5]!}`;
  const headers = await adminHeaders();
  const response = await app.inject({ method: "GET", url: "/api/admin/skillhub/overview", headers });
  assert.equal(response.statusCode, 200);
  const { counts } = response.json();
  assert.equal(counts.candidates, before.candidates + 3);
  assert.equal(counts.classified, before.classified + 2);
  assert.equal(counts.byModel, before.byModel + 1);
  assert.equal(counts.byRules, before.byRules + 1);
  assert.equal(counts.unclassified, counts.candidates - counts.classified);
  assert.equal(counts.classified, counts.byModel + counts.byRules);
  assert.equal((await sql`SELECT 1 FROM skillhub_tool_types WHERE article_id = ANY(${ids}::text[])`).length, 5);
});

test("push records are paginated and day queries use Beijing midnight, not the server timezone", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/skillhub/items" })).statusCode, 401);
  const headers = await adminHeaders();
  const ids = await Promise.all([tool("日期边界前"), tool("日期边界内"), tool("日期边界后")]);
  for (const [i, time] of ["2026-11-08T15:59:59Z", "2026-11-08T16:00:00Z", "2026-11-09T16:00:00Z"].entries()) {
    await sql`INSERT INTO skillhub_pushes (article_id, status, attempts, pushed_at) VALUES (${ids[i]!}, 'exists', 1, ${time})`;
  }
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${ids[1]!}`;
  const day = await app.inject({ method: "GET", url: "/api/admin/skillhub/items?date=2026-11-09&pageSize=1", headers });
  assert.equal(day.statusCode, 200);
  assert.equal(day.json().total, 1);
  assert.equal(day.json().rows[0].articleId, ids[1]);
  assert.equal(day.json().rows[0].operation, "legacy");
  assert.equal(day.json().rows[0].canRepush, false, "withdrawal does not erase history, but prevents re-push");
  const empty = await app.inject({ method: "GET", url: "/api/admin/skillhub/items?date=2026-11-09&pageSize=1&page=2", headers });
  assert.equal(empty.json().total, 1);
  assert.deepEqual(empty.json().rows, []);
  const pages = [];
  for (const page of [1, 2]) pages.push((await app.inject({ method: "GET", url: `/api/admin/skillhub/items?pageSize=2&page=${page}`, headers })).json());
  assert.equal(pages[0].total, pages[1].total);
  assert.equal(new Set(pages.flatMap(p => p.rows.map((r: { articleId: string }) => r.articleId))).size, 4);
  for (const query of ["page=0", "pageSize=101", "date=2026-02-30", "date=not-a-date"]) {
    assert.equal((await app.inject({ method: "GET", url: `/api/admin/skillhub/items?${query}`, headers })).statusCode, 400);
  }
  assertNoSecrets(day.body);
});

test("batch recreation needs CSRF and an explicit nonempty scope, and excludes withdrawn IDs", async () => {
  const headers = await adminHeaders();
  const id = await tool("批量重推");
  const withdrawn = await tool("不可重推");
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${withdrawn}`;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/skillhub/repush", headers: { cookie: headers.cookie }, payload: { all: true } })).statusCode, 403);
  for (const payload of [{}, { articleIds: [] }, { all: false }, { all: true, articleIds: [id] }]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/skillhub/repush", headers, payload })).statusCode, 400);
  }
  const result = await app.inject({ method: "POST", url: "/api/admin/skillhub/repush", headers, payload: { articleIds: [id, id, withdrawn, "missing-tool"] } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { enqueued: 1, pending: 1 });
  const [job] = await sql`SELECT data FROM pgboss.job WHERE name = 'skillhub-push.push' AND data->>'mode' = 'repush' ORDER BY created_on DESC LIMIT 1`;
  assert.deepEqual(job!.data.articleIds, [id]);
  assert.equal(job!.data.reclassify, undefined, "recreation reuses classifications");
  assertNoSecrets(result.body);
});

test("classifying on demand stores the answers, audits counts, and echoes no credential", async () => {
  const id = await tool(`接口分类-${T}`);
  const headers = await adminHeaders();
  // A write without the CSRF token is refused by the engine's guard.
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/skillhub/classify", headers: { cookie: headers.cookie }, payload: {} })).statusCode, 403);

  const response = await app.inject({ method: "POST", url: "/api/admin/skillhub/classify", headers, payload: { articleIds: [id], onlyMissing: true } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { attempted: number; byModel: number; byRules: number; model: string | null };
  assert.equal(body.attempted, 1);
  assert.equal(body.byModel, 1, "the stub's answer was adopted");
  assert.equal(body.byRules, 0);
  assertNoSecrets(response.body);

  const [stored] = await sql<{ category_code: string; decided_by: string }[]>`SELECT category_code, decided_by FROM skillhub_tool_types WHERE article_id = ${id}`;
  assert.equal(stored?.category_code, "software-development");
  assert.equal(stored?.decided_by, "model");

  const [entry] = await sql<{ after: Record<string, unknown> }[]>`SELECT after FROM audit_log WHERE action = 'skillhub.classify' ORDER BY created_at DESC LIMIT 1`;
  assert.equal(entry?.after.attempted, 1, "the audit keeps the counts");
  assert.equal(entry?.after.byModel, 1);
  assert.ok(!JSON.stringify(entry?.after).includes("{{SECRET_zzgnhpna}}"), "the audit row carries no cookie");
});

test("pasting a curl saves the session and answers with flags, never the values", async () => {
  const headers = await adminHeaders();
  const paste = [
    "curl 'https://skillhub.aefree.com/api/v1/admin/ai-tools' \\",
    `  -H 'cookie: ${COOKIE}' \\`,
    `  -H 'x-xsrf-token: ${XSRF}' \\`,
    "  --compressed",
  ].join("\n");
  const response = await app.inject({ method: "POST", url: "/api/admin/skillhub/paste", headers, payload: { paste } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    configured: { cookie: unknown; xsrf: unknown; source: string };
    parsed: { cookie: unknown; xsrf: unknown; baseUrl: string | null; notes: string[] };
  };
  assert.equal(body.configured.cookie, true);
  assert.equal(body.configured.xsrf, true);
  assert.equal(body.configured.source, "settings", "the pasted session is now the stored one");
  assert.equal(body.parsed.baseUrl, "https://skillhub.aefree.com", "the page can say which site it came from");
  assert.ok(body.parsed.notes.length > 0);
  assertNoSecrets(response.body);

  const junk = await app.inject({ method: "POST", url: "/api/admin/skillhub/paste", headers, payload: { paste: "hello world" } });
  assert.equal(junk.statusCode, 400, "text with no session in it is refused instead of wiping the stored one");
  assertNoSecrets(junk.body);

  const overview = await app.inject({ method: "GET", url: "/api/admin/skillhub/overview", headers });
  assert.equal(overview.statusCode, 200);
  assertNoSecrets(overview.body);
});
