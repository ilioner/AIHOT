import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { stableJson } from "../lib/ids.ts";
import { validSourcePrefilter } from "./source-prefilter.ts";

export const ManualPrefilterSchema = z.object({
  revision: z.number().int().positive(),
  analysisId: z.number().int().positive(),
  requestId: z.string().min(8).max(80),
  actor: z.string().min(1),
  reason: z.string().trim().min(1).max(2000),
}).strict();

export type ManualPrefilterPass = z.infer<typeof ManualPrefilterSchema>;

export function manualPrefilterPass(value: unknown, revision: number): ManualPrefilterPass | null {
  const parsed = ManualPrefilterSchema.safeParse(value);
  return parsed.success && parsed.data.revision === revision ? parsed.data : null;
}

export function prefilterPassed(output: { prefilter?: { label?: string } | null; manualPrefilter?: unknown; sourcePrefilter?: unknown } | undefined, fields: Record<string, unknown>, revision: number, sourceId?: string): boolean {
  if (output && "sourcePrefilter" in output) return output.prefilter?.label === "PASS" && validSourcePrefilter(output.sourcePrefilter, sourceId, revision);
  if (output?.prefilter?.label === "PASS") return true;
  const approved = manualPrefilterPass(fields.manualPrefilter, revision);
  return output?.prefilter?.label === "UNKNOWN" && !!approved && stableJson(output.manualPrefilter) === stableJson(approved);
}

export async function loadManualPrefilter(articleId: string, revision: number, db: Db = sql) {
  const [row] = await db<{ approval: unknown; label: string; reason: string | null; model: string | null; receipt_ids: number[] }[]>`
    SELECT e.fields->'manualPrefilter' AS approval, an.output->'prefilter'->>'label' AS label,
      an.output->'prefilter'->>'reason' AS reason, an.model, an.receipt_ids
    FROM editorial_overrides e JOIN analyses an ON an.article_id=e.article_id
      AND an.id::text=e.fields->'manualPrefilter'->>'analysisId'
    WHERE e.article_id=${articleId} AND an.input_revision=${revision} AND an.origin='model'
      AND an.output->'prefilter'->>'label'='UNKNOWN'`;
  const approval = manualPrefilterPass(row?.approval, revision);
  if (!row || !approval) return null;
  return { approval, prefilter: { label: "UNKNOWN" as const, reason: row.reason ?? "", model: row.model ?? "",
    receiptId: row.receipt_ids[0] ?? null, reused: true } };
}
