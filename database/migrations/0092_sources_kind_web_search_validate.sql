-- 验证已有的 sources 行都满足更宽（而非更严）的 kind 列表；不改数据，只补上约束的检查标记。
ALTER TABLE sources VALIDATE CONSTRAINT sources_kind_check;
