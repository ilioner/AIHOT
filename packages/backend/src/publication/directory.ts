import { sql, type Db, type Tx } from "../db.ts";
import { emit } from "../modules.ts";
import { publishArticleTx, type PublishResult } from "./publish.ts";
import { directoryPolicy } from "./rules.ts";

export async function settleDirectoryArticle(articleId: string, db: Db = sql): Promise<PublishResult | null> {
  const run = async (tx: Tx) => {
    const [article] = await tx<{ source_id: string; participation_mode: string }[]>`
      SELECT a.source_id,s.participation_mode FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=${articleId} FOR UPDATE OF a`;
    if (!article || !directoryPolicy(article.source_id, article.participation_mode)) return null;
    const [previous] = await tx<{ story_id: number | null }[]>`SELECT story_id FROM publications WHERE article_id=${articleId}`;
    await tx`UPDATE articles SET processing_state='skipped',processing_error=NULL,processing_attempts=0,
      processing_retry_at=NULL,processing_queued_at=NULL,processing_attempt_tag=NULL,
      grouping_status='complete',grouped_at=coalesce(grouped_at,now()) WHERE id=${articleId}
      AND (processing_state<>'skipped' OR processing_error IS NOT NULL OR processing_attempts<>0
        OR processing_retry_at IS NOT NULL OR processing_queued_at IS NOT NULL OR processing_attempt_tag IS NOT NULL OR grouping_status<>'complete')`;
    const result = await publishArticleTx(tx, articleId);
    if (previous && result?.changed) await emit("articleChanged", { id: articleId, reason: "directory publication", kind: result.changeKind,
      reduced: result.reduced, previousStoryIds: previous.story_id === null ? [] : [previous.story_id] }, tx);
    return result;
  };
  return "begin" in db ? (db as typeof sql).begin(run) : run(db as Tx);
}
