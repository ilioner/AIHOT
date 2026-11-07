// The skillhub session the admin pastes. A Cookie and its XSRF token are login credentials: the
// database holds them sealed with AES-256-GCM under a key derived from the site's SESSION_SECRET, and the admin API
// only says whether they are configured. Rotating SESSION_SECRET makes a stored session unreadable; the
// page then shows it as not configured instead of failing silently afterwards.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { credential } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";

/** The settings row the seals live in. */
export const SETTINGS_KEY = "skillhub.push";

export interface Credentials {
  cookie: string;
  xsrf: string;
}

export class SealedCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedCredentialError";
  }
}

function key(): Buffer {
  const secret = credential("auth", "SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is required to seal the skillhub credentials");
  return createHash("sha256").update(`skillhub-push\u0000${secret}`).digest();
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

interface StoredSeals {
  cookie?: string;
  xsrf?: string;
}

async function readSeals(): Promise<StoredSeals> {
  const [row] = await sql<{ value: StoredSeals }[]>`SELECT value FROM settings WHERE key = ${SETTINGS_KEY}`;
  return row?.value ?? {};
}

function unseal(sealed: string | undefined): string | null {
  if (!sealed) return null;
  try {
    return open(sealed);
  } catch {
    return null; // a rotating SESSION_SECRET leaves the row, not a broken session
  }
}

/** The credentials saved from the admin page, if any (a value that no longer opens counts as absent). */
export async function storedCredentials(): Promise<{ cookie: string | null; xsrf: string | null }> {
  const seals = await readSeals();
  return { cookie: unseal(seals.cookie), xsrf: unseal(seals.xsrf) };
}

/** Saves what was pasted; a blank value deletes that half. Both blank deletes the row. */
export async function saveCredentials(input: { cookie?: string; xsrf?: string }): Promise<void> {
  const seals = await readSeals();
  const next: StoredSeals = { ...seals };
  if (input.cookie !== undefined) {
    const value = input.cookie.trim();
    if (value) next.cookie = seal(value);
    else delete next.cookie;
  }
  if (input.xsrf !== undefined) {
    const value = input.xsrf.trim();
    if (value) next.xsrf = seal(value);
    else delete next.xsrf;
  }
  if (!next.cookie && !next.xsrf) {
    await sql`DELETE FROM settings WHERE key = ${SETTINGS_KEY}`;
    return;
  }
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${SETTINGS_KEY}, ${sql.json(next as never)}, 'skillhub.push')
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
}

/** Whether each half is configured, and where it came from; never the values themselves. */
export type ConfiguredSource = "settings" | "environment" | "none";

export interface Configuration {
  cookie: boolean;
  xsrf: boolean;
  source: ConfiguredSource;
}

async function resolve(): Promise<{ cookie: string | null; xsrf: string | null; source: ConfiguredSource }> {
  const stored = await storedCredentials();
  const fromEnvironment = { cookie: credential("integrations", "SKILLHUB_COOKIE"), xsrf: credential("integrations", "SKILLHUB_XSRF_TOKEN") };
  const cookie = stored.cookie ?? fromEnvironment.cookie;
  const xsrf = stored.xsrf ?? fromEnvironment.xsrf;
  const source: ConfiguredSource = stored.cookie || stored.xsrf ? "settings" : fromEnvironment.cookie || fromEnvironment.xsrf ? "environment" : "none";
  return { cookie, xsrf, source };
}

/** What the admin page may show: whether each half is configured, not what it holds. */
export async function configuration(): Promise<Configuration> {
  const { cookie, xsrf, source } = await resolve();
  return { cookie: !!cookie, xsrf: !!xsrf, source };
}

/** The pair a push needs, settings first and then the environment; null when either half is missing. */
export async function resolveCredentials(): Promise<Credentials | null> {
  const { cookie, xsrf } = await resolve();
  return cookie && xsrf ? { cookie, xsrf } : null;
}
