// The engine's own model: one OpenAI-compatible model (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL) runs every
// step of the analysis when nothing picks another one for a step.
import { stub, tag } from "./setup.ts";
import { analysisStep, SELECTING_SCORE, type AnalysisStep } from "./analysis-steps.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { CAPABILITIES, type Capability } from "@aihot/backend/editorial/models";
import { ModelUnavailableError } from "@aihot/backend/providers/receipts";
import { stopBoss } from "@aihot/backend/jobs/queue";

// Nothing chosen per step: every capability falls back to the `default` model (a step the site
// gives a model of its own is sent back to it by its environment variable).
for (const c of Object.values(CAPABILITIES) as Capability[]) {
  if (c.default === "default") delete process.env[c.env];
  else process.env[c.env] = "default";
}

const T = tag();
const SOURCE = `test-default-model-${T}`;
const seen: Array<{ model: string; step: AnalysisStep }> = [];
const provider = await stub((_hit, req) => {
  const step = analysisStep(req.body);
  seen.push({ model: (JSON.parse(req.body) as { model: string }).model, step });
  const content =
    step === "prefilter" ? { label: "PASS", reason: "测试" }
    : step === "score" ? { attentionScore: SELECTING_SCORE }
    : step === "understand" ? { itemType: "ai_in_teaching", authorRole: "principal", tags: ["AI赋能教学"], editorialJudgment: "理由", titleZh: "一个AI进课堂的标题", summaryZh: "一个AI进课堂的摘要。第二句。" }
    : step === "structure" ? { category: "ai-teaching", tags: ["AI赋能教学"], subjects: [], fact: null }
    : "title_zh: 标题\nsummary_zh: 摘要。";
  return { id: `stub-${seen.length}`, choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "one-model", MODEL_CALLS_ENABLED: "true" });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test default model', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("one model runs the prefilter, both scores, the writing and the structure", async () => {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}`, title: `A product launch ${T}`, bodyText: `A company launched a product with pricing and availability. ${T} `.repeat(6),
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  } as never);
  const res = await analyzeArticle(articleId);
  assert.equal(res!.output!.selected, true);
  assert.equal(res!.output!.titleZh, "一个AI进课堂的标题");
  assert.deepEqual(seen.map((r) => r.step).sort(), ["prefilter", "score", "score", "structure", "understand"]);
  assert.ok(seen.every((r) => r.model === "one-model"), "every request names the configured model");
  const services = await sql<{ service: string }[]>`SELECT DISTINCT service FROM receipts WHERE subject LIKE ${`article:${articleId}%`}`;
  assert.deepEqual(services.map((s) => s.service), ["llm"]);
});

test("a decision model cannot be used as the deployment's general chat model", async () => {
  const model = process.env.LLM_MODEL;
  process.env.LLM_MODEL = "decision-model-preview";
  try {
    const { articleId } = await upsertMaterial({
      sourceId: SOURCE, url: `https://example.com/decision-default-${T}`, title: `Vocational policy ${T}`,
      bodyText: `A ministry released a vocational policy with its scope and schedule. ${T} `.repeat(6), bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
    } as never);
    const hits = provider.hits();
    await assert.rejects(analyzeArticle(articleId), ModelUnavailableError);
    assert.equal(provider.hits(), hits, "a non-chat model is rejected before a request is sent");
    const receipts = await sql`SELECT id FROM receipts WHERE subject LIKE ${`article:${articleId}%`}`;
    assert.equal(receipts.length, 0);
  } finally {
    process.env.LLM_MODEL = model;
  }
});
