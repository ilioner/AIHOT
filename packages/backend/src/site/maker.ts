// The maker block on the about page can show the avatar of an X account the site follows as a source
// (ABOUT.maker).
import { ABOUT } from "@aihot/site";
import { sql } from "../db.ts";
import { proxiedImage } from "../media/imgproxy.ts";

/** The maker's avatar at 400px through the image proxy, or null without a maker source or icon. */
export async function loadMakerAvatar(): Promise<string | null> {
  const sourceId = ABOUT.maker?.avatarSourceId;
  if (!sourceId) return null;
  const [row] = await sql<{ icon_url: string | null }[]>`SELECT icon_url FROM sources WHERE id = ${sourceId}`;
  const icon = row?.icon_url?.replace(/_(normal|bigger|mini)(\.\w+)$/, "_400x400$2") ?? null;
  return proxiedImage(icon, "thumb");
}
