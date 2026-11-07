# 公众号限流规避与 AI 工具推送

> 使用者要求：想尽办法规避微信公众号抓取限流，后续可能增加更多账号；后台增加推送入口；按
> `admin-ai-tool-create-api.md` 把已抓取和之后抓到的 AI 工具推送到 skillhub 后台，推送失败就跳过。

## 为什么现在会触发限流

`modules/weread-mp` 现在一次抓取只借一个账号，把一次检查里的请求全部打在这个账号上：

- `listPosts` 先读列表，再对每条缺链接/时间的文章补 `/review/single`，然后逐篇取正文 `/web/mp/content`；
  一次检查最多 8 篇，最坏是 1 + 8 + 8 ≈ 17 个请求背靠背发出，中间没有间隔。
- 账号池只在 `-2014` 之后冷却 5 分钟、`-2041` 之后冷却 30 分钟，冷却时长固定，没有抖动，
  多个账号也只会“谁最久没用就用谁”，没有节奏和预算。
- 一次检查绑定一个账号：它被限流，整次检查就失败，即使池里还有别的可用账号。
- 调度按 15 分钟一轮把所有到期信源一起入队，没有错峰。

## 方案 A：账号池的节奏、轮换与退避（`modules/weread-mp`）

1. **每个账号自己的节奏**（`weread_accounts` 新增 `next_allowed_at`、`requests_hour`、`hour_started_at`、
   `cooldown_level`）：
   - 每次请求之后 `next_allowed_at = now() + interval + jitter`，默认 `WEREAD_REQUEST_INTERVAL_MS=2500`，
     抖动 ±30%，账号越多就越不会在同一时刻排队打同一个账号。
   - 每小时每个账号有条数预算，默认 `WEREAD_HOURLY_BUDGET=90`；用满就等到下一个小时窗口。
2. **按请求选账号，而不是按信源**：新增 `pooledCaller()`，每次调用都挑 `next_allowed_at` 最早、
   仍有预算、不在冷却的账号；同一个信源默认黏在一个账号上（复用它已激活的会话），
   只有这个账号被限流/要验证时才换下一个账号重试同一个请求。
3. **指数退避 + 抖动**：`-2014`（限流）冷却 5 分钟起，按 `cooldown_level` 翻倍，封顶 60 分钟；
   `-2041`（人机验证）30 分钟起，封顶 6 小时；成功一次就把 `cooldown_level` 清零。
   冷却结束后先放行一次，再按原来的节奏继续。
4. **全部账号都在冷却时**：这次检查记为“账号池冷却中”并跳过，不把信源健康度打成失败，
   也不把请求重试到把冷却期拖长；下一个调度周期再看。
5. **错峰调度**：`scheduleCollect` 给每条入队加 0–120 秒随机延迟，避免同一分钟几十个信源一起开抓。
6. **后台可见**：账号池表格显示每个账号的“下次可用时间 / 本小时请求数 / 冷却等级”，
   页面顶部显示账号池汇总（几个可用、下一个多久后可请求）。新增账号仍是扫码，扫多少个就用多少个。

## 方案 B：`modules/skillhub-push`（新增模块）

- **推送对象**：`publications` 里 `category = 'ai-tools'`、`visibility = 'public'`、
  `articles.raw->>'contentKind' = 'tool-directory'` 的条目（当前 324 条：优设 AI 导航 288、AIbase 36）。
  360 专题页（`tool-collection`）是聚合页不是工具，星踪岛等资讯也不是工具，都不推。
- **映射**（纯函数，可单测）：`name` 取标题；`slug` 由主机名 + 地址哈希生成（满足
  `^[a-z0-9]+(-[a-z0-9]+)*$`、≤200、全局唯一）；`url`/`canonicalUrl` 用 `identityKeyForUrl`
  归一化后的地址；`description` 取摘要；`iconUrl` 取 `sourceMetadata.iconUrl` 或 `media[0]`；
  `aiNote` 写来源目录、源站分类与标签；三个字典 ID **按 `code` 在运行时查询**（不同环境 ID 不同），
  分类按源站分类块名/标签映射到 8 个 `aitool.category`，默认 `office-productivity`，
  适用人群默认 `teacher-research`，功能特点只在有“推荐/精选”标签时给 `editorial-pick`。
- **推送状态**（新表 `skillhub_pushes`，一条资料一行）：`pending / sent / exists / failed / skipped`，
  含尝试次数、远端 id、最近错误、推送时间。`slug`/`canonicalUrl` 已存在的 400 记为 `exists`（视为成功），
  其他失败累计到上限后停止自动重试，可在后台手动重试。
- **触发**：`SKILLHUB_PUSH_ENABLED=true` 时每 10 分钟扫一次待推送条目（覆盖历史存量与之后新抓到的），
  排队执行、逐条推送、单条失败不影响后面的条目。后台页面随时可「推送全部待推送」。
- **后台入口**：新页面「AI 工具 → skillhub 推送」，含连接配置（Cookie/XSRF，sealed 存 settings）、
  「测试连接」、概览计数、批量推送、失败重试、逐条状态与错误。
- **凭据**：`SKILLHUB_COOKIE` / `SKILLHUB_XSRF_TOKEN` 可放环境变量，也可以在后台页粘贴；
  后台保存的用 `SESSION_SECRET` 派生密钥加密，接口只回“已配置”状态。

## 验收

- 模块单测：映射规则、slug 合法性/唯一性、已存在视为成功、单条失败跳过、401 记为配置问题、
  冷却换账号、节奏与预算计算（纯函数，不依赖真实网络）。
- `npm run typecheck`、`npx tsc -p modules`、模块测试、`tests/architecture.test.ts`、web 构建通过。
- 历史 324 条在后台「推送全部待推送」后全部有状态（sent/exists），失败条目有可读原因。

## 验收结果（2026-11-07 本机）

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（含 web） | 通过 |
| `npx tsc -p modules` | 通过 |
| `npm run build -w @aihot/web` | 通过 |
| `modules/weread-mp/tests/*.test.ts` | 19/19 |
| `modules/skillhub-push/tests/*.test.ts` | 13/13（含「连续 3 条可重试失败就停下批次」） |
| `tests/migrations.test.ts` + 迁移静态检查 | 7/7、11/11 |
| `tests/architecture.test.ts` | 12/13（唯一失败是工作区里已删的 `packages/backend/src/admin/selectbench.ts` 仍留在 git 索引，与本次改动无关） |
| 迁移 0102–0106 应用到 `aihot_zhijiao` | 已应用（`schema_migrations` 有记录，可重复执行不重复应用） |
| 历史 324 条端到端演练（本地假 skillhub，不联网） | 322 条 `sent`、2 条故意 500 → 跳过并累计一次尝试，批次未中断；第二轮只重试这 2 条（幂等） |

### 首次真实推送（2026-11-07，真 skillhub）

凭据由用户粘贴，经 `saveCredentials()` 密封后存进 `settings`（key `skillhub.push`，`updated_by='skillhub.push'`），
API 只回 `{cookie:true,xsrf:true,source:"settings"}`，读回校验与写入值一致。字典读取成功
（category 15/16/17/18/19/20/21/22/51，audience 23/24/25/52，feature 26/27/53）后按 `pushCandidates({limit:50})` 分批推：

| 批次 | 结果 |
| --- | --- |
| 1 条试推 | `exists`（400「slug or canonical URL already exists」） |
| 50 条 | 13 `sent` / 37 `exists` |
| 50 / 50 / 50 | 50 `sent`、49 `sent`+1 `exists`、50 `sent` |
| 50 / 50 / 23 / 空 | 49 `sent`+1 `exists`、48 `sent`+2 `exists`、23 `sent`、已无待推 |
| **合计 324 条** | **282 `sent`（都有远端 ID）/ 42 `exists` / 0 `failed` / 0 `pending` / 0 `skipped`** |

回查证据：对 282 个远端 ID 逐条 `GET /api/v1/admin/ai-tools/<id>`，**282/282 的 slug 与本地 payload 完全一致**；
42 条 `exists` 抽查重发，返回体确为 `{"code":400,"msg":"An AI tool with this slug or canonical URL already exists"}`，
是真的重复而不是把 400 误判成成功。50 条约 9 秒，全程无 401/5xx，桌面端无一行 `failed`。

之前「本机连不上 skillhub」的结论是错的：`guardedFetch`、Node `fetch`、`curl` 打
`GET /api/v1/admin/dicts/aitool.category/items` 都是 **HTTP 401 且 0.5 秒内返回**，那次 28 超时只是瞬时网络状态。

补充验证（同一台机器，临时起一个 `API_PORT=3201` 的实例打真库，`DEV_AUTH_ROLE=admin` 只用于那次冒烟）：

| 检查 | 结果 |
| --- | --- |
| `GET /api/admin/skillhub/overview` | `{"enabled":false,"configured":{"source":"none"},"counts":{"candidates":324,"pending":0,...}}` |
| `POST /api/admin/skillhub/config`（假凭据） | `{"configured":{"cookie":true,"xsrf":true,"source":"settings"}}`，值 sealed 进 `settings`，再查 overview 仍是布尔 |
| `POST /api/admin/skillhub/run` | `{"enqueued":1,"pending":324}`，`pgboss.job` 里出现 `skillhub-push.push`，`audit_log` 记 `dev:Dev Admin / skillhub.push` |
| 无 `x-csrf-token` 的 POST | 403 |
| 冒烟后清理 | 删掉那条 settings、那条 job 与两条审计，`skillhub_pushes` 仍为 0 行 |

前端：`apps/web/build/server/index.js` 与客户端 `page-*.js` 里能找到「skillhub 推送」（菜单）与「推送全部待推送」（按钮）、`admin/skillhub-push`（页面路由）。

### 第二轮：补漏、每日一次、类型交给模型（2026-11-07 晚）

用户报「政策没有推送」，查下来是筛选条件漏了两类，加上类型判定换模型：

| 问题 | 原因 | 改法 |
| --- | --- | --- |
| 10 条政策从未推送 | `publishedTools()` 只取 `category = 'ai-tools'` | 纳入 `category = 'policy'`，分类固定 `policy-regulations`（模型只能定受众/特点） |
| 12 条工具漏推 | 只认 `contentKind = 'tool-directory'` | 放成 `tool-directory`／`tool-collection`／空，仍排除 `tutorial`（2 条教程） |
| 「推送太频繁」 | cron `*/10 * * * *` | 每天一次 `0 9 * * *`，`SKILLHUB_PUSH_CRON` 可改；推过的（`sent`/`exists`）永不重推 |
| 类型是关键词规则，324 条里受众全是 `teacher-research`、分类只有 6 种、`policy-regulations` 一条没有 | 规则表写死 | 新增 `backend/classify.ts`：步骤 `skillhub-classify`（默认站点 default，即 deepseek）每批 10 条从字典 code 里选分类/受众/特点，结果缓存进 `skillhub_tool_types`（迁移 `0107`）；模型不可用或给了字典外的 code 就退回规则，`decided_by = 'rules'`，推送不中断 |

真库实测（346 条候选，全部由模型判定，`byModel = 346 / byRules = 0`）：

| 分类 | 条数 | | 受众 | 条数 | | 特点 | 条数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| image-video | 157 | | other | 212 | | （空） | 294 |
| software-development | 47 | | administrative-office | 53 | | editorial-pick | 37 |
| text-writing | 45 | | student-learning | 43 | | authoritative-release | 15 |
| office-productivity | 41 | | teacher-research | 38 | | | |
| other | 18 | | | | | | |
| training-resources | 13 | | | | | | |
| literature-research | 12 | | | | | | |
| policy-regulations | 10 | | | | | | |
| academic-ethics | 3 | | | | | | |

补推结果：22 条新增（10 条政策 + 12 条工具）→ **19 条 `sent`、3 条 `exists`、0 失败**，19 条全部按 `remote_id` 回查 `GET /api/v1/admin/ai-tools/{id}` 且 `slug` 一致。总计 `skillhub_pushes` = 301 `sent` + 45 `exists`，与候选 346 对齐。

顺带验明（文档里没写，实测出来的）：`PUT /api/v1/admin/ai-tools/{id}` 可以更新，必须发**完整**创建体（只发部分字段返回 500），`PATCH` 不支持（405）；因此「把已推条目的类型换成模型判的」走 `--update-existing`（后台按钮需二次确认）。`exists` 的 45 条没有 `remote_id`（远端是别人先建的），永远不更新。

回写远端（用户确认后执行）：`updateSent` 把已推成功且有 `remote_id` 的 **301 条**按模型结果逐条 `PUT`，**301 成功、0 失败**；随后抽查 15 条（含政策、`other`/`editorial-pick` 等边界值）用 `GET /api/v1/admin/ai-tools/{id}` 比对三本字典的真实 ID，15/15 一致。回滚方式：用规则再跑一遍同一接口（规则的结论是文章内容的纯函数，随时可重算）。

第三批（同一晚，采集器又入库了 49 条）：ai-tools 从 338 涨到 392，其中 `contentKind` 空 54 条（44 条来自 `weblist-aixzd-tools`、2 条来自 RSS 资讯）、tool-directory 327、news 4、tutorial 3。按新筛选规则待推 49 条，推了其中 **47 条工具（47 `sent`、0 失败）**，全部按 `remote_id` 回查 slug 一致（远端 921–967）。留下 2 条待定：`rss-36kr`「谷歌发布 Gemini Omni 1.2 Flash」与 `rss-qbitai`「海亮科服推出 e 生涯服务平台」——它们被上游判定为 ai-tools 但内容是资讯，不是工具；要不要推由用户决定，`SKILLHUB_PUSH_ENABLED` 关着，不会自动被扫出去。

当前状态：`skillhub_pushes` = 348 `sent` + 45 `exists`（393 条），`skillhub_tool_types` 与之一致（393 条全部 `decided_by = 'model'`），远端没有任何一条带 `last_error`。

### 第三轮：凭据一框粘、分类模型跟着 `LLM_MODEL`（2026-11-07 夜）

用户的反馈是「这地方过于复杂」（页面上 Cookie 与 XSRF Token 两个框，各自要去 devtools 里找），外加「分类模型自动用 .env 里的 LLM_MODEL」。

- 页面只剩一个「登录凭据」框：整条 `curl`（浏览器「Copy as cURL」）、一段请求头、或者单独一段 Cookie 值都行。`backend/paste.ts` 负责解析——Cookie 先试 `-b`／`--cookie`，再试请求头 `cookie:`，最后才把整段当 Cookie；XSRF 先试请求头 `X-XSRF-TOKEN`，没有就从 Cookie 里的 `XSRF-TOKEN` 取；顺带认出 curl 里的域名。`POST /api/admin/skillhub/paste` 只回「认出了哪半、请求去的哪个域名、从哪儿取的」，值照旧 sealed 进 `settings`；一个都认不出直接 400，不会覆盖已存的会话。「解析并保存」一次点击 = 解析 + 保存 + 读三本字典验证，连不通当场报错。
- 两字段的 `POST /api/admin/skillhub/config` 删掉了（页面和路由测试同步改成 `/paste`），少一条路径就少一处能存进错东西的地方。`tests/paste.test.ts` 覆盖 bash 多行 curl、`-b`/`--cookie`、Windows `^` 续行、Chrome 请求头块、单段 Cookie、跨行 Cookie 头、以及五种「不是会话」的垃圾输入。
- 分类模型：步骤 `skillhub-classify` 默认吃站点 default，也就是 `.env` 的 `LLM_MODEL`。`currentModel()` 现在用 `concreteModel()` 把 `default` 解析成真实模型名，页面「分类模型」显示 `deepseek-v4.1-flash-1017` 而不是 `default`；分类记录里的 `model` 列也写真实名（库里 393 行已按 `LLM_MODEL` 回填）。
- 校验：`npm run typecheck` 退出 0；模块测试 38/38（含新加的 9 条）。

