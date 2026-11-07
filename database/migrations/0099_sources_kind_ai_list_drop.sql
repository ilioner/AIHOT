-- 让 sources 能装 AI 抽取列表类型（ai_list）：先去掉旧的 kind 约束，随后按 NOT VALID 加回更宽的列表。
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_kind_check;
