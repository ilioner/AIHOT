// The account pool: the WeRead logins an administrator scanned in, their tokens, cooldowns and the
// request path every other module file uses. One account is normally enough; a second lets collection
// continue while the first cools down after a platform throttle.
import { sql } from "@aihot/backend/db";
import { APP_HEADERS, ENDPOINTS, WEB_UA } from "./endpoints.ts";
import { call, classify, errcodeOf, WereadError, type FailureKind } from "./http.ts";
import { open, seal, SealedCredentialError } from "./secret.ts";
import { genSignature } from "./signer.ts";

export type AccountStatus = "active" | "cooling" | "reauth";

export interface AccountRow {
  id: number;
  vid: string;
  nickname: string;
  avatar: string;
  access_token: string;
  refresh_token: string | null;
  skey: string;
  device_id: string;
  device_name: string;
  install_id: string;
  user_agent: string;
  status: AccountStatus;
  fail_count: number;
  cooldown_until: Date | null;
  last_used_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

/** A usable login: the row's identity plus its tokens in the clear. */
export interface Session {
  id: number;
  vid: string;
  accessToken: string;
  skey: string;
  row: AccountRow;
}

export interface AccountView {
  id: number;
  vid: string;
  nickname: string;
  avatar: string;
  status: AccountStatus;
  failCount: number;
  cooldownUntil: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

const message = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 300);

/** The cookie WeRead's web pages and the reader endpoint expect for this login. */
export function cookieOf(session: Session): string {
  return `wr_vid=${session.vid}; wr_skey=${session.skey}`;
}

function headersOf(session: Session): Record<string, string> {
  return {
    "user-agent": WEB_UA,
    "content-type": "application/json; charset=UTF-8",
    vid: session.vid,
    accessToken: session.accessToken,
    skey: session.skey,
    cookie: cookieOf(session),
  };
}

export async function listAccounts(): Promise<AccountView[]> {
  const rows = await sql<AccountRow[]>`
    SELECT * FROM weread_accounts ORDER BY created_at`;
  return rows.map((row) => ({
    id: row.id,
    vid: row.vid,
    nickname: row.nickname,
    avatar: row.avatar,
    status: row.status,
    failCount: row.fail_count,
    cooldownUntil: row.cooldown_until?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
  }));
}

export interface NewAccount {
  vid: string;
  nickname: string;
  avatar: string;
  accessToken: string;
  refreshToken: string | null;
  skey: string;
  deviceId: string;
  deviceName: string;
  installId: string;
  userAgent: string;
}

/** Stores a freshly scanned login, or replaces the same WeRead user's earlier tokens. */
export async function saveAccount(account: NewAccount): Promise<void> {
  await sql`
    INSERT INTO weread_accounts (vid, nickname, avatar, access_token, refresh_token, skey, device_id, device_name, install_id, user_agent)
    VALUES (${account.vid}, ${account.nickname}, ${account.avatar}, ${seal(account.accessToken)}, ${account.refreshToken ? seal(account.refreshToken) : null},
            ${seal(account.skey)}, ${account.deviceId}, ${account.deviceName}, ${account.installId}, ${account.userAgent})
    ON CONFLICT (vid) DO UPDATE SET
      nickname = EXCLUDED.nickname, avatar = EXCLUDED.avatar,
      access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, skey = EXCLUDED.skey,
      device_id = EXCLUDED.device_id, device_name = EXCLUDED.device_name, install_id = EXCLUDED.install_id,
      user_agent = EXCLUDED.user_agent, status = 'active', fail_count = 0, cooldown_until = NULL,
      last_error = NULL, updated_at = now()`;
}

/** The stored row, for callers that must hand it to refreshAccount. */
export async function accountRow(id: number): Promise<AccountRow | null> {
  const [row] = await sql<AccountRow[]>`SELECT * FROM weread_accounts WHERE id = ${id}`;
  return row ?? null;
}

export async function deleteAccount(id: number): Promise<boolean> {
  const rows = await sql`DELETE FROM weread_accounts WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

function sessionOf(row: AccountRow): Session {
  try {
    return {
      id: row.id,
      vid: row.vid,
      accessToken: open(row.access_token),
      skey: open(row.skey),
      row,
    };
  } catch (error) {
    if (error instanceof SealedCredentialError) throw new WereadError(`账号 ${row.nickname || row.vid} 的凭据无法解密，需要重新扫码登录`, "auth");
    throw error;
  }
}

/** The next account that may be used now, or null when every login is cooling or needs a new scan. */
export async function borrowAccount(): Promise<Session | null> {
  await sql`UPDATE weread_accounts SET status = 'active', cooldown_until = NULL, updated_at = now()
            WHERE status = 'cooling' AND cooldown_until IS NOT NULL AND cooldown_until <= now()`;
  const [row] = await sql<AccountRow[]>`
    UPDATE weread_accounts SET last_used_at = now(), updated_at = now()
    WHERE id = (
      SELECT id FROM weread_accounts WHERE status = 'active'
      ORDER BY last_used_at NULLS FIRST, id LIMIT 1
    ) RETURNING *`;
  if (!row) return null;
  try {
    return sessionOf(row);
  } catch (error) {
    await markReauth(row.id, message(error));
    throw error;
  }
}

export async function markSuccess(id: number): Promise<void> {
  await sql`UPDATE weread_accounts SET fail_count = 0, last_error = NULL, updated_at = now() WHERE id = ${id}`;
}

/** A temporary platform refusal: this login is not used again until the cooldown ends. */
export async function cool(id: number, seconds: number, error: string): Promise<void> {
  await sql`UPDATE weread_accounts SET status = 'cooling', cooldown_until = now() + make_interval(secs => ${seconds}),
              fail_count = fail_count + 1, last_error = ${error}, updated_at = now() WHERE id = ${id}`;
}

/** The stored tokens are no longer accepted and a refresh did not help: the person must scan again. */
export async function markReauth(id: number, error: string): Promise<void> {
  await sql`UPDATE weread_accounts SET status = 'reauth', fail_count = fail_count + 1, last_error = ${error}, updated_at = now() WHERE id = ${id}`;
}

/** Exchanges the long-lived refresh token for current access tokens, and stores what came back. */
export async function refreshAccount(row: AccountRow): Promise<Session | null> {
  let refreshToken: string;
  try {
    refreshToken = row.refresh_token ? open(row.refresh_token) : "";
  } catch (error) {
    await markReauth(row.id, message(error));
    return null;
  }
  if (!refreshToken) {
    await markReauth(row.id, "账号没有 refreshToken，需要重新扫码登录");
    return null;
  }
  const now = Date.now();
  const random = Math.floor(Math.random() * 1000);
  // A network failure says nothing about the tokens: it propagates and the account stays as it is.
  const answer = await call(`${ENDPOINTS.api}/login`, {
    method: "POST",
    headers: APP_HEADERS,
    body: {
      refreshToken,
      deviceId: row.device_id,
      wxToken: 0,
      inBackground: 0,
      trackId: "",
      kickType: 1,
      refCgi: "",
      timestamp: now,
      random,
      signature: genSignature(["", row.device_id, String(now), String(random), refreshToken]),
      virtualChannelId: "",
      deviceName: row.device_name || "Android",
    },
  });
  const json = (answer.json ?? {}) as Record<string, unknown>;
  const accessToken = typeof json.accessToken === "string" ? json.accessToken : "";
  const nextRefresh = typeof json.refreshToken === "string" && json.refreshToken ? json.refreshToken : refreshToken;
  const skey = typeof json.skey === "string" && json.skey ? json.skey : accessToken;
  if (answer.status !== 200 || !accessToken) {
    const kind: FailureKind = classify(answer);
    const error = `刷新登录凭据失败：HTTP ${answer.status}${errcodeOf(json, answer.text) === null ? "" : ` (${errcodeOf(json, answer.text)})`}`;
    if (kind === "throttled") await cool(row.id, 300, error);
    else await markReauth(row.id, error);
    return null;
  }
  const [updated] = await sql<AccountRow[]>`
    UPDATE weread_accounts SET access_token = ${seal(accessToken)}, refresh_token = ${seal(nextRefresh)}, skey = ${seal(skey)},
      status = 'active', cooldown_until = NULL, last_error = NULL, updated_at = now()
    WHERE id = ${row.id} RETURNING *`;
  return updated ? sessionOf(updated) : null;
}

/** Reports a mobile session as online; the API refuses some listing calls until this has happened once. */
export async function activateSession(session: Session): Promise<void> {
  const headers = { ...headersOf(session), "user-agent": WEB_UA };
  try {
    await call(`${ENDPOINTS.api}/mobileSync`, {
      method: "POST",
      headers,
      timeoutMs: 10_000,
      body: {
        shelf: 0, bookInventory: 0, shelfLecture: 0, notifications: 0, config: 0, gift: 0, payItem: 0, balance: 0.0,
        reviewTimeline: 0, follower: 0, readingExchange: 0, chat: 0, chatRemovedSynckey: 0, wechatFriend: 0,
        inBackground: 0, refluxSynckey: 0, following: 0, applyList: 0, mcard: 0, discoverFeedSynckey: 0,
        rateSynckey: 0, browse: 0, medal: 0, medalUrl: 0, regionResource: 0, discoverColumnSynckey: 0,
        friendReviewSynckey: 0, wehearSyncKey: 0, preferTab: 1, localBrowseTab: "", localCommunityTab: "",
      },
    });
  } catch {
    // Best effort: the listing call that follows reports what still does not work.
    return;
  }
  await call(`${ENDPOINTS.api}/shelf/sync?synckey=0`, { headers, timeoutMs: 10_000 }).catch(() => undefined);
  await call(`${ENDPOINTS.api}/mp/list?listType=0&count=50&synckey=0`, { headers, timeoutMs: 10_000 }).catch(() => undefined);
}

export interface ApiOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
  /** Extra headers for this call (the reader's web endpoints take the same cookie). */
  headers?: Record<string, string>;
}

/**
 * ONE account's API call, with the recovery the mobile app performs: a 401 quietly refreshes the
 * tokens and retries once; -2041 activates the mobile session and retries once; -2014 cools the login
 * down for five minutes and asks the caller to try again later.
 */
export async function callApi(session: Session, path: string, opts: ApiOptions = {}): Promise<Record<string, unknown>> {
  let current = session;
  let activated = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let answer;
    try {
      answer = await call(`${ENDPOINTS.api}${path}`, {
        method: opts.method,
        body: opts.body,
        headers: { ...headersOf(current), ...(opts.headers ?? {}) },
        timeoutMs: opts.timeoutMs,
        maxBytes: opts.maxBytes,
      });
    } catch (error) {
      throw error instanceof WereadError ? error : new WereadError(message(error), "network");
    }
    if (answer.status === 200) {
      await markSuccess(current.id).catch(() => undefined);
      return (answer.json ?? {}) as Record<string, unknown>;
    }
    const kind = classify(answer);
    const errcode = errcodeOf(answer.json, answer.text);
    const failure = `weread HTTP ${answer.status}${errcode === null ? "" : ` (${errcode})`}`;
    if (kind === "auth") {
      const refreshed = await refreshAccount(current.row);
      if (refreshed) {
        current = refreshed;
        continue;
      }
      throw new WereadError("微信读书登录凭据已失效，请在后台重新扫码", "auth", answer.status, errcode);
    }
    if (kind === "verify" && !activated) {
      activated = true;
      await activateSession(current);
      continue;
    }
    if (kind === "verify") {
      const text = "微信读书要求人机验证（-2041），这个账号暂停 30 分钟；仍失败请重新扫码";
      await cool(current.id, 1800, text);
      throw new WereadError(text, "verify", answer.status, errcode);
    }
    if (kind === "throttled") {
      const text = "微信读书限流（-2014），这个账号暂停 5 分钟";
      await cool(current.id, 300, text);
      throw new WereadError(text, "throttled", answer.status, errcode);
    }
    throw new WereadError(failure, "other", answer.status, errcode);
  }
  throw new WereadError("微信读书请求重试后仍然失败", "other");
}

/** Reports a just-scanned login as an online mobile session; best effort, as the app does after login. */
export async function activateAccount(vid: string): Promise<void> {
  const [row] = await sql<AccountRow[]>`SELECT * FROM weread_accounts WHERE vid = ${vid}`;
  if (!row) return;
  try {
    await activateSession(sessionOf(row));
  } catch {
    // A failure here does not undo the login; collection reports it if the session stays inactive.
  }
}

/** Runs a call on the next usable account, or reports that none is available. */
export async function withAccount<T>(fn: (session: Session) => Promise<T>): Promise<T> {
  const session = await borrowAccount();
  if (!session) throw new WereadError("账号池中没有可用的微信读书账号，请先在后台扫码登录", "auth");
  return fn(session);
}
