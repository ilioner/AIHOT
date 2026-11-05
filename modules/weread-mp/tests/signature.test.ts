// The pure parts of the WeRead protocol: the request signature (vectors produced by the client
// library's own implementation), the anti-replay signature, and the WeChat id conversions a source
// stored in config.ghid and an article's short link depend on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { antiReplaySignature, genSignature } from "../backend/signer.ts";
import { bizFromBookId, bookIdFromBiz, isWereadBookId, normalizeWechatShortUrl, shortUrlForReview } from "../backend/wechat.ts";

test("genSignature matches WeRead's own signature", () => {
  assert.equal(genSignature(["", "410515152", "1700000000000", "42", "refresh-token-example"]), "d6b8ecb355c1076c9c09bc8a655e6120f9a87f283cbaa055796aeca6eefe9f4c");
  assert.equal(genSignature(["a", "device-1"]), "c4a48690e60cc13ee051bdadf8a20df5582fb43e3ee7b65a5c93caf03238e7cf");
  assert.equal(genSignature([]), "803650dc58f1b68a4826c26926ff4b52dbdb6f948d6905227aa3d722b5abb836");
});

test("the anti-replay signature hashes timestamp, device and random in that order", () => {
  assert.equal(antiReplaySignature("dev", 1700000000000, 42), "5bcc605102a3ab3d4738fed56fcfc148033127ebb54c2a12f8e776de07719c63");
});

test("a WeRead book id and a WeChat __biz name the same account", () => {
  assert.equal(isWereadBookId("MP_WXS_123456"), true);
  assert.equal(isWereadBookId("123456"), false);
  assert.equal(bookIdFromBiz(bizFromBookId("MP_WXS_123456")), "MP_WXS_123456");
  assert.equal(bookIdFromBiz("123456"), "MP_WXS_123456");
});

test("a review id's short link is the canonical article address", () => {
  assert.equal(shortUrlForReview("MP_WXS_123456_abcdefghijklmnop"), "https://mp.weixin.qq.com/s/abcdefghijklmnop");
  assert.equal(shortUrlForReview("MP_WXS_123456"), "");
  assert.equal(normalizeWechatShortUrl("https://mp.weixin.qq.com/s/abcdefghijklmno~"), "https://mp.weixin.qq.com/s/abcdefghijklmno_");
});
