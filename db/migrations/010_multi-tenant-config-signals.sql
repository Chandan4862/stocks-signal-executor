-- Multi-tenant: Per-user config overrides and signal subscriptions.
-- Also drops token_store (tokens now live in Redis only).

-- UP

-- ── user_config ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_config (
  user_id    BIGINT NOT NULL REFERENCES users(id),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

-- ── user_signal_subscriptions ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_signal_subscriptions (
  user_id        BIGINT NOT NULL REFERENCES users(id),
  signal_source  TEXT NOT NULL DEFAULT 'default',
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, signal_source)
);

-- ── Drop token_store (tokens stored in Redis only) ──────────────────
DROP TABLE IF EXISTS token_store;

-- DOWN
-- DROP TABLE IF EXISTS user_config;
-- DROP TABLE IF EXISTS user_signal_subscriptions;
-- CREATE TABLE IF NOT EXISTS token_store (
--   trade_date DATE PRIMARY KEY,
--   enctoken TEXT NOT NULL,
--   expires_at TIMESTAMPTZ,
--   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
-- );
