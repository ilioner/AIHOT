// What the site's modules add to the web pages (site/modules/index.ts).
import type { WebModule } from "@aihot/web/modules";
import wereadMp from "@aihot/weread-mp/web";
import skillhubPush from "@aihot/skillhub-push/web";

export const WEB_MODULES: readonly WebModule[] = [wereadMp, skillhubPush];
