// The module's two ways in: the QR handshake that turns a phone scan into a pooled login, and
// collection of one account's posts through that login. Both run against a local stub of the WeRead
// hosts; the tokens never leave the database sealed.
import { Reply, stub, tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "../backend/collect.ts";
import { ENDPOINTS } from "../backend/endpoints.ts";
import { pollLogin, startLogin } from "../backend/login.ts";
import { accountRow, listAccounts, saveAccount } from "../backend/pool.ts";

// Pacing is a sleep between requests: zero here, so a check is not slowed down and a login is ready
// for its next request as soon as the previous one finished.
process.env.WEREAD_REQUEST_INTERVAL_MS = "0";

const T = tag();
const UIN = String(Date.now()).slice(-9);
const BOOK = `MP_WXS_${UIN}`;
const REVIEW = `${BOOK}_abcdefghijklmnop`;
const SOURCE = `mp-${UIN}`;
const SHORT = "https://mp.weixin.qq.com/s/abcdefghijklmnop";
const ACCESS = "access-token-1";

let polls = 0;
/** Each book the stub knows, so two sources in this file never share a review id or short link. */
const chaptersOf = new Map<string, { reviewId: string; title: string; digest: string }>();
chaptersOf.set(BOOK, { reviewId: REVIEW, title: `微信文章 ${T}`, digest: `摘要 ${T}` });
/** While set, the stub answers that login's listing with -2014, as a throttled account would. */
let throttledVid: string | null = null;
const chaptersByVid = new Map<string, number>();
const bodyCookies: string[] = [];
const weread = await stub((_hit, req) => {
  const url = new URL(req.url, "http://stub");
  if (url.pathname === "/wxticket") return { timeStamp: 1700000000, signature: "ticket-signature" };
  if (url.pathname.startsWith("/connect/sdk/qrconnect")) return { uuid: "qr-uuid", qrcode: { qrcodebase64: "ZmFrZQ==" } };
  if (url.pathname.startsWith("/connect/l/qrconnect")) {
    polls += 1;
    return polls === 1 ? { wx_errcode: 408 } : { wx_errcode: 405, wx_code: "scan-code" };
  }
  if (url.pathname === "/login") return { vid: "vid-1", accessToken: ACCESS, refreshToken: "refresh-token-1", skey: "skey-1", user: { name: "测试账号", avatar: "" } };
  if (url.pathname === "/mp/chapters") {
    const vid = String(req.headers.vid ?? "");
    chaptersByVid.set(vid, (chaptersByVid.get(vid) ?? 0) + 1);
    if (throttledVid && vid === throttledVid) return new Reply(429, { errcode: -2014 });
    const post = chaptersOf.get(url.searchParams.get("bookId") ?? "");
    return {
      chapters: post ? [{
        reviewId: post.reviewId,
        createTime: Math.floor(Date.now() / 1000) - 3600,
        mpInfo: { title: post.title, digest: post.digest, author: "作者", doc_url: SHORT, pic_url: "https://example.com/cover.jpg" },
      }] : [],
    };
  }
  if (url.pathname === "/web/mp/content") {
    bodyCookies.push(String(req.headers.cookie ?? ""));
    return new Reply(200, null, `<html><body><div class="rich_media_content"><p>正文第一段 ${T}</p><p>正文第二段</p></div></body></html>`);
  }
  return {};
});

before(async () => {
  ENDPOINTS.api = weread.url;
  ENDPOINTS.longpoll = weread.url;
  ENDPOINTS.web = weread.url;
  ENDPOINTS.open = weread.url;
  config.allowPrivateNetworkFetch = true;
});

after(async () => {
  await weread.close();
  await stopBoss();
  await closeDb();
});

test("a scanned QR login joins the account pool with its tokens sealed", async () => {
  const started = await startLogin();
  assert.ok(started.qr.startsWith("data:image/jpeg;base64,"));
  assert.equal((await pollLogin(started.loginId)).status, "scanning");
  assert.equal((await pollLogin(started.loginId)).status, "success");

  const account = (await listAccounts()).find((a) => a.vid === "vid-1")!;
  assert.equal(account.nickname, "测试账号");
  const row = await accountRow(account.id);
  assert.ok(row!.access_token.startsWith("v1:"), "the access token is sealed");
  assert.ok(row!.refresh_token!.startsWith("v1:"), "the refresh token is sealed");
  assert.ok(!JSON.stringify(await listAccounts()).includes(ACCESS), "the admin view carries no token");
});

test("collecting an account stores each post once, with its body from the reader", async () => {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at)
            VALUES (${SOURCE}, ${`微信读书 ${T}`}, 'mp_account', ${sql.json({ ghid: BOOK, nickname: `微信读书 ${T}` })}, 'T2', 'editorial', '2100-01-01')`;

  const first = await collectSource(SOURCE, "manual");
  assert.deepEqual({ status: first.status, created: first.created, found: first.found }, { status: "ok", created: 1, found: 1 });

  const [article] = await sql<{ url: string; title: string; body_status: string; body_text: string; via: string; review: string }[]>`
    SELECT a.url, a.title, a.body_status, a.body_text, d.via, a.raw->'weread'->>'reviewId' AS review
    FROM articles a JOIN article_discoveries d ON d.article_id = a.id AND d.source_id = a.source_id
    WHERE a.source_id = ${SOURCE}`;
  assert.equal(article!.url, SHORT);
  assert.equal(article!.title, `微信文章 ${T}`);
  assert.equal(article!.body_status, "ok");
  assert.match(article!.body_text, new RegExp(`正文第一段 ${T}`));
  assert.equal(article!.via, "weread-mp");
  assert.equal(article!.review, REVIEW);

  const second = await collectSource(SOURCE, "manual");
  assert.equal(second.created, 0, "a post already stored is not stored again");
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int FROM articles WHERE source_id = ${SOURCE}`;
  assert.equal(count, 1);
});

test("collecting spreads over the pool: a throttled login hands the same request to the next one", async () => {
  const book2 = `MP_WXS_${UIN}7`;
  const source2 = `mp-${UIN}7`;
  chaptersOf.set(book2, { reviewId: `${book2}_abcdefghijklmnoq`, title: `微信文章 ${T} 乙`, digest: `摘要 ${T} 乙` });
  await saveAccount({
    vid: "vid-2",
    nickname: "第二个账号",
    avatar: "",
    accessToken: "second-access-token",
    refreshToken: null,
    skey: "skey-2",
    deviceId: "device-2",
    deviceName: "Android",
    installId: "install-2",
    userAgent: "weread-ua-2",
  });
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at)
            VALUES (${source2}, ${`微信读书 ${T} 乙`}, 'mp_account', ${sql.json({ ghid: book2, nickname: `微信读书 ${T} 乙` })}, 'T2', 'editorial', '2100-01-01')`;

  const listingsBefore = chaptersByVid.get("vid-1") ?? 0;
  throttledVid = "vid-1";
  try {
    const result = await collectSource(source2, "manual");
    assert.equal(result.status, "ok", "the check finished on the other login");
    assert.equal(result.created, 1);
  } finally {
    throttledVid = null;
  }

  // The refused login was asked exactly once and then left alone; the same listing request was
  // retried on the second login, which also fetched the body.
  assert.equal((chaptersByVid.get("vid-1") ?? 0) - listingsBefore, 1);
  assert.equal(chaptersByVid.get("vid-2"), 1);
  assert.ok(bodyCookies.some((cookie) => cookie.includes("wr_vid=vid-2")), "the body went out as the second login");

  const [throttled] = await sql<{ status: string; cooldown_level: number; cooldown_until: Date | null; last_error: string | null }[]>`
    SELECT status, cooldown_level, cooldown_until, last_error FROM weread_accounts WHERE vid = 'vid-1'`;
  assert.equal(throttled!.status, "cooling", "the login that was throttled cools down");
  assert.equal(throttled!.cooldown_level, 1, "its first throttle starts the doubling cooldown at level 1");
  assert.ok(throttled!.cooldown_until && throttled!.cooldown_until.getTime() > Date.now(), "the cooldown is in the future");

  const [healthy] = await sql<{ status: string }[]>`SELECT status FROM weread_accounts WHERE vid = 'vid-2'`;
  assert.equal(healthy!.status, "active");
  const [source] = await sql<{ health: string; fail_count: number }[]>`SELECT health, fail_count FROM sources WHERE id = ${source2}`;
  assert.equal(source!.health, "ok", "the source itself did not fail");
  assert.equal(source!.fail_count, 0);
});
