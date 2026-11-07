import { defineWebModule } from "@aihot/web/modules";

export default defineWebModule({
  name: "skillhub-push",
  admin: {
    groups: [{ group: "AI 工具", items: [{ to: "/admin/skillhub-push", label: "skillhub 推送" }] }],
  },
});
