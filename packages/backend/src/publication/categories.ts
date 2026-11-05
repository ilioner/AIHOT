// The public projection contains no editorial guides, audit details or other settings.
import { feedCategoryLabel, type CategoryDefinition, type PublicCategoryView } from "@aihot/contracts/taxonomy";
export { loadCategories } from "../taxonomy.ts";

export function publicCategoryViews(categories: readonly CategoryDefinition[]): PublicCategoryView[] {
  return categories.map(c => ({ key: c.key, label: c.label, enabled: c.enabled, feedLabel: feedCategoryLabel(c.key, categories) }));
}
