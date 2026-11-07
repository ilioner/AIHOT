-- Pacing: requests made in the login's current rolling hour (WEREAD_HOURLY_BUDGET caps it).
ALTER TABLE weread_accounts ADD COLUMN IF NOT EXISTS requests_hour integer NOT NULL DEFAULT 0;
