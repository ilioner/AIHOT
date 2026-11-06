import { defineServerModule } from "@aihot/backend/modules";
import { collectCatalog, collectQueue, scheduleCollect } from "./backend/collect.ts";

export default defineServerModule({
  name: "source-catalogs",
  sourceKinds: { external: { fetchNow: source => collectCatalog(source.id) } },
  queues: [collectQueue],
  schedules: [{ name: "source-catalogs.collect", cron: "*/15 * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: scheduleCollect }],
});
