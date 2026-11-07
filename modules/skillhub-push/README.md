# skillhub-push

把站内已公开的 **AI 工具目录**条目推送到 skillhub 后台的创建接口（`POST /api/v1/admin/ai-tools`），
并记录每一条的推送状态。推送单条失败会跳过并记下原因，不影响同一批次里后面的条目。
已经推过的条目可以用完整请求体覆盖（`PUT /api/v1/admin/ai-tools/{id}`），用来把模型判定的分类补到远端。

三类**字典 code**（`aitool.category` / `aitool.audience` / `aitool.feature`）由模型决定，结果按条目缓存；
模型不可用时退回规则，绝不阻断推送。

## 推送哪些条目

一条 `publications` 记录同时满足以下条件时进入推送范围：

| 条件 | 含义 |
| --- | --- |
| `p.visibility = 'public'` | 已公开 |
| `p.eligible` | 未被规则挡下 |
| `contentKind <> 'tutorial'` | 教程是文章，不是工具（政策栏目也不例外） |
| 明确工具类型、旧工具条目、政策三者之一 | `contentKind` 为 `tool-directory` / `tool-collection`，或 `category=ai-tools` 且类型为空 / NULL，或 `category=policy` |

明确的工具或合集即使被分到 `tip`、`ai-teaching` 等栏目也进入推送，不能用网站栏目否定采集器标记的内容类型。
普通教程、非政策的 `news`、其他栏目中未标明工具类型的内容仍排除，不是放开整个 `tip` 栏目。
不能把当前候选数当作全站公开内容数。实时数量以后台为准，排查与补推记录见
`docs/plans/2026-11-07-skillhub-push-repair.md` 和 `docs/plans/2026-11-07-skillhub-tool-kind-scope.md`。

政策条目在映射阶段固定归到 `policy-regulations`（政策法规），不会落进兜底的「办公提效」。

## 数据表

`skillhub_pushes`（迁移 `modules/skillhub-push/migrations/0102_skillhub_pushes.sql`，一条 `CREATE TABLE IF NOT EXISTS`）：

| 列 | 含义 |
| --- | --- |
| `article_id` (PK) | 对应 `articles.id` |
| `status` | `pending` / `sent` / `exists` / `failed` / `skipped` |
| `attempts` | 已花掉的尝试次数，自动重试上限 3 次 |
| `remote_id` | skillhub 返回的 AI 工具 ID（更新时用它） |
| `last_error` | 最近一次的错误原因（页面上「最近错误」列） |
| `payload` | 实际发送的请求体，便于事后核对 |
| `pushed_at` | 被 skillhub 接受（新建或已存在）的时间 |
| `created_at` / `updated_at` | 记录时间 |

状态说明：`sent` 新建成功；`exists` 返回 400「slug 或标准地址已存在」，不再自动创建，但不代表已逐字段核对远端内容；`pending` 还会被重试；
`failed` 已用满 3 次，只在后台手动重试时重开；`skipped` 是映射阶段就不合格的条目（如标题为空），不会重试。

`skillhub_tool_types`（迁移 `modules/skillhub-push/migrations/0107_skillhub_tool_types.sql`）缓存分类结果：

| 列 | 含义 |
| --- | --- |
| `article_id` (PK) | 对应 `articles.id` |
| `category_code` / `audience_code` / `feature_code` | 三个字典 code（`feature_code` 可为空） |
| `model` | 做这次判断的模型（退回规则时为空） |
| `reason` | 模型给的理由，或退回规则的原因 |
| `decided_by` | `model` 或 `rules` |
| `created_at` / `updated_at` | 记录时间 |

退回规则的结论也会缓存（`decided_by = 'rules'`），所以同一批里不会为同一条反复调用模型；
要重新问一次就用后台的「用模型重新分类」或命令行的 `--reclassify`（`force` 忽略缓存）。

## 分类：模型决定，规则兜底（`backend/classify.ts`）

- 模型步骤名 `skillhub-classify`（`server.ts` 的 `models` 声明，后台「模型与评测」页可换），默认跟随站点的 `default` 模型，
  也可以用环境变量 `SKILLHUB_CLASSIFY_MODEL` 指到某个具名模型。
- 每次调用把 **10 条**工具（标题、摘要、源站分类、标签、所属栏目）拼成 JSON，要求模型只输出
  `{"items":[{"articleId","categoryCode","audienceCode","featureCode","reason"}]}`；`temperature: 0`，`promptVersion: "skillhub-classify-2"`。
  受众要求：能对上教师教研、学生学习、行政办公的挑最接近的一类，只有确实与这三类都无关才给 `other`。
- 模型给的 code 必须出现在**当前部署的三本字典里**，否则这一条退回规则，并在 `reason` 里记下「模型给的 code 不在字典里：…」。
  模型超时、5xx、返回的不是 JSON、少了一条，也都按同样的方式退回，`decided_by = 'rules'`，**推送继续**。
- 规则兜底在 `backend/mapping.ts` 的 `rulesFor()`：政策 → `policy-regulations`，其余按下面的关键字表；
  受众固定 `teacher-research`；标签含「推荐 / 精选」才给 `editorial-pick`。
- 政策条目（`p.category = 'policy'`）的 `categoryCode` 固定 `policy-regulations`：模型可以决定受众和功能特点，
  但不能把它归到工具分类里（`classify.ts` 存库前、`mapTool()` 出请求体前各拦一次）。

## 字段映射（`backend/mapping.ts`，纯函数）

| skillhub 字段 | 来源 |
| --- | --- |
| `name` | `publications.title`，去掉首尾空白，最多 200 字 |
| `slug` | 主机名 + 归一化地址的 sha256 前 8 位，如 `app-aibase-com-b00ae741`，全站唯一且只含小写字母、数字与连字符 |
| `url` | 原地址 |
| `canonicalUrl` | 经 `identityKeyForUrl` 归一化（小写主机、去 `www.`、统一 `https`、去掉 utm 等跟踪参数、参数排序）；如果文章已有的 `identity_key` 保留 fragment，推送也保留，以区分 hash 路由专题；普通锚点仍去除，x.com 推文等非工具地址直接跳过 |
| `description` | `publications.summary` |
| `iconUrl` | `raw.sourceMetadata.iconUrl`，缺失时取 `media` 里第一张图 |
| `aiNote` | `来源目录：<源站名>；源站分类：<blockName 或首个小分类>；标签：…` |
| `categoryDictItemId` | 模型的 `categoryCode`（模型没给出可用答案时用规则），再按 code 查字典 ID；兜底 `office-productivity`（办公提效） |
| `audienceDictItemId` | 模型的 `audienceCode`（规则兜底 `teacher-research`），按 code 查字典 ID |
| `featureDictItemId` | 模型的 `featureCode`（规则兜底：标签含「推荐」或「精选」时给 `editorial-pick`），按 code 查字典 ID |

规则兜底的分类关键字（按顺序命中，先具体后宽泛）：伦理/学术诚信 → `academic-ethics`；文献/论文/科研/学术/研究 → `literature-research`；
培训/学习/教程/课程/教育/教学/考试 → `training-resources`；政策/法规/合规/监管/法律 → `policy-regulations`；
编程/开发/代码/api/skills/agent/智能体/数据库/部署/运维 → `software-development`；写作/文案/文本/翻译/提示词/prompt/摘要/小说/润色 → `text-writing`；
绘画/图像/图片/视频/音视频/设计/3d/ui/音乐/语音/剪辑/摄影/aigc/角色/数字人/建模 → `image-video`；
办公/效率/会议/求职/电商/助理/聊天/知识管理/检测/安全/seo/导航 → `office-productivity`。

## 接口调用（`backend/client.ts`）

先按 code 读三本字典 `aitool.category` / `aitool.audience` / `aitool.feature`（`GET /api/v1/admin/dicts/<code>/items?activeOnly=true`，只保留 `status = "ACTIVE"`，进程内缓存 10 分钟），
再 `POST /api/v1/admin/ai-tools` 新建、或 `PUT /api/v1/admin/ai-tools/{id}` 覆盖（两者都带 `cookie` 与 `x-xsrf-token`，走 `guardedFetch`，30 秒超时）。

更新必须发**完整的创建请求体**：`PATCH` 返回 405，只发部分字段返回 500。

响应分类：

| 情况 | 处理 |
| --- | --- |
| 2xx | 新建记 `sent` 并记下 `remote_id`；更新记 `updated`，行状态不变 |
| 400 且提示「已存在 / 重复」或已知英文 `slug / canonical URL already exists` | 新建记 `exists`；更新记一次失败，行仍是 `sent` |
| 401 / 403 | 会话失效：新建记为 `pending` + 错误原因，**立即停止本批次**；更新**不改本地任何状态**，同样停止 |
| 其他 4xx | `pending`，记 `last_error`，重试到 3 次后 `failed`；更新只记 `last_error`，行仍是 `sent` |
| 429 / 5xx / 网络错误 | 同上；但连续 3 条都失败就停下本批次（`summary.error` 写明原因），剩下的留给下一轮，避免对端挂了还逐条等超时 |

## 只推一次，失败才会重来

- `sent` / `exists` 的条目**永不重推**（`pendingToolRows` 只取没有状态行、或 `pending` 且 `attempts < 3` 的）。
- `skipped` 不重试：映射阶段就不合格的条目，重试也是同样的结果。
- `failed` 只在后台点「重试失败」或单条「重试」时清零重开（命令行 `--retry-failed`）。
- 每天一次的扫描只看「有没有新的待推送条目」，有就排一批（`batchSize` 50），没有就什么都不做。

## 更新已推送的条目

`PUT` 会把远端工具的**全部字段**覆盖成当前模型判定的版本，所以只对 `status = 'sent'` 且 `remote_id` 非空的条目做；
`exists` 的条目没有新建时返回的 ID，**永远不更新**。

- 后台按钮「用模型重分类并更新远端」（`POST /api/admin/skillhub/run` + `{updateExisting: true, reclassify: true}`），
  二次确认对话框里写明「会覆盖远端已有字段」。
- 命令行 `--all --update-existing`（可加 `--reclassify` 强制重新问模型）。
- 更新失败不会把 `sent` 翻成 `pending` / `failed`：远端还有旧版本，行状态照旧，`last_error` 里写明是哪一条、远端 ID 多少、为什么没成。

## 凭据

后台「连接配置」里保存的值优先（用 `SESSION_SECRET` 派生的密钥加密后写进 `settings` 表，key `skillhub.push`），
没有才用环境变量 `SKILLHUB_COOKIE` / `SKILLHUB_XSRF_TOKEN`（也认 `AIHOT_CREDENTIALS_DIR/integrations.env`）。
**接口从不返回明文**，页面只显示「已配置 / 未配置完整」。会话泄漏风险由 cookie 本身的过期时间兜底，失效后重新粘贴即可。

会话失效（401/403）不会消耗条目的尝试次数，也不会把条目记成失败：整批停下，修好凭据后下一轮接着推。

接口地址与分类规则不进数据库：地址取 `SKILLHUB_BASE_URL`（页面只显示它），规则表是 `backend/mapping.ts` 里的常量。

## 后台页面

`/admin/skillhub-push`（菜单「AI 工具 → skillhub 推送」）：连接配置与测试连接、推送概览
（工具总数 / 待推送 / 已推送 / 已存在 / 失败 / 跳过 / 已分类 / 分类模型），
「推送全部待推送」「重试失败」「用模型重新分类」「用模型重分类并更新远端」四个按钮，以及带单条「重试」的推送记录表
（每行显示模型判定的三个 code 和判定者）。

待推送数包含尚无 `skillhub_pushes` 记录的新候选。列表也展示这些条目（`pending`、尝试 0 次），
读取概览不会为它们创建推送状态；历史状态统计不会覆盖实际候选的待推数量。

| 路由 | 作用 |
| --- | --- |
| `GET /api/admin/skillhub/overview` | 概览、状态计数、已分类/未分类条数、当前分类模型、最多 200 条记录（优先失败、待推，含从未推送的候选和每条的 `types`）、凭据是否已配置 |
| `POST /api/admin/skillhub/run` | 把待推送条目排进队列（不等推送完成）：`{limit?, onlyFailed?, articleIds?, updateExisting?, reclassify?}` |
| `POST /api/admin/skillhub/classify` | 立刻跑一遍分类：`{limit?, articleIds?, onlyMissing?}`，返回 `{attempted, byModel, byRules, model}` |
| `POST /api/admin/skillhub/paste` | 页面唯一入口：粘 curl / 请求头 / Cookie 整段，服务端解析出 Cookie 与 XSRF 后 sealed 保存（`{paste, test?}`；`test` 顺带读一次字典） |
| `POST /api/admin/skillhub/test` | 用当前凭据读一次三本字典，验证会话是否有效 |
| `POST /api/admin/skillhub/retry-failed` | 重置失败记录并重新排队 |
| `POST /api/admin/skillhub/items/:articleId/retry` | 单条重试（`attempts` 归零后重新排队） |

所有路由都挂在引擎的管理端守卫后面（`adminHandler`：会话 + 非 GET 请求的 `x-csrf-token`）。
凭据只需要在页面上粘一次：整条 `curl`（浏览器「Copy as cURL」）、一段请求头、或者单独一段 Cookie 值都行，
`backend/paste.ts` 负责从里面挖出 Cookie 与 XSRF（优先请求头 `X-XSRF-TOKEN`，没有就从 Cookie 的 `XSRF-TOKEN` 取），
解析结果只回「认出了哪半、请求去的哪个域名」，不回值本身；「解析并保存」会顺带读一次三本字典，连不通当场报错。

保存凭据、手动推送、模型分类、整体更新都会写一条 `audit_log`（`skillhub.config` / `skillhub.push` / `skillhub.classify` / `skillhub.update`），
记的是谁、什么时候、多少条、用了哪个模型；凭据值本身不进审计，也不进任何接口响应。

## 队列与定时

- 队列 `skillhub-push.push`（`retryLimit: 0`，一次一条），worker 逐条推送或逐条更新，汇总返回。
- 定时 `skillhub-push.sweep`，cron 默认 `0 9 * * *`（每天 9:00，`SKILLHUB_PUSH_CRON` 可改），
  只有 `SKILLHUB_PUSH_ENABLED=true` 时才排一批；后台按钮不受此开关限制。

## 命令行

```bash
# 只预览：不联网、不写库，打印每条将要发送的请求体（含分类 code 与判定者）
node --env-file-if-exists=.env modules/skillhub-push/scripts/push.ts --dry-run --limit 3

# 真推（需要有效 Cookie / XSRF Token）
node --env-file-if-exists=.env modules/skillhub-push/scripts/push.ts --all --limit 50

# 先把失败记录清零再推
node --env-file-if-exists=.env modules/skillhub-push/scripts/push.ts --all --retry-failed

# 只补分类，不推送
node --env-file-if-exists=.env modules/skillhub-push/scripts/push.ts --all --classify

# 全部重新问一次模型（忽略缓存）
node --env-file-if-exists=.env modules/skillhub-push/scripts/push.ts --all --classify --reclassify

# 用模型分类结果覆盖 skillhub 里已有的工具（完整 PUT）
node --env-file-if-exists=.env modules/skillhub-push/scripts/push.ts --all --update-existing --reclassify
```

不带 `--all` 一律按 dry run 处理（预览分类范围 / 预览 PUT 请求体，不调用模型、不联网、不写库）。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `SKILLHUB_BASE_URL` | 默认 `https://skillhub.aefree.com` |
| `SKILLHUB_PUSH_ENABLED` | 只有 `true` 时定时任务才会自动推送 |
| `SKILLHUB_PUSH_CRON` | 定时扫描的 cron，默认 `0 9 * * *` |
| `SKILLHUB_CLASSIFY_MODEL` | 分类步骤用的具名模型；不设则跟随站点 `default`，即 `.env` 的 `LLM_MODEL` |
| `SKILLHUB_COOKIE` | 后台登录后的 Cookie 请求头 |
| `SKILLHUB_XSRF_TOKEN` | 对应 `X-XSRF-TOKEN` 请求头 |

## 测试

```bash
npx tsc -p modules
DATABASE_URL=postgres://postgres@127.0.0.1:5437/aihot_zhijiao_test \
  node --test-global-setup=tests/databases.ts --import ./tests/databases.ts --test --test-timeout=120000 \
  "modules/skillhub-push/tests/*.test.ts"
```

| 文件 | 覆盖什么 |
| --- | --- |
| `tests/mapping.test.ts` | 纯函数：slug、归一化地址、分类关键字、请求体、字典 ID 查询 |
| `tests/candidates.test.ts` | 跨栏目 `tool-directory` / `tool-collection` 入选；空类型仅限旧工具栏目；公开与 eligible 边界、教程与资讯排除；政策归 `policy-regulations` |
| `tests/push.test.ts` | 新建：成功、400 已存在、单条 500 跳过且后面继续、401 停止、3 次上限后不再被扫到、连续失败停下批次 |
| `tests/classify.test.ts` | 分类：模型答案被采用、无效 code 退回规则、5xx 与不可解析输出退回规则且推送继续、第二次跑缓存不再调用模型、`force` 重新问 |
| `tests/update.test.ts` | 更新：完整请求体 PUT、404/500 跳过且继续、401 停止且不动本地状态、`exists` 条目永不更新 |
| `tests/routes.test.ts` | 管理接口：未登录 401、缺 CSRF 403、概览字段、按需分类写库与审计、**任何响应都不含凭据明文** |

全部用本地 stub 顶替 skillhub 与模型（`tests/setup.ts` 的 `stub`、`pointModels`），不联网。
