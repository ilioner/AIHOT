-- 更宽的 kind 列表。NOT VALID 只跳过对已有行的检查，新写入立即受约束，所以后台随即能创建 ai_list 信源；
-- 已有行在随后的 0101 里单独验证。加约束取 SHARE UPDATE EXCLUSIVE 锁，正常读写不受影响。
ALTER TABLE sources ADD CONSTRAINT sources_kind_check CHECK (kind IN ('rss', 'web_list', 'json_list', 'x_search', 'mp_account', 'external', 'web_search', 'ai_list')) NOT VALID;
