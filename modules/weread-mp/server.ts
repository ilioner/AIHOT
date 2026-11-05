import { defineServerModule } from "@aihot/backend/modules";
import { enqueue, QUEUES } from "@aihot/backend/jobs/queue";
import { registerWereadRoutes } from "./api/routes.ts";
import { collectQueue, collectSource, scheduleCollect } from "./backend/collect.ts";
import { isWereadBookId } from "./backend/wechat.ts";

export default defineServerModule({
  name: "weread-mp",
  http: registerWereadRoutes,
  sourceKinds: {
    // Only accounts this module added carry a WeRead book id in config.ghid. Every other mp_account
    // source belongs to the engine's Dajiala collector, so a manual fetch is handed back to its queue.
    mp_account: {
      fetchNow: async (source) => {
        if (!isWereadBookId(source.config.ghid)) {
          const jobId = await enqueue(QUEUES.mpCheck, { sourceId: source.id, reason: "manual" }, { singletonKey: `mp:${source.id}` });
          return { jobId };
        }
        const result = await collectSource(source.id, "manual");
        return { sourceId: result.sourceId, status: result.status, found: result.found, created: result.created, error: result.error };
      },
    },
  },
  queues: [collectQueue],
  schedules: [
    {
      name: "weread-mp.collect",
      cron: "*/15 * * * *",
      when: () => process.env.COLLECT_ENABLED === "true",
      run: () => scheduleCollect(),
    },
  ],
});
