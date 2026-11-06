import { SELECTION } from "@aihot/industry/selection";
import { audit } from "@aihot/backend/audit";
import { closeDb, sql, type Tx } from "@aihot/backend/db";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { settleDirectoryArticle } from "@aihot/backend/publication/directory";
import { stableJson } from "@aihot/backend/lib/ids";
import { emit } from "@aihot/backend/modules";

if (process.argv.slice(2).some(arg => arg !== "--apply")) throw new Error("用法：node --env-file-if-exists=.env scripts/publish-directory-sources.ts [--apply]");

async function snapshot(tx: Tx, id: string) {
  const [row] = await tx`SELECT a.source_id,a.revision,a.processing_state,a.processing_error,a.processing_attempts,
    a.processing_retry_at,a.processing_queued_at,a.processing_attempt_tag,a.grouping_status,
    p.visibility,p.eligible,p.selected,p.title,p.summary,p.category,p.score,p.revision AS publication_revision
    FROM articles a LEFT JOIN publications p ON p.article_id=a.id WHERE a.id=${id}`;
  return row;
}

try {
  const boss = await getBoss();
  const sources = await sql<{ sourceId: string; articles: number; public: number; withdrawn: number }[]>`
    SELECT s.id AS "sourceId",count(*)::int AS articles,
      count(*) FILTER (WHERE p.visibility='public' AND p.eligible)::int AS public,
      count(*) FILTER (WHERE o.visibility='withdrawn')::int AS withdrawn
    FROM sources s JOIN articles a ON a.source_id=s.id LEFT JOIN publications p ON p.article_id=a.id
    LEFT JOIN editorial_overrides o ON o.article_id=a.id
    WHERE s.id = ANY(${Object.keys(SELECTION.directorySources)}::text[]) AND s.participation_mode='editorial' GROUP BY s.id ORDER BY s.id`;
  console.log(JSON.stringify({ apply: process.argv.includes("--apply"), sources }));
  if (process.argv.includes("--apply")) {
    let changed = 0;
    let cancelled = 0;
    for (const source of sources) {
      const articles = await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id=${source.sourceId} ORDER BY id`;
      for (const article of articles) {
        const result = await sql.begin(async tx => {
          const [current] = await tx`SELECT source_id FROM articles WHERE id=${article.id} FOR UPDATE`;
          if (current?.source_id !== source.sourceId) return { changed: false, cancelled: 0 };
          const jobs = await tx<{ id: string; name: string; state: string }[]>`SELECT id,name,state FROM pgboss.job
            WHERE data->>'articleId'=${article.id} AND name IN (${QUEUES.analyze},${QUEUES.extractBody},${QUEUES.group})
              AND state IN ('created','retry','active') FOR UPDATE`;
          if (jobs.some(job => job.state === "active")) throw new Error("目录仍有运行中的任务，请先停止 worker 再执行");
          const before = await snapshot(tx, article.id);
          const publication = await settleDirectoryArticle(article.id, tx);
          if (!publication) return { changed: false, cancelled: 0 };
          for (const job of jobs) await boss.cancel(job.name, job.id, {
            db: { executeSql: async (text, values) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) },
          });
          const after = await snapshot(tx, article.id);
          const changed = publication.changed || stableJson(before) !== stableJson(after) || jobs.length > 0;
          if (changed) await audit("directory-publication-policy", "content.directory-publication", `content:${article.id}`,
            "使用者批准此来源新旧专题按目录公开，跳过模型与精选，保留人工下架及全文版权限制", before,
            { ...after, cancelledJobs: jobs.map(job => job.id) }, { db: tx });
          return { changed, cancelled: jobs.length };
        });
        if (result.changed) changed++;
        cancelled += result.cancelled;
      }
      if (articles.length) await emit("sourceRepublished", { sourceId: source.sourceId });
    }
    const rows = await sql`SELECT a.source_id,count(*)::int AS total,
      count(*) FILTER (WHERE p.visibility='public' AND p.eligible)::int AS public,
      count(*) FILTER (WHERE p.visibility='withdrawn')::int AS withdrawn
      FROM articles a JOIN publications p ON p.article_id=a.id WHERE a.source_id=ANY(${sources.map(source => source.sourceId)}::text[])
      GROUP BY a.source_id ORDER BY a.source_id`;
    console.log(JSON.stringify({ changed, cancelled, sources: rows }));
  }
} finally {
  await stopBoss();
  await closeDb();
}
