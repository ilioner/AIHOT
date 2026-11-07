import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "skillhub-push",
  adminPages: [{ path: "admin/skillhub-push", file: "web/page.tsx", id: "admin-skillhub-push" }],
  apiPaths: [/^\/api\/admin\/skillhub(?:\/|$)/],
});
