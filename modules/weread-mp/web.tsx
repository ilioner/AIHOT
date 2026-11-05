import { defineWebModule } from "@aihot/web/modules";

export default defineWebModule({
  name: "weread-mp",
  admin: {
    groups: [{ group: "公众号", items: [{ to: "/admin/weread", label: "微信读书采集" }] }],
  },
});
