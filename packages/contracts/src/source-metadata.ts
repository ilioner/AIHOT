export interface SourceMetadata {
  title: string;
  originalTitle?: string | null;
  categories: string[];
  tags: string[];
  coverUrl?: string | null;
  iconUrl?: string | null;
  documentUrl?: string | null;
  catalogUrl?: string | null;
  itemUrl: string;
  originalUrl?: string | null;
}

export function sourceMetadata(value: unknown): SourceMetadata | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const url = (input: unknown): string | null => {
    if (typeof input !== "string") return null;
    try {
      const parsed = new URL(input);
      return /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
    } catch { return null; }
  };
  const itemUrl = url(record.itemUrl);
  if (typeof record.title !== "string" || !itemUrl) return null;
  const strings = (input: unknown) => Array.isArray(input) ? [...new Set(input.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()).map(entry => entry.trim()))] : [];
  return {
    title: record.title, originalTitle: typeof record.originalTitle === "string" ? record.originalTitle : null,
    categories: strings(record.categories), tags: strings(record.tags), itemUrl,
    originalUrl: url(record.originalUrl), catalogUrl: url(record.catalogUrl), coverUrl: url(record.coverUrl),
    iconUrl: url(record.iconUrl), documentUrl: url(record.documentUrl),
  };
}
