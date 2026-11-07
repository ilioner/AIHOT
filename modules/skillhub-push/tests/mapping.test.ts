// The mapping rules, checked as pure functions: the slug is legal and stable, the canonical address is
// normalized, the source's own category blocks and labels reach the right `aitool.category` code, and
// the dictionary IDs are looked up by code rather than fixed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_AUDIENCE_CODE,
  DEFAULT_CATEGORY_CODE,
  EDITORIAL_PICK_CODE,
  aiNoteFor,
  canonicalToolUrl,
  categoryCodeFor,
  featureCodeFor,
  mapTool,
  slugForUrl,
  toolPayload,
  type Dictionaries,
  type ToolRow,
} from "../backend/mapping.ts";

const row = (over: Partial<ToolRow> = {}): ToolRow => ({
  articleId: "tool-1",
  sourceId: "catalog-uisdc-nav",
  sourceName: "优设 · AI 导航",
  title: "即梦",
  url: "https://jimeng.jianying.com/ai-tool/home",
  summary: "字节跳动的 AI 图像与视频生成工具。",
  blockName: "热门推荐",
  categories: ["热门推荐"],
  tags: ["推荐", "CN"],
  iconUrl: "https://image.uisdc.com/hao-nav-jimeng.webp",
  media: [],
  ...over,
});

const ids = (category: Record<string, number>, audience: Record<string, number> = { "teacher-research": 25 }, feature: Record<string, number> = { "editorial-pick": 27 }): Dictionaries => ({
  category: new Map(Object.entries(category)),
  audience: new Map(Object.entries(audience)),
  feature: new Map(Object.entries(feature)),
});

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

test("the slug is legal, stable and unique per canonical address", () => {
  const slug = slugForUrl("https://jimeng.jianying.com/ai-tool/home");
  assert.match(slug, SLUG);
  assert.ok(slug.length <= 200);
  assert.match(slug, /^jimeng-jianying-com-[0-9a-f]{8}$/, "the host keeps it readable, the address digest makes it unique");
  assert.equal(slugForUrl("https://jimeng.jianying.com/ai-tool/home"), slug, "the same address always gives the same slug");
  assert.notEqual(slugForUrl("https://jimeng.jianying.com/ai-tool/other"), slug);
  assert.match(slugForUrl("https://www.midjourney.com/"), /^midjourney-com-[0-9a-f]{8}$/, "a leading www is dropped from the readable part");
  for (const address of ["https://a.b/", "https://127.0.0.1:8080/x", "http://例子.测试/工具", "https://very-long-sub-domain-name.example.com/" + "a".repeat(300)]) {
    const value = slugForUrl(address);
    assert.match(value, SLUG, address);
    assert.ok(value.length <= 200, address);
  }
});

test("the canonical address folds the host and drops tracking parameters", () => {
  assert.equal(canonicalToolUrl("https://www.Example.com/tool/?utm_source=nav&b=2&a=1#top"), "https://example.com/tool/?a=1&b=2");
  assert.equal(canonicalToolUrl("http://example.com/tool"), "https://example.com/tool", "the scheme is folded to https");
  assert.equal(canonicalToolUrl("https://example.com"), "https://example.com/");
  assert.equal(canonicalToolUrl("https://x.com/someone/status/123456"), null, "a social post is not a tool address");
  assert.equal(canonicalToolUrl("mailto:hi@example.com"), null);
  assert.equal(canonicalToolUrl("https://user:secret@example.com/tool"), null, "an address with credentials is refused");
  assert.equal(canonicalToolUrl(""), null);
});

test("distinct source identities retain their hash routes when mapped to tools", () => {
  const topics = [36, 38, 40].map((topicId) => {
    const url = `https://aistore.360.cn/#/subjectdetail?id=${topicId}`;
    const mapped = mapTool(row({ url, identityKey: `url:${url}` }));
    assert.ok(mapped.ok);
    assert.equal(mapped.tool.canonicalUrl, url);
    return mapped.tool;
  });
  assert.equal(new Set(topics.map((tool) => tool.slug)).size, topics.length);
  const anchored = mapTool(row({ url: "https://example.com/tool#top", identityKey: "url:https://example.com/tool" }));
  assert.ok(anchored.ok);
  assert.equal(anchored.tool.canonicalUrl, "https://example.com/tool");
});

test("the source's own category block and labels choose the aitool.category code", () => {
  const cases: Array<[Partial<ToolRow>, string]> = [
    [{ blockName: "AI绘画", categories: [] }, "image-video"],
    [{ blockName: "AI图像处理", categories: [] }, "image-video"],
    [{ blockName: "平面设计", categories: [] }, "image-video"],
    [{ blockName: "3D设计", categories: [] }, "image-video"],
    [{ blockName: "UI设计", categories: [] }, "image-video"],
    [{ blockName: "AI音视频", categories: [] }, "image-video"],
    [{ blockName: "AIGC达人", categories: [] }, "image-video"],
    [{ blockName: "AI智能写作", categories: [] }, "text-writing"],
    [{ blockName: "AI翻译", categories: [] }, "text-writing"],
    [{ blockName: "AI提示词", categories: [] }, "text-writing"],
    [{ blockName: "AI编程开发", categories: [] }, "software-development"],
    [{ blockName: "Skills", categories: [] }, "software-development"],
    [{ blockName: "Agent智能体", categories: [] }, "software-development"],
    [{ blockName: "AI办公", categories: [] }, "office-productivity"],
    [{ blockName: "AI聊天", categories: [] }, "office-productivity"],
    [{ blockName: "AI学习", categories: [] }, "training-resources"],
    [{ blockName: "AI研究机构", categories: [] }, "literature-research"],
    [{ blockName: "热门推荐", categories: [] }, DEFAULT_CATEGORY_CODE],
    [{ blockName: "AI工具合集", categories: [] }, DEFAULT_CATEGORY_CODE],
    [{ blockName: "探索更多", categories: [] }, DEFAULT_CATEGORY_CODE],
    [{ blockName: null, categories: ["视频生成"] }, "image-video"],
    [{ blockName: null, categories: ["代码助手"] }, "software-development"],
    [{ blockName: null, categories: ["翻译"] }, "text-writing"],
    [{ blockName: null, categories: ["个人助理"] }, "office-productivity"],
    [{ blockName: null, categories: ["文献管理"] }, "literature-research"],
    [{ blockName: null, categories: [] }, DEFAULT_CATEGORY_CODE],
  ];
  for (const [over, code] of cases) {
    assert.equal(categoryCodeFor({ blockName: over.blockName ?? null, categories: over.categories ?? [], tags: [] }), code, JSON.stringify(over));
  }
});

test("only a recommended entry gets the 编辑精选 feature, and the audience is always 教师教研", () => {
  assert.equal(featureCodeFor(["推荐"]), EDITORIAL_PICK_CODE);
  assert.equal(featureCodeFor(["精选"]), EDITORIAL_PICK_CODE);
  assert.equal(featureCodeFor(["热门", "CN"]), null, "热门 alone is not the site's recommendation");
  assert.equal(featureCodeFor([]), null);

  const mapped = mapTool(row());
  assert.ok(mapped.ok);
  assert.equal(mapped.tool.audienceCode, DEFAULT_AUDIENCE_CODE);
  assert.equal(mapped.tool.featureCode, EDITORIAL_PICK_CODE);
  const plain = mapTool(row({ tags: ["CN"] }));
  assert.ok(plain.ok);
  assert.equal(plain.tool.featureCode, null);
});

test("the request body carries the title, the summary, the icon and where the entry came from", () => {
  const mapped = mapTool(row());
  assert.ok(mapped.ok);
  const tool = mapped.tool;
  assert.equal(tool.name, "即梦");
  assert.equal(tool.description, "字节跳动的 AI 图像与视频生成工具。");
  assert.equal(tool.iconUrl, "https://image.uisdc.com/hao-nav-jimeng.webp");
  assert.match(tool.aiNote, /来源目录：优设 · AI 导航/);
  assert.match(tool.aiNote, /源站分类：热门推荐/);
  assert.match(tool.aiNote, /标签：推荐、CN/);

  const fromMedia = mapTool(row({ iconUrl: null, media: [{ url: "https://cdn.example/cover.png", kind: "image" }] }));
  assert.ok(fromMedia.ok);
  assert.equal(fromMedia.tool.iconUrl, "https://cdn.example/cover.png", "the first media image stands in for a missing icon");
  const withoutIcon = mapTool(row({ iconUrl: null, media: [] }));
  assert.ok(withoutIcon.ok);
  assert.equal(withoutIcon.tool.iconUrl, null);

  assert.equal(aiNoteFor(row({ sourceName: null, sourceId: "catalog-aibase", blockName: null, categories: ["视频生成"], tags: [] })), "来源目录：catalog-aibase；源站分类：视频生成");
});

test("a row without a usable title or address is not pushed", () => {
  assert.deepEqual(mapTool(row({ title: "   " })), { ok: false, problem: "标题为空" });
  const noAddress = mapTool(row({ url: "javascript:alert(1)" }));
  assert.equal(noAddress.ok, false);
  const long = mapTool(row({ title: "长".repeat(250) }));
  assert.ok(long.ok);
  assert.equal(long.tool.name.length, 200, "skillhub's name field stops at 200 characters");
});

test("the three dictionary IDs are looked up by code, with 办公提效 as the category fallback", () => {
  const mapped = mapTool(row());
  assert.ok(mapped.ok);
  const tool = mapped.tool;
  assert.equal(tool.categoryCode, "office-productivity");

  const exact = toolPayload({ ...tool, categoryCode: "image-video" }, ids({ "image-video": 20, "office-productivity": 19 }));
  assert.ok(exact.ok);
  assert.equal(exact.payload.categoryDictItemId, 20);
  assert.equal(exact.payload.audienceDictItemId, 25);
  assert.equal(exact.payload.featureDictItemId, 27);
  assert.equal(exact.payload.slug, tool.slug);
  assert.equal(exact.payload.canonicalUrl, tool.canonicalUrl);

  const fellBack = toolPayload({ ...tool, categoryCode: "no-such-code" }, ids({ "office-productivity": 19 }));
  assert.ok(fellBack.ok);
  assert.equal(fellBack.payload.categoryDictItemId, 19);

  const missing = toolPayload(tool, ids({}));
  assert.equal(missing.ok, false);

  const noFeature = toolPayload({ ...tool, featureCode: null }, ids({ "office-productivity": 19, "image-video": 20 }));
  assert.ok(noFeature.ok);
  assert.equal(noFeature.payload.featureDictItemId, null);

  const sparse = toolPayload(tool, ids({ "office-productivity": 19 }, {}, {}));
  assert.ok(sparse.ok);
  assert.equal(sparse.payload.audienceDictItemId, null, "a dictionary without the audience code sends null, not a guess");
  assert.equal(sparse.payload.featureDictItemId, null);
});
