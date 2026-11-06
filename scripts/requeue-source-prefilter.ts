import { previewSourcePrefilter, requeueSourcePrefilter } from "@aihot/backend/admin/source-prefilter";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";

if (process.argv.slice(2).some(arg => arg !== "--apply")) throw new Error("用法：node --env-file-if-exists=.env scripts/requeue-source-prefilter.ts [--apply]");

try {
  const preview = await previewSourcePrefilter();
  const sources = Object.groupBy(preview, entry => entry.sourceId);
  console.log(JSON.stringify({ apply: process.argv.includes("--apply"), eligible: preview.length,
    sources: Object.fromEntries(Object.entries(sources).map(([source, entries]) => [source, entries!.length])) }));
  if (process.argv.includes("--apply")) {
    const results = await requeueSourcePrefilter(preview, "source-prefilter-policy", "使用者批准六个指定来源预筛直通 PASS；保留后续分析、拦截标签和人工下架");
    console.log(JSON.stringify({ queued: results.filter(entry => entry.status === "queued").length,
      skipped: results.filter(entry => entry.status === "skipped").length, failed: results.filter(entry => entry.status === "failed") }));
    if (results.some(entry => entry.status === "failed")) process.exitCode = 1;
  }
} finally {
  await stopBoss();
  await closeDb();
}
