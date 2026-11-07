// One published tool directory entry turned into skillhub's create request. Pure: no database and no
// network, so the rules (slug, canonical address, categories, dictionary codes) are checked directly.
// The dictionary IDs are not fixed values: they are looked up by `code` at push time, because the
// numbers differ between environments (admin-ai-tool-create-api.md).
import { createHash } from "node:crypto";
import { identityKeyForUrl } from "@aihot/backend/lib/url";

/** The dictionary item IDs the create call needs, by dictionary code (aitool.category, …). */
export interface Dictionaries {
  category: ReadonlyMap<string, number>;
  audience: ReadonlyMap<string, number>;
  feature: ReadonlyMap<string, number>;
}

/** One row of the published tool directory, as the query reads it. */
export interface ToolRow {
  articleId: string;
  identityKey?: string | null;
  /** The publication's own category: 'ai-tools' for the directories, 'policy' for the notices. */
  publicationCategory?: string | null;
  sourceId: string;
  /** The source's name, e.g. 优设 · AI 导航. */
  sourceName: string | null;
  title: string;
  url: string;
  summary: string | null;
  /** The source's own category block (优设导航: 热门推荐, AI绘画 …). */
  blockName: string | null;
  /** The source's category labels (AIbase: 视频生成 …). */
  categories: string[];
  tags: string[];
  iconUrl: string | null;
  media: unknown;
}

/** The body of POST /api/v1/admin/ai-tools, with every dictionary ID resolved. */
export interface ToolPayload {
  name: string;
  slug: string;
  url: string;
  canonicalUrl: string;
  description: string | null;
  categoryDictItemId: number;
  audienceDictItemId: number | null;
  featureDictItemId: number | null;
  aiNote: string;
  iconUrl: string | null;
}

/** What the mapping works out before the dictionaries are read: codes, not IDs. */
export interface MappedTool {
  articleId: string;
  name: string;
  slug: string;
  url: string;
  canonicalUrl: string;
  description: string | null;
  iconUrl: string | null;
  aiNote: string;
  categoryCode: string;
  audienceCode: string;
  featureCode: string | null;
  /** Who chose the three codes above: the configured model, or these rules. */
  decidedBy: "model" | "rules";
}

/**
 * The three codes one article was given, from the model or from the rules, as `skillhub_tool_types`
 * keeps them. Everything here is already checked against the dictionaries' codes.
 */
export interface ToolTypes {
  categoryCode: string;
  audienceCode: string;
  featureCode: string | null;
  decidedBy: "model" | "rules";
}

export const DEFAULT_CATEGORY_CODE = "office-productivity";
export const DEFAULT_AUDIENCE_CODE = "teacher-research";
/** Where a publication of category 'policy' goes: the notices are 教育部/职教所 的政策文件, not tools. */
export const POLICY_CATEGORY_CODE = "policy-regulations";
/** The only feature this module sets: 编辑精选, for entries the source marks as recommended. */
export const EDITORIAL_PICK_CODE = "editorial-pick";

/**
 * Source category block / label / tag keyword → `aitool.category` code, most specific first. The block
 * names are 优设 AI 导航's own (AI绘画, AI办公, Skills, AI工具合集 …); the labels are AIbase's
 * (视频生成, 代码助手 …). Anything that matches nothing falls back to office-productivity.
 */
const CATEGORY_RULES: ReadonlyArray<readonly [code: string, keywords: readonly string[]]> = [
  ["academic-ethics", ["伦理", "学术诚信", "诚信"]],
  ["literature-research", ["文献", "论文", "科研", "学术", "研究"]],
  ["training-resources", ["培训", "学习", "教程", "课程", "教育", "教学", "考试"]],
  ["policy-regulations", ["政策", "法规", "合规", "监管", "法律"]],
  ["software-development", ["编程", "开发", "代码", "api", "skills", "agent", "智能体", "数据库", "部署", "运维"]],
  ["text-writing", ["写作", "文案", "文本", "翻译", "提示词", "prompt", "摘要", "小说", "润色"]],
  ["image-video", ["绘画", "图像", "图片", "视频", "音视频", "设计", "3d", "ui", "音乐", "语音", "剪辑", "摄影", "aigc", "角色", "数字人", "建模"]],
  ["office-productivity", ["办公", "效率", "会议", "求职", "电商", "助理", "聊天", "知识管理", "检测", "安全", "seo", "导航"]],
];

/** The source's own labels of one entry, in the order the rules read them. */
function sourceLabels(row: Pick<ToolRow, "blockName" | "categories" | "tags">): string[] {
  return [row.blockName ?? "", ...row.categories, ...row.tags].map((label) => label.trim()).filter(Boolean);
}

/** The `aitool.category` code an entry belongs to. */
export function categoryCodeFor(row: Pick<ToolRow, "blockName" | "categories" | "tags"> & { publicationCategory?: string | null }): string {
  // A policy notice is a policy notice whatever its body says: the category the publication already
  // carries beats every keyword, which is how the 10 教育部/职教所 通知 land in policy-regulations.
  if (row.publicationCategory === "policy") return POLICY_CATEGORY_CODE;
  const text = sourceLabels(row).join(" ").toLowerCase();
  for (const [code, keywords] of CATEGORY_RULES) {
    if (keywords.some((keyword) => text.includes(keyword))) return code;
  }
  return DEFAULT_CATEGORY_CODE;
}

/** The three codes the rules alone give an entry — what the model's answer replaces, and what a failed call falls back to. */
export function rulesFor(row: ToolRow): ToolTypes {
  return {
    categoryCode: categoryCodeFor(row),
    audienceCode: DEFAULT_AUDIENCE_CODE,
    featureCode: featureCodeFor(row.tags),
    decidedBy: "rules",
  };
}

/** 编辑精选 only when the source itself marked the entry 推荐 or 精选; otherwise no feature at all. */
export function featureCodeFor(tags: readonly string[]): string | null {
  return tags.some((tag) => /推荐|精选/.test(tag)) ? EDITORIAL_PICK_CODE : null;
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The source's address identity: preserve fragments only when collection used them to distinguish entries. */
export function canonicalToolUrl(raw: string, identityKey?: string | null): string | null {
  const keepFragment = identityKey === identityKeyForUrl(raw, { keepFragment: true });
  const key = identityKeyForUrl(raw, { keepFragment });
  if (!key || !key.startsWith("url:")) return null; // x.com statuses and unparsable input are not tools
  return httpUrl(key.slice("url:".length));
}

/**
 * A stable, legal slug: the host plus the first eight hex digits of the canonical address's SHA-256.
 * The digest is what makes it unique — one canonical address per published tool — and the host keeps
 * it readable. Fits `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 200 characters.
 */
export function slugForUrl(canonicalUrl: string): string {
  const host = new URL(canonicalUrl).hostname.toLowerCase().replace(/^www\./, "");
  const prefix = host.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tool";
  const digest = createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 8);
  return `${prefix}-${digest}`.slice(0, 200).replace(/-+$/, "");
}

function trimmed(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function iconOf(row: ToolRow): string | null {
  const direct = httpUrl(row.iconUrl ?? "");
  if (direct) return direct;
  for (const item of Array.isArray(row.media) ? row.media : []) {
    const url = (item as { url?: unknown } | null)?.url;
    if (typeof url !== "string") continue;
    const found = httpUrl(url);
    if (found) return found;
  }
  return null;
}

/** Where the entry came from, in words: the directory, its own category block and its labels. */
export function aiNoteFor(row: ToolRow): string {
  const parts = [`来源目录：${trimmed(row.sourceName) || row.sourceId}`];
  const categories = [...new Set([trimmed(row.blockName), ...row.categories.map(trimmed)])].filter(Boolean);
  if (categories.length > 0) parts.push(`源站分类：${categories.join("、")}`);
  const tags = row.tags.map(trimmed).filter(Boolean);
  if (tags.length > 0) parts.push(`标签：${tags.join("、")}`);
  return parts.join("；").slice(0, 1000);
}

/**
 * Everything the dictionaries do not decide. A row with no usable address is not pushable.
 * `types` is what the classifier (or the cached row in skillhub_tool_types) chose; without it the
 * rules decide, so a dry run and an unclassified article still map.
 */
export function mapTool(row: ToolRow, types?: ToolTypes | null): { ok: true; tool: MappedTool } | { ok: false; problem: string } {
  const name = [...trimmed(row.title)].slice(0, 200).join("");
  if (!name) return { ok: false, problem: "标题为空" };
  const url = httpUrl(row.url);
  if (!url) return { ok: false, problem: `不是可推送的 HTTP 地址：${trimmed(row.url).slice(0, 120) || "（空）"}` };
  const canonicalUrl = canonicalToolUrl(row.url, row.identityKey);
  if (!canonicalUrl) return { ok: false, problem: `地址无法归一化：${url.slice(0, 120)}` };
  const chosen = types ?? rulesFor(row);
  // A policy notice is filed under 政策法规 whatever the stored answer says: it is not a tool, and a
  // stale cache row (or a model that answered 办公效率) must not file it as one.
  const categoryCode = row.publicationCategory === "policy" ? POLICY_CATEGORY_CODE : chosen.categoryCode;
  return {
    ok: true,
    tool: {
      articleId: row.articleId,
      name,
      slug: slugForUrl(canonicalUrl),
      url,
      canonicalUrl,
      description: trimmed(row.summary) || null,
      iconUrl: iconOf(row),
      aiNote: aiNoteFor(row),
      categoryCode,
      audienceCode: chosen.audienceCode,
      featureCode: chosen.featureCode,
      decidedBy: chosen.decidedBy,
    },
  };
}

/** The create request, with the three dictionary IDs looked up by code. */
export function toolPayload(tool: MappedTool, ids: Dictionaries): { ok: true; payload: ToolPayload } | { ok: false; problem: string } {
  const categoryId = ids.category.get(tool.categoryCode) ?? ids.category.get(DEFAULT_CATEGORY_CODE);
  if (!categoryId) return { ok: false, problem: `字典 aitool.category 里没有 ${tool.categoryCode}（也没有 ${DEFAULT_CATEGORY_CODE}）` };
  return {
    ok: true,
    payload: {
      name: tool.name,
      slug: tool.slug,
      url: tool.url,
      canonicalUrl: tool.canonicalUrl,
      description: tool.description,
      categoryDictItemId: categoryId,
      audienceDictItemId: ids.audience.get(tool.audienceCode) ?? null,
      featureDictItemId: tool.featureCode ? ids.feature.get(tool.featureCode) ?? null : null,
      aiNote: tool.aiNote,
      iconUrl: tool.iconUrl,
    },
  };
}
