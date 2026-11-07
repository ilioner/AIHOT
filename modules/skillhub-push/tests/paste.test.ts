// The credential card takes one box, so this is the part that has to be right: a whole curl, a block of
// request headers, or a bare Cookie value all have to yield the same session, and nothing else may.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSession } from "../backend/paste.ts";

const COOKIE = "SESSION={{SECRET_zzgnhpna}}; XSRF-TOKEN=3f1c2d9e-aaaa-bbbb-cccc-1a2b3c4d5e6f; theme=dark";
const XSRF = "3f1c2d9e-aaaa-bbbb-cccc-1a2b3c4d5e6f";

test("a browser's 'Copy as cURL' is enough on its own", () => {
  const pasted = [
    "curl 'https://skillhub.aefree.com/api/v1/admin/dicts/aitool.category/items' \\",
    "  -H 'accept: application/json' \\",
    `  -H 'cookie: ${COOKIE}' \\`,
    "  -H 'x-xsrf-token: {{SECRET_o7gobvsi}}' \\",
    "  --compressed",
  ].join("\n");
  const parsed = parseSession(pasted);
  assert.equal(parsed.cookie, COOKIE);
  assert.equal(parsed.xsrf, "{{SECRET_o7gobvsi}}", "the header wins over the cookie when both are there");
  assert.equal(parsed.baseUrl, "https://skillhub.aefree.com");
  assert.ok(parsed.notes.some((note) => note.includes("cookie:")), "the page can say where it came from");
});

test("the XSRF token is taken from the cookie when no header carries it", () => {
  const parsed = parseSession(`curl https://skillhub.aefree.com/x -H "cookie: ${COOKIE}"`);
  assert.equal(parsed.cookie, COOKIE);
  assert.equal(parsed.xsrf, XSRF);
  assert.ok(parsed.notes.some((note) => note.includes("Cookie 里的 XSRF-TOKEN")));
});

test("--cookie / -b forms and the Windows command prompt's line continuation", () => {
  const bash = parseSession(`curl -sS --cookie '${COOKIE}' https://skillhub.aefree.com/api`);
  assert.equal(bash.cookie, COOKIE);
  assert.equal(bash.xsrf, XSRF);

  const cmd = [
    'curl.exe "https://skillhub.aefree.com/api/v1/admin/ai-tools" ^',
    `  -H "cookie: ${COOKIE}" ^`,
    '  -H "x-xsrf-token: {{SECRET_o7gobvsi}}"',
  ].join("\r\n");
  const parsed = parseSession(cmd);
  assert.equal(parsed.cookie, COOKIE);
  assert.equal(parsed.xsrf, "{{SECRET_o7gobvsi}}");
  assert.equal(parsed.baseUrl, "https://skillhub.aefree.com");
});

test("a pasted block of request headers works too", () => {
  const pasted = [
    ":authority: skillhub.aefree.com",
    "accept: application/json",
    `cookie: ${COOKIE}`,
    "x-xsrf-token: {{SECRET_o7gobvsi}}",
  ].join("\n");
  const parsed = parseSession(pasted);
  assert.equal(parsed.cookie, COOKIE);
  assert.equal(parsed.xsrf, "{{SECRET_o7gobvsi}}");
});

test("just the Cookie value, pasted alone", () => {
  const parsed = parseSession(COOKIE);
  assert.equal(parsed.cookie, COOKIE);
  assert.equal(parsed.xsrf, XSRF);
  assert.equal(parsed.baseUrl, null);
});

test("a header block wrapped across lines is joined back together", () => {
  const parsed = parseSession(`cookie: SESSION={{SECRET_zzgnhpna}};\n  XSRF-TOKEN=${XSRF}`);
  assert.equal(parsed.cookie, `SESSION={{SECRET_zzgnhpna}}; XSRF-TOKEN=${XSRF}`);
  assert.equal(parsed.xsrf, XSRF);
});

test("things that are not a session come back empty, with a note saying so", () => {
  for (const junk of ["", "   ", "hello world", '{"cookie":"no"}', "curl https://skillhub.aefree.com/api"]) {
    const parsed = parseSession(junk);
    assert.equal(parsed.cookie, null, `no cookie from ${JSON.stringify(junk)}`);
    assert.equal(parsed.xsrf, null, `no token from ${JSON.stringify(junk)}`);
    assert.ok(parsed.notes.length > 0);
  }
});

test("a token is never a quoted blob or another header", () => {
  const parsed = parseSession(`cookie: ${COOKIE}\nx-xsrf-token: 'tok-quoted-1234'`);
  assert.equal(parsed.xsrf, "tok-quoted-1234", "the shell quotes are stripped");
  const noToken = parseSession("cookie: SESSION=only1234");
  assert.equal(noToken.cookie, "SESSION=only1234");
  assert.equal(noToken.xsrf, null);
  assert.ok(noToken.notes.some((note) => note.startsWith("没识别出 XSRF")));
});
