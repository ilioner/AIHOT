-- One row per article: the three dictionary codes the model (or, when it fails, the rules) chose, and who
-- chose them. Written once and reused, so a batch does not pay for the same classification twice.
-- decided_by: model / rules; reason is a short note from the model or why the rules were used instead.
CREATE TABLE IF NOT EXISTS skillhub_tool_types (
  article_id    text PRIMARY KEY,
  category_code text NOT NULL,
  audience_code text NOT NULL,
  feature_code  text,
  model         text,
  reason        text,
  decided_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
