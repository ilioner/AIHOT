// Runtime category snapshot shared by HTTP requests, editorial jobs and report composition.
import { z } from "zod";
import { CATEGORY_KEY_PATTERN, CHANNEL_KEYS, DEFAULT_CATEGORIES, type CategoryDefinition } from "@aihot/contracts/taxonomy";
import { sql, type Db } from "./db.ts";

export const CategorySchema = z.object({
  key: z.string().max(60).regex(CATEGORY_KEY_PATTERN).refine(key => !(CHANNEL_KEYS as readonly string[]).includes(key), "分类 key 不能使用固定筛选入口"),
  label: z.string().trim().min(1).max(60),
  tag: z.string().trim().min(1).max(60),
  guide: z.string().trim().min(1).max(4000),
  section: z.string().trim().min(1).max(100),
  tagColor: z.enum(["neutral", "blue", "wathet", "turquoise", "green", "lime", "yellow", "orange", "red", "carmine", "violet", "purple", "indigo", "amber", "grey", "gray"]),
  feedLabel: z.string().trim().min(1).max(100).optional(),
  commentary: z.boolean().optional(),
  enabled: z.boolean(),
}).strict();

export const CategoriesSchema = z.array(CategorySchema).min(1).max(100).superRefine((categories, ctx) => {
  for (const field of ["key", "tag"] as const) {
    const seen = new Set<string>();
    categories.forEach((c, i) => {
      if (seen.has(c[field])) ctx.addIssue({ code: "custom", path: [i, field], message: `分类${field === "key" ? " key" : "首标签"}重复` });
      seen.add(c[field]);
    });
  }
  if (!categories.some(c => c.enabled)) ctx.addIssue({ code: "custom", message: "至少保留一个启用的分类" });
});

export async function loadCategories(db: Db = sql): Promise<CategoryDefinition[]> {
  const [row] = await db<{ value: CategoryDefinition[] }[]>`SELECT value FROM settings WHERE key = 'categories'`;
  return row ? CategoriesSchema.parse(row.value) : DEFAULT_CATEGORIES.map(c => ({ ...c }));
}
