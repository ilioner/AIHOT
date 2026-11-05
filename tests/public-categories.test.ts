// A category filter on the public API, RSS and MCP takes in exactly the categories the site publishes as
// it (site/site.ts PUBLIC_CATEGORIES), whatever the industry's categories are; the website filters by each
// of its own. Failure cases: a public filter takes in a category the site publishes on its own (or misses
// one merged into it); the website's filter merges categories; the exits disagree; HTTP validation,
// Agent search, MCP input schemas or OpenAPI still advertise a retired category list.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { v1Items } from "@aihot/backend/publication/v1";
import { CATEGORY_KEYS, DEFAULT_CATEGORIES, PUBLIC_API_CATEGORY_KEYS, toPublicApiCategory } from "@aihot/contracts/taxonomy";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { buildApp } from "../apps/api/src/app.ts";
import { updateCategories } from "@aihot/backend/admin/settings";
import { loadItemOgCard } from "@aihot/backend/publication/og";

const T = tag();
const SOURCE = `categories-${T}`;
const now = new Date();
const at = new Date(now.getTime() - 3600_000);
const title = (category: string) => `${T} ${category}`;
const app = await buildApp();
const client = new Client({ name: 'category-check', version: '1.0.0' });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${SOURCE}, 'Category fixture', 'rss', 'T1')`;
  for (const category of CATEGORY_KEYS) {
    const id = `${T}-${category}`;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at)
      VALUES (${id}, ${SOURCE}, ${id}, ${`https://example.org/${id}`}, ${title(category)}, ${at}, ${at}, ${at})`;
    await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, published_at, sort_at,
        eligible, selected, visible_after, visibility, tags, category, search_text)
      VALUES (${id}, ${title(category)}, ${SOURCE}, 'news', ${`https://example.org/${id}`}, ${at}, ${at}, ${at}, ${at},
        true, true, ${at}, 'public', ${[T]}, ${category}, ${title(category)})`;
  }
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/api/mcp`)));
});
after(async () => { await client.close(); await app.close(); await closeDb(); });

const ours = (titles: string[]) => titles.filter((t) => t.startsWith(`${T} `)).sort();

test("a public category takes in the categories the site publishes as it, and only those", async () => {
  for (const key of PUBLIC_API_CATEGORY_KEYS) {
    const want = CATEGORY_KEYS.filter((k) => toPublicApiCategory(k) === key).map(title).sort();
    const v1 = await v1Items({ mode: "selected", window: "24h", by: "timeline", category: key, q: null, limit: 100, cursor: null }, now);
    assert.deepEqual(ours(v1.items.map((i) => i.title)), want, `v1 and MCP, ${key}`);
    const rss = await itemFeed("selected", key, { now });
    assert.deepEqual(ours([...rss.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)].map((m) => m[1]!)), want, `RSS, ${key}`);
  }
});

test("the website filters by each of its own categories", async () => {
  for (const key of CATEGORY_KEYS) {
    const timeline = await loadTimeline({ channel: "all", category: key, tag: T, limit: 40, now });
    assert.deepEqual(ours(timeline.cards.map((c) => c.item.title)), [title(key)], key);
  }
});

test("HTTP, Agent, MCP and discovery agree on the public categories and returned items", async () => {
  const spec = (await app.inject('/openapi-v1.json')).json();
  for (const path of ['/api/v1/items', '/api/v1/agent/latest', '/api/v1/agent/search']) {
    const parameter = spec.paths[path].get.parameters.find((p: { name?: string }) => p.name === 'category');
    assert.deepEqual(parameter.schema.examples ?? parameter.schema.enum, [...PUBLIC_API_CATEGORY_KEYS], path);
  }
  for (const name of [MCP_TOOL_NAMES.latest, MCP_TOOL_NAMES.search]) {
    const invalid = await client.callTool({ name, arguments: { category: "unknown-category", ...(name === MCP_TOOL_NAMES.search ? { q: T } : {}) } });
    assert.equal(invalid.isError, true, "MCP validates current category membership at invocation time");
  }
  for (const key of PUBLIC_API_CATEGORY_KEYS) {
    const want = CATEGORY_KEYS.filter((k) => toPublicApiCategory(k) === key).map(title).sort();
    for (const mode of ['all', 'selected']) {
      const response = await app.inject(`/api/v1/items?mode=${mode}&category=${key}`);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(ours(response.json().items.map((item: { title: string }) => item.title)), want);
      assert.ok(response.json().items.every((item: { category: string }) => item.category === key));
    }
    for (const path of [`/api/v1/agent/latest?category=${key}`, `/api/v1/agent/search?q=${T}&category=${key}`]) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 200, path);
      for (const item of want) assert.ok(response.body.includes(item), path);
      for (const other of CATEGORY_KEYS.filter((k) => toPublicApiCategory(k) !== key)) assert.ok(!response.body.includes(title(other)), path);
    }
    for (const name of [MCP_TOOL_NAMES.latest, MCP_TOOL_NAMES.search]) {
      const result = await client.callTool({ name, arguments: { category: key, ...(name === MCP_TOOL_NAMES.search ? { q: T } : {}) } });
      assert.notEqual(result.isError, true);
      const items = (result.structuredContent as { items: { title: string; category: string }[] }).items;
      assert.deepEqual(ours(items.map((item) => item.title)), want);
      assert.ok(items.every((item) => item.category === key));
    }
  }
});

test("new and disabled categories work without a restart across public exits and invalidate labels and discovery", async () => {
  const extra = { key: "runtime-category", label: "运行时分类", tag: "运行时首标签", section: "运行时栏目", guide: "不应公开的分类指导", tagColor: "gray", enabled: true };
  const categories = [extra, ...DEFAULT_CATEGORIES];
  const specBefore = await app.inject("/openapi-v1.json");
  await updateCategories({ categories, reason: "public category fixture" }, "test");
  const id = `${T}-runtime`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at)
    VALUES (${id}, ${SOURCE}, ${id}, ${`https://example.org/${id}`}, ${title(extra.key)}, ${at}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, title, summary, source_id, channel, url, discovered_at, timeline_at, published_at, sort_at,
    eligible, selected, visible_after, visibility, tags, category, search_text)
    VALUES (${id}, ${title(extra.key)}, '测试摘要', ${SOURCE}, 'news', ${`https://example.org/${id}`}, ${at}, ${at}, ${at}, ${at},
      true, true, ${at}, 'public', ${[extra.tag]}, ${extra.key}, ${title(extra.key)})`;
  try {
    const paths = [
      `/api/site/timeline?category=${extra.key}`, `/api/site/pool?category=${extra.key}`,
      `/api/v1/items?category=${extra.key}`, `/api/v1/agent/latest?category=${extra.key}`,
      `/api/v1/agent/search?q=${T}&category=${extra.key}`, `/feed/category/${extra.key}.xml`,
    ];
    for (const path of paths) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 200, `${path}: ${response.body}`);
      assert.ok(response.body.includes(id) || response.body.includes(title(extra.key)), path);
    }
    const oldPool = await app.inject(`/api/site/pool?category=${extra.key}`);
    const spec = await app.inject({ url: "/openapi-v1.json", headers: { "if-none-match": specBefore.headers.etag! } });
    assert.equal(spec.statusCode, 200);
    assert.ok(spec.body.includes(extra.key));
    for (const path of ["/api/v1/agent", "/llms.txt", "/api/site/categories"]) {
      const response = await app.inject(path);
      assert.ok(response.body.includes(extra.key), path);
      assert.ok(!response.body.includes(extra.guide), "private instructions stay private");
    }
    for (const name of [MCP_TOOL_NAMES.latest, MCP_TOOL_NAMES.search]) {
      const result = await client.callTool({ name, arguments: { category: extra.key, ...(name === MCP_TOOL_NAMES.search ? { q: T } : {}) } });
      assert.notEqual(result.isError, true);
      assert.equal((result.structuredContent as { items: { category: string }[] }).items[0]!.category, extra.key);
    }
    const changed = categories.map(c => c.key === extra.key ? { ...c, enabled: false, label: "已改名分类" } : c);
    await updateCategories({ categories: changed, reason: "rename and disable" }, "test");
    const pool = await app.inject({ url: `/api/site/pool?category=${extra.key}`, headers: { "if-none-match": oldPool.headers.etag! } });
    assert.equal(pool.statusCode, 200, "taxonomy changes bypass the old search cache and ETag");
    assert.equal(pool.json().items[0].categoryLabel, "已改名分类");
    assert.equal(pool.json().categories.find((c: { key: string }) => c.key === extra.key).enabled, false);
    for (const path of paths) assert.equal((await app.inject(path)).statusCode, 200, "disabled category URLs survive");
    const detail = (await app.inject(`/api/site/items/${id}`)).json();
    assert.equal(detail.categoryLabel, "已改名分类");
    assert.equal((await loadItemOgCard(id))?.kicker, "已改名分类");
    assert.match((await app.inject(`/feed/category/${extra.key}.xml`)).body, /已改名分类/);
  } finally {
    await sql`DELETE FROM settings WHERE key = 'categories'`;
  }
});
