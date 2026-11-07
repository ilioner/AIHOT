// Reads what an admin pastes into the skillhub card. Nobody wants to hunt for two separate values in
// devtools, so the box takes whatever is easiest to copy — the browser's "Copy as cURL", a block of
// request headers, or just the Cookie header's value — and digs the session out of it:
//
//   curl 'https://skillhub.aefree.com/api/v1/admin/dicts/...' -H 'cookie: a=1; XSRF-TOKEN=2' ...
//   Cookie: a=1; XSRF-TOKEN=2
//   X-XSRF-TOKEN: 2
//   a=1; XSRF-TOKEN=2
//
// The XSRF token is read from the header when it is there, and otherwise from the `XSRF-TOKEN` cookie,
// which is where the site keeps the same value. Nothing here talks to the network; it only turns text
// into {cookie, xsrf, baseUrl, notes}.
const MAX_PASTE = 20_000;

export interface ParsedSession {
  cookie: string | null;
  xsrf: string | null;
  /** The origin the pasted request went to, when it named one. */
  baseUrl: string | null;
  /** What was found and where, for the page to show back ("已识别 Cookie + XSRF"…). */
  notes: string[];
}

/** Undo the shell quoting a devtools copy leaves around a value, and any `$'…'` form. */
function unquote(raw: string): string {
  let value = raw.trim();
  if ((value.startsWith("'") && value.endsWith("'") && value.length > 1) || (value.startsWith('"') && value.endsWith('"') && value.length > 1)) {
    value = value.slice(1, -1);
  } else if (value.startsWith("$'") && value.endsWith("'")) {
    value = value.slice(2, -1).replace(/\\n/g, "\n").replace(/\\'/g, "'");
  }
  return value.replace(/\s+/g, " ").trim();
}

/** `-H 'name: value'` pairs, quoted or bare, in any mix of quote styles. */
function flagHeaders(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)(?:-H|--header)(?:\s+|=)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/gi)) {
    found.push(unquote(match[1]!));
  }
  return found;
}

/** A pasted block of headers ("Copy request headers"): one `name: value` per line, wrapped lines joined. */
function headerBlock(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let last: string | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(trimmed);
    if (pair) {
      last = pair[1]!.toLowerCase();
      map.set(last, pair[2]!.trim());
    } else if (last && !/^[A-Za-z][\w-]*:/.test(trimmed)) {
      map.set(last, `${map.get(last) ?? ""} ${trimmed}`.trim());
    } else {
      last = null;
    }
  }
  return map;
}

function headerValue(headers: readonly string[], name: string): string | null {
  for (const header of headers) {
    const at = header.toLowerCase().indexOf(`${name}:`);
    if (at === 0) {
      const value = unquote(header.slice(name.length + 1));
      if (value) return value;
    }
  }
  return null;
}

/** The `XSRF-TOKEN` the site keeps in its own cookie — the same value the header carries. */
function xsrfFromCookie(cookie: string): string | null {
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]+)/i.exec(cookie);
  return match ? unquote(match[1]!) : null;
}

function looksLikeCookie(value: string): boolean {
  return value.length >= 8 && value.length <= 8000 && /^[^\s;=]+=[^;]*/.test(value) && !/[{}]/.test(value.slice(0, 1));
}

/**
 * Whatever was pasted, as a session. A cookie without `=` is not a cookie, and a "token" with a quote or
 * a semicolon in it is not a token: those come back null with a note saying what was missing.
 */
export function parseSession(input: string): ParsedSession {
  const notes: string[] = [];
  const text = input.slice(0, MAX_PASTE).replace(/\r\n?/g, "\n").replace(/\\\s*\n/g, " ").replace(/\^\s*\n/g, " ").trim();
  const fromCurl = /^curl(\.exe)?\b/i.test(text) || /(?:^|\s)(?:-H|--header|--cookie|-b)\s/.test(text);

  const headers = flagHeaders(text);
  const block = headerBlock(text);
  for (const [name, value] of block) headers.push(`${name}: ${value}`);

  let cookie: string | null = null;
  const cookieFlag = /(?:^|\s)(?:-b|--cookie)(?:\s+|=)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/i.exec(text);
  if (cookieFlag) {
    const value = unquote(cookieFlag[1]!);
    if (looksLikeCookie(value)) {
      cookie = value;
      notes.push("Cookie 取自 curl 的 -b/--cookie");
    }
  }
  if (!cookie) {
    const fromHeader = headerValue(headers, "cookie");
    if (fromHeader && looksLikeCookie(fromHeader)) {
      cookie = fromHeader;
      notes.push("Cookie 取自请求头 cookie:");
    }
  }
  if (!cookie && !fromCurl) {
    // Just the cookie value, pasted on its own.
    const bare = unquote(text.split("\n").find((line) => looksLikeCookie(line.trim())) ?? "");
    if (bare && looksLikeCookie(bare)) {
      cookie = bare;
      notes.push("按整段 Cookie 值读取（没有 curl 或请求头）");
    }
  }
  if (!cookie) notes.push("没识别出 Cookie：整条粘 curl，或者只粘 Cookie 头的值");

  let xsrf: string | null = null;
  const fromHeaderXsrf = headerValue(headers, "x-xsrf-token");
  if (fromHeaderXsrf && fromHeaderXsrf.length >= 4 && fromHeaderXsrf.length <= 500) {
    xsrf = fromHeaderXsrf;
    notes.push("XSRF 取自请求头 X-XSRF-TOKEN");
  } else if (cookie) {
    const fromCookie = xsrfFromCookie(cookie);
    if (fromCookie && fromCookie.length >= 4 && fromCookie.length <= 500) {
      xsrf = fromCookie;
      notes.push("XSRF 取自 Cookie 里的 XSRF-TOKEN");
    }
  }
  if (!xsrf) notes.push("没识别出 XSRF：Cookie 里通常带 XSRF-TOKEN，若没有请一并粘上 X-XSRF-TOKEN 请求头");

  let baseUrl: string | null = null;
  const url = /https?:\/\/[^\s'"\\|)]+/.exec(text);
  if (url) {
    try {
      baseUrl = new URL(url[0]).origin;
      notes.push(`请求地址的域名是 ${baseUrl}`);
    } catch {
      baseUrl = null;
    }
  }

  return { cookie, xsrf, baseUrl, notes };
}
