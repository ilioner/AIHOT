-- Pacing: the earliest moment this login may take its next WeRead request (the pool spaces requests
-- and keeps a source on one login).
ALTER TABLE weread_accounts ADD COLUMN IF NOT EXISTS next_allowed_at timestamptz;
