// Stable category identities are shared by URLs, publications and the worker. The industry pack
// supplies defaults; backend settings supply the current definitions to HTTP clients and jobs.
import { CATEGORIES, CATEGORY_FIRST_TAGS } from "@aihot/industry/taxonomy";
import { PUBLIC_CATEGORIES } from "@aihot/site";

export interface CategoryDefinition {
  key: string;
  label: string;
  tag: string;
  section: string;
  guide: string;
  tagColor: string;
  feedLabel?: string;
  commentary?: boolean;
  enabled: boolean;
}

export interface PublicCategoryView {
  key: string;
  label: string;
  enabled: boolean;
  feedLabel: string;
}

export const DEFAULT_CATEGORIES: readonly CategoryDefinition[] = CATEGORIES.map(c => ({ ...c, tag: CATEGORY_FIRST_TAGS[c.key]!, enabled: true }));
export type CategoryKey = string;
export const CATEGORY_KEYS = CATEGORIES.map(c => c.key) as unknown as readonly [string, ...string[]];
export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));

const MERGE: Partial<Record<string, string>> = PUBLIC_CATEGORIES.merge;
const FEED_LABELS: Partial<Record<string, string>> = PUBLIC_CATEGORIES.feedLabels;
export type PublicApiCategoryKey = string;

export function publicApiCategoryKeys(categories: readonly CategoryDefinition[]): string[] {
  return categories.filter(c => !Object.hasOwn(MERGE, c.key)).map(c => c.key);
}
export const PUBLIC_API_CATEGORY_KEYS = publicApiCategoryKeys(DEFAULT_CATEGORIES) as [string, ...string[]];

export function toPublicApiCategory(category: string | null, categories?: readonly CategoryDefinition[]): PublicApiCategoryKey | null {
  if (!category || (categories && !categories.some(c => c.key === category))) return null;
  return MERGE[category] ?? category;
}

export function feedCategoryLabel(key: PublicApiCategoryKey, categories: readonly CategoryDefinition[] = DEFAULT_CATEGORIES): string {
  const c = categories.find(c => c.key === key);
  return FEED_LABELS[key] ?? c?.feedLabel ?? c?.label ?? key;
}

export function isCategoryKey(value: unknown, categories: readonly Pick<CategoryDefinition, "key">[] = DEFAULT_CATEGORIES): value is CategoryKey {
  return typeof value === "string" && categories.some(c => c.key === value);
}

export const CATEGORY_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const CHANNEL_KEYS = ["all", "news", "x", "firstParty"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];
export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  all: "全部", news: "资讯", x: "X", firstParty: "一手",
};
export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === "string" && (CHANNEL_KEYS as readonly string[]).includes(value);
}

/** Article ids. Also the local-data import validation pattern. */
export const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
