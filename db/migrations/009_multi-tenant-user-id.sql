-- Multi-tenant: Add user_id FK to all tenant-scoped tables.
-- Uses DEFAULT 1 for backward compatibility with existing data.
-- A seed user (id=1) must exist before running this migration.

-- UP

-- Seed the system user (represents the original single-user setup)
INSERT INTO users (id, telegram_chat_id, status, trading_enabled, onboarded_at)
VALUES (1, '__system_seed__', 'ACTIVE', TRUE, NOW())
ON CONFLICT (id) DO NOTHING;

-- Reset sequence so next user gets id=2+
SELECT setval('users_id_seq', GREATEST((SELECT MAX(id) FROM users), 1));

-- ── trades ──────────────────────────────────────────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS user_id BIGINT DEFAULT 1 REFERENCES users(id);
-- Backfill existing rows
UPDATE trades SET user_id = 1 WHERE user_id IS NULL;
ALTER TABLE trades ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE trades ALTER COLUMN user_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_trades_user_state ON trades (user_id, state);

-- ── idempotency ─────────────────────────────────────────────────────
ALTER TABLE idempotency ADD COLUMN IF NOT EXISTS user_id BIGINT DEFAULT 1 REFERENCES users(id);
UPDATE idempotency SET user_id = 1 WHERE user_id IS NULL;
ALTER TABLE idempotency ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE idempotency ALTER COLUMN user_id DROP DEFAULT;
-- Replace PK: (action_key) → (user_id, action_key)
ALTER TABLE idempotency DROP CONSTRAINT IF EXISTS idempotency_pkey;
ALTER TABLE idempotency ADD PRIMARY KEY (user_id, action_key);

-- ── audit_logs ──────────────────────────────────────────────────────
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id);
-- Nullable — system events have no user
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs (user_id, created_at DESC);

-- ── pnl_records ─────────────────────────────────────────────────────
ALTER TABLE pnl_records ADD COLUMN IF NOT EXISTS user_id BIGINT DEFAULT 1 REFERENCES users(id);
UPDATE pnl_records SET user_id = 1 WHERE user_id IS NULL;
ALTER TABLE pnl_records ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE pnl_records ALTER COLUMN user_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_pnl_user ON pnl_records (user_id, exited_at DESC);

-- ── reco_scan_log ───────────────────────────────────────────────────
ALTER TABLE reco_scan_log ADD COLUMN IF NOT EXISTS user_id BIGINT DEFAULT 1 REFERENCES users(id);
UPDATE reco_scan_log SET user_id = 1 WHERE user_id IS NULL;
ALTER TABLE reco_scan_log ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE reco_scan_log ALTER COLUMN user_id DROP DEFAULT;
-- Remove UNIQUE on reco_id (same reco can now appear for different users)
ALTER TABLE reco_scan_log DROP CONSTRAINT IF EXISTS reco_scan_log_reco_id_key;
CREATE INDEX IF NOT EXISTS idx_reco_scan_user ON reco_scan_log (user_id, scanned_at DESC);

-- ── postback_log ────────────────────────────────────────────────────
ALTER TABLE postback_log ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id);
-- Nullable — postbacks matched later during processing

-- DOWN
-- ALTER TABLE trades DROP COLUMN IF EXISTS user_id;
-- ALTER TABLE idempotency DROP COLUMN IF EXISTS user_id;
-- ALTER TABLE audit_logs DROP COLUMN IF EXISTS user_id;
-- ALTER TABLE pnl_records DROP COLUMN IF EXISTS user_id;
-- ALTER TABLE reco_scan_log DROP COLUMN IF EXISTS user_id;
-- ALTER TABLE postback_log DROP COLUMN IF EXISTS user_id;
