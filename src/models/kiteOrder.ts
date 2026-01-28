import { OrderState } from "../enums/trade";

export type TransactionType = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";

export interface KiteOrder {
  orderId?: string;
  tradingsymbol: string;
  exchange: "NSE";
  transactionType: TransactionType;
  quantity: number;
  price?: number; // for LIMIT orders
  orderType: OrderType;
  status: OrderState;
  tag?: string; // idempotency tag
}
