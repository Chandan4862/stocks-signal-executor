-- Add ltp (last traded price) column to trades table.
-- Updated on every monitor tick with the latest holding price from Dhan.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS ltp NUMERIC(12,2);
