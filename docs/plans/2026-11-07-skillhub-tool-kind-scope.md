# SkillHub 工具类型漏推修复

目标：补齐用户指出的「AI帮你剪视频」，排查同类遗漏，让工具目录和工具合集不因网站栏目不同而漏推。

## 根因与边界

该条目的来源是 360 专题，`contentKind=tool-collection`、`category=tip`，已经公开且 eligible；旧推送查询先要求栏目为 `ai-tools` 或 `policy`，导致明确的工具合集仍被过滤。此前保持这一范围是为了不擅自放开全部教程；用户本次明确要求解决此类遗漏。

采用内容类型优先的最小修复，不修改网站分类，不增加模型调用入口或新开关：

- `visibility=public`、`eligible=true` 仍是前提；`tutorial` 仍排除。
- 明确标记为 `tool-directory` 或 `tool-collection` 的内容不再受网站栏目限制。
- 未标记类型的旧内容仍只允许 `ai-tools`，政策仍维持原规则。
- 不采用「放开整个 tip 栏目」的办法，以免将普通教程、资讯一并推入工具目录；也不单改这一条的栏目，以免以后再次漏推。

## 实施与验收

1. 在现有 `modules/skillhub-push/tests/candidates.test.ts` 覆盖跨栏目工具及合集、未公开和不 eligible 的边界；在 `tests/push.test.ts` 的 hash 专题用例中加入 `tip` 的合集，在 `tests/routes.test.ts` 覆盖其计数和待推列表。先观察回归失败。
2. 仅调整 `modules/skillhub-push/backend/push.ts` 的共享 `publishedTools()` 查询，让概览、待推、列表、分类和执行使用相同范围；更新模块说明及部署文档。
3. 对真实库运行前后对比，保存变更候选清单，确认旧候选不减少、只新增明确工具类型且公开的条目。分页读取远端目录，按标准地址和 slug 对账，避免把「本地未推」误说成「远端缺失」。
4. 运行模块测试、类型检查、全量后端测试、前端构建测试及站点冒烟；用 Ego Lite 验证后台待推项，通过既有队列补推，回查远端完整请求字段。
5. 保存备份与审计。自动推送仍关闭，不删除或覆盖已有远端记录，不提交 Git。测试只使用本地假服务，不连接真实推送或模型端点。

验证命令沿用仓库脚本；Node 使用 `/opt/homebrew/opt/node@24/bin`，测试数据库使用独立的 `aihot_skillhub_scope_test`，不对真实库运行测试。

## 执行结果（2026-11-07）

- 修复前对本地 482 条公开且 eligible 的内容、远端 912 条记录分页对账。原候选 396 条均能在远端按标准地址找到；同类误排、且远端确实缺失的只有「AI帮你剪视频」。另有 28 条明确工具类型的内容已撤回且不 eligible，不恢复或推送；其余 85 条公开内容不属于本模块定义的推送范围。
- 修复后实际共享查询返回 397 条：只新增 `zubshhgfdp3j0rnoe2t2n2nz3`，旧候选没有减少，待推送为 1。没有修改该条目的 `tip` 栏目，也没有放开整个 `tip` 栏目。
- 18:43 通过 Ego Lite 后台按钮进入既有队列，任务 `3c9eec46-bea6-40c7-908b-4efe1f14d7c5` 完成，尝试 1 条、成功 1 条。SkillHub 新记录 ID 为 **971**，状态 `ACTIVE`，分类「图像视频」。回查远端详情，全部 10 个提交字段完全一致，专题地址保留 `#/subjectdetail?id=39`。
- 后台刷新显示工具总数 397、已推送 352、已存在 45、待推送 0、失败 0；已分类 397/397，「推送全部待推送」按钮禁用。自动推送保持关闭。
- 补推后再次完整读取远端 913 条记录，全部 397 个候选都有对应标准地址，缺失数为 0。原远端记录的已备份字段及原本地推送记录均未变化；已写入 `skillhub.scope-repair.verify` 审计记录。
- 备份和逐条对账保存在 `.data/backups/skillhub-scope-20261107/`：`before.json`、`reconciliation.json`、`candidate-diff.json`、`verified.json`；文件权限为 0600，不提交这些数据。不删除或覆盖已有远端记录，不提交 Git。

## 验证记录

- RED：新增回归在旧代码上得到 44 项中 3 项失败，分别复现跨栏目候选缺失、专题 39 未推送和概览待推计数错误。
- GREEN：模块测试 **44/44 通过**；`npm run typecheck`、前端构建及 `scripts/smoke.ts --base http://localhost:3000` 均通过。Ego Lite 已验证待推条目、补推操作及完成状态。
- 全量后端 **1074/1076 通过**；两项既有阻碍未改动：架构测试读取工作区先前删除但仍在 Git 清单中的 `selectbench.ts`；备份恢复使用 pg_restore 18 对 PostgreSQL 16 设置不支持的 `transaction_timeout`。
- 前端测试 **41/66 通过**；其余 25 项因本机缺少 Playwright Chromium/WebKit 可执行文件，无法启动浏览器。未安装或升级浏览器环境来绕过这一问题，实际后台 UI 使用项目指定的 Ego Lite 检查。
- 日志位于 `.data/logs/skillhub-scope-*.log`。测试使用隔离测试库和本地假服务，真实补推单独通过管理员操作执行。
