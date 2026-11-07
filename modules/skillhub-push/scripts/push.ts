// Pushes the published tool directory into skillhub by hand. Dry run by default: it prints the request
// bodies and touches neither the network nor the database's push state.
//
//   node --env-file-if-exists=.env modules/skillhub-push/scripts/push.ts --dry-run --limit 3
//   node --env-file-if-exists=.env modules/skillhub-push/scripts/push.ts --all --limit 50
//   node --env-file-if-exists=.env modules/skillhub-push/scripts/push.ts --all --retry-failed
//   node --env-file-if-exists=.env modules/skillhub-push/scripts/push.ts --all --classify
//   node --env-file-if-exists=.env modules/skillhub-push/scripts/push.ts --all --update-existing [--reclassify]
//
// Only --all sends anything (a push, a PUT, or a paid classification); a dry run lists what would go out,
// with the category codes rather than the dictionary IDs, because those are looked up at push time.
import { closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { loadTypes } from "../backend/classify.ts";
import { mapTool, type MappedTool } from "../backend/mapping.ts";
import server from "../server.ts";
import {
  BATCH_SIZE, MAX_ATTEMPTS, classifyOnly, pendingToolRows, publishedToolRows, pushCandidates, resetFailed, rowsMissingTypes, sentToolRows, updateSent,
} from "../backend/push.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
function numberArg(name: string, fallback: number): number {
  const at = args.indexOf(`--${name}`);
  const raw = at >= 0 ? args[at + 1] : undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

const all = flag("all");
const dryRun = !all || flag("dry-run");
const retryFailed = flag("retry-failed");
const classify = flag("classify");
const reclassify = flag("reclassify");
const updateExisting = flag("update-existing");
const limit = numberArg("limit", BATCH_SIZE);

// The classification step is declared by this module (`models` in server.ts); the api and the worker
// install the site's list, but a bare script starts with none, so `modelRoute("skillhub-classify")`
// would not know the step exists. Installing this module alone is all the script needs.
installModules([server]);

/** The request body as far as it can be written without the dictionaries (the IDs are looked up live). */
const preview = (tool: MappedTool) => ({
  name: tool.name,
  slug: tool.slug,
  url: tool.url,
  canonicalUrl: tool.canonicalUrl,
  description: tool.description,
  iconUrl: tool.iconUrl,
  aiNote: tool.aiNote,
  categoryCode: tool.categoryCode,
  audienceCode: tool.audienceCode,
  featureCode: tool.featureCode,
  decidedBy: tool.decidedBy,
  categoryDictItemId: "按 categoryCode 在推送时查询",
});

try {
  if (dryRun) {
    if (classify) {
      const rows = reclassify ? await publishedToolRows(limit) : await rowsMissingTypes(limit);
      for (const row of rows) console.log(JSON.stringify({ articleId: row.articleId, title: row.title, publicationCategory: row.publicationCategory ?? null }));
      console.log(`dry-run：${reclassify ? "会重新分类" : "会补分类"} ${rows.length} 条；未调用模型、未写入。加 --all 才真跑。`);
    } else if (updateExisting) {
      const targets = await sentToolRows({ limit });
      const cached = await loadTypes(targets.map((target) => target.row.articleId));
      let previewed = 0;
      for (const { row, remoteId } of targets) {
        const mapped = mapTool(row, cached.get(row.articleId));
        if (!mapped.ok) {
          console.log(JSON.stringify({ articleId: row.articleId, remoteId, skipped: mapped.problem }, null, 2));
          continue;
        }
        console.log(JSON.stringify({ articleId: row.articleId, method: "PUT", path: `/api/v1/admin/ai-tools/${remoteId}`, request: preview(mapped.tool) }, null, 2));
        previewed += 1;
      }
      console.log(`dry-run：会更新 ${previewed} 条已推送工具（共读取 ${targets.length} 条）；未联网、未写入。加 --all 才更新。`);
    } else {
      const pending = await pendingToolRows({ limit, retryFailed });
      const cached = await loadTypes(pending.map((row) => row.articleId));
      let previewed = 0;
      for (const row of pending) {
        const mapped = mapTool(row, cached.get(row.articleId));
        if (!mapped.ok) {
          console.log(JSON.stringify({ articleId: row.articleId, skipped: mapped.problem }, null, 2));
          continue;
        }
        console.log(JSON.stringify({ articleId: mapped.tool.articleId, request: preview(mapped.tool) }, null, 2));
        previewed += 1;
      }
      console.log(`dry-run：预览 ${previewed} 条（共读取 ${pending.length} 条候选）；未联网、未写入。加 --all 才推送。`);
    }
    process.exitCode = 0;
  } else if (classify) {
    const result = await classifyOnly({ limit, onlyMissing: !reclassify });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.byRules > 0 ? 1 : 0;
  } else if (updateExisting) {
    const summary = await updateSent({ limit, reclassify });
    console.log(JSON.stringify({
      attempted: summary.attempted,
      updated: summary.updated,
      failed: summary.failed,
      stopped: summary.stopped,
      error: summary.error,
    }, null, 2));
    for (const item of summary.items.filter((entry) => entry.error)) console.log(`${item.articleId} 远端 ${item.remoteId} ${item.error}`);
    process.exitCode = summary.stopped || summary.failed > 0 ? 1 : 0;
  } else {
    if (retryFailed) {
      const reset = await resetFailed();
      console.log(`重置 ${reset} 条失败记录，最多再试 ${MAX_ATTEMPTS} 次。`);
    }
    const summary = await pushCandidates({ limit, retryFailed, reclassify });
    console.log(JSON.stringify({
      attempted: summary.attempted,
      sent: summary.sent,
      exists: summary.exists,
      failed: summary.failed,
      skipped: summary.skipped,
      stopped: summary.stopped,
      error: summary.error,
    }, null, 2));
    for (const item of summary.items.filter((entry) => entry.error)) console.log(`${item.articleId} ${item.status} ${item.error}`);
    process.exitCode = summary.stopped || summary.failed > 0 ? 1 : 0;
  }
} finally {
  await closeDb();
}
