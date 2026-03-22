-- Replace reco JSONB column with reco_id reference in trades table.
-- Full reco payload is now stored in reco_scan_log.

ALTER TABLE trades DROP COLUMN IF EXISTS reco;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS reco_id BIGINT;
