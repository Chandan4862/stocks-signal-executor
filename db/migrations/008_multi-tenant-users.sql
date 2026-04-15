-- Multi-tenant: Create users table (central tenant entity).
-- All other tables will gain a user_id FK column in the next migration.

-- UP

CREATE TABLE IF NOT EXISTS users (
  id                    BIGSERIAL PRIMARY KEY,
  telegram_chat_id      TEXT NOT NULL UNIQUE,
  telegram_username     TEXT,
  display_name          TEXT,

  -- Broker credentials (AES-256-GCM encrypted)
  dhan_client_id        TEXT,
  dhan_credentials_enc  BYTEA,          -- Encrypted JSON: {pin, totpSecret}
  dhan_credentials_iv   BYTEA,          -- AES initialization vector

  -- User state
  status                TEXT NOT NULL DEFAULT 'ONBOARDING'
                          CHECK (status IN ('ONBOARDING','ACTIVE','PAUSED','SUSPENDED')),
  trading_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  onboarded_at          TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_telegram ON users (telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_users_status   ON users (status);

-- DOWN
-- DROP TABLE IF EXISTS users;
