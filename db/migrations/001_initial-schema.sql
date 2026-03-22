-- Initial schema: trades, audit logs, PnL, token store, instruments, postback

-- UP

CREATE TABLE IF NOT EXISTS trades (
  id BIGINT PRIMARY KEY,
  tradingsymbol TEXT NOT NULL,
  exchange TEXT NOT NULL DEFAULT 'NSE',
  reco_type TEXT NOT NULL CHECK (reco_type IN ('buy','sell')),
  entry_price NUMERIC(12,2) NOT NULL,
  quantity INTEGER NOT NULL,
  state TEXT NOT NULL,
  security_id TEXT,
  symbol TEXT,
  buy_order_id TEXT,
  exit_order_id TEXT,
  target NUMERIC(12,2),
  sl_trigger NUMERIC(12,2),
  capital NUMERIC(12,2),
  reco JSONB,
  entered_at TIMESTAMPTZ,
  exited_at TIMESTAMPTZ,
  exit_price NUMERIC(12,2),
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency (
  action_key TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  trade_id BIGINT,
  event TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'INFO',
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pnl_records (
  id BIGSERIAL PRIMARY KEY,
  trade_id BIGINT NOT NULL,
  tradingsymbol TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  entry_price NUMERIC(12,2) NOT NULL,
  exit_price NUMERIC(12,2) NOT NULL,
  realized_pnl NUMERIC(14,2) NOT NULL,
  exited_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS token_store (
  trade_date DATE PRIMARY KEY,
  enctoken TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instrument_list_nse_eq (
  id BIGSERIAL PRIMARY KEY,
  exch_id TEXT NOT NULL,
  security_id TEXT NOT NULL,
  instrument TEXT,
  underlying_symbol TEXT,
  display_name TEXT,
  instrument_type TEXT,
  series TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_instrument_security_id ON instrument_list_nse_eq (security_id);
CREATE INDEX IF NOT EXISTS idx_instrument_underlying_symbol ON instrument_list_nse_eq (underlying_symbol);

CREATE TABLE IF NOT EXISTS postback_log (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL,
  correlation_id TEXT,
  order_status TEXT NOT NULL,
  transaction_type TEXT,
  security_id TEXT,
  trading_symbol TEXT,
  quantity INTEGER,
  filled_qty INTEGER,
  price NUMERIC(12,2),
  trigger_price NUMERIC(12,2),
  raw JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_postback_order_id ON postback_log (order_id);
