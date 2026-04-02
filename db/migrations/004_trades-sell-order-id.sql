-- Add sell_order_id column to trades table.
-- Used as an atomic guard to prevent duplicate SELL orders (S1 safeguard).
-- Also enables crash recovery: if sell was attempted but state update failed,
-- reconciliation can detect stale sell_order_id and notify user.

ALTER TABLE trades ADD COLUMN IF NOT EXISTS sell_order_id TEXT DEFAULT NULL;
