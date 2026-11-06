import { SELECTION } from "@aihot/industry/selection";
import { audit } from "../audit.ts";
import { sql, type Db } from "../db.ts";
import { queueProcessing } from "../jobs/content.ts";
import { getBoss, QUEUES } from "../jobs/queue.ts";
import { publishArticleTx } from "../publication/publish.ts";

export interface SourcePrefilterEntry {
  articleId: string;
  sourceId: string;
  revision: number;
  analysisId: number;
  label: string;
  state: string;
}

async function candidates(db: Db, articleId?: string): Promise<SourcePrefilterEntry[]> {
  const rows = await db<{ id: string; source_id: string; revision: number; analysis_id: number; label: string; processing_state: string }[]>`
    SELECT a.id,a.source_id,a.revision,an.id AS analysis_id,an.output->'prefilter'->>'label' AS label,a.processing_state
    FROM articles a JOIN sources s ON s.id=a.source_id JOIN LATERAL (
      SELECT id,origin,output FROM analyses WHERE article_id=a.id AND input_revision=a.revision ORDER BY id DESC LIMIT 1
    ) an ON true
    WHERE a.source_id IN ${db(SELECTION.prefilterPassSources)} AND s.participation_mode='editorial'
      AND a.source_id <> ALL(${Object.keys(SELECTION.directorySources)}::text[])
      AND (${articleId ?? null}::text IS NULL OR a.id=${articleId ?? null})
      AND a.processing_state IN ('blocked','analyzed','failed') AND an.origin='model'
      AND an.output->'prefilter'->>'label' IN ('UNKNOWN','BLOCK') AND NOT (an.output ? 'sourcePrefilter')
      AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name IN (${QUEUES.analyze},${QUEUES.extractBody})
        AND j.state IN ('created','retry','active') AND j.data->>'articleId'=a.id)
    ORDER BY a.id`;
  return rows.map(row => ({ articleId: row.id, sourceId: row.source_id, revision: row.revision, analysisId: row.analysis_id, label: row.label, state: row.processing_state }));
}

export async function previewSourcePrefilter(): Promise<SourcePrefilterEntry[]> {
  await getBoss();
  return candidates(sql);
}

export async function requeueSourcePrefilter(entries: SourcePrefilterEntry[], actor: string, reason: string) {
  if (!actor.trim() || !reason.trim()) throw new Error("来源放行必须记录操作者和理由");
  await getBoss();
  const results: Array<{ articleId: string; status: "queued" | "skipped" | "failed"; reason?: string }> = [];
  for (const entry of entries) {
    try {
      const status = await sql.begin(async tx => {
        await tx`SELECT id FROM articles WHERE id=${entry.articleId} FOR UPDATE`;
        const [current] = await candidates(tx, entry.articleId);
        if (!current || current.sourceId !== entry.sourceId || current.revision !== entry.revision || current.analysisId !== entry.analysisId || current.state !== entry.state) return "skipped" as const;
        await tx`UPDATE articles SET processing_state='new',processing_error=NULL,processing_attempts=0,
          processing_retry_at=NULL,updated_at=now() WHERE id=${entry.articleId}`;
        const jobId = await queueProcessing(entry.articleId, { attemptTag: `source-prefilter:${entry.analysisId}`, db: tx });
        if (!jobId) throw new Error("队列未接受任务，未保存本次修改");
        await publishArticleTx(tx, entry.articleId);
        await audit(actor, "content.source-prefilter", `content:${entry.articleId}`, reason, current,
          { ...current, state: "new", effectivePrefilter: "PASS", jobId }, { db: tx });
        return "queued" as const;
      });
      results.push({ articleId: entry.articleId, status });
    } catch (error) {
      results.push({ articleId: entry.articleId, status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
