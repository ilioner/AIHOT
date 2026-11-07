// Which `aitool.category` / `aitool.audience` / `aitool.feature` code one published tool belongs to,
// decided by the model the admin picked for the step `skillhub-classify` (deepseek unless changed) from
// the codes the dictionaries actually have. The answer is cached per article in `skillhub_tool_types`,
// so a second run costs nothing; a model that is down, slow, or answers a code we do not have is not a
// reason to stop pushing — those rows fall back to the keyword rules and say so (`decidedBy: "rules"`).
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { modelRoute } from "@aihot/backend/editorial/models";
import { MODELS, chatJson } from "@aihot/backend/providers/llm";
import { POLICY_CATEGORY_CODE, rulesFor, type Dictionaries, type ToolRow, type ToolTypes } from "./mapping.ts";

/** The step's key in the admin's「模型与评测」page and in site/models.ts (declared in server.ts). */
export const CLASSIFY_STEP = "skillhub-classify";
/** Bumped whenever the prompt changes: a receipt keeps the version it was paid under. */
export const PROMPT_VERSION = "skillhub-classify-2";
/** Ten rows per call keeps the answer inside maxTokens (each row is ~120 output tokens). */
export const CLASSIFY_BATCH = 10;
const MAX_TOKENS = 2500;

/**
 * What each dictionary code means, in Chinese, for the prompt. Only codes the deployed dictionaries
 * actually have are sent, so a different skillhub (or an extra code) still works.
 */
const CODE_LABELS: Record<string, string> = {
  // aitool.category
  "text-writing": "文本写作（写作、文案、翻译、提示词、摘要、润色）",
  "image-video": "图像视频（绘画、图片、视频、音视频、设计、3D、剪辑、摄影、数字人）",
  "software-development": "软件开发（编程、代码、API、Agent、智能体、数据库、部署、运维）",
  "office-productivity": "办公效率（办公、效率、会议、求职、电商、助理、聊天、知识管理、导航）",
  "literature-research": "文献研究（文献、论文、科研、学术、研究工具）",
  "training-resources": "培训资源（培训、学习、教程、课程、教育、教学、考试）",
  "policy-regulations": "政策法规（政策、法规、合规、监管、法律文件）",
  "academic-ethics": "学术伦理（学术诚信、伦理、查重与引用规范）",
  // aitool.audience
  "student-learning": "学生学习（学生自学、作业、备考）",
  "teacher-research": "教师教研（教师备课、教研、教学研究）",
  "administrative-office": "行政办公（学校行政、管理与办公事务）",
  // aitool.feature
  "authoritative-release": "权威发布（官方、政府或机构正式发布）",
  "editorial-pick": "编辑精选（源站明确标为推荐、精选）",
  other: "其他（以上都不合适时）",
};

const ReplyRow = z.object({
  articleId: z.string().min(1).max(80),
  categoryCode: z.string().min(1).max(80),
  audienceCode: z.string().min(1).max(80),
  featureCode: z.string().min(1).max(80).nullish(),
  reason: z.string().max(200).nullish(),
});
const Reply = z.object({ items: z.array(ReplyRow).max(CLASSIFY_BATCH * 2) });
export type Classification = z.infer<typeof ReplyRow>;

const SYSTEM = [
  "你是 AI 工具目录的分类编辑。给定若干条工具，为每一条从下面的 code 里选 categoryCode、audienceCode、featureCode。",
  "- 只能使用清单里出现的 code，不许发明，也不许改写成别的写法。",
  "- categoryCode 选最贴合这条工具主要用途的一项；看不出用途就用 other（清单里有的话），否则用 office-productivity。",
  "- audienceCode 按主要使用者选：教师教研（教师备课、教研、教学与评价）、学生学习（学生自学、作业、备考）、行政办公（学校行政、管理与办公事务）。通用工具也要挑最接近的一类，只有确实看不出与这三类使用者任何一种有关时才用 other。",
  "- featureCode：只有官方/政府/权威机构正式发布的文件或平台才给 authoritative-release；只有源站自己标为推荐、精选才给 editorial-pick；其余一律 null。",
  "- reason 用不超过 40 个字说明理由。",
  "只输出 JSON：{\"items\":[{\"articleId\":\"…\",\"categoryCode\":\"…\",\"audienceCode\":\"…\",\"featureCode\":null,\"reason\":\"…\"}]}，条数与输入一致，不要输出多余文字。",
].join("\n");

/** One code list, only the codes this deployment's dictionary has. */
function codeList(ids: ReadonlyMap<string, number>): string {
  return [...ids.keys()].map((code) => `- ${code}${CODE_LABELS[code] ? `：${CODE_LABELS[code]}` : ""}`).join("\n");
}

function promptFor(rows: readonly ToolRow[], ids: Dictionaries): string {
  const items = rows.map((row) => ({
    articleId: row.articleId,
    title: row.title.slice(0, 200),
    summary: (row.summary ?? "").replace(/\s+/g, " ").slice(0, 300),
    sourceCategory: [row.blockName ?? "", ...row.categories].filter(Boolean).slice(0, 6),
    tags: row.tags.slice(0, 10),
    publicationCategory: row.publicationCategory ?? null,
  }));
  return [
    "可选 code：",
    "categoryCode：",
    codeList(ids.category),
    "audienceCode：",
    codeList(ids.audience),
    "featureCode（可为 null）：",
    codeList(ids.feature),
    "",
    "工具清单（JSON）：",
    JSON.stringify(items),
  ].join("\n");
}

/** Where one article's codes came from, as `skillhub_tool_types` keeps it. */
export interface Classified {
  types: ToolTypes;
  model: string | null;
  reason: string | null;
}

/** The model's answer for one article, checked against the codes the dictionaries have. */
function accepted(answer: Classification, ids: Dictionaries): ToolTypes | null {
  if (!ids.category.has(answer.categoryCode)) return null;
  if (!ids.audience.has(answer.audienceCode)) return null;
  const feature = answer.featureCode ?? null;
  if (feature !== null && !ids.feature.has(feature)) return null;
  return {
    categoryCode: answer.categoryCode,
    audienceCode: answer.audienceCode,
    featureCode: feature,
    decidedBy: "model",
  };
}

/** One paid call for up to CLASSIFY_BATCH rows. Throws when the model or its answer is unusable. */
async function classifyBatch(rows: readonly ToolRow[], ids: Dictionaries): Promise<Map<string, Classified>> {
  const route = await modelRoute(CLASSIFY_STEP);
  const answer = await chatJson({
    ...route,
    purpose: "skillhub_classify",
    subject: `skillhub:${rows.length} 条工具`,
    promptVersion: PROMPT_VERSION,
    system: SYSTEM,
    user: promptFor(rows, ids),
    schema: Reply,
    temperature: 0,
    maxTokens: MAX_TOKENS,
  });
  const byArticle = new Map(answer.data.items.map((item) => [item.articleId, item]));
  const out = new Map<string, Classified>();
  for (const row of rows) {
    const item = byArticle.get(row.articleId);
    const types = item ? policyKept(row, accepted(item, ids), ids) : null;
    // The model answered something we cannot use (or did not answer this row): the rules decide, and
    // the row is stored as such so the next run does not pay for the same question again.
    out.set(row.articleId, types
      ? { types, model: concreteModel(answer.model), reason: item?.reason?.trim() || null }
      : { types: rulesFor(row), model: null, reason: item ? `模型给的 code 不在字典里：${item.categoryCode} / ${item.audienceCode} / ${item.featureCode ?? "null"}` : "模型没有返回这一条" });
  }
  return out;
}

/**
 * A policy notice stays under 政策法规 whatever the model answered: the audience and the feature may come
 * from the model, the category does not. (The rules already do this; this covers the model path.)
 */
function policyKept(row: ToolRow, types: ToolTypes | null, ids: Dictionaries): ToolTypes | null {
  if (!types || row.publicationCategory !== "policy") return types;
  if (types.categoryCode === POLICY_CATEGORY_CODE || !ids.category.has(POLICY_CATEGORY_CODE)) return types;
  return { ...types, categoryCode: POLICY_CATEGORY_CODE };
}

/** The cached codes of the given articles; empty when the module's table was never created. */
export async function loadTypes(articleIds: readonly string[]): Promise<Map<string, ToolTypes>> {
  const out = new Map<string, ToolTypes>();
  if (articleIds.length === 0) return out;
  try {
    const rows = await sql<{ article_id: string; category_code: string; audience_code: string; feature_code: string | null; decided_by: string }[]>`
      SELECT article_id, category_code, audience_code, feature_code, decided_by FROM skillhub_tool_types
      WHERE article_id = ANY(${articleIds as string[]}::text[])`;
    for (const row of rows) {
      out.set(row.article_id, {
        categoryCode: row.category_code,
        audienceCode: row.audience_code,
        featureCode: row.feature_code,
        decidedBy: row.decided_by === "model" ? "model" : "rules",
      });
    }
  } catch {
    // Before the migration ran there is no cache; the caller classifies (or uses the rules) instead.
  }
  return out;
}

async function saveTypes(rows: readonly ToolRow[], classified: ReadonlyMap<string, Classified>): Promise<void> {
  for (const row of rows) {
    const picked = classified.get(row.articleId);
    if (!picked) continue;
    await sql`INSERT INTO skillhub_tool_types (article_id, category_code, audience_code, feature_code, model, reason, decided_by)
      VALUES (${row.articleId}, ${picked.types.categoryCode}, ${picked.types.audienceCode}, ${picked.types.featureCode},
        ${picked.model}, ${picked.reason}, ${picked.types.decidedBy})
      ON CONFLICT (article_id) DO UPDATE SET
        category_code = excluded.category_code, audience_code = excluded.audience_code, feature_code = excluded.feature_code,
        model = excluded.model, reason = excluded.reason, decided_by = excluded.decided_by, updated_at = now()`;
  }
}

export interface EnsureOptions {
  /** Throw the cache away and ask the model again (后台「用模型重新分类」, `--reclassify`). */
  force?: boolean;
  /** Called with what each row ended up as, for the script's log. */
  onResult?: (rows: readonly ToolRow[], classified: Map<string, Classified>) => void;
}

/**
 * The codes for the given rows: the cached ones, then the model for whatever is missing. Never throws —
 * a model that fails leaves those rows on the rules, which is still pushable.
 */
export async function ensureTypes(rows: readonly ToolRow[], ids: Dictionaries, options: EnsureOptions = {}): Promise<Map<string, ToolTypes>> {
  const cached = options.force ? new Map<string, ToolTypes>() : await loadTypes(rows.map((row) => row.articleId));
  const out = new Map<string, ToolTypes>(cached);
  const missing = rows.filter((row) => !out.has(row.articleId));
  if (missing.length > 0) inFlight += 1;
  try {
    for (let start = 0; start < missing.length; start += CLASSIFY_BATCH) {
      const batch = missing.slice(start, start + CLASSIFY_BATCH);
      let classified: Map<string, Classified>;
      try {
        classified = await classifyBatch(batch, ids);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 200);
        classified = new Map(batch.map((row) => [row.articleId, { types: rulesFor(row), model: null, reason: `模型不可用，改用规则：${message}` }]));
      }
      for (const row of batch) out.set(row.articleId, classified.get(row.articleId)!.types);
      options.onResult?.(batch, classified);
      try {
        await saveTypes(batch, classified);
      } catch (error) {
        // An unwritable cache costs the next run another model call, not the push.
        console.warn(`[skillhub-push] 分类结果没写进 skillhub_tool_types：${String(error instanceof Error ? error.message : error).slice(0, 200)}`);
      }
    }
  } finally {
    if (missing.length > 0) inFlight -= 1;
  }
  return out;
}

/** How many classification batches are running in this process (the admin page's「分类中」). */
let inFlight = 0;

export function classificationRunning(): boolean {
  return inFlight > 0;
}

/** How many articles have codes stored, and who decided them (the admin overview). */
export async function typeCounts(): Promise<{ classified: number; byModel: number; byRules: number }> {
  try {
    const [row] = await sql<{ classified: number; by_model: number; by_rules: number }[]>`
      SELECT count(*)::int AS classified,
        count(*) FILTER (WHERE decided_by = 'model')::int AS by_model,
        count(*) FILTER (WHERE decided_by <> 'model')::int AS by_rules
      FROM skillhub_tool_types`;
    return { classified: row?.classified ?? 0, byModel: row?.by_model ?? 0, byRules: row?.by_rules ?? 0 };
  } catch {
    return { classified: 0, byModel: 0, byRules: 0 };
  }
}

/** `default` is the deployment's own model (`LLM_MODEL` in .env); show that name, not the alias. */
export function concreteModel(key: string): string {
  return MODELS[key]?.model || key;
}

/** The model the step is on now, for the admin page; null when the step is not routable. */
export async function currentModel(): Promise<string | null> {
  try {
    return concreteModel((await modelRoute(CLASSIFY_STEP)).model);
  } catch {
    return null;
  }
}
