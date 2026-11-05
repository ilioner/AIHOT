// The account pool's tokens at rest. A refresh token is a login credential: the database holds it
// sealed with AES-256-GCM under a key derived from the site's SESSION_SECRET, and the admin API never
// returns it. Rotating SESSION_SECRET makes stored tokens unreadable; the account then shows as needing
// a new scan instead of failing silently.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { credential } from "@aihot/backend/config";

export class SealedCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedCredentialError";
  }
}

function key(): Buffer {
  const secret = credential("auth", "SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is required to seal the WeRead credentials");
  return createHash("sha256").update(`weread-mp\u0000${secret}`).digest();
}

/** `v1:` + base64(iv | tag | ciphertext). */
export function seal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

export function open(sealed: string): string {
  if (!sealed.startsWith("v1:")) throw new SealedCredentialError("credential has no known seal");
  const raw = Buffer.from(sealed.slice(3), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SealedCredentialError("credential cannot be opened with this site's SESSION_SECRET");
  }
}
