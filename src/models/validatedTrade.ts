/**
 * ValidatedTrade: Resolved & validated payload ready for order placement.
 * Produced by validateAndResolveTrade, consumed by placeEntryOrder / persistBuyState.
 */
export interface ValidatedTrade {
  id: number;
  securityId: string;
  symbol: string;
  entryPrice: number;
  quantity: number;
  capital: number;
  slTrigger: number;
  target?: number;
}
