import { TradeState } from "../enums/trade";

export interface ExecutedTrade {
  id: number; // reference to source recommendation id
  tradingsymbol: string; // NSE symbol
  exchange: "NSE";
  reco_type: "buy" | "sell"; // original reco type
  entry_price: number;
  quantity: number;
  state: TradeState;
  entered_at?: string; // ISO date when BUY executed
  exited_at?: string; // ISO date when SELL executed
  exit_price?: number;
}
