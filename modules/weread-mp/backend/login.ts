// The WeChat QR handshake that turns a phone scan into a WeRead login. The browser shows the image and
// polls while this module long-polls the QR channel; a confirmed scan is exchanged for tokens, which go
// into the account pool sealed. Attempts live in this process only: a restart means scanning again.
import { randomUUID } from "node:crypto";
import { APP_HEADERS, ENDPOINTS, QR_APP_ID, QR_SCOPE, WEB_UA } from "./endpoints.ts";
import { call, callJson, errcodeOf } from "./http.ts";
import { activateAccount, saveAccount } from "./pool.ts";
import { antiReplaySignature, newDeviceProfile, type DeviceProfile } from "./signer.ts";

export type LoginStatus = "scanning" | "scanned" | "success" | "expired" | "failed";

export interface LoginView {
  status: LoginStatus;
  message: string;
  account?: { vid: string; nickname: string; avatar: string };
}

interface Attempt {
  id: string;
  uuid: string;
  status: LoginStatus;
  message: string;
  device: DeviceProfile;
  last: string | null;
  createdAt: number;
  expiresAt: number;
  account?: LoginView["account"];
}

const ATTEMPT_TTL_MS = 5 * 60_000;
const attempts = new Map<string, Attempt>();

function prune(now: number): void {
  for (const [id, attempt] of attempts) {
    if (now - attempt.createdAt > ATTEMPT_TTL_MS * 2) attempts.delete(id);
  }
  // The admin opens one scan at a time; keep a handful in case of a race between two tabs.
  while (attempts.size > 5) attempts.delete(attempts.keys().next().value!);
}

export interface StartedLogin {
  loginId: string;
  qr: string;
  expiresAt: string;
}

export async function startLogin(): Promise<StartedLogin> {
  const now = Date.now();
  prune(now);
  const ticket = await callJson(`${ENDPOINTS.api}/wxticket?nonceStr=weread`, { headers: APP_HEADERS });
  const timestamp = ticket.timeStamp;
  const signature = ticket.signature;
  if (timestamp === undefined || typeof signature !== "string") throw new Error("微信读书没有返回扫码票据");
  const params = new URLSearchParams({
    appid: QR_APP_ID,
    noncestr: "weread",
    timestamp: String(timestamp),
    scope: QR_SCOPE,
    signature,
  });
  const qr = await callJson(`${ENDPOINTS.open}/connect/sdk/qrconnect?${params.toString()}`, { headers: APP_HEADERS });
  const uuid = typeof qr.uuid === "string" ? qr.uuid : "";
  if (!uuid) throw new Error("微信没有返回二维码 uuid");
  const code = qr.qrcode;
  const base64 = code && typeof code === "object" ? String((code as Record<string, unknown>).qrcodebase64 ?? "") : "";
  const image = base64 ? `data:image/jpeg;base64,${base64}` : `${ENDPOINTS.open}/connect/qrcode/${uuid}`;
  const id = randomUUID();
  const expiresAt = now + ATTEMPT_TTL_MS;
  attempts.set(id, { id, uuid, status: "scanning", message: "请用微信扫描二维码，并在手机上确认登录", device: newDeviceProfile(), last: null, createdAt: now, expiresAt });
  return { loginId: id, qr: image, expiresAt: new Date(expiresAt).toISOString() };
}

function errcode(json: unknown, text: string): number | null {
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    const value = o.wx_errcode ?? o.errcode;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const match = /["']?wx_errcode["']?\s*[:=]\s*(\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** One long-poll step. The browser calls this every few seconds while the image is on screen. */
export async function pollLogin(id: string): Promise<LoginView> {
  const attempt = attempts.get(id);
  if (!attempt) return { status: "failed", message: "这次扫码已经结束，请重新生成二维码" };
  if (attempt.status === "success" || attempt.status === "failed" || attempt.status === "expired") return view(attempt);
  if (Date.now() > attempt.expiresAt) {
    attempt.status = "expired";
    attempt.message = "二维码已过期，请重新生成";
    return view(attempt);
  }
  const url = `${ENDPOINTS.longpoll}/connect/l/qrconnect?f=json&uuid=${encodeURIComponent(attempt.uuid)}${attempt.last ? `&last=${attempt.last}` : ""}`;
  let answer;
  try {
    answer = await call(url, { headers: { "user-agent": WEB_UA }, timeoutMs: 25_000, maxBytes: 64 * 1024 });
  } catch {
    // A long poll that timed out or lost its answer just means "keep waiting".
    return view(attempt);
  }
  const code = errcode(answer.json, answer.text);
  if (code === 405) {
    const json = (answer.json ?? {}) as Record<string, unknown>;
    const wxCode = typeof json.wx_code === "string" ? json.wx_code : "";
    attempt.status = "success";
    attempt.message = "已确认，正在换取微信读书登录凭据…";
    if (!wxCode) {
      attempt.status = "failed";
      attempt.message = `微信没有返回授权码${errcodeOf(answer.json, answer.text) === null ? "" : "（扫码票据被拒绝）"}`;
      return view(attempt);
    }
    try {
      const account = await exchange(wxCode, attempt.device);
      attempt.account = account;
      attempt.message = `登录成功：${account.nickname}`;
      await activateAccount(account.vid);
    } catch (error) {
      attempt.status = "failed";
      attempt.message = `换取微信读书凭据失败：${String(error instanceof Error ? error.message : error).slice(0, 200)}`;
    }
    return view(attempt);
  }
  if (code === 404) {
    attempt.status = "scanned";
    attempt.message = "已扫码，请在手机微信上点击确认";
    attempt.last = "404";
    return view(attempt);
  }
  if (code === 402 || code === 403) {
    attempt.status = "expired";
    attempt.message = "二维码已失效，请重新生成";
    return view(attempt);
  }
  // 408 (and anything unexpected) means the scan has not happened yet.
  attempt.status = "scanning";
  attempt.message = "请用微信扫描二维码，并在手机上确认登录";
  return view(attempt);
}

function view(attempt: Attempt): LoginView {
  return { status: attempt.status, message: attempt.message, ...(attempt.account ? { account: attempt.account } : {}) };
}

interface LoginAnswer {
  vid?: unknown;
  accessToken?: unknown;
  refreshToken?: unknown;
  skey?: unknown;
  user?: { name?: unknown; avatar?: unknown };
}

async function exchange(wxCode: string, device: DeviceProfile): Promise<{ vid: string; nickname: string; avatar: string }> {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000);
  const answer = await callJson(`${ENDPOINTS.api}/login`, {
    method: "POST",
    headers: { ...APP_HEADERS, "user-agent": device.userAgent },
    body: {
      code: wxCode,
      deviceId: device.deviceId,
      trackId: "",
      timestamp,
      random,
      signature: antiReplaySignature(device.deviceId, timestamp, random),
      wxToken: 1,
      appFirstInstall: 0,
      virtualChannelId: "",
      installId: device.installId,
      isFromQrcode: 1,
      isAutoLogout: 0,
      deviceName: "Android",
      deviceType: 1,
    },
  });
  const data = answer as LoginAnswer;
  const vid = data.vid === undefined || data.vid === null ? "" : String(data.vid);
  const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
  if (!vid || !accessToken) throw new Error("微信读书登录接口没有返回 vid 或 accessToken");
  const user = data.user ?? {};
  const nickname = typeof user.name === "string" && user.name ? user.name : `微信读书用户 ${vid}`;
  const avatar = typeof user.avatar === "string" ? user.avatar : "";
  await saveAccount({
    vid,
    nickname,
    avatar,
    accessToken,
    refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : null,
    skey: typeof data.skey === "string" && data.skey ? data.skey : accessToken,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    installId: device.installId,
    userAgent: device.userAgent,
  });
  return { vid, nickname, avatar };
}
