// Seeds a fresh site from the industry pack: the demo sources (industry/sources.json, only the ones not
// there yet, so admin edits are never undone) and the default paid-service budgets. Topics need no
// seeding: they are read from industry/topics.json.
// Re-runnable:  node --env-file=.env scripts/seed.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

interface SeedSource {
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "web_search" | "x_search" | "mp_account" | "external";
  config: Record<string, unknown>;
  tier?: string;
  owner_entity_id?: string | null;
  participation_mode?: string;
  interval_minutes?: number;
  tags?: string[];
  site_fulltext?: boolean;
  syndicate_fulltext?: boolean;
  enabled?: boolean;
}

const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: SeedSource[] };
let added = 0;
for (const s of sources) {
  assertSupportedConfig(s.kind, s.config);
  const tier = s.tier ?? "T2";
  // First-party means a T1 source, as the admin sets it.
  const inserted = await sql`
    INSERT INTO sources (id, name, kind, config, tier, first_party, owner_entity_id, participation_mode, interval_minutes, tags, site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
    VALUES (${s.id}, ${s.name}, ${s.kind}, ${sql.json(s.config as never)}, ${tier}, ${tier === "T1"}, ${s.owner_entity_id ?? null},
            ${s.participation_mode ?? "editorial"}, ${s.interval_minutes ?? 60}, ${s.tags ?? []}, ${s.site_fulltext ?? false}, ${s.syndicate_fulltext ?? false},
            ${s.enabled ?? true}, now())
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  added += inserted.length;
}
console.log(`sources: ${added} added, ${sources.length - added} already there`);
// Default budget rows for paid services added after 0055: online migrations accept no INSERT
// (scripts/migration-safety.ts), so this idempotent default travels with the other seed data, which
// every deployment runs after migrate. Without a row a service is unlimited, so a site that only ran
// migrate must set the row by hand (docs/deploy.md).
const DEFAULT_BUDGETS: Array<[service: string, perMinute: number, perHour: number, perDay: number, note: string]> = [
  ["fathom", 5, 10, 12, "网页搜索（按请求计费）"],
];
for (const [service, perMinute, perHour, perDay, note] of DEFAULT_BUDGETS) {
  // per_minute covers the first run, when every search source is due at once.
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day, note)
            VALUES (${service}, ${perMinute}, ${perHour}, ${perDay}, ${note}) ON CONFLICT (service) DO NOTHING`;
}
await closeDb();
