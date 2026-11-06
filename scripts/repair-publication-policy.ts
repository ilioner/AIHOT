import { audit } from "@aihot/backend/audit";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";

const apply = process.argv.includes("--apply");
const actor = "publication-policy-repair";
const reason = "按使用者确认取消内部隔离；仅当前分析通过公开，UNKNOWN 按 BLOCK 处理，保留人工下架";

try {
  const sources = await sql<{ id: string; name: string; tags: string[] }[]>`
    SELECT id,name,tags FROM sources WHERE participation_mode NOT IN ('editorial','hot_signal') ORDER BY id`;
  const unknown = await sql<{ article_id: string; id: number }[]>`
    SELECT a.id AS article_id,n.id FROM articles a JOIN LATERAL (
      SELECT id,relevance,output FROM analyses WHERE article_id=a.id AND input_revision=a.revision ORDER BY id DESC LIMIT 1
    ) n ON true WHERE n.output->'prefilter'->>'label' IN ('UNKNOWN','BLOCK') AND n.relevance IS DISTINCT FROM 'block' ORDER BY a.id`;
  const [{ count: total }] = await sql<{ count: string }[]>`SELECT count(*) FROM articles`;
  console.log(JSON.stringify({ apply, sources: sources.map(source => source.id), blockedAnalyses: unknown.length, rebuildArticles: Number(total) }));
  if (apply) {
    for (const source of sources) await sql.begin(async tx => {
      const [before] = await tx`SELECT id,name,tags,participation_mode FROM sources WHERE id=${source.id} FOR UPDATE`;
      const name = source.name.replace(/（(?:仅)?内部参考）/g, "").trim();
      const tags = source.tags.filter(tag => tag !== "待再分发授权");
      const [after] = await tx`UPDATE sources SET participation_mode='editorial',name=${name},tags=${tags},updated_at=now() WHERE id=${source.id} RETURNING id,name,tags,participation_mode`;
      await audit(actor, "source.publication-policy", `source:${source.id}`, reason, before, after, { db: tx });
    });
    for (const entry of unknown) await sql.begin(async tx => {
      const [article] = await tx`SELECT revision,processing_state FROM articles WHERE id=${entry.article_id} FOR UPDATE`;
      const [before] = await tx`SELECT id,input_revision,relevance,selected FROM analyses WHERE id=${entry.id}`;
      if (!article || article.revision !== before?.input_revision) return;
      const [after] = await tx`UPDATE analyses SET relevance='block',selected=false WHERE id=${entry.id} RETURNING id,input_revision,relevance,selected`;
      await tx`UPDATE articles SET processing_state='blocked' WHERE id=${entry.article_id} AND processing_state='analyzed'`;
      await audit(actor, "content.publication-policy", `content:${entry.article_id}`, reason, before, after, { db: tx });
    });
    let done = 0;
    let changed = 0;
    let cursor = "";
    for (;;) {
      const articles = await sql<{ id: string }[]>`SELECT id FROM articles WHERE id>${cursor} ORDER BY id LIMIT 100`;
      if (!articles.length) break;
      for (const article of articles) {
        const [before] = await sql`SELECT visibility,eligible,selected FROM publications WHERE article_id=${article.id}`;
        const result = await publishArticle(article.id);
        if (result?.changed) {
          changed++;
          const [after] = await sql`SELECT visibility,eligible,selected FROM publications WHERE article_id=${article.id}`;
          await audit(actor, "content.republish-policy", `content:${article.id}`, reason, before ?? null, after);
        }
        done++;
        cursor = article.id;
      }
      console.log(JSON.stringify({ done, changed }));
    }
    await sql`ALTER TABLE sources VALIDATE CONSTRAINT sources_publication_modes_check`;
    console.log(JSON.stringify({ done, changed, constraintValidated: true }));
  }
} finally {
  await stopBoss();
  await closeDb();
}
