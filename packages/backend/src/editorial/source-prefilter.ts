import { z } from "zod";
import { SELECTION } from "@aihot/industry/selection";

const SourcePrefilterSchema = z.object({ sourceId: z.string().min(1), revision: z.number().int().positive() }).strict();
export type SourcePrefilterPass = z.infer<typeof SourcePrefilterSchema>;

export function sourcePrefilterPass(sourceId: string | undefined, revision: number): SourcePrefilterPass | null {
  return sourceId && SELECTION.prefilterPassSources.includes(sourceId) ? { sourceId, revision } : null;
}

export function validSourcePrefilter(value: unknown, sourceId: string | undefined, revision: number): boolean {
  const parsed = SourcePrefilterSchema.safeParse(value);
  return parsed.success && parsed.data.sourceId === sourceId && parsed.data.revision === revision && !!sourcePrefilterPass(sourceId, revision);
}
