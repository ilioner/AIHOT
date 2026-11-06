import { sql } from "../db.ts";

export function contentStatus() {
  return sql`CASE
    WHEN p.visibility = 'withdrawn' AND EXISTS (SELECT 1 FROM editorial_overrides status_override WHERE status_override.article_id = a.id AND status_override.visibility = 'withdrawn') THEN '人工下架'
    WHEN a.processing_state = 'failed' THEN '分析失败'
    WHEN a.processing_state = 'new' THEN '待分析'
    WHEN a.processing_state = 'blocked' OR p.visibility = 'withdrawn' THEN '规则拦截'
    WHEN s.participation_mode = 'hot_signal' THEN '仅热度参考'
    WHEN p.visibility = 'summary-only' THEN '仅摘要'
    WHEN p.visibility = 'public' AND NOT p.eligible THEN '相关性待确认'
    WHEN p.visibility = 'public' THEN '公开'
    ELSE '未公开' END`;
}
