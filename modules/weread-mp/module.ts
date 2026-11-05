import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "weread-mp",
  adminPages: [{ path: "admin/weread", file: "web/page.tsx", id: "admin-weread" }],
  apiPaths: [/^\/api\/admin\/weread(?:\/|$)/],
});
