// How the account pool spaces its requests: the rest one login takes between calls, the rolling hour
// budget that keeps it under the platform's limit, which login a request goes to, and how long a
// throttle or a human-verification demand keeps it out. Everything here is arithmetic over the account
// rows, so pool.ts and the tests share one rule set without a database or a network.

/** Rest between two requests on one login; WEREAD_REQUEST_INTERVAL_MS (0 in tests). */
export const DEFAULT_REQUEST_INTERVAL_MS = 2_500;
/** Requests one login may make in a rolling hour; WEREAD_HOURLY_BUDGET. */
export const DEFAULT_HOURLY_BUDGET = 90;

/** ±30% on the rest, so logins scanned in together do not hit the platform in lockstep. */
const INTERVAL_JITTER = 0.3;
/** ±15% on a cooldown that already doubles per failure, so retries do not line up either. */
const COOLDOWN_JITTER = 0.15;
/** -2014 starts at five minutes and doubles per consecutive failure, up to an hour. */
const THROTTLE_BASE_SECONDS = 5 * 60;
const THROTTLE_MAX_SECONDS = 60 * 60;
/** -2041 (the platform wants a human) starts at thirty minutes, up to six hours. */
const VERIFY_BASE_SECONDS = 30 * 60;
const VERIFY_MAX_SECONDS = 6 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;

export type CoolingKind = "throttled" | "verify";
/** What keeps a login from taking a request now; "ready" means nothing does. */
export type BlockReason = "ready" | "cooling" | "interval" | "budget";

export interface PacingSettings {
  intervalMs: number;
  hourlyBudget: number;
}

/** The pacing columns of one weread_accounts row; `AccountRow` in pool.ts satisfies it. */
export interface PacingAccount {
  id: number;
  status: string;
  cooldown_until: Date | null;
  next_allowed_at: Date | null;
  requests_hour: number;
  hour_started_at: Date | null;
}

/** WEREAD_REQUEST_INTERVAL_MS and WEREAD_HOURLY_BUDGET, with the defaults above for missing or unusable values. */
export function pacingSettings(): PacingSettings {
  const interval = Number(process.env.WEREAD_REQUEST_INTERVAL_MS);
  const budget = Number(process.env.WEREAD_HOURLY_BUDGET);
  return {
    intervalMs: Number.isFinite(interval) && interval >= 0 ? interval : DEFAULT_REQUEST_INTERVAL_MS,
    hourlyBudget: Number.isInteger(budget) && budget > 0 ? budget : DEFAULT_HOURLY_BUDGET,
  };
}

function fraction(random: number): number {
  return Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
}

/** The rest before this login's next request: the base interval with ±30% jitter. */
export function requestIntervalMs(settings: PacingSettings, random: number = Math.random()): number {
  const factor = 1 - INTERVAL_JITTER + 2 * INTERVAL_JITTER * fraction(random);
  return Math.max(0, Math.round(settings.intervalMs * factor));
}

/**
 * How long a login stays out after `level` consecutive failures of `kind` (1 is the first one): the
 * base doubles every level and is capped, then jittered ±15% without leaving the cap.
 */
export function cooldownSeconds(kind: CoolingKind, level: number, random: number = Math.random()): number {
  const base = kind === "verify" ? VERIFY_BASE_SECONDS : THROTTLE_BASE_SECONDS;
  const cap = kind === "verify" ? VERIFY_MAX_SECONDS : THROTTLE_MAX_SECONDS;
  const step = Math.min(cap, base * 2 ** Math.max(0, Math.floor(level) - 1));
  const jittered = step * (1 - COOLDOWN_JITTER + 2 * COOLDOWN_JITTER * fraction(random));
  return Math.max(1, Math.min(cap, Math.round(jittered)));
}

export interface HourWindow {
  /** When the login's current hour started counting; the caller stores it back as hour_started_at. */
  startedAt: Date;
  /** Requests already spent in that hour. */
  used: number;
}

/** The login's rolling hour: a window that is an hour old starts again at `now` with nothing spent. */
export function hourWindowOf(account: PacingAccount, now: Date): HourWindow {
  const startedAt = account.hour_started_at;
  if (!startedAt || now.getTime() - startedAt.getTime() >= HOUR_MS) return { startedAt: now, used: 0 };
  return { startedAt, used: Math.max(0, account.requests_hour) };
}

export interface Availability {
  /** The moment this login may take its next request. */
  at: Date;
  reason: BlockReason;
}

/** When this login may take a request, and what it is waiting for. */
export function availabilityOf(account: PacingAccount, now: Date, settings: PacingSettings): Availability {
  const blocks: Array<{ at: Date; reason: Exclude<BlockReason, "ready"> }> = [];
  if (account.cooldown_until && account.cooldown_until.getTime() > now.getTime()) blocks.push({ at: account.cooldown_until, reason: "cooling" });
  if (account.next_allowed_at && account.next_allowed_at.getTime() > now.getTime()) blocks.push({ at: account.next_allowed_at, reason: "interval" });
  const window = hourWindowOf(account, now);
  if (window.used >= settings.hourlyBudget) blocks.push({ at: new Date(window.startedAt.getTime() + HOUR_MS), reason: "budget" });
  if (!blocks.length) return { at: now, reason: "ready" };
  // The latest block is what actually holds the login back; on a tie the first listed reason wins.
  return blocks.reduce((latest, block) => (block.at.getTime() > latest.at.getTime() ? block : latest));
}

/** The login one request goes to, how long it waits first, and what held it back until then. */
export type PoolChoice<T extends PacingAccount> =
  | { account: T; waitMs: number; reason: BlockReason }
  | { account: null; waitMs: 0; reason: "empty" };

const NOTHING_EXCLUDED: ReadonlySet<number> = new Set();

/**
 * The login the next request goes to: never one that needs a new scan, never one already tried, and,
 * among the rest, the one that may go soonest. `preferredId` stays the pick while that login is ready,
 * so a source keeps reusing the session it activated instead of waking a second login's session.
 */
export function chooseAccount<T extends PacingAccount>(
  accounts: readonly T[],
  now: Date,
  settings: PacingSettings,
  { preferredId = null, exclude = NOTHING_EXCLUDED }: { preferredId?: number | null; exclude?: ReadonlySet<number> } = {},
): PoolChoice<T> {
  const candidates = accounts
    .filter((account) => account.status !== "reauth" && !exclude.has(account.id))
    .map((account) => ({ account, availability: availabilityOf(account, now, settings) }));
  if (!candidates.length) return { account: null, waitMs: 0, reason: "empty" };
  const preferred = preferredId === null
    ? undefined
    : candidates.find((candidate) => candidate.account.id === preferredId && candidate.availability.reason === "ready");
  const best = preferred
    ?? candidates.reduce((soonest, candidate) => (candidate.availability.at.getTime() < soonest.availability.at.getTime() ? candidate : soonest));
  return { account: best.account, waitMs: Math.max(0, best.availability.at.getTime() - now.getTime()), reason: best.availability.reason };
}

export interface PoolSnapshot {
  total: number;
  /** Logins that may take a request now. */
  ready: number;
  /** Logins held back by a throttle/verification cooldown. */
  cooling: number;
  /** Logins that need a new scan. */
  reauth: number;
  /** When the pool may take a request again, if none may now. */
  nextAt: Date | null;
  /** Requests every login made in its current hour, together. */
  requestsThisHour: number;
}

/** The pool's headline numbers for the admin page. */
export function summarizePool(accounts: readonly PacingAccount[], now: Date, settings: PacingSettings): PoolSnapshot {
  let ready = 0;
  let cooling = 0;
  let reauth = 0;
  let requestsThisHour = 0;
  let nextAt: Date | null = null;
  for (const account of accounts) {
    requestsThisHour += hourWindowOf(account, now).used;
    if (account.status === "reauth") {
      reauth += 1;
      continue;
    }
    const availability = availabilityOf(account, now, settings);
    if (availability.reason === "ready") ready += 1;
    else if (availability.reason === "cooling") cooling += 1;
    if (availability.reason !== "ready" && (!nextAt || availability.at.getTime() < nextAt.getTime())) nextAt = availability.at;
  }
  return { total: accounts.length, ready, cooling, reauth, nextAt, requestsThisHour };
}
