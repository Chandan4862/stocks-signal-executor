-- Tracks every recommendation seen during active trade scans,
-- including those skipped (with reason) and those placed.

CREATE TABLE IF NOT EXISTS reco_scan_log (
  id BIGSERIAL PRIMARY KEY,
  reco_id BIGINT NOT NULL UNIQUE,
  symbol TEXT,
  outcome TEXT NOT NULL,           -- PLACED | SKIPPED | ERROR
  skip_reason TEXT,                -- null when outcome = PLACED
  entry_price NUMERIC(12,2),
  quantity INTEGER,
  reco JSONB,                      -- full raw reco payload
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reco_scan_log_scanned_at ON reco_scan_log (scanned_at);
