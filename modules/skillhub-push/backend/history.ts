// The latest state drives retries; immutable events answer what happened on a particular Beijing day.
import { sql, type Db } from "@aihot/backend/db";
import type { PushStatus } from "./push.ts";

/** Shared admin view, also captured at the time of each operation. No credential or request headers. */
export function pushSnapshot() {
  return sql`jsonb_build_object(
    'articleId', a.id, 'title', coalesce(p.title, a.title, a.id),
    'status', coalesce(sp.status, 'pending'), 'attempts', coalesce(sp.attempts, 0),
    'remoteId', sp.remote_id, 'lastError', sp.last_error, 'pushedAt', sp.pushed_at,
    'updatedAt', coalesce(sp.updated_at, a.discovered_at),
    'types', CASE WHEN t.category_code IS NULL THEN NULL ELSE jsonb_build_object(
      'categoryCode', t.category_code, 'audienceCode', t.audience_code,
      'featureCode', t.feature_code, 'decidedBy', t.decided_by, 'model', t.model) END)`;
}

export function snapshotFrom() {
  return sql`FROM articles a LEFT JOIN publications p ON p.article_id = a.id
    LEFT JOIN skillhub_pushes sp ON sp.article_id = a.id
    LEFT JOIN skillhub_tool_types t ON t.article_id = a.id`;
}

/** Old state only proves the last acceptance, not every past attempt or its original classification. */
export function legacySnapshot() {
  return sql`${pushSnapshot()} || jsonb_build_object(
    'title', coalesce(sp.payload->>'name', p.title, a.title, a.id),
    'status', CASE WHEN sp.remote_id IS NULL THEN 'exists' ELSE 'sent' END,
    'lastError', NULL, 'types', NULL, 'updatedAt', sp.pushed_at, 'operation', 'legacy')`;
}

export function unrecordedLegacy() {
  return sql`sp.pushed_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM skillhub_push_events e WHERE e.article_id = a.id)`;
}

/** Save the known old acceptance before a reset/attempt can overwrite it; never bulk-backfill migrations. */
export async function preserveLegacy(db: Db, articleIds: string[]): Promise<void> {
  if (!articleIds.length) return;
  await db`INSERT INTO skillhub_push_events (article_id, operation, occurred_at, snapshot)
    SELECT a.id, 'legacy', sp.pushed_at, ${legacySnapshot()} ${snapshotFrom()}
    WHERE a.id = ANY(${articleIds}::text[]) AND ${unrecordedLegacy()}
    ON CONFLICT DO NOTHING`;
}

export async function appendEvent(db: Db, articleId: string, event: {
  operation: "create" | "update";
  status: PushStatus;
  error: string | null;
  accepted?: boolean;
}): Promise<void> {
  await db`INSERT INTO skillhub_push_events (article_id, operation, snapshot)
    SELECT a.id, ${event.operation}, ${pushSnapshot()} || jsonb_build_object(
      'status', ${event.status}::text, 'lastError', ${event.error}::text,
      'pushedAt', CASE WHEN ${event.accepted === true} THEN now() ELSE NULL END,
      'updatedAt', now()) ${snapshotFrom()} WHERE a.id = ${articleId}`;
}
