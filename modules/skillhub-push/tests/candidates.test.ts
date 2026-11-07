// Explicit tool directories and collections do not depend on the website's editorial category.
// Unmarked legacy tools and policy notices keep their category-based rules; publication guards remain.
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { mapTool } from "../backend/mapping.ts";
import { overviewCounts, pendingToolRows, publishedToolRows } from "../backend/push.ts";

const T = tag();
const SOURCE = `skillhub-scope-${T}`;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, ${`skillhub 范围测试 ${T}`}, 'external', 'T2', 'editorial', '2100-01-01')`;
});

after(async () => {
  await closeDb();
});

let seq = 0;
/** One published row of a given kind; returns its article id (which carries the test's tag). */
async function entry(options: { category: string | null; contentKind?: string | null; blockName?: string }): Promise<string> {
  seq += 1;
  const id = `scope-${T}-${String(seq).padStart(3, "0")}`;
  const raw = options.contentKind === undefined
    ? { blockName: options.blockName ?? "AI办公" }
    : { contentKind: options.contentKind, blockName: options.blockName ?? "AI办公" };
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, timeline_at, discovered_at, raw, media)
    VALUES (${id}, ${SOURCE}, ${id}, ${`https://tools.example/${id}`}, ${`条目 ${id}`}, now(), now(), ${sql.json(raw)}, ${sql.json([])})`;
  await sql`INSERT INTO publications (article_id, source_id, title, summary, url, timeline_at, discovered_at, sort_at,
      selected, eligible, visible_after, tags, channel, category)
    VALUES (${id}, ${SOURCE}, ${`条目 ${id}`}, ${"简介"}, ${`https://tools.example/${id}`}, now(), now(), now(),
      true, true, now() - interval '1 minute', ARRAY['AI工具'], 'news', ${options.category})`;
  return id;
}

/** The candidates this test created (the database also holds whatever else the suite published). */
async function mine(): Promise<string[]> {
  const rows = await publishedToolRows(2000);
  return rows.map((row) => row.articleId).filter((id) => id.startsWith(`scope-${T}-`));
}

test("the tool directory's own entries and the policy notices are candidates, tutorials and reports are not", async () => {
  const directory = await entry({ category: "ai-tools", contentKind: "tool-directory" });
  const collection = await entry({ category: "ai-tools", contentKind: "tool-collection" });
  const legacy = await entry({ category: "ai-tools", contentKind: "" });
  const missingKind = await entry({ category: "ai-tools" });
  const policy = await entry({ category: "policy", contentKind: null, blockName: "政策法规" });
  // Left out on purpose.
  const tutorial = await entry({ category: "ai-tools", contentKind: "tutorial" });
  const news = await entry({ category: "ai-tools", contentKind: "news" });
  const tipTutorial = await entry({ category: "tip", contentKind: "tutorial" });
  const policyTutorial = await entry({ category: "policy", contentKind: "tutorial" });
  const tip = await entry({ category: "tip" });
  const opinion = await entry({ category: "opinion" });

  const selected = await mine();
  for (const included of [directory, collection, legacy, missingKind, policy]) {
    assert.ok(selected.includes(included), `${included} should be pushed`);
  }
  for (const excluded of [tutorial, news, tipTutorial, policyTutorial, tip, opinion]) {
    assert.ok(!selected.includes(excluded), `${excluded} is not a tool and must not be pushed`);
  }
});

test("explicit tool kinds remain candidates when filed outside the tools category", async () => {
  const before = await overviewCounts();
  const included = [
    await entry({ category: "tip", contentKind: "tool-collection" }),
    await entry({ category: "tip", contentKind: "tool-directory" }),
    await entry({ category: "industry", contentKind: "tool-directory" }),
    await entry({ category: "ai-teaching", contentKind: "tool-collection" }),
    await entry({ category: null, contentKind: "tool-directory" }),
  ];
  const selected = await mine();
  const pending = await pendingToolRows({ articleIds: included });
  for (const id of included) assert.ok(selected.includes(id), `${id} is an explicitly identified tool`);
  assert.deepEqual(pending.map(row => row.articleId).sort(), [...included].sort());
  const after = await overviewCounts();
  assert.equal(after.candidates, before.candidates + included.length);
  assert.equal(after.pending, before.pending + included.length);
});

test("explicit tool kinds do not bypass publication visibility or eligibility", async () => {
  const withdrawn = await entry({ category: "tip", contentKind: "tool-collection" });
  const summaryOnly = await entry({ category: "ai-tools", contentKind: "tool-directory" });
  const ineligible = await entry({ category: "tip", contentKind: "tool-directory" });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${withdrawn}`;
  await sql`UPDATE publications SET visibility = 'summary-only' WHERE article_id = ${summaryOnly}`;
  await sql`UPDATE publications SET eligible = false WHERE article_id = ${ineligible}`;
  const selected = await mine();
  for (const id of [withdrawn, summaryOnly, ineligible]) assert.ok(!selected.includes(id));
  assert.equal((await pendingToolRows({ articleIds: [withdrawn, summaryOnly, ineligible] })).length, 0);
});

test("a policy notice is filed under policy-regulations, not under the directory's catch-all", async () => {
  const policy = await entry({ category: "policy", contentKind: null, blockName: "政策法规" });
  const rows = (await publishedToolRows(2000)).filter((row) => row.articleId === policy);
  assert.equal(rows.length, 1, "the policy row is a candidate and carries its publication category");
  const mapped = mapTool(rows[0]!);
  assert.ok(mapped.ok);
  assert.equal(mapped.tool.categoryCode, "policy-regulations");
  assert.equal(mapped.tool.decidedBy, "rules", "without a stored model answer the rules decide");

  // Even a stored answer naming a tool category does not move the notice out of 政策法规.
  const fromModel = mapTool(rows[0]!, { categoryCode: "office-productivity", audienceCode: "teacher-research", featureCode: null, decidedBy: "model" });
  assert.ok(fromModel.ok);
  assert.equal(fromModel.tool.categoryCode, "policy-regulations");
  assert.equal(fromModel.tool.decidedBy, "model", "the audience and the feature still come from the model");
});

test("the overview counts the wider set", async () => {
  const counts = await overviewCounts();
  assert.ok(counts.candidates >= 5, "at least the rows this test published");
  assert.ok(counts.pending >= 0);
  assert.ok(counts.sent >= 0);
});
