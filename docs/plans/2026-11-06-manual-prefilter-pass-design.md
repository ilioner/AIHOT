# UNKNOWN 人工预筛通过

使用者已确认执行：内容诊断支持筛选原始预筛 UNKNOWN、分页勾选、当前页全选和全部匹配范围。单条详情使用同一命令。提交前预览准确范围，必须填写审核理由。

原始模型标签、分析记录和计费回执不改写。复用 editorial_overrides.fields 保存受保护的 manualPrefilter 授权，绑定材料 revision 和原始 UNKNOWN 分析编号，记录操作者、理由和请求编号。只有专用审核命令能新增授权，普通字段修正不能设置或清除它。材料更新后授权失效。

人工 PASS 只替代预筛的有效结论，worker 复用原始 UNKNOWN 证据并继续现有评分、结构分析及写作；仍使用原有计费回执和预算。不跳过材料不足、拦截标签、写作失败、摘要要求、人工下架、信源权限或精选门槛。授权保存时仍不公开，后续成功分析才由统一发布层决定公开。

预览生成绑定管理员的签名快照，包含当时的条目、材料版本、分析编号和人工设置版本，不会包含后来新增的 UNKNOWN。每次最多 1000 条，超过时要求缩小检索范围；这是批量请求大小限制，不是内容评分门槛。提交重新锁定并核对快照，正在处理、已经审核或变化的条目跳过；逐项保存授权、任务和审计，失败项回滚，返回实际成功、跳过、失败数及逐项原因。同一请求重放返回已提交结果，不重复入队或付费。

## 实施计划

> 实施者遵循 TDD：先运行行为测试确认缺失，再写最小实现；未经要求不提交 Git、不委派。

1. 在 `tests/admin-corrections.test.ts` 增加 API 筛选、预览、审核、审计、权限、重复请求和变化跳过测试；在 `tests/analyze.test.ts` 验证 UNKNOWN 原始回执保留、后续分析和公开门禁。运行 Node 24 专项测试确认失败。
2. 修改 `packages/contracts/src/admin.ts`、`packages/backend/src/admin/content.ts`、`packages/backend/src/editorial/analyze.ts` 和 `packages/backend/src/publication/publish.ts`，新增 `packages/backend/src/editorial/manual-prefilter.ts` 共享授权校验；修改 `apps/api/src/routes/admin.ts` 接入专用命令。复用现有 JSON 字段，无迁移和历史回填。
3. 修改 `apps/web/app/routes/admin/content.tsx` 和 `apps/web/app/routes/admin/content-item.tsx`，提供筛选、多选、预览及真实数量反馈；在 `apps/web/tests/cache.test.ts` 验证真实生产页面与假 API 的交互。
4. 同步 `docs/selection.md`、`docs/deploy.md` 和此前设计记录，明确 UNKNOWN 默认仍拦截，只有专用人工审核例外。运行专项测试、typecheck、全部后端与网页测试、网页构建、本机 Ego Lite 检查和 smoke。
5. 恢复原有真实采集和模型开关，推送保持关闭。本任务不自动批量审核运营库内容，也不再次删除非公众号资料。
