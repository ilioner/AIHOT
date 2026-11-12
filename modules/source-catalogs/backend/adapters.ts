import * as cheerio from "cheerio";
import { sha256 } from "@aihot/backend/lib/ids";
import { collapseWhitespace, stripTags } from "@aihot/backend/lib/text";
import { identityKeyForUrl, normalizeUrl } from "@aihot/backend/lib/url";
import type { MaterialInput } from "@aihot/backend/content/materials";

export const SOURCE_IDS = ["catalog-aibase", "catalog-aihot-tip", "catalog-360-teacher", "catalog-360-student", "catalog-360-topics", "catalog-uisdc", "catalog-uisdc-nav"] as const;
export type CatalogId = typeof SOURCE_IDS[number];
export type CatalogItem = Omit<MaterialInput, "sourceId" | "via">;

export function isCatalog(id: string): id is CatalogId {
  return (SOURCE_IDS as readonly string[]).includes(id);
}

export function endpoint(id: CatalogId): string {
  if (id === "catalog-aibase") return "https://app.aibase.com/zh/discover";
  if (id === "catalog-aihot-tip") return "https://aihot.news/api/v1/items?category=tip&mode=all&limit=50";
  if (id === "catalog-uisdc") return "https://www.uisdc.com/ajax.php?action=get_news&paged=1";
  if (id === "catalog-uisdc-nav") return "https://hao.uisdc.com/ai/";
  const url = new URL(id === "catalog-360-topics" ? "https://api.aistore.360.cn/sd/topic/hotlist?page_size=8" : `https://api.aistore.360.cn/sd/topic/detail?tid=${id === "catalog-360-teacher" ? 44 : 45}`);
  url.searchParams.set("m", sha256("zhijiao-radar:360:mid").slice(0, 32));
  url.searchParams.set("m2", sha256("zhijiao-radar:360:mid2").slice(0, 44));
  url.searchParams.set("uid", sha256("zhijiao-radar:360:uid").slice(0, 32));
  url.searchParams.set("v", "1");
  url.searchParams.set("nse", "1");
  url.searchParams.set("src", "browser");
  return url.href;
}

function text(value: unknown): string {
  return typeof value === "string" ? collapseWhitespace(stripTags(value)) : "";
}

function rows(value: unknown, path: string): Record<string, any>[] {
  if (!Array.isArray(value)) throw new Error(`信源结构变化：${path} 不是数组`);
  if (value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error(`信源结构变化：${path} 存在无效条目`);
  return value;
}

function link(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Absolute HTTP(S) link from a possibly relative attribute value. */
function absoluteLink(value: unknown, base: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return link(new URL(value.trim(), base).href); } catch { return null; }
}

/** Lazy-loading markup often keeps the real image in data-src and a placeholder in src. */
function imageLink(node: cheerio.Cheerio<any>, base: string): string | null {
  for (const attribute of ["data-src", "data-original", "data-lazy-src", "data-lazy", "src"]) {
    const url = absoluteLink(node.attr(attribute), base);
    if (url) return url;
  }
  const srcset = node.attr("data-srcset") ?? node.attr("srcset");
  return absoluteLink(srcset?.split(",")[0]?.trim().split(/\s+/)[0], base);
}

function entry(input: { title: unknown; summary: unknown; url: string; identityKey?: string; publishedAt?: Date | null; images?: unknown[]; iconUrl?: unknown; categories?: unknown[]; tags?: unknown[]; originalTitle?: unknown; raw: Record<string, unknown> }): CatalogItem {
  const title = text(input.title);
  if (!title) throw new Error("信源条目缺少标题");
  const summary = text(input.summary);
  if (input.publishedAt && !Number.isFinite(input.publishedAt.getTime())) throw new Error("信源条目的日期无效");
  const dated = input.publishedAt ?? null;
  const images = [...new Set((input.images ?? []).map(link).filter((url): url is string => !!url))];
  return {
    title, url: input.url, identityKey: input.identityKey ?? identityKeyForUrl(input.url, { keepFragment: true }) ?? undefined,
    publishedAt: dated, publicationTime: dated?.toISOString() ?? null,
    undatedPolicy: dated ? undefined : "discovery", language: "zh",
    excerpt: summary.slice(0, 2000) || null, bodyText: summary || title, bodyStatus: "ok",
    media: images.map(url => ({ kind: "image", url, alt: title })),
    sourceMetadata: { title, originalTitle: text(input.originalTitle) || null, categories: (input.categories ?? []).map(text).filter(Boolean),
      tags: (input.tags ?? []).map(text).filter(Boolean), coverUrl: images[0] ?? null, iconUrl: link(input.iconUrl), itemUrl: input.url,
      catalogUrl: link(input.raw.catalogUrl), originalUrl: link(input.raw.originalUrl) },
    raw: { ...input.raw, timeBasis: dated ? "source" : "first-observed", publicationTimeKnown: !!dated },
  };
}

export function parseCatalog(id: CatalogId, payload: string): CatalogItem[] {
  if (id === "catalog-aibase") {
    const document = cheerio.load(payload);
    const items: CatalogItem[] = [];
    document('a[href^="/zh/details/"]').each((_, node) => {
      const card = document(node);
      const href = card.attr("href")!;
      const productId = /^\/zh\/details\/(\d+)\/?$/.exec(href)?.[1];
      if (!productId) return;
      items.push(entry({ title: card.find(".truncate1").text() || card.find("img[alt]").attr("alt"), summary: card.find(".truncate2").text(),
        images: [card.find("img").attr("data-src") || card.find("img").attr("src")], categories: card.find("span.activeColor").map((_, node) => document(node).text()).get(),
        url: new URL(href, "https://app.aibase.com").href, raw: { externalId: productId, catalogUrl: endpoint(id), contentKind: "tool-directory" } }));
    });
    if (!items.length) throw new Error("AIbase 产品卡片为空或页面结构变化");
    return [...new Map(items.map(item => [item.identityKey, item])).values()];
  }
  if (id === "catalog-uisdc-nav") {
    const document = cheerio.load(payload);
    const catalogUrl = endpoint(id);
    const items: CatalogItem[] = [];
    document("div.part-cat-block").each((groupId, blockNode) => {
      const block = document(blockNode);
      const heading = block.find("h2.c-title[id]").first();
      const blockId = heading.attr("id")?.trim();
      const blockName = text(heading.find(".l > strong").text()) || text(heading.find(".l").text());
      if (!blockId || !blockName) throw new Error("优设导航分类缺少 ID 或标题");
      block.find("div.part-item-website > a.f-box[href]").each((_, node) => {
        const card = document(node);
        const url = absoluteLink(card.attr("href"), catalogUrl);
        if (!url) throw new Error(`优设导航「${blockName}」条目缺少有效链接`);
        const iconUrl = imageLink(card.find("img").first(), catalogUrl);
        items.push(entry({
          title: card.find("strong.title").text() || card.find("img[alt]").attr("alt"), summary: card.find(".item-desc").text(), url,
          identityKey: identityKeyForUrl(url) ?? undefined, images: iconUrl ? [iconUrl] : [], iconUrl,
          categories: [blockName], tags: card.find(".item-tag .tag").map((_, tag) => document(tag).text()).get(),
          raw: { contentKind: "tool-directory", externalId: sha256(normalizeUrl(url) ?? url), blockId, blockName, groupId,
            catalogUrl, itemUrl: url },
        }));
      });
    });
    if (!items.length) throw new Error("优设导航分类为空或页面结构变化");
    // One resource may sit in several categories: keep the first occurrence and its labels.
    const seen = new Set<string | undefined>();
    return items.filter(item => {
      if (seen.has(item.identityKey)) return false;
      seen.add(item.identityKey);
      return true;
    });
  }
  const data = JSON.parse(payload);
  if (!data || typeof data !== "object") throw new Error("信源返回无效 JSON");
  if (data.code !== undefined && ![0, 200].includes(data.code)) throw new Error(`信源接口 ${data.code}: ${text(data.msg)}`);
  if (id === "catalog-aihot-tip") {
    return rows(data.items, "items").filter(item => item.category === "tip").map(item => {
      const url = link(item.links?.aihot);
      if (!url || !item.id) throw new Error("教程条目缺少 ID 或来源链接");
      return entry({ title: item.title, summary: item.summary, url, identityKey: `aihot-tip:${item.id}`,
        originalTitle: item.originalTitle, categories: [item.category], tags: Array.isArray(item.tags) ? item.tags : [],
        publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        raw: { externalId: item.id, attribution: item.attribution, catalogUrl: "https://aihot.news/?category=tip", originalUrl: link(item.links?.original), source: item.source, contentKind: "tutorial", redistribution: "authorization-required" } });
    });
  }
  if (id === "catalog-uisdc") {
    if (Array.isArray(data.error) && data.error.length) throw new Error(`优设接口错误：${JSON.stringify(data.error)}`);
    return rows(data.data, "data").flatMap(pack => {
      if (!pack.id || !Number.isFinite(Number(pack.time)) || Number(pack.time) <= 0) throw new Error("优设日包缺少 ID 或时间");
      return rows(pack.dubao, "dubao").map(item => {
        const title = text(item.title);
        const originalUrl = link(item.url);
        const fulltextUrl = link(typeof item.content === "string" ? /\[\[全文:(https?:\/\/[^\]]+)\]\]/.exec(item.content)?.[1] : null);
        return entry({ title, summary: item.content, url: originalUrl ?? fulltextUrl ?? "https://www.uisdc.com/news",
          images: typeof item.images === "string" ? item.images.split("|") : [], tags: [item.tag],
          identityKey: `uisdc:${pack.id}:${sha256(originalUrl ?? title).slice(0, 32)}`, publishedAt: new Date(Number(pack.time) * 1000),
          raw: { externalId: `${pack.id}:${sha256(originalUrl ?? title).slice(0, 32)}`, dailyPackId: pack.id, sourceTag: text(item.tag),
            catalogUrl: "https://www.uisdc.com/news", originalUrl: originalUrl ?? fulltextUrl, independentUrl: !!(originalUrl ?? fulltextUrl), contentKind: "news", timePrecision: "daily-pack" } });
      });
    });
  }
  if (id === "catalog-360-topics") {
    return rows(data.data?.list, "data.list").map(topic => {
      if (!topic.id) throw new Error("360 专题缺少 ID");
      return entry({ title: topic.name, summary: topic.des, url: `https://aistore.360.cn/#/subjectdetail?id=${encodeURIComponent(topic.id)}`,
        images: [topic.img], raw: { externalId: topic.id, catalogUrl: "https://aistore.360.cn/#/", contentKind: "tool-collection" } });
    });
  }
  return rows(data.data?.sites, "data.sites").map(tool => {
    if (!tool.id) throw new Error("360 工具缺少 ID");
    const url = link(tool.url);
    if (!url) throw new Error(`360 工具 ${tool.id} 缺少有效链接`);
    return entry({ title: text(tool.tool_name) ? `${text(tool.tool_name)} · ${text(tool.name)}` : tool.name, summary: tool.des, url,
      originalTitle: tool.name, images: [tool.img || tool.big_img || tool.logo], iconUrl: tool.logo,
      categories: [tool.level0_word, tool.level1_word, tool.level2_word, tool.level3_word, tool.level4_word].filter(value => value !== "待确定"),
      identityKey: `360-tool:${tool.id}`, raw: { externalId: tool.id, originalUrl: url,
        catalogUrl: `https://aistore.360.cn/#/subjectdetail?id=${encodeURIComponent(data.data.id)}`,
        contentKind: "tool-directory", topicId: data.data.id, topicName: data.data.name } });
  });
}
