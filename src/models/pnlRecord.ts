export interface PnLRecord {
  trade_id: number;
  tradingsymbol: string;
  quantity: number;
  entry_price: number;
  exit_price: number;
  realized_pnl: number; // (exit - entry) * qty
  exited_at: string; // ISO date
}
