-- Pacing: consecutive throttles/verification demands, which double the login's cooldown each time.
ALTER TABLE weread_accounts ADD COLUMN IF NOT EXISTS cooldown_level integer NOT NULL DEFAULT 0;
