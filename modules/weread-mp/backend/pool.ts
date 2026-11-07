// The account pool: the WeRead logins an administrator scanned in, their tokens, pacing and cooldowns,
// and the request path every other module file uses. One account is normally enough; a second lets
// collection continue while the first cools down after a platform throttle.
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "@aihot/backend/db";
import { APP_HEADERS, ENDPOINTS, WEB_UA } from "./endpoints.ts";
import { call, classify, errcodeOf, WereadError, type FailureKind } from "./http.ts";
import {
  chooseAccount, cooldownSeconds, hourWindowOf, pacingSettings, requestIntervalMs, summarizePool,
  type BlockReason, type CoolingKind, type PacingSettings,
} from "./pacing.ts";
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
  next_allowed_at: Date | null;
  requests_hour: number;
  hour_started_at: Date | null;
  cooldown_level: number;
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
  nextAllowedAt: string | null;
  requestsHour: number;
  hourlyBudget: number;
  cooldownLevel: number;
}

/** The pool's own state, next to the accounts it shows. */
export interface PoolView {
  total: number;
  ready: number;
  cooling: number;
  reauth: number;
  /** When a login may take the next request, if none may now. */
  nextAt: string | null;
  requestsThisHour: number;
  hourlyBudget: number;
  intervalMs: number;
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

function viewOf(row: AccountRow, settings: PacingSettings, now: Date): AccountView {
  return {
    id: row.id,
    vid: row.vid,
    nickname: row.nickname,
    avatar: row.avatar,
    // A finished cooldown leaves the column as it was: the badge follows the clock, not the last write,
    // so an account that cooled down last night does not look blocked this morning.
    status: row.status === "cooling" && !(row.cooldown_until && row.cooldown_until.getTime() > now.getTime()) ? "active" : row.status,
    failCount: row.fail_count,
    cooldownUntil: row.cooldown_until?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    nextAllowedAt: row.next_allowed_at?.toISOString() ?? null,
    requestsHour: row.requests_hour,
    hourlyBudget: settings.hourlyBudget,
    cooldownLevel: row.cooldown_level,
  };
}

export async function listAccounts(): Promise<AccountView[]> {
  const rows = await sql<AccountRow[]>`SELECT * FROM weread_accounts ORDER BY created_at`;
  const settings = pacingSettings();
  const now = new Date();
  return rows.map((row) => viewOf(row, settings, now));
}

/** The accounts plus the pool's headline: how many may go now and when the next one may. */
export async function accountPool(): Promise<{ accounts: AccountView[]; pool: PoolView }> {
  const settings = pacingSettings();
  const rows = await sql<AccountRow[]>`SELECT * FROM weread_accounts ORDER BY created_at`;
  const now = new Date();
  const snapshot = summarizePool(rows, now, settings);
  return {
    accounts: rows.map((row) => viewOf(row, settings, now)),
    pool: {
      total: snapshot.total,
      ready: snapshot.ready,
      cooling: snapshot.cooling,
      reauth: snapshot.reauth,
      nextAt: snapshot.nextAt?.toISOString() ?? null,
      requestsThisHour: snapshot.requestsThisHour,
      hourlyBudget: settings.hourlyBudget,
      intervalMs: settings.intervalMs,
    },
  };
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

/** Stores a freshly scanned login, or replaces the same WeRead user's earlier tokens and pacing state. */
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
      cooldown_level = 0, next_allowed_at = NULL, requests_hour = 0, hour_started_at = NULL,
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

/**
 * What the pool can give one request: a login with the wait it needs first, a wait that belongs to the
 * next scheduling cycle, or no login at all.
 */
type Reservation =
  | { kind: "ready"; session: Session; waitMs: number; poolSize: number }
  | { kind: "waiting"; reason: Exclude<BlockReason, "ready">; waitMs: number; poolSize: number }
  | { kind: "empty" };

/**
 * Picks this request's login and counts the request against its hour budget before it goes out, so two
 * collectors cannot spend the same slot. The row locks are held while choosing, not while waiting.
 */
async function reserve(preferredId: number | null = null, exclude: ReadonlySet<number> = new Set()): Promise<Reservation> {
  const settings = pacingSettings();
  const now = new Date();
  const reserved = await sql.begin(async (tx) => {
    const rows = await tx<AccountRow[]>`SELECT * FROM weread_accounts ORDER BY id FOR UPDATE`;
    const poolSize = rows.filter((row) => row.status !== "reauth" && !exclude.has(row.id)).length;
    const choice = chooseAccount(rows, now, settings, { preferredId, exclude });
    if (!choice.account) return { kind: "empty" as const };
    if (choice.reason !== "ready" && choice.reason !== "interval") {
      return { kind: "waiting" as const, reason: choice.reason, waitMs: choice.waitMs, poolSize };
    }
    const window = hourWindowOf(choice.account, now);
    // next_allowed_at covers the wait this request takes before it goes out, so the rest is measured
    // from when the request is actually made rather than from when it was picked.
    const interval = requestIntervalMs(settings);
    const [row] = await tx<AccountRow[]>`
      UPDATE weread_accounts SET
        last_used_at = now(), requests_hour = ${window.used + 1}, hour_started_at = ${window.startedAt},
        status = CASE WHEN status = 'cooling' THEN 'active' ELSE status END,
        cooldown_until = CASE WHEN cooldown_until IS NOT NULL AND cooldown_until <= now() THEN NULL ELSE cooldown_until END,
        next_allowed_at = now() + make_interval(secs => ${(choice.waitMs + interval) / 1000}),
        updated_at = now()
      WHERE id = ${choice.account.id}
      RETURNING *`;
    return { kind: "ready" as const, row: row!, waitMs: choice.waitMs, poolSize };
  });
  if (reserved.kind !== "ready") return reserved;
  try {
    return { kind: "ready", session: sessionOf(reserved.row), waitMs: reserved.waitMs, poolSize: reserved.poolSize };
  } catch (error) {
    await markReauth(reserved.row.id, message(error));
    throw error;
  }
}

/** The pool has nothing to give this cycle: cooling, out of hour budget, or every login needs a scan. */
function poolCoolingError(reason: Exclude<BlockReason, "ready">, waitMs: number): WereadError {
  const why = reason === "budget" ? "本小时请求预算已用完" : "账号都在冷却";
  const wait = waitMs >= 60_000 ? `约 ${Math.max(1, Math.round(waitMs / 60_000))} 分钟后` : "稍后";
  return new WereadError(`账号池冷却中（${why}，${wait}可再请求）；这次检查跳过，等下一个调度周期`, "throttled");
}

/**
 * The login one call may use now, after waiting out an ordinary pacing gap. Throws when the pool has
 * nothing usable, so a caller never sends a request into a cooldown.
 */
export async function borrowAccount(preferredId: number | null = null): Promise<Session> {
  const outcome = await reserve(preferredId);
  if (outcome.kind === "empty") throw new WereadError("账号池中没有可用的微信读书账号，请先在后台扫码登录", "auth");
  if (outcome.kind === "waiting") throw poolCoolingError(outcome.reason, outcome.waitMs);
  await sleep(outcome.waitMs);
  return outcome.session;
}

/** One source's request path: every WeRead request picks a login, waits its pacing gap, and moves on. */
export type PooledCaller = <T>(fn: (session: Session) => Promise<T>) => Promise<T>;

/**
 * The pool's request path for one collection check. Each request takes the soonest login with budget,
 * waits only its ordinary pacing rest (a cooldown or an exhausted hour budget ends the check instead of
 * stretching it), and when the platform throttles, demands verification or rejects the tokens, the same
 * request moves to the next login — at most once per login in the pool.
 */
export function pooledCaller(): PooledCaller {
  // Sticky: while one login keeps answering, the rest of this check reuses the session it activated.
  let preferredId: number | null = null;
  const failed = new Set<number>();
  return async <T>(fn: (session: Session) => Promise<T>): Promise<T> => {
    let lastError: WereadError | null = null;
    for (;;) {
      const outcome = await reserve(preferredId, failed);
      if (outcome.kind === "empty") throw lastError ?? new WereadError("账号池中没有可用的微信读书账号，请先在后台扫码登录", "auth");
      if (outcome.kind === "waiting") throw lastError ?? poolCoolingError(outcome.reason, outcome.waitMs);
      await sleep(outcome.waitMs);
      try {
        const result = await fn(outcome.session);
        preferredId = outcome.session.id;
        return result;
      } catch (error) {
        if (!(error instanceof WereadError)) throw error;
        // Other failures (a bad path, a 500) would fail on every login just the same: report them as is.
        if (error.kind !== "throttled" && error.kind !== "verify" && error.kind !== "auth") throw error;
        failed.add(outcome.session.id);
        preferredId = null;
        lastError = error;
        if (failed.size >= outcome.poolSize) {
          throw new WereadError(`账号池冷却中（${error.message}）；这次检查跳过，等下一个调度周期`, "throttled");
        }
      }
    }
  };
}

export async function markSuccess(id: number): Promise<void> {
  await sql`UPDATE weread_accounts SET fail_count = 0, cooldown_level = 0, last_error = NULL, updated_at = now() WHERE id = ${id}`;
}

/**
 * A temporary platform refusal: this login is not used again until its cooldown ends, and each
 * consecutive refusal doubles that cooldown (`cooldown_level`) up to what the kind allows.
 */
export async function cool(id: number, kind: CoolingKind, error: string): Promise<void> {
  const [row] = await sql<{ cooldown_level: number }[]>`SELECT cooldown_level FROM weread_accounts WHERE id = ${id}`;
  const level = Math.max(0, row?.cooldown_level ?? 0) + 1;
  const seconds = cooldownSeconds(kind, level);
  await sql`UPDATE weread_accounts SET status = 'cooling', cooldown_level = ${level},
              cooldown_until = now() + make_interval(secs => ${seconds}),
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
  await paceRequest(row.id);
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
    if (kind === "throttled") await cool(row.id, "throttled", error);
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
/**
 * Counts one request a login makes outside the pooled path (session activation, a token refresh) against
 * its hour budget, and waits the ordinary rest first: these calls reuse the session already in hand
 * instead of picking one, so without this they would land back to back on the same login.
 */
async function paceRequest(id: number): Promise<void> {
  const interval = requestIntervalMs(pacingSettings());
  await sql`
    UPDATE weread_accounts SET
      last_used_at = now(),
      requests_hour = CASE WHEN hour_started_at IS NULL OR hour_started_at <= now() - interval '1 hour'
        THEN 1 ELSE requests_hour + 1 END,
      hour_started_at = CASE WHEN hour_started_at IS NULL OR hour_started_at <= now() - interval '1 hour'
        THEN now() ELSE hour_started_at END,
      next_allowed_at = now() + make_interval(secs => ${interval / 1000}),
      updated_at = now()
    WHERE id = ${id}`;
  await sleep(interval);
}

export async function activateSession(session: Session): Promise<void> {
  const headers = { ...headersOf(session), "user-agent": WEB_UA };
  try {
    await paceRequest(session.id);
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
  await paceRequest(session.id);
  await call(`${ENDPOINTS.api}/shelf/sync?synckey=0`, { headers, timeoutMs: 10_000 }).catch(() => undefined);
  await paceRequest(session.id);
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
 * down and asks the pool's caller to try another account.
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
      const text = "微信读书要求人机验证（-2041），这个账号已暂停，稍后自动重试；仍失败请重新扫码";
      await cool(current.id, "verify", text);
      throw new WereadError(text, "verify", answer.status, errcode);
    }
    if (kind === "throttled") {
      const text = "微信读书限流（-2014），这个账号已暂停，稍后自动重试";
      await cool(current.id, "throttled", text);
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

/** Runs one call on the next usable account. */
export async function withAccount<T>(fn: (session: Session) => Promise<T>): Promise<T> {
  return fn(await borrowAccount());
}
