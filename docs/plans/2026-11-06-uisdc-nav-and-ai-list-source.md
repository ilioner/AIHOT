# 优设 AI 导航信源 + 通用「AI 抽取列表」信源类型

日期：2026-11-06 · 使用者确认：优设 AI 导航（https://hao.uisdc.com/ai/）侧栏全部资源都要收，且默认 PASS；后台要能「填链接 + 提示词」让预设模型自己抽列表。每个条目只收目录里已有的标题、简介、标签、图标、目标链接，不抓目标站正文。

## 1. `catalog-uisdc-nav`：优设 AI 导航（专用适配器）

实测：`https://hao.uisdc.com/ai/` 单页服务端渲染，20 个分类块（`div.part-cat-block`，标题在 `h2.c-title[id]` 的 `strong`），294 个条目（`div.part-item-website > a.f-box[href]`，标题 `strong.title`，简介 `.item-desc`，图标 `img[src]`，标签 `.item-tag .tag`）。侧栏 `#anchor` 指向同一页的分类块，没有分页、没有接口。

- 息源 ID `catalog-uisdc-nav`，`kind: external`，`config: {}`，间隔 1440 分钟，标签 `["AI工具", "资源导航"]`。
- 适配器落在 `modules/source-catalogs/backend/adapters.ts`：`endpoint()` 返回页面地址；`parseCatalog()` 用 cheerio 解析，每个条目一条 material；身份 `identityKeyForUrl(url)`（`normalizeUrl` 已去掉 utm_ 等跟踪参数，且同一资源出现在多个分类时只留一条）。
- `sourceMetadata`：`categories: [分类块标题]`、`tags: [条目标签]`、`iconUrl`、`coverUrl`（就是图标）、`catalogUrl`、`itemUrl`；`raw`：`contentKind: "tool-directory"`、`externalId`（URL 规范化后的 sha256）、`blockId`、`blockName`、`groupId`（分类块序号）。
- 无发布日期：`undatedPolicy: "discovery"`（走 `entry()` 默认行为即可）。
- 发布：加入 `industry/selection.ts` 的 `directorySources`（`{ category: "ai-tools" }`）→ 目录直发、默认 PASS、不调模型、不进精选；正文与标签按现有目录策略处理，人工下架依然有效。
- 采集器自带浏览器 UA（源站对无 UA 请求可能 403）；`readCatalog` 里为它加 `user-agent` 与 `accept: text/html…`。

## 2. `ai_list`：后台「链接 + 提示词」的通用 AI 抽取信源

新增一种信源类型，后台新建信源时选它，填 `url` 和 `prompt`，采集时用站点预设的模型把页面里的条目抽成列表。

- **kind 名**：`ai_list`（中文标签「AI 抽取列表」）。
- **config 允许项**：`url`（必填，HTTP(S)）、`prompt`（必填，抽取要求，例如「抽出侧栏分类下的全部资源，保留名称和一句简介」）、`baseUrl`（可选，解析相对链接，缺省取 `url` 的 origin）、`maxItems`（1–200，默认 60）、`maxLinks`（20–800，默认 400）；其余沿用通用键：`_aihot`、`ingestNoiseFilter`、`itemUrlPrefixRewrite`、`allowUrlPrefixes`、`denyUrlPrefixes`、`publishedAtUtcOffset`、`acceptLanguage`、`publisherRole`、`publisherUrlPrefixes`、`publisherRequiresDiscovery`。不含 `detail`、`publishedAfter`（同 `web_search`：日期要等抽取才可能知道，先做未标注日期的资料）。
- **一次运行 = 一次付费请求**：`guardedFetch` 取页面（`maxBytes` 4 MB、`timeoutMs` 30 s、`redirectPolicy: "same-origin"`），把页面的链接清单（锚点文字 + 附近文字，按 `maxLinks` 截断，单条与整体长度封顶）连同 `prompt` 交给 `chatJson`（`providers/llm.ts`，已经是回执 + 预算 + 熔断入口），模型返回 `{ items: [{ url, title, summary? }] }`；用 zod 校验，URL 必须命中我们给出的链接清单（或 `allowUrlPrefixes`），模型编的地址一律丢弃，`maxItems` 截断。
- **模型**：`modelFor("structure")`（后台「模型与评测」里换结构化模型即可换它），`purpose: "source-list"`，`promptVersion: "ai-list-v1"`，`subject: source:<id>`。
- **候选**：`{ url, title, excerpt, bodyStatus: "pending", raw: { via: "ai-list", receiptId, pageUrl } }`，与 `web_search` 一样不带发布日期，`detail` 里记 `{ links: 交给模型的链接数, items: 抽出的条目数, receiptIds }`。
- **失败**：模型不可用 / 预算耗尽 / 输出不合格式都算这次采集失败（`fetch_runs.status = 'failed'`，健康度退化），不写半成品；页面上没有任何链接时明确报错。
- **调度**：`scheduleDueSources()` 的 kind 白名单加 `ai_list`；`adaptIntervals()` 不动它（付费信源的间隔由运营自己设，同 `web_search` 的取舍）。
- **后台**：新建信源的类型下拉加「AI 抽取列表」，模板 `{ url, prompt, maxItems }`，预览按钮要提示「预览会产生一次模型调用（计入预算）」；`CreateSchema` 的 kind 枚举加 `ai_list`；编辑信源仍只在这三种可换采集器类型（`REPLACEABLE_SOURCE_KINDS`）之间替换，不在本次范围。
- **发布策略**：`ai_list` 默认走正常预筛/评分/写作，**不**默认 PASS。「默认 PASS」是每个信源的目录直发策略（`industry/selection.ts` 的 `directorySources`，本次只有 `catalog-uisdc-nav` 和既有的 `catalog-360-topics`）。后台开关留给后续单独评估。

## 3. 文件归属（避免冲突）

| 归属 | 文件 |
|---|---|
| 优设导航（T1） | `modules/source-catalogs/**`、`industry/sources.json`、`industry/selection.ts` |
| ai_list 后端（T2） | `packages/backend/src/sources/{types,config-keys,collect,ai-list}.ts`、`packages/backend/src/jobs/sources.ts`（如需）、`scripts/seed.ts`、`tests/ai-list*.test.ts` |
| ai_list 后台与文档（T3） | `packages/contracts/src/admin.ts`、`packages/backend/src/admin/sources.ts`、`apps/web/app/routes/admin/source-new.tsx`、`apps/web/app/features/admin/labels.ts`、`docs/customize.md` |
| 集成与部署说明（Lead） | `docs/deploy.md`、本次验证 |

## 4. 验收

- `npm run typecheck` 全绿；`node --test modules/source-catalogs/tests/*.test.ts` 通过；`npm run test:standalone` 里相关用例通过。
- 优设导航：用真实页面跑一次解析（可离线保存 HTML 做 fixture），条数 > 0、分类数 = 20、同一 URL 在多个分类只出一条。
- `ai_list`：用本地 stub 模型验证「抽取成功」「模型编造 URL 被丢弃」「输出不合格式即失败」三种情形，且不新增未走回执的付费调用。
- 文档：`docs/customize.md` 说明两种入口的配置方法与费用；`docs/deploy.md` 更新条目写清新增信源、默认 PASS 规则只对 `catalog-uisdc-nav` 生效、`ai_list` 是付费请求。
