// Fathom Search: a multi-engine web search, paid per request (1 credit). Every call goes through a
// receipt and the budget; the collector keeps organic results only and never invents a date.
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { assertAccepted, paidRequest, type CallOutcome } from "./receipts.ts";

export interface FathomResult {
  id: string;
  rank: number;
  type: string;
  title: string;
  url: string;
  display_url?: string;
  snippet?: string;
  domain?: string;
  engine?: string;
}

export interface FathomSearch {
  results: FathomResult[];
  receiptId: number;
  reused: boolean;
}

/** The API root; tests point it at a local stub (FATHOM_BASE_URL), like SOCIALDATA_BASE_URL. */
function apiBase(): string {
  return (credential("collectors", "FATHOM_BASE_URL") ?? "https://fathomsearch.xyz").replace(/\/$/, "");
}

/** The UTC day: a same-day retry reuses the paid answer; the next day's run queries (and pays) again. */
export const dayWindow = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

/**
 * One paid search. Fathom bills in credits and reports no money for the call, so the usage records the
 * call and its result count and the cost is left null rather than guessed (the same rule Jina follows).
 */
export async function searchWeb(query: string, opts: { lang: string; region: string; limit: number; subject: string; window: string }): Promise<FathomSearch> {
  const key = credential("collectors", "FATHOM_API_KEY");
  if (!key) throw new Error("FATHOM_API_KEY is not configured");
  const sp = new URLSearchParams({ text: query, lang: opts.lang, region: opts.region, limit: String(opts.limit), format: "json" });
  const receipt = await paidRequest(
    {
      service: "fathom",
      purpose: "source_fetch",
      subject: opts.subject,
      identity: { text: query, lang: opts.lang, region: opts.region, limit: opts.limit, window: opts.window },
      requestSummary: { text: query, lang: opts.lang, region: opts.region, limit: opts.limit },
    },
    async () => {
      const res = await guardedFetch(`${apiBase()}/search?${sp}`, {
        headers: { "x-api-key": key, accept: "application/json" },
        // A multi-engine query is slow (seconds to tens of seconds), and a timeout leaves an unknown
        // receipt — the search may still have been billed — so it gets the same budget as SocialData's search.
        timeoutMs: 60_000,
        maxBytes: 8 * 1024 * 1024,
        route: "direct",
      });
      const text = res.text();
      assertAccepted("fathom", res.status, text);
      const json = JSON.parse(text) as { results?: FathomResult[] };
      const results = Array.isArray(json.results) ? json.results : [];
      return { response: json, usage: { searches: 1, results: results.length }, cost: null } satisfies CallOutcome;
    },
  );
  const json = receipt.response as { results?: FathomResult[] };
  return { results: json.results ?? [], receiptId: receipt.receiptId, reused: receipt.reused };
}
