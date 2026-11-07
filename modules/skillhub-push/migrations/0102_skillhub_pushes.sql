-- One row per published tool directory entry the module pushed into skillhub's admin.
-- status: pending / sent / exists / failed / skipped; attempts counts sends, last_error is the refusal
-- in words, payload is the body that was sent (without credentials).
CREATE TABLE IF NOT EXISTS skillhub_pushes (
  article_id  text PRIMARY KEY,
  status      text NOT NULL DEFAULT 'pending',
  attempts    integer NOT NULL DEFAULT 0,
  remote_id   bigint,
  last_error  text,
  payload     jsonb,
  pushed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
