CREATE INDEX CONCURRENTLY IF NOT EXISTS skillhub_push_events_day_idx ON skillhub_push_events (occurred_at DESC, id DESC);
