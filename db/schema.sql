-- Phase 1 DB schema draft: trades, audit logs, PnL, token store

CREATE TABLE IF NOT EXISTS trades (
  id BIGINT PRIMARY KEY,
  tradingsymbol TEXT NOT NULL,
  exchange TEXT NOT NULL DEFAULT 'NSE',
  reco_type TEXT NOT NULL CHECK (reco_type IN ('buy','sell')),
  entry_price NUMERIC(12,2) NOT NULL,
  quantity INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('NEW','ENTERED','EXITED','CANCELLED')),
  entered_at TIMESTAMPTZ,
  exited_at TIMESTAMPTZ,
  exit_price NUMERIC(12,2)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  trade_id BIGINT,
  event TEXT NOT NULL,
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
