-- Runtime trading configuration stored in DB.
-- Replaces .env for tunable params; allows live updates via Telegram /config.

CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed with defaults (matches previous .env values)
INSERT INTO app_config (key, value) VALUES
  ('max_trade_capital',   '25000'),
  ('per_trade_capital',   '2000'),
  ('max_active_trades',   '10'),
  ('tsl_increment_rs',    '2'),
  ('tsl_initial_sl_pct',  '3'),
  ('tsl_trailing_step_pct', '1')
ON CONFLICT (key) DO NOTHING;
