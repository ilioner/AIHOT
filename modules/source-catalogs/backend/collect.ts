import { sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { guardedFetch, requireOk, type GuardedFetchOptions, type GuardedResponse } from "@aihot/backend/lib/http-fetch";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn } from "@aihot/backend/jobs/queue";
import { endpoint, isCatalog, parseCatalog, SOURCE_IDS, type CatalogId } from "./adapters.ts";

type Reader = (url: string, options: GuardedFetchOptions) => Promise<GuardedResponse>;

export const collectQueue = defineQueue<{ sourceId: string }>({
  name: "source-catalogs.collect",
  options: { policy: "short", retryLimit: 0, expireInSeconds: 300 },
  worker: { batchSize: 1 },
  run: async jobs => {
    if (process.env.COLLECT_ENABLED !== "true") return;
    for (const job of jobs) await collectCatalog(job.sourceId);
  },
});

export async function readCatalog(id: CatalogId, reader: Reader = guardedFetch) {
  const headers: Record<string, string> = { accept: "application/json,text/html;q=0.9" };
  if (id === "catalog-aibase") Object.assign(headers, {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  });
  if (id === "catalog-uisdc") Object.assign(headers, { "user-agent": "Mozilla/5.0", referer: "https://www.uisdc.com/news", "x-requested-with": "XMLHttpRequest" });
  const response = requireOk(await reader(endpoint(id), { headers, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024, redirectPolicy: "same-origin" }));
  return parseCatalog(id, response.text());
}

export async function collectCatalog(sourceId: string, reader: Reader = guardedFetch): Promise<Record<string, unknown>> {
  if (!isCatalog(sourceId)) return { sourceId, status: "unmanaged" };
  const [source] = await sql<{ enabled: boolean; participation_mode: string }[]>`SELECT enabled, participation_mode FROM sources WHERE id = ${sourceId} AND kind = 'external'`;
  if (!source) return { sourceId, status: "missing" };
  if (!source.enabled) return { sourceId, status: "paused" };
  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id, detail) VALUES (${sourceId}, ${sql.json({ via: "source-catalogs" })}) RETURNING id`;
  let created = 0;
  let revised = 0;
  try {
    const items = await readCatalog(sourceId, reader);
    for (const item of items) {
      const result = await upsertMaterial({ ...item, sourceId, via: "source-catalogs" });
      if (result.created) created += 1;
      if (result.revised) revised += 1;
      if (result.created || result.revised || result.processingNeeded) await queueProcessing(result.articleId);
    }
    await sql`UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL, health = 'ok',
      next_fetch_at = now() + make_interval(mins => interval_minutes), updated_at = now() WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${items.length}, new_count = ${created} WHERE id = ${run!.id}`;
    return { sourceId, status: "ok", found: items.length, created, revised };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    await sql`UPDATE sources SET last_fetch_at = now(), last_error = ${message}, fail_count = fail_count + 1,
      health = CASE WHEN fail_count + 1 >= 3 THEN 'failing' ELSE 'degraded' END,
      next_fetch_at = now() + make_interval(mins => interval_minutes), updated_at = now() WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed", created, error: message };
  }
}

export async function scheduleCollect(): Promise<{ enqueued: number }> {
  if (process.env.COLLECT_ENABLED !== "true") return { enqueued: 0 };
  const sources = await sql<{ id: string }[]>`SELECT id FROM sources WHERE kind = 'external' AND enabled
    AND id = ANY(${[...SOURCE_IDS]}::text[]) AND (next_fetch_at IS NULL OR next_fetch_at <= now()) ORDER BY id`;
  for (const source of sources) await enqueueOn(collectQueue, { sourceId: source.id }, { singletonKey: source.id });
  return { enqueued: sources.length };
}
