-- Pacing: when the login's current hour budget window started; an hour old means it starts again.
ALTER TABLE weread_accounts ADD COLUMN IF NOT EXISTS hour_started_at timestamptz;
