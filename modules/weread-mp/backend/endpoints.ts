// The hosts and headers of the WeRead mobile app protocol. Exported as an object so a test can point
// every call at a local stub; production reads the real hosts.

/** The API the app talks to, the long-poll host the QR handshake uses, and the reader's web host. */
export const ENDPOINTS = {
  api: "https://i.weread.qq.com",
  longpoll: "https://long.open.weixin.qq.com",
  web: "https://weread.qq.com",
  open: "https://open.weixin.qq.com",
};

/** The WeRead app id the QR handshake authorizes against. */
export const QR_APP_ID = "wxab9b71ad2b90ff34";
export const QR_SCOPE = "snsapi_userinfo,snsapi_timeline,snsapi_friend,snsapi_favorites";

/** The app's own identity, used for the login handshake. */
export const APP_HEADERS: Record<string, string> = {
  "user-agent": "WeRead/7.5.0 (Android; 33; arm64-v8a)",
  "content-type": "application/json; charset=UTF-8",
};

/** A browser identity: the app's API rejects some endpoints from the app identity after login. */
export const WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
