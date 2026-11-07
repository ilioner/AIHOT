// Operator settings: per-service request budgets (the circuit breaker paid calls check before sending)
// and the category list.
import type { AdminBudget, AdminSettings, BeforeJson } from "@aihot/contracts/admin";
import { z } from "zod";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import { CategoriesSchema, loadCategories } from "../taxonomy.ts";
import type { CategoryDefinition } from "@aihot/contracts/taxonomy";

/** The settings page: paid-service budgets and the categories. */
export async function settingsOverview(): Promise<BeforeJson<AdminSettings>> {
  const [budgets, categories] = await Promise.all([listBudgets(), loadCategories()]);
  return { budgets, categories };
}

/** Keep existing identities and first tags: old URLs, articles and reports refer to them. */
const CategoriesUpdate = z.object({ categories: CategoriesSchema, reason: z.string().trim().min(1).max(1000) }).strict();

export async function updateCategories(input: unknown, actor: string): Promise<CategoryDefinition[]> {
  const { categories: next, reason } = CategoriesUpdate.parse(input);
  return sql.begin(async (tx) => {
    const before = await loadCategories(tx);
    for (const prior of before) {
      const current = next.find(c => c.key === prior.key);
      if (!current || current.tag !== prior.tag) throw Object.assign(new Error("已有分类 key 和首标签不能删除或修改，请停用该分类"), { statusCode: 400 });
    }
    await tx`INSERT INTO settings (key, value, updated_by) VALUES ('categories', ${tx.json(next as never)}, ${actor})
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(actor, "settings.categories", "settings:categories", reason, before, next, { db: tx });
    return next;
  }) as Promise<CategoryDefinition[]>;
}

export async function listBudgets(): Promise<BeforeJson<AdminBudget>[]> {
  return sql<BeforeJson<AdminBudget>[]>`
    SELECT b.service, b.per_minute, b.per_hour, b.per_day, b.note, b.updated_at,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day') AS used_day,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 hour') AS used_hour
    FROM budgets b ORDER BY b.service`;
}

export async function updateBudget(service: string, input: { perMinute: number; perHour: number; perDay: number; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  for (const v of [input.perMinute, input.perHour, input.perDay]) if (!Number.isInteger(v) || v < 0) throw new Error("budgets are non-negative integers (0 stops the service)");
  const [before] = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
  const [after] = await sql`
    INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES (${service}, ${input.perMinute}, ${input.perHour}, ${input.perDay}, ${input.reason})
    ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day, note = EXCLUDED.note, updated_at = now()
    RETURNING service, per_minute, per_hour, per_day`;
  await audit(actor, "budget.update", `budget:${service}`, input.reason, before ?? null, after);
  return after;
}
