// WeChat identifiers used across the module: a WeRead account id (MP_WXS_<uin>), the __biz a WeChat
// page carries, a review id (MP_WXS_<uin>_<short id>) and the short article link built from it.

const SHORT_ID = /^[A-Za-z0-9_~-]{15,}$/;

/** Whether a config value names a WeRead WeChat-account book. */
export function isWereadBookId(value: unknown): value is string {
  return typeof value === "string" && /^MP_WXS_\d+$/.test(value);
}

/** The article's short link id, when the review id carries one. */
export function shortIdFromReviewId(reviewId: string): string {
  const match = /^MP_WXS_[0-9]+_([A-Za-z0-9_~-]{15,})$/.exec(reviewId);
  return match ? match[1]!.replace(/~/g, "_") : "";
}

/** The public article URL WeRead's review id stands for, or "" when it has no short id. */
export function shortUrlForReview(reviewId: string): string {
  const short = shortIdFromReviewId(reviewId);
  return short ? `https://mp.weixin.qq.com/s/${short}` : "";
}

/** WeChat writes "~" into short links in some places; the canonical link has "_". */
export function normalizeWechatShortUrl(url: string): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    if (parsed.hostname !== "mp.weixin.qq.com" || parsed.username || parsed.password) return url;
    if (parsed.port && parsed.port !== "80" && parsed.port !== "443") return url;
    if (!parsed.pathname.startsWith("/s/")) return url;
    const short = parsed.pathname.slice(3);
    if (short.includes("/") || !SHORT_ID.test(short) || !short.includes("~")) return url;
    parsed.pathname = `/s/${short.replace(/~/g, "_")}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

/** A WeChat __biz (base64 of the account's uin) to WeRead's book id. */
export function bookIdFromBiz(value: string): string {
  const fid = value.trim();
  if (!fid) return "";
  if (fid.startsWith("MP_")) return fid;
  let raw = fid;
  try {
    raw = decodeURIComponent(fid).trim();
  } catch {
    raw = fid;
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8").trim();
    if (/^\d+$/.test(decoded)) return `MP_WXS_${decoded}`;
  }
  if (/^\d+$/.test(fid)) return `MP_WXS_${fid}`;
  return fid;
}

/** The __biz for a WeRead book id, as an article link carries it. */
export function bizFromBookId(bookId: string): string {
  const match = /^MP_WXS_(\d+)$/.exec(bookId.trim());
  return match ? Buffer.from(match[1]!, "utf8").toString("base64") : bookId.trim();
}
