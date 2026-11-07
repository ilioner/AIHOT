import { defineServerModule } from "@aihot/backend/modules";
import { registerSkillhubRoutes } from "./api/routes.ts";
import { pushQueue, schedulePush } from "./backend/push.ts";

/** Once a day is enough: a new tool waits at most a day, and nothing already pushed is sent again. */
const DEFAULT_CRON = "0 9 * * *";

export default defineServerModule({
  name: "skillhub-push",
  http: registerSkillhubRoutes,
  queues: [pushQueue],
  models: {
    // The admin's「模型与评测」page can point this step at another model, and SKILLHUB_CLASSIFY_MODEL
    // overrides it; by default it takes the site's `default`, which is `LLM_MODEL` in .env.
    "skillhub-classify": { label: "skillhub 工具分类", env: "SKILLHUB_CLASSIFY_MODEL", purposes: ["skillhub_classify"] },
  },
  schedules: [
    {
      name: "skillhub-push.sweep",
      cron: process.env.SKILLHUB_PUSH_CRON ?? DEFAULT_CRON,
      when: () => process.env.SKILLHUB_PUSH_ENABLED === "true",
      run: () => schedulePush(),
    },
  ],
});
