-- Immutable operation results; old deployments retain their last known acceptance as a legacy event.
CREATE TABLE IF NOT EXISTS skillhub_push_events (
  id bigserial PRIMARY KEY,
  article_id text NOT NULL,
  operation text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL
);
