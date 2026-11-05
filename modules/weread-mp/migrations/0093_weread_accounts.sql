-- The WeRead logins the 微信读书采集 admin page scans in. Tokens are sealed by the module
-- (AES-256-GCM under SESSION_SECRET); this table only holds the seals.
CREATE TABLE IF NOT EXISTS weread_accounts (
  id bigserial PRIMARY KEY,
  vid text NOT NULL UNIQUE,
  nickname text NOT NULL DEFAULT '',
  avatar text NOT NULL DEFAULT '',
  access_token text NOT NULL,
  refresh_token text,
  skey text NOT NULL,
  device_id text NOT NULL,
  device_name text NOT NULL DEFAULT '',
  install_id text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  fail_count integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  last_used_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
