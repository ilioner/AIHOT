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
import { accountRow, listAccounts } from "../backend/pool.ts";

const T = tag();
const UIN = String(Date.now()).slice(-9);
const BOOK = `MP_WXS_${UIN}`;
const REVIEW = `${BOOK}_abcdefghijklmnop`;
const SOURCE = `mp-${UIN}`;
const SHORT = "https://mp.weixin.qq.com/s/abcdefghijklmnop";
const ACCESS = "access-token-1";

let polls = 0;
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
    return {
      chapters: [{
        reviewId: REVIEW,
        createTime: Math.floor(Date.now() / 1000) - 3600,
        mpInfo: { title: `微信文章 ${T}`, digest: `摘要 ${T}`, author: "作者", doc_url: SHORT, pic_url: "https://example.com/cover.jpg" },
      }],
    };
  }
  if (url.pathname === "/web/mp/content") {
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
