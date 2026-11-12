CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS skillhub_push_events_legacy_idx ON skillhub_push_events (article_id) WHERE operation = 'legacy';
