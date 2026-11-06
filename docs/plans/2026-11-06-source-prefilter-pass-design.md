# 六个指定来源预筛直通

## 已确认范围

此设计中 `catalog-360-topics` 的后续要求已获使用者确认，改为目录直接公开；详见 [360 专题目录设计](2026-11-06-directory-publication-design.md)。该来源不再由本设计的历史入队脚本处理，其他五个来源保持以下预筛直通流程。

使用者批准以下来源默认预筛 PASS，并将已有 UNKNOWN / BLOCK 重新入队继续分析：`weblist-aixzd-tools`、`catalog-aihot-tip`、`catalog-aibase`、`catalog-360-topics`、`catalog-360-student`、`catalog-360-teacher`。

## 设计

来源名单放在 `industry/selection.ts`，按来源 ID 精确匹配，不按名称或来源类型扩大范围。通过现有分析入口产生注明来源策略的 PASS，不请求预筛模型。新分析单独保存来源 ID 和材料版本作为来源放行证据；历史分析和收费回执不修改、不冒充模型 PASS。后续评分、结构分类、写作、材料不足、失败、拦截标签、人工下架和精选门槛保持原状。公开投影验证来源放行证据与当前来源和材料版本一致。

历史处理通过可预览的专用脚本，仅选择六个来源当前版本最新模型分析的 UNKNOWN / BLOCK，排除已经来源放行、正在处理或已排队的内容。事务内锁定文章并复核，清理重试状态、调用现有入队入口、重建仍不可公开的投影并记审计；不删除资料，不全量重新抓取，不解除人工下架。重复执行不重复排队。真实运行先暂停 worker、备份运营库，再应用并恢复授权的采集和模型调用；消息推送保持关闭。

## 实施计划

**Goal:** 六个来源新旧数据均可绕过预筛继续正常分析，而不是立即公开。

**Architecture:** 来源规则归行业配置，后端分析与公开读取共用证据校验；历史数据操作使用现有事务、入队与审计机制。

**Tech Stack:** Node.js 24、TypeScript、PostgreSQL、pg-boss、node:test。

1. 在 `tests/analyze.test.ts` 添加来源直通、下游拦截、材料不足、历史分析及回执不变测试；在 `tests/admin-corrections.test.ts` 添加范围、幂等、忙任务跳过和人工下架测试，先运行确认失败。
2. 修改 `industry/selection.ts`、`packages/backend/src/editorial/input.ts`、`packages/backend/src/editorial/analyze.ts`、`packages/backend/src/editorial/manual-prefilter.ts`、`packages/backend/src/publication/publish.ts`；添加来源策略校验与历史入队服务，运行上述测试确认通过。
3. 添加 `scripts/requeue-source-prefilter.ts`，默认预览、`--apply` 才写；同步 `docs/selection.md`、`docs/deploy.md`、`docs/信息源.md`、`modules/source-catalogs/README.md`。
4. 运行 `npm run typecheck`、独立测试库的 `npm test`、`npm run test:standalone`、web 构建和 web 测试、`git diff --check`。测试模型仅连接本地假服务。
5. 备份运营库，先预览再应用历史入队，记录真实计数；恢复服务并执行 `node scripts/smoke.ts --base http://localhost:3000`。不创建提交或分支。

## 实施验收

- 运营库已备份到 `.data/backups/source-prefilter-20261106/database.dump`，归档目录可读取；入队前后完整 `analyses`（357 行）与 `receipts`（3901 行）内容哈希一致。
- 111 条已重新入队，无失败：AIbase 40、教程 40、360 教师 8、360 学生 10、360 专题 5、星踪岛 8。重复预览不重复纳入已经排队的资料。
- 来源、分析、人工修正和公开投影定向测试 64 / 64，独立测试 241 / 241，类型检查、网页构建及站点 smoke 通过。
- 后端全量 1018 项有 1 项既有飞书 webhook 限流计时失败；该文件独立串行复测 4 / 4，通过来源策略相关测试，不修改限流业务或放宽断言。网页 66 项有 53 项通过，13 项因缺少 WebKit 执行器失败；使用本机 Chrome 执行可运行的测试，未改依赖。
- 入队后使用者已从本机终端启动服务，采集与模型调用继续运行；队列任务经原有预算限流与失败重试。360 专题五条均预筛 PASS，但四条材料不足、写作 none，另一条含拦截标签，所以按本设计尚不公开。使用者随后要求该来源全部放行，需明确与本设计“只通过预筛”的区别再更新。
