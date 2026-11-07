// Pushing the published tool directory into skillhub: one row of state per article, one bad row skipped
// so the rest still go out, and a signed-out session that stops the batch instead of marking every row
// failed. The queue and the daily sweep look for what is still pending; the admin page may push at any
// time, and may re-send an already pushed tool in full (PUT) after the model re-classified it.
// Nothing here reaches another module or the public site.
import { sql } from "@aihot/backend/db";
import { enqueueOn } from "@aihot/backend/jobs/queue";
import { defineQueue } from "@aihot/backend/modules";
import { currentModel, ensureTypes, typeCounts } from "./classify.ts";
import { openSkillhub, type PushResult, type Skillhub, type Transport } from "./client.ts";
import { mapTool, toolPayload, type MappedTool, type ToolRow, type ToolTypes } from "./mapping.ts";

/** A row is retried three times in all; after that only the admin's own retry starts it again. */
export const MAX_ATTEMPTS = 3;
/** One queue job and one sweep push at most this many tools; the admin may ask for up to MAX_BATCH. */
export const BATCH_SIZE = 50;
export const MAX_BATCH = 500;
/** This many retryable failures in a row means the endpoint, not the tools: the batch stops early. */
export const CONSECUTIVE_RETRY_LIMIT = 3;

export const PUSH_STATUSES = ["pending", "sent", "exists", "failed", "skipped"] as const;
export type PushStatus = (typeof PUSH_STATUSES)[number];

/** Automatic pushing is off unless the environment turns it on, like the other safety valves. */
export function pushEnabled(): boolean {
  return process.env.SKILLHUB_PUSH_ENABLED === "true";
}

/** The published entries this module pushes. */
function columns() {
  return sql`a.id AS article_id, a.identity_key, p.category AS publication_category, a.source_id, s.name AS source_name,
    p.title, p.url, p.summary,
    a.raw->>'blockName' AS block_name,
    a.raw->'sourceMetadata'->'categories' AS categories,
    a.raw->'sourceMetadata'->'tags' AS tags,
    a.raw->'sourceMetadata'->>'iconUrl' AS icon_url,
    a.media`;
}

function fromTools() {
  return sql`FROM publications p JOIN articles a ON a.id = p.article_id LEFT JOIN sources s ON s.id = a.source_id`;
}

/**
 * What goes to skillhub: the tool directories plus the policy notices.
 *
 * - `contentKind` identifies `tool-directory` (one tool) and `tool-collection` (several tools), even
 *   when the website files them under another category. Unmarked entries still need `ai-tools`.
 *   `tutorial` is a how-to article, not a tool, and stays out.
 * - `p.category = 'policy'`: the 教育部/职教所 通知. They are not tools either, but the user
 *   asked for them in the directory, and the mapping sends them to `policy-regulations`.
 *
 * Other categories alone never qualify an unmarked article for pushing.
 */
function publishedTools() {
  return sql`p.visibility = 'public' AND p.eligible
    AND coalesce(a.raw->>'contentKind', '') <> 'tutorial'
    AND (p.category = 'policy'
      OR a.raw->>'contentKind' IN ('tool-directory', 'tool-collection')
      OR (p.category = 'ai-tools' AND coalesce(a.raw->>'contentKind', '') = ''))`;
}

const NOT_PUSHED_YET = () => sql`(sp.article_id IS NULL OR (sp.status = 'pending' AND sp.attempts < ${MAX_ATTEMPTS}))`;

interface ToolDbRow {
  article_id: string;
  identity_key: string;
  publication_category: string | null;
  source_id: string;
  source_name: string | null;
  title: string;
  url: string;
  summary: string | null;
  block_name: string | null;
  categories: string[] | null;
  tags: string[] | null;
  icon_url: string | null;
  media: unknown;
}

function toToolRow(row: ToolDbRow): ToolRow {
  return {
    articleId: row.article_id,
    identityKey: row.identity_key,
    publicationCategory: row.publication_category,
    sourceId: row.source_id,
    sourceName: row.source_name,
    title: row.title,
    url: row.url,
    summary: row.summary,
    blockName: row.block_name,
    categories: Array.isArray(row.categories) ? row.categories.filter((value): value is string => typeof value === "string") : [],
    tags: Array.isArray(row.tags) ? row.tags.filter((value): value is string => typeof value === "string") : [],
    iconUrl: row.icon_url,
    media: row.media,
  };
}

function clamp(limit: number | undefined, fallback = BATCH_SIZE): number {
  const value = Math.trunc(limit ?? fallback);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, MAX_BATCH);
}

/** The published tools in push order. Reads no push state, so a dry run works before the table exists. */
export async function publishedToolRows(limit = BATCH_SIZE): Promise<ToolRow[]> {
  const rows = await sql<ToolDbRow[]>`SELECT ${columns()} ${fromTools()}
    WHERE ${publishedTools()} ORDER BY a.discovered_at, a.id LIMIT ${clamp(limit)}`;
  return rows.map(toToolRow);
}

/** The published tools among the given ids, in push order (one row's re-classification, or a named list). */
export async function toolRowsFor(articleIds: string[]): Promise<ToolRow[]> {
  if (articleIds.length === 0) return [];
  const rows = await sql<ToolDbRow[]>`SELECT ${columns()} ${fromTools()}
    WHERE ${publishedTools()} AND a.id = ANY(${articleIds}::text[])
    ORDER BY a.discovered_at, a.id LIMIT ${MAX_BATCH}`;
  return rows.map(toToolRow);
}

/** The published tools that have no cached classification yet (后台「补分类」and `--classify`). */
export async function rowsMissingTypes(limit = BATCH_SIZE): Promise<ToolRow[]> {
  const rows = await sql<ToolDbRow[]>`SELECT ${columns()} ${fromTools()}
    LEFT JOIN skillhub_tool_types t ON t.article_id = a.id
    WHERE ${publishedTools()} AND t.article_id IS NULL
    ORDER BY a.discovered_at, a.id LIMIT ${clamp(limit)}`;
  return rows.map(toToolRow);
}

/** The tools with no state row yet, or one that is still pending below the attempt limit. */
export async function pendingToolRows(options: { limit?: number; retryFailed?: boolean; articleIds?: string[] } = {}): Promise<ToolRow[]> {
  const articleIds = options.articleIds?.length ? options.articleIds : null;
  const only = articleIds
    ? sql`a.id = ANY(${articleIds}::text[])`
    : options.retryFailed
      ? sql`(${NOT_PUSHED_YET()} OR sp.status = 'failed')`
      : NOT_PUSHED_YET();
  const rows = await sql<ToolDbRow[]>`SELECT ${columns()} ${fromTools()}
    LEFT JOIN skillhub_pushes sp ON sp.article_id = a.id
    WHERE ${publishedTools()} AND ${only}
    ORDER BY a.discovered_at, a.id LIMIT ${clamp(options.limit)}`;
  return rows.map(toToolRow);
}

/**
 * The tools that are already in skillhub (status 'sent', with the id skillhub gave them), for a full
 * PUT after the model re-classified them. 'exists' rows are someone else's entries — the create was
 * refused as a duplicate and we never learned an id, so they are not ours to update.
 */
export async function sentToolRows(options: { limit?: number; articleIds?: string[] } = {}): Promise<Array<{ row: ToolRow; remoteId: number }>> {
  const articleIds = options.articleIds?.length ? options.articleIds : null;
  const only = articleIds ? sql`AND a.id = ANY(${articleIds}::text[])` : sql``;
  const rows = await sql<(ToolDbRow & { remote_id: number })[]>`SELECT ${columns()}, sp.remote_id ${fromTools()}
    JOIN skillhub_pushes sp ON sp.article_id = a.id
    WHERE ${publishedTools()} AND sp.status = 'sent' AND sp.remote_id IS NOT NULL ${only}
    ORDER BY a.discovered_at, a.id LIMIT ${clamp(options.limit, MAX_BATCH)}`;
  return rows.map((row) => ({ row: toToolRow(row), remoteId: Number(row.remote_id) }));
}

/** How many published tools there are and how many still need a push. */
export async function overviewCounts(): Promise<{ candidates: number; pending: number; sent: number }> {
  const [candidates] = await sql<{ n: number }[]>`SELECT count(*)::int AS n ${fromTools()} WHERE ${publishedTools()}`;
  const [pending] = await sql<{ n: number }[]>`SELECT count(*)::int AS n ${fromTools()}
    LEFT JOIN skillhub_pushes sp ON sp.article_id = a.id WHERE ${publishedTools()} AND ${NOT_PUSHED_YET()}`;
  const [sent] = await sql<{ n: number }[]>`SELECT count(*)::int AS n ${fromTools()}
    JOIN skillhub_pushes sp ON sp.article_id = a.id WHERE ${publishedTools()} AND sp.status = 'sent' AND sp.remote_id IS NOT NULL`;
  return { candidates: candidates?.n ?? 0, pending: pending?.n ?? 0, sent: sent?.n ?? 0 };
}

export async function pushStatusCounts(): Promise<Record<PushStatus, number>> {
  const counts: Record<PushStatus, number> = { pending: 0, sent: 0, exists: 0, failed: 0, skipped: 0 };
  const rows = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM skillhub_pushes GROUP BY status`;
  for (const row of rows) if ((PUSH_STATUSES as readonly string[]).includes(row.status)) counts[row.status as PushStatus] = row.n;
  return counts;
}

/** One row of the admin's list: what was pushed, how far it got, and why it stopped. */
export interface PushRowView {
  articleId: string;
  title: string;
  status: PushStatus;
  attempts: number;
  remoteId: number | null;
  lastError: string | null;
  pushedAt: string | null;
  updatedAt: string;
  /** The codes the model (or the rules) chose, when the article has been classified yet. */
  types: (ToolTypes & { model: string | null }) | null;
}

export async function recentPushes(limit = 200): Promise<PushRowView[]> {
  const rows = await sql<{
    article_id: string; title: string | null; status: PushStatus; attempts: number;
    remote_id: number | null; last_error: string | null; pushed_at: Date | null; updated_at: Date;
    category_code: string | null; audience_code: string | null; feature_code: string | null;
    decided_by: string | null; model: string | null;
  }[]>`SELECT a.id AS article_id, p.title, coalesce(sp.status, 'pending') AS status, coalesce(sp.attempts, 0) AS attempts,
      sp.remote_id, sp.last_error, sp.pushed_at, coalesce(sp.updated_at, a.discovered_at) AS updated_at,
      t.category_code, t.audience_code, t.feature_code, t.decided_by, t.model
    FROM articles a LEFT JOIN publications p ON p.article_id = a.id
    LEFT JOIN skillhub_pushes sp ON sp.article_id = a.id
    LEFT JOIN skillhub_tool_types t ON t.article_id = a.id
    WHERE sp.article_id IS NOT NULL OR (${publishedTools()})
    ORDER BY CASE coalesce(sp.status, 'pending') WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      coalesce(sp.updated_at, a.discovered_at) DESC, a.id
    LIMIT ${clamp(limit, 200)}`;
  return rows.map((row) => ({
    articleId: row.article_id,
    title: row.title ?? row.article_id,
    status: row.status,
    attempts: row.attempts,
    remoteId: row.remote_id === null ? null : Number(row.remote_id),
    lastError: row.last_error,
    pushedAt: row.pushed_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    types: row.category_code === null ? null : {
      categoryCode: row.category_code,
      audienceCode: row.audience_code ?? "",
      featureCode: row.feature_code,
      decidedBy: row.decided_by === "model" ? "model" : "rules",
      model: row.model,
    },
  }));
}

interface Attempt {
  status: PushStatus;
  error: string | null;
  remoteId?: number | null;
  payload?: unknown;
  /** The row was accepted by skillhub (sent or already there). */
  accepted?: boolean;
  /** A refusal worth retrying: it stays pending until the attempt limit, then it is failed. */
  retryable?: boolean;
}

/** Writes one attempt: counts it, stores the body sent, and fails the row once the limit is reached. */
async function recordAttempt(articleId: string, attempt: Attempt): Promise<{ attempts: number; status: PushStatus }> {
  await sql`INSERT INTO skillhub_pushes (article_id) VALUES (${articleId}) ON CONFLICT (article_id) DO NOTHING`;
  const [row] = await sql<{ attempts: number; status: PushStatus }[]>`
    UPDATE skillhub_pushes SET
      attempts = attempts + 1,
      status = CASE WHEN ${attempt.retryable === true} AND attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE ${attempt.status} END,
      remote_id = ${attempt.remoteId ?? null},
      last_error = ${attempt.error},
      payload = ${attempt.payload === undefined ? sql`payload` : sql.json(attempt.payload as never)},
      pushed_at = CASE WHEN ${attempt.accepted === true} THEN now() ELSE pushed_at END,
      updated_at = now()
    WHERE article_id = ${articleId}
    RETURNING attempts, status`;
  return row!;
}

/** A refused session burns no attempt: the row is annotated, so it is swept again once the session is back. */
async function recordBlocked(articleId: string, error: string): Promise<{ attempts: number; status: PushStatus }> {
  await sql`INSERT INTO skillhub_pushes (article_id) VALUES (${articleId}) ON CONFLICT (article_id) DO NOTHING`;
  const [row] = await sql<{ attempts: number; status: PushStatus }[]>`
    UPDATE skillhub_pushes SET last_error = ${error}, updated_at = now()
    WHERE article_id = ${articleId} RETURNING attempts, status`;
  return row!;
}

/** A row the mapping cannot push is not a failure of the session: it is marked skipped once. */
async function recordSkipped(articleId: string, problem: string): Promise<{ attempts: number; status: PushStatus }> {
  const [row] = await sql<{ attempts: number; status: PushStatus }[]>`
    INSERT INTO skillhub_pushes (article_id, status, last_error) VALUES (${articleId}, 'skipped', ${problem})
    ON CONFLICT (article_id) DO UPDATE SET status = 'skipped', last_error = excluded.last_error, updated_at = now()
    RETURNING attempts, status`;
  return row!;
}

export interface PushItem {
  articleId: string;
  status: PushStatus;
  attempts: number;
  remoteId: number | null;
  error: string | null;
}

/** What one batch came to; `stopped` says a session problem ended it early, not the rows themselves. */
export interface PushSummary {
  attempted: number;
  sent: number;
  exists: number;
  failed: number;
  skipped: number;
  stopped: boolean;
  error: string | null;
  items: PushItem[];
}

const emptySummary = (): PushSummary => ({ attempted: 0, sent: 0, exists: 0, failed: 0, skipped: 0, stopped: false, error: null, items: [] });

/** Pushes one batch, skipping the rows that fail and stopping only when the session itself is refused. */
export async function pushCandidates(options: { limit?: number; retryFailed?: boolean; articleIds?: string[]; reclassify?: boolean; transport?: Transport } = {}): Promise<PushSummary> {
  const summary = emptySummary();
  const rows = await pendingToolRows(options);
  if (rows.length === 0) return summary;

  const opened = await openSkillhub({ transport: options.transport });
  if (!opened.ok) {
    summary.stopped = true;
    summary.error = opened.error;
    return summary;
  }
  const client: Skillhub = opened.skillhub;
  // The three codes come from the model (cached per article); a model that fails leaves the rules in
  // place and the push goes on, so nothing here can stop a batch.
  const types: Map<string, ToolTypes> = await ensureTypes(rows, client.ids, { force: options.reclassify });

  let consecutiveRetries = 0;
  for (const row of rows) {
    summary.attempted += 1;
    const mapped = mapTool(row, types.get(row.articleId));
    if (!mapped.ok) {
      const written = await recordSkipped(row.articleId, mapped.problem);
      summary.skipped += 1;
      summary.items.push({ articleId: row.articleId, status: written.status, attempts: written.attempts, remoteId: null, error: mapped.problem });
      continue;
    }
    const payload = toolPayload(mapped.tool, client.ids);
    if (!payload.ok) {
      const written = await recordSkipped(row.articleId, payload.problem);
      summary.skipped += 1;
      summary.items.push({ articleId: row.articleId, status: written.status, attempts: written.attempts, remoteId: null, error: payload.problem });
      continue;
    }

    const result: PushResult = await client.push(payload.payload);
    const written = await writeResult(row.articleId, mapped.tool, result, payload.payload);
    summary.items.push({ articleId: row.articleId, status: written.status, attempts: written.attempts, remoteId: result.kind === "success" ? result.remoteId : null, error: errorOf(result) });
    if (result.kind === "success") summary.sent += 1;
    else if (result.kind === "exists") summary.exists += 1;
    else {
      summary.failed += 1;
      if (result.kind === "config") {
        // The session is gone: every later row would fail the same way, so the batch stops here.
        summary.stopped = true;
        summary.error = result.error;
        break;
      }
      // One bad row is the row's problem and the batch goes on; a run of them is the endpoint's problem.
      // Stopping keeps an unreachable host from tying up the worker for a timeout per remaining row —
      // everything stays pending and the next sweep continues where this one left off.
      if (result.kind === "retry") {
        consecutiveRetries += 1;
        if (consecutiveRetries >= CONSECUTIVE_RETRY_LIMIT) {
          summary.stopped = true;
          summary.error = `连续 ${consecutiveRetries} 条都失败（${result.error}）：先停下，剩下的下一轮接着推`;
          break;
        }
      }
    }
    if (result.kind === "success" || result.kind === "exists" || result.kind === "invalid") consecutiveRetries = 0;
  }
  return summary;
}

function errorOf(result: PushResult): string | null {
  return result.kind === "success" || result.kind === "exists" ? null : result.error;
}

async function writeResult(articleId: string, tool: MappedTool, result: PushResult, payload: unknown): Promise<{ attempts: number; status: PushStatus }> {
  switch (result.kind) {
    case "success":
      return recordAttempt(articleId, { status: "sent", error: null, remoteId: result.remoteId, payload, accepted: true });
    case "exists":
      // The slug or the canonical address is already in the directory: the push has done its job.
      return recordAttempt(articleId, { status: "exists", error: null, payload, accepted: true });
    case "config":
      // The session is gone, not the tool: annotate the row without spending one of its attempts.
      return recordBlocked(articleId, result.error);
    case "invalid":
      return recordAttempt(articleId, { status: "pending", error: `${tool.slug}：${result.error}`, payload, retryable: true });
    case "retry":
      return recordAttempt(articleId, { status: "pending", error: result.error, payload, retryable: true });
  }
}

/** The tool is already in skillhub and its body was replaced: the row stays 'sent', only the copy is refreshed. */
async function recordUpdated(articleId: string, payload: unknown): Promise<void> {
  await sql`UPDATE skillhub_pushes SET last_error = NULL, payload = ${sql.json(payload as never)}, updated_at = now()
    WHERE article_id = ${articleId}`;
}

/** A refused update of a live tool: noted for the admin, and the row stays exactly as sent. */
async function recordUpdateFailed(articleId: string, error: string): Promise<void> {
  await sql`UPDATE skillhub_pushes SET last_error = ${error}, updated_at = now() WHERE article_id = ${articleId}`;
}

/** What one update batch came to. `failed` rows keep their 'sent' status: an old copy is not a lost tool. */
export interface UpdateSummary {
  attempted: number;
  updated: number;
  failed: number;
  stopped: boolean;
  error: string | null;
  items: Array<{ articleId: string; remoteId: number; ok: boolean; error: string | null }>;
}

/**
 * Re-sends every already pushed tool in full (PUT /api/v1/admin/ai-tools/{id}) with the codes the model
 * chose. Only `status = 'sent'` rows that carry skillhub's id are touched: `exists` rows are someone
 * else's entries and a `failed` one is not in the directory at all. A 401/403 stops the batch and
 * nothing local is changed; any other refusal is recorded and the batch goes on.
 */
export async function updateSent(options: { limit?: number; articleIds?: string[]; reclassify?: boolean; transport?: Transport } = {}): Promise<UpdateSummary> {
  const summary: UpdateSummary = { attempted: 0, updated: 0, failed: 0, stopped: false, error: null, items: [] };
  const targets = await sentToolRows(options);
  if (targets.length === 0) return summary;

  const opened = await openSkillhub({ transport: options.transport });
  if (!opened.ok) {
    summary.stopped = true;
    summary.error = opened.error;
    return summary;
  }
  const client: Skillhub = opened.skillhub;
  const types = await ensureTypes(targets.map((target) => target.row), client.ids, { force: options.reclassify });

  let consecutiveRetries = 0;
  for (const { row, remoteId } of targets) {
    summary.attempted += 1;
    const mapped = mapTool(row, types.get(row.articleId));
    if (!mapped.ok) {
      summary.failed += 1;
      await recordUpdateFailed(row.articleId, `重新生成请求体失败：${mapped.problem}`.slice(0, 500));
      summary.items.push({ articleId: row.articleId, remoteId, ok: false, error: mapped.problem });
      continue;
    }
    const payload = toolPayload(mapped.tool, client.ids);
    if (!payload.ok) {
      summary.failed += 1;
      await recordUpdateFailed(row.articleId, payload.problem.slice(0, 500));
      summary.items.push({ articleId: row.articleId, remoteId, ok: false, error: payload.problem });
      continue;
    }

    const result = await client.updateTool(remoteId, payload.payload);
    if (result.kind === "config") {
      // The session is gone: nothing local changes, the next run picks up where this one stopped.
      summary.stopped = true;
      summary.error = result.error;
      break;
    }
    if (result.kind === "success") {
      consecutiveRetries = 0;
      summary.updated += 1;
      await recordUpdated(row.articleId, payload.payload);
      summary.items.push({ articleId: row.articleId, remoteId, ok: true, error: null });
      continue;
    }
    consecutiveRetries = result.kind === "retry" ? consecutiveRetries + 1 : 0;
    summary.failed += 1;
    // 'exists'（对方说是重复）和 'invalid'/'retry' 一样处理：这一条没更新成功，记下来，接着下一条。
    const error = result.kind === "exists" ? "skillhub 把这次更新当成了重复条目" : result.error;
    await recordUpdateFailed(row.articleId, `${mapped.tool.slug}（远端 ${remoteId}）：${error}`.slice(0, 500));
    summary.items.push({ articleId: row.articleId, remoteId, ok: false, error });
    if (consecutiveRetries >= CONSECUTIVE_RETRY_LIMIT) {
      summary.stopped = true;
      summary.error = `连续 ${consecutiveRetries} 条都没更新成功（${error}）：先停下，剩下的下一轮接着推`;
      break;
    }
  }
  return summary;
}
/** Gives every failed row a fresh budget of attempts (the admin's「重试失败」and the script's flag). */
export async function resetFailed(): Promise<number> {
  const rows = await sql<{ article_id: string }[]>`
    UPDATE skillhub_pushes SET status = 'pending', attempts = 0, updated_at = now()
    WHERE status = 'failed' RETURNING article_id`;
  return rows.length;
}

/** Puts one row back in the queue; null when no such row was ever pushed. */
export async function resetOne(articleId: string): Promise<boolean> {
  await sql`INSERT INTO skillhub_pushes (article_id) VALUES (${articleId}) ON CONFLICT (article_id) DO NOTHING`;
  const rows = await sql<{ article_id: string }[]>`
    UPDATE skillhub_pushes SET status = 'pending', attempts = 0, updated_at = now()
    WHERE article_id = ${articleId} RETURNING article_id`;
  return rows.length > 0;
}

/** A push (or a full re-send of what is already there) of one batch, on its own queue so the admin and the sweep share one worker path. */
export interface PushJob {
  mode?: "push" | "update";
  limit?: number;
  articleIds?: string[];
  /** Ask the model again instead of using the cached codes (后台「用模型重分类并更新远端」, `--reclassify`). */
  reclassify?: boolean;
}

export const pushQueue = defineQueue<PushJob>({
  name: "skillhub-push.push",
  options: { policy: "short", retryLimit: 0, expireInSeconds: 1800 },
  worker: { batchSize: 1 },
  run: async (jobs) => {
    let last: PushSummary | UpdateSummary | null = null;
    for (const job of jobs) {
      const options = { limit: job.limit, articleIds: job.articleIds, reclassify: job.reclassify };
      last = job.mode === "update" ? await updateSent(options) : await pushCandidates(options);
    }
    return last;
  },
});

/**
 * The daily sweep: enqueue one batch when something is still pending and the valve is open. An article
 * that is sent or seen as a duplicate is never pushed again, a skipped one is never retried, and only
 * the admin's「重试失败」brings a failed row back — so a day with nothing new costs nothing.
 */
export async function schedulePush(): Promise<{ enqueued: number; pending: number }> {
  if (!pushEnabled()) return { enqueued: 0, pending: 0 };
  const { pending } = await overviewCounts();
  if (pending === 0) return { enqueued: 0, pending: 0 };
  const jobId = await enqueueOn(pushQueue, { limit: BATCH_SIZE }, { singletonKey: "sweep" });
  return { enqueued: jobId ? 1 : 0, pending };
}

/** Queues everything that is still pending, for the admin's「推送全部待推送」. */
export async function enqueuePending(limit?: number): Promise<{ enqueued: number; pending: number }> {
  const { pending } = await overviewCounts();
  if (pending === 0) return { enqueued: 0, pending: 0 };
  // Its own key, not the sweep's: a sweep already queued (50 rows) must not swallow the person's click.
  // The queue runs one job at a time, so this batch simply takes what the sweep left.
  const jobId = await enqueueOn(pushQueue, { limit: Math.min(limit ?? pending, MAX_BATCH) }, { singletonKey: "admin" });
  return { enqueued: jobId ? 1 : 0, pending };
}

/** Queues the articles the admin named, regardless of their state. */
export async function enqueueArticles(articleIds: string[]): Promise<{ enqueued: number; pending: number }> {
  const ids = articleIds.slice(0, MAX_BATCH);
  if (ids.length === 0) return { enqueued: 0, pending: 0 };
  const jobId = await enqueueOn(pushQueue, { articleIds: ids, limit: ids.length });
  return { enqueued: jobId ? 1 : 0, pending: ids.length };
}

/** Queues one article again after a manual retry. */
export async function enqueueOne(articleId: string): Promise<void> {
  await enqueueOn(pushQueue, { articleIds: [articleId], limit: 1 });
}

/** Queues a full re-send (PUT) of what is already in skillhub, for 后台「用模型重分类并更新远端」 and `--update-existing`. */
export async function enqueueUpdate(options: { limit?: number; articleIds?: string[]; reclassify?: boolean; } = {}): Promise<{ enqueued: number; sent: number }> {
  const { sent } = await overviewCounts();
  if (sent === 0) return { enqueued: 0, sent: 0 };
  const jobId = await enqueueOn(pushQueue, {
    mode: "update",
    limit: Math.min(options.limit ?? sent, MAX_BATCH),
    articleIds: options.articleIds,
    reclassify: options.reclassify ?? true,
  }, { singletonKey: "update" });
  return { enqueued: jobId ? 1 : 0, sent };
}

/** Re-runs the classifier over the articles the admin named (or the first `limit` still unclassified). */
export async function classifyOnly(options: { limit?: number; articleIds?: string[]; onlyMissing?: boolean; } = {}): Promise<{
  attempted: number;
  byModel: number;
  byRules: number;
  model: string | null;
}> {
  const opened = await openSkillhub();
  if (!opened.ok) throw new Error(opened.error);
  // Named articles win over the two batch modes, so the page can classify one row at a time.
  const targets = options.articleIds?.length
    ? await toolRowsFor(options.articleIds)
    : options.onlyMissing
      ? await rowsMissingTypes(clamp(options.limit, BATCH_SIZE))
      : await publishedToolRows(clamp(options.limit, BATCH_SIZE));
  const counts = { attempted: targets.length, byModel: 0, byRules: 0, model: null as string | null };
  await ensureTypes(targets, opened.skillhub.ids, {
    // onlyMissing trusts the cache; an explicit re-classification (the page's button, --reclassify) does not.
    force: !options.onlyMissing,
    onResult: (_rows, classified) => {
      for (const picked of classified.values()) {
        if (picked.types.decidedBy === "model") counts.byModel += 1;
        else counts.byRules += 1;
        if (picked.model && !counts.model) counts.model = picked.model;
      }
    },
  });
  counts.model ??= await currentModel();
  return counts;
}
