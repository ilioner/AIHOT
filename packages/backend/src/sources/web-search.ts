// A web search (Fathom Search): one paid query per run, organic results only. The API states no
// publication date anywhere, so a candidate never claims one; extraction reads the target page's meta.
import { dayWindow, searchWeb, type FathomResult } from "../providers/fathom.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

export interface WebSearchFetch {
  candidates: Candidate[];
  receiptIds: number[];
  ads: number;
}

/** Pure, so the parser is testable without a database or a network: ads and non-http URLs are dropped. */
export function resultsToCandidates(results: FathomResult[]): { candidates: Candidate[]; ads: number } {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let ads = 0;
  for (const r of results) {
    if (r.type !== "organic") {
      ads += 1;
      continue;
    }
    const url = String(r.url ?? "").trim();
    const title = String(r.title ?? "").trim();
    if (!/^https?:\/\//i.test(url) || !title || seen.has(url)) continue;
    seen.add(url);
    candidates.push({
      url,
      title,
      excerpt: String(r.snippet ?? "").trim() || null,
      // No publishedAt: the API states none, and inventing one would publish old pages as news.
      // A pending body sends the extraction job to the page, which reads the date its meta carries.
      bodyStatus: "pending",
      raw: { engine: r.engine ?? null, searchId: r.id ?? null },
    });
  }
  return { candidates, ads };
}

export async function fetchWebSearch(source: SourceRow): Promise<WebSearchFetch> {
  const query = String(source.config.query ?? "").trim();
  if (!query) throw new FetchError("query missing");
  const lang = typeof source.config.lang === "string" ? source.config.lang : "zh-CN";
  const region = typeof source.config.region === "string" ? source.config.region : "CN";
  const limit = Math.min(50, Math.max(1, Number(source.config.limit ?? 10) || 10));
  const { results, receiptId } = await searchWeb(query, { lang, region, limit, subject: `source:${source.id}`, window: dayWindow() });
  const { candidates, ads } = resultsToCandidates(results);
  return { candidates, receiptIds: [receiptId], ads };
}
