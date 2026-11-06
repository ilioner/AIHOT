// The backend of the site's modules, installed by the api and the worker when they start (site/modules/index.ts).
import type { ServerModule } from "@aihot/backend/modules";
import wereadMp from "@aihot/weread-mp/server";
import sourceCatalogs from "@aihot/source-catalogs/server";

export const SERVER_MODULES: readonly ServerModule[] = [wereadMp, sourceCatalogs];
