// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import type { AdminContentChain, BeforeJson } from "@aihot/contracts/admin";
import { CATEGORY_KEYS, DEFAULT_CATEGORIES } from "@aihot/contracts/taxonomy";
import { UNSAFE_decodeViaTurboStream } from "react-router";
import { fakeApi, fixtureCategories, FIXTURE_AT, startWebServer, visit, type WebServer } from "./web-server.ts";

let web: WebServer;
let origin: string;
let deadline: number;
/** Root metadata answers only after the selected deadline has passed: a slow sibling loader. */
let metaAfterDeadline = false;
const apiCookies: Array<string | undefined> = [];
const api = fakeApi(async (url, res, req) => {
  apiCookies.push(req.headers.cookie);
  if (url.pathname === "/api/site/meta") {
    // Past the deadline on the wall clock the server reads: timers run on another clock, and a CI VM
    // stepping its wall clock back mid-wait would otherwise answer before the deadline.
    while (metaAfterDeadline && Date.now() < deadline * 1000 + 50) await new Promise((resolve) => setTimeout(resolve, deadline * 1000 + 50 - Date.now()));
    return { changelogVersion: "2026-09-28T12:00" };
  }
  if (url.pathname === "/api/site/timeline") {
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null };
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return { categories: fixtureCategories, filters, cards: [], nextCursor: null, dayCounts: [], hot: null };
  }
  if (url.pathname === "/api/site/hot") return { entries: [] };
  if (url.pathname === "/api/site/echo-client") return { forwarded: req.headers["x-forwarded-for"], real: req.headers["x-real-ip"] };
  if (url.pathname === "/api/site/download") {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="article.md"');
    return res.end("# Article");
  }
  if (url.pathname === "/api/site/items/long-lived") return { id: "long-lived", title: "t" };
  if (url.pathname === "/api/site/maker") return { makerAvatar: null };
  if (url.pathname === "/api/site/stories/merged") {
    res.statusCode = 308;
    return { mergedInto: "surviving-story" };
  }
  if (url.pathname.startsWith("/api/admin/")) {
    res.statusCode = 401;
    return { code: "not_found" };
  }
});

before(async () => {
  deadline = Math.floor(Date.now() / 1000) + 20;
  web = await startWebServer(api);
  origin = web.origin;
});
after(() => web.stop());

test("public route subsets produce the same complete navigation data; filters still differ", async () => {
  const answers = await Promise.all(["", "?_routes=root", "?_routes=routes%2Fhome", "?_routes=unknown"].map(async (query) => {
    const res = await fetch(`${origin}/_.data${query}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Cache-Control")!, /^public,/);
    assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
    assert.doesNotMatch(res.headers.get("Cache-Control")!, /stale/);
    const body = await res.text();
    assert.ok(body.includes("root") && body.includes("routes/home"));
    return body;
  }));
  assert.ok(answers.every((body) => body === answers[0]));
  const category = CATEGORY_KEYS.at(-1)!;
  const filtered = await fetch(`${origin}/_.data?category=${category}&_routes=root`);
  const body = await filtered.text();
  assert.ok(body.includes(category));
  assert.notEqual(body, answers[0]);
});

test("navigation streams are plain text for download managers, including errors", async () => {
  for (const [pathname, status] of [["/_.data?_routes=root", 200], ["/items/missing.data", 404]] as const) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, status, pathname);
    assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8", pathname);
    assert.equal(res.headers.get("Content-Disposition"), null, pathname);
    assert.ok((await res.text()).length > 0, pathname);
  }
  const download = await fetch(origin + "/api/site/download");
  assert.equal(download.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(download.headers.get("Content-Disposition"), 'attachment; filename="article.md"');
  assert.equal(await download.text(), "# Article");
});

test("HTML and navigation share freshness; cookies do not personalize public results", async () => {
  const html = await fetch(`${origin}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.match(await html.text(), /精选/);
  // The api's deadline also fixes the result's own expiry, so reads seconds apart compare byte for byte.
  const plain = await fetch(`${origin}/_.data`);
  const signedIn = await fetch(`${origin}/_.data?_routes=root`, { headers: { cookie: "admin_session=private; reader=returning" } });
  assert.match(plain.headers.get("Cache-Control")!, /^public,/);
  assert.equal(plain.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.equal(await signedIn.text(), await plain.text());
  assert.ok(apiCookies.every((cookie) => !cookie));
});

test("missing routes cannot be hidden by a root-only request; errors and redirects stay uncached", async () => {
  for (const pathname of ["/items/missing.data?_routes=root", "/does-not-exist.data?_routes=root", "/items/missing"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Accel-Expires"), "0");
    await res.text();
  }
  for (const [pathname, target] of [["/story/merged.data?_routes=root", "/story/surviving-story"], ["/_.data?q=search&_routes=root", "/all?q=search"]]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.match(await res.text(), new RegExp(target.replace("?", "\\?")));
  }
});

test("admin data and actions never become public cache entries", async () => {
  const admin = await fetch(`${origin}/admin/sources.data?_routes=admin-layout`);
  assert.equal(admin.status, 202);
  assert.equal(admin.headers.get("Cache-Control"), "private, no-store");
  assert.equal(admin.headers.get("X-Accel-Expires"), "0");
  assert.match(await admin.text(), /api\/auth\/login/);
  const action = await fetch(`${origin}/hot.data`, { method: "POST" });
  assert.equal(action.status, 405);
  assert.equal(action.headers.get("Cache-Control"), "private, no-store");
  assert.equal(action.headers.get("X-Accel-Expires"), "0");
  await action.text();
});

test("browser freshness shares the selected deadline, including slow sibling loaders", async () => {
  const savedDeadline = deadline;
  try {
    deadline = Math.floor(Date.now() / 1000) + 20;
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      const cc = res.headers.get("Cache-Control")!;
      const browser = Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]);
      const shared = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]);
      assert.ok(browser > 0 && browser === shared);
      assert.ok(Date.parse(res.headers.get("Date")!) / 1000 + browser <= deadline);
      assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
      assert.match(cc, /must-revalidate/);
      assert.doesNotMatch(cc, /stale/);
      await res.text();
    }
    // The selected loader initially grants a positive TTL (at least a whole second), but root metadata
    // finishes after it.
    deadline = Math.floor(Date.now() / 1000) + 2;
    metaAfterDeadline = true;
    await Promise.all(["/", "/_.data?_routes=routes%2Fhome"].map(async (pathname) => {
      const res = await fetch(origin + pathname);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-cache");
      assert.equal(res.headers.get("X-Accel-Expires"), "0");
      await res.text();
    }));
  } finally {
    deadline = savedDeadline;
    metaAfterDeadline = false;
  }
});

test("a shared cache may keep an item page longer than browsers", async () => {
  const res = await fetch(`${origin}/items/long-lived.data`);
  assert.equal(res.status, 200);
  const cc = res.headers.get("Cache-Control")!;
  assert.equal(Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]), 300);
  assert.ok(Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]) > 300);
  await res.text();
});

// A tab opened before a page lost its loader still asks for that page's result, and its router rejects
// a missing one before React's release recovery can run.
test("a page without a loader still answers navigation with an empty result", async () => {
  const res = await fetch(`${origin}/terms.data?_routes=routes%2Fterms`);
  assert.equal(res.status, 200);
  const { value } = await UNSAFE_decodeViaTurboStream(res.body!, globalThis);
  const result = value as Record<string, { data: unknown }>;
  assert.ok("routes/terms" in result, "an already open router must be able to unwrap its requested route");
  assert.equal(result["routes/terms"]!.data, null);
});

test("browser caching preserves noindex and private sign-in responses", async () => {
  const feedback = await fetch(origin + "/feedback");
  assert.equal(feedback.status, 200);
  assert.match(await feedback.text(), /name="robots" content="noindex/);
  assert.equal(feedback.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  const login = await fetch(origin + "/admin/login");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await login.text();
});

test("a signed-in admin is sent past the sign-in page", async () => {
  const api = fakeApi((url, res, req) => {
    if (url.pathname === "/api/admin/me") {
      if (req.headers.cookie?.includes("aihot_admin=fixture")) return { name: "Fixture admin", csrf: "fixture", dev: false };
      res.statusCode = 401;
      return { code: "unauthorized" };
    }
    if (url.pathname === "/api/auth/options") return { password: true, feishu: false };
  });
  const signedIn = await startWebServer(api);
  try {
    const res = await fetch(`${signedIn.origin}/admin/login?return=%2Fadmin%2Fcontent`, { headers: { cookie: "aihot_admin=fixture" }, redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/admin/content");
    await res.text();
    for (const target of ["javascript:alert(1)", "//evil.example/admin", "https://evil.example/admin"]) {
      const away = await fetch(`${signedIn.origin}/admin/login?return=${encodeURIComponent(target)}`, { headers: { cookie: "aihot_admin=fixture" }, redirect: "manual" });
      assert.equal(away.headers.get("location"), "/admin", target);
      await away.text();
    }
    const anonymous = await fetch(`${signedIn.origin}/admin/login?return=%2Fadmin`, { redirect: "manual" });
    assert.equal(anonymous.status, 200, "without a session the page still offers the ways in");
    await anonymous.text();
  } finally {
    await signedIn.stop();
  }
});

test("admin corrections distinguish saved fields from publication and do not resubmit a dormant selection intent", async () => {
  const chain: BeforeJson<AdminContentChain> = {
    categories: [...DEFAULT_CATEGORIES],
    article: {
      id: "correction", source_id: "fixture", url: "https://example.org/correction", identity_key: "fixture:correction", title: "原始标题",
      author: null, language: "zh", published_at: FIXTURE_AT, published_at_claim: null, discovered_at: FIXTURE_AT, timeline_at: FIXTURE_AT,
      backfill: false, body_status: "ok", revision: 1, processing_state: "blocked", processing_error: null, grouped_at: null, body_chars: 20,
      source_name: "Fixture", source_kind: "rss", tier: "T1", participation_mode: "editorial", site_fulltext: false, syndicate_fulltext: false, status_reason: "规则拦截",
    },
    publication: {
      article_id: "correction", analysis_id: 1, revision: 1, visibility: "withdrawn", eligible: false, selected: false, seat: false,
      title: "原始标题", original_title: null, summary: "已有摘要", reason: null, category: "tip", tags: [], score: 20,
      source_id: "fixture", channel: "news", first_party: false, url: "https://example.org/correction", published_at: FIXTURE_AT,
      discovered_at: FIXTURE_AT, timeline_at: FIXTURE_AT, sort_at: FIXTURE_AT, backfill: false, selected_ready_at: null, visible_after: null,
      body_mode: "summary", syndicate: false, indexable: false, seo_indexed_at: null, seo_excluded_at: null, story_id: null, fact_id: null, updated_at: FIXTURE_AT,
    },
    override: { fields: { selected: true }, visibility: null, reason: "历史意图", version: 1, updated_by: "test", updated_at: FIXTURE_AT },
    discoveries: [], revisions: [], analyses: [], ledger: [], membership: [], decisions: [], deliveries: [], history: [],
  };
  const refusal = "操作未生效：预筛结果为 UNKNOWN，按规则拦截。人工设置不能绕过发布门禁。";
  const api = fakeApi(async (url, res, req) => {
    if (url.pathname === "/api/admin/me") return { name: "Fixture admin", csrf: "fixture", dev: false };
    if (url.pathname === "/api/admin/nav-counts") return {};
    if (url.pathname === "/api/admin/content/correction" && req.method === "GET") return chain;
    if (!url.pathname.startsWith("/api/admin/content/correction/")) return;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (!url.pathname.endsWith("/override") || input.fields.selected === true) {
      res.statusCode = 409;
      return { code: "conflict", detail: refusal };
    }
    Object.assign(chain.override!.fields, input.fields);
    for (const key of input.clear ?? []) delete chain.override!.fields[key];
    chain.override!.version += 1;
    chain.publication!.title = chain.override!.fields.title as string;
    return { visibility: "withdrawn", selected: false };
  });
  const browser = await chromium.launch({ channel: "chromium" });
  let editing: WebServer | undefined;
  try {
    editing = await startWebServer(api);
    const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
    await visit(page, editing.origin + "/admin/content/correction");
    const dialog = page.getByRole("dialog");
    for (const command of ["公开范围", "标记收录"]) {
      await page.getByRole("button", { name: command, exact: true }).click();
      if (command === "公开范围") await dialog.getByText("正常展示", { exact: true }).click();
      await dialog.getByPlaceholder("为什么做这个改动").fill("核验实际生效反馈");
      await dialog.getByRole("button", { name: command === "公开范围" ? "应用" : "标记收录", exact: true }).click();
      await expect(page.getByRole("status")).toContainText(refusal);
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    await page.getByRole("button", { name: "人工修正", exact: true }).click();
    await dialog.getByPlaceholder("原始标题", { exact: true }).fill("修正后标题");
    await dialog.getByPlaceholder("为什么做这个改动").fill("只改标题，保留历史精选意图");
    await dialog.getByRole("button", { name: "保存修正", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("修正已保存，内容仍未公开");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("修正后标题");
    assert.equal(chain.override!.fields.selected, true);
    assert.equal(chain.publication!.visibility, "withdrawn");
    assert.equal(chain.publication!.selected, false);
  } finally {
    await browser.close();
    await editing?.stop();
  }
});

test("a visitor cannot name its own address to the api without a trusted proxy in front", async () => {
  const res = await fetch(`${origin}/api/site/echo-client`, { headers: { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "6.6.6.6" } });
  assert.deepEqual(await res.json(), { forwarded: "127.0.0.1", real: "127.0.0.1" });
});

test("admin UNKNOWN bulk review previews all matching pages and reports actual queued, skipped and failed counts", async () => {
  let scope: Record<string, unknown> | undefined;
  let submitted: Record<string, unknown> | undefined;
  const api = fakeApi(async (url, _res, req) => {
    if (url.pathname === "/api/admin/me") return { name: "Fixture admin", csrf: "fixture", dev: false };
    if (url.pathname === "/api/admin/nav-counts") return {};
    if (url.pathname === "/api/admin/content") return { total: 60, page: Number(url.searchParams.get("page") ?? 1), rows: [
      { id: "unknown-one", title: "AI 工作流演示", source: "Fixture", url: "https://example.org/demo", discovered_at: FIXTURE_AT,
        processing_state: "blocked", visibility: "withdrawn", selected: false, score: null, prefilter_label: "UNKNOWN", reviewable: true },
      { id: "unknown-busy", title: "正在分析", source: "Fixture", url: "https://example.org/busy", discovered_at: FIXTURE_AT,
        processing_state: "new", visibility: "withdrawn", selected: false, score: null, prefilter_label: "UNKNOWN", reviewable: false },
    ] };
    if (!url.pathname.startsWith("/api/admin/content/prefilter-pass")) return;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (url.pathname.endsWith("/preview")) {
      scope = input;
      return { token: "fixture-token", total: 60, eligible: 58, rows: [{ id: "unknown-one", title: "AI 工作流演示", reason: null }] };
    }
    submitted = input;
    return { succeeded: 55, skipped: 3, failed: 2, rows: [{ id: "unknown-busy", status: "skipped", reason: "正在处理" }] };
  });
  const browser = await chromium.launch({ channel: "chromium" });
  const editing = await startWebServer(api);
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
    await visit(page, editing.origin + "/admin/content?prefilter=UNKNOWN");
    await page.getByRole("checkbox", { name: "选择 AI 工作流演示", exact: true }).check();
    await expect(page.getByRole("checkbox", { name: "选择 正在分析", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "选择全部匹配 60 条", exact: true }).click();
    await page.getByRole("button", { name: "人工判为 PASS", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("60 条");
    await expect(dialog).toContainText("58 条");
    await expect(dialog.getByRole("button", { name: "确认预筛通过并继续分析", exact: true })).toBeDisabled();
    await dialog.getByPlaceholder("为什么做这个改动").fill("人工核对任务与实质操作信息");
    await dialog.getByRole("button", { name: "确认预筛通过并继续分析", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("55 条已预筛通过并排队分析，3 条跳过，2 条失败");
    assert.deepEqual(scope, { q: "", all: true });
    assert.deepEqual(submitted, { token: "fixture-token", reason: "人工核对任务与实质操作信息" });
    await expect(page.getByRole("listitem").filter({ hasText: "unknown-busy" })).toContainText("正在处理");
  } finally { await browser.close(); await editing.stop(); }
});

// The real listener must own its ephemeral port; reserving and releasing one before spawn races
// another CI process. Canonical URLs still have to identify the listener's actual address.
test("a web server assigned port zero serves its own canonical address", async () => {
  const ephemeral = await startWebServer(fakeApi(), { WEB_PORT: "0", SITE_URL: "http://127.0.0.1:0" });
  try {
    const response = await fetch(`${ephemeral.origin}/about`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(`rel="canonical" href="${ephemeral.origin}/about"`));
  } finally { await ephemeral.stop(); }
});
