// The pacing rules on their own: the rest between requests, the rolling hour budget, the doubling
// cooldown, which login a request goes to and what the pool reports. No database and no network — the
// random draws are passed in, so every number below is arithmetic a reviewer can check by hand.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseAccount,
  cooldownSeconds,
  hourWindowOf,
  pacingSettings,
  requestIntervalMs,
  summarizePool,
  type PacingAccount,
  type PacingSettings,
} from "../backend/pacing.ts";

const settings: PacingSettings = { intervalMs: 2_500, hourlyBudget: 90 };
const now = new Date("2026-11-07T04:00:00.000Z");
const seconds = (n: number) => new Date(now.getTime() + n * 1000);

function account(over: Partial<PacingAccount> = {}): PacingAccount {
  return {
    id: 1,
    status: "active",
    cooldown_until: null,
    next_allowed_at: null,
    requests_hour: 0,
    hour_started_at: null,
    ...over,
  };
}

test("the rest between two requests is the base interval, jittered ±30%", () => {
  assert.equal(requestIntervalMs(settings, 0), 1_750, "the low end is 0.7×");
  assert.equal(requestIntervalMs(settings, 0.5), 2_500, "the middle is the base");
  assert.equal(requestIntervalMs(settings, 1), 3_250, "the high end is 1.3×");
  assert.equal(requestIntervalMs({ intervalMs: 0, hourlyBudget: 90 }, 0.9), 0, "tests ask for no wait");
});

test("settings come from the environment and fall back when a value is unusable", () => {
  const saved = { interval: process.env.WEREAD_REQUEST_INTERVAL_MS, budget: process.env.WEREAD_HOURLY_BUDGET };
  try {
    process.env.WEREAD_REQUEST_INTERVAL_MS = "0";
    process.env.WEREAD_HOURLY_BUDGET = "12";
    assert.deepEqual(pacingSettings(), { intervalMs: 0, hourlyBudget: 12 });
    delete process.env.WEREAD_REQUEST_INTERVAL_MS;
    process.env.WEREAD_HOURLY_BUDGET = "ninety";
    assert.deepEqual(pacingSettings(), { intervalMs: 2_500, hourlyBudget: 90 });
  } finally {
    if (saved.interval === undefined) delete process.env.WEREAD_REQUEST_INTERVAL_MS;
    else process.env.WEREAD_REQUEST_INTERVAL_MS = saved.interval;
    if (saved.budget === undefined) delete process.env.WEREAD_HOURLY_BUDGET;
    else process.env.WEREAD_HOURLY_BUDGET = saved.budget;
  }
});

test("a throttled login starts at five minutes and doubles up to an hour", () => {
  assert.equal(cooldownSeconds("throttled", 1, 0.5), 300);
  assert.equal(cooldownSeconds("throttled", 2, 0.5), 600);
  assert.equal(cooldownSeconds("throttled", 3, 0.5), 1_200);
  assert.equal(cooldownSeconds("throttled", 5, 0.5), 3_600, "twenty minutes doubles to the hour cap");
  assert.equal(cooldownSeconds("throttled", 9, 0.5), 3_600);
});

test("a login the platform wants to verify starts at thirty minutes and stops at six hours", () => {
  assert.equal(cooldownSeconds("verify", 1, 0.5), 1_800);
  assert.equal(cooldownSeconds("verify", 2, 0.5), 3_600);
  assert.equal(cooldownSeconds("verify", 5, 0.5), 21_600);
  assert.equal(cooldownSeconds("verify", 8, 0.5), 21_600);
});

test("a cooldown is jittered ±15% and never leaves its cap", () => {
  assert.equal(cooldownSeconds("throttled", 1, 0), 255);
  assert.equal(cooldownSeconds("throttled", 1, 1), 345);
  assert.ok(cooldownSeconds("throttled", 8, 1) <= 3_600, "jitter cannot push past the hour cap");
  assert.ok(cooldownSeconds("verify", 8, 1) <= 21_600);
});

test("the hour budget counts a rolling hour and starts again when that hour is over", () => {
  const live = hourWindowOf(account({ requests_hour: 7, hour_started_at: seconds(-600) }), now);
  assert.deepEqual(live, { startedAt: seconds(-600), used: 7 });
  const stale = hourWindowOf(account({ requests_hour: 7, hour_started_at: seconds(-3_601) }), now);
  assert.deepEqual(stale, { startedAt: now, used: 0 });
});

test("a login with no request left this hour waits for the window to turn over", () => {
  const spent = account({ requests_hour: 90, hour_started_at: seconds(-60) });
  const choice = chooseAccount([spent], now, settings);
  assert.equal(choice.account?.id, 1, "it is still the only login the pool may use");
  assert.equal(choice.reason, "budget");
  assert.equal(choice.waitMs, 3_540_000, "the rest of the hour, then it may go again");
});

test("the next request goes to the login that may go soonest", () => {
  const cooling = account({ id: 1, status: "cooling", cooldown_until: seconds(120) });
  const resting = account({ id: 2, next_allowed_at: seconds(1) });
  const choice = chooseAccount([cooling, resting], now, settings);
  assert.equal(choice.account?.id, 2);
  assert.equal(choice.reason, "interval");
  assert.equal(choice.waitMs, 1_000);
  assert.equal(chooseAccount([account({ id: 3 }), resting], now, settings).account?.id, 3, "one that may go now wins");
  assert.equal(chooseAccount([cooling], now, settings).reason, "cooling");
});

test("a login that needs a new scan is never picked", () => {
  assert.equal(chooseAccount([account({ status: "reauth" })], now, settings).reason, "empty");
  assert.equal(chooseAccount([], now, settings).reason, "empty");
  const both = [account({ id: 1, status: "reauth" }), account({ id: 2 })];
  assert.equal(chooseAccount(both, now, settings).account?.id, 2);
});

test("a source stays on its login while that login may go, and moves when it may not", () => {
  const ready = [account({ id: 1 }), account({ id: 2 })];
  assert.equal(chooseAccount(ready, now, settings, { preferredId: 2 }).account?.id, 2, "sticky while ready");
  const busy = [account({ id: 1, next_allowed_at: seconds(30) }), account({ id: 2 })];
  assert.equal(chooseAccount(busy, now, settings, { preferredId: 1 }).account?.id, 2, "another takes over");
  assert.equal(chooseAccount(ready, now, settings, { preferredId: 9 }).account?.id, 1, "an unknown preference is ignored");
});

test("a login already tried in this request is not picked again", () => {
  const pool = [account({ id: 1 }), account({ id: 2, next_allowed_at: seconds(5) })];
  const choice = chooseAccount(pool, now, settings, { exclude: new Set([1]) });
  assert.equal(choice.account?.id, 2);
  assert.equal(chooseAccount([account({ id: 1 })], now, settings, { exclude: new Set([1]) }).reason, "empty");
});

test("the pool summary counts what may go now and when the next login may", () => {
  const snapshot = summarizePool([
    account({ id: 1, requests_hour: 3, hour_started_at: seconds(-600) }),
    account({ id: 2, status: "cooling", cooldown_until: seconds(600), requests_hour: 2, hour_started_at: seconds(-600) }),
    account({ id: 3, status: "reauth" }),
  ], now, settings);
  assert.deepEqual(snapshot, { total: 3, ready: 1, cooling: 1, reauth: 1, nextAt: seconds(600), requestsThisHour: 5 });
});
