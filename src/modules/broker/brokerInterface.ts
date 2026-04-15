/*
  BrokerInterface: Abstract interface for broker API integrations.
  DhanService implements this today. Future brokers (Zerodha, Angel One)
  will implement the same interface.

  Keeps trade services broker-agnostic — they call BrokerInterface methods
  without knowing which broker is underneath.
*/

export interface PlaceOrderParams {
  correlationId: string;
  transactionType: "BUY" | "SELL";
  exchangeSegment: string;
  productType: string;
  orderType: string;
  validity: string;
  securityId: string;
  quantity: number;
  price?: number;
  triggerPrice?: number;
}

export interface PlaceForeverOrderParams {
  correlationId: string;
  transactionType: "BUY" | "SELL";
  exchangeSegment: string;
  productType: string;
  orderType: string;
  securityId: string;
  quantity: number;
  price: number;
  triggerPrice: number;
}

export interface OrderResult {
  orderId: string;
  orderStatus?: string;
}

export interface Holding {
  securityId: string;
  tradingSymbol: string;
  totalQty: number;
  avgCostPrice: number;
  lastTradedPrice?: number;
}

export interface ForeverOrder {
  orderId: string;
  orderStatus: string;
  securityId?: string;
  [key: string]: any;
}

export interface RegularOrder {
  orderId: string;
  orderStatus: string;
  algoId?: string;
  filledQty?: number;
  averageTradedPrice?: number;
  price?: number;
  omsErrorDescription?: string;
  [key: string]: any;
}

/**
 * Abstract broker interface.
 * All broker-specific implementations must satisfy this contract.
 */
export interface BrokerInterface {
  /** Place a regular order (Market, Limit, etc.) */
  placeOrder(params: PlaceOrderParams): Promise<OrderResult>;

  /** Place a Forever (GTT) order */
  placeForeverOrder(params: PlaceForeverOrderParams): Promise<OrderResult>;

  /** Cancel a Forever order */
  cancelForeverOrder(orderId: string): Promise<void>;

  /** Get all Forever orders */
  getForeverOrders(): Promise<ForeverOrder[]>;

  /** Get all regular orders */
  getOrders(): Promise<RegularOrder[]>;

  /** Get all CNC holdings */
  getHoldings(): Promise<Holding[]>;

  /** Get current positions */
  getPositions(): Promise<any[]>;

  /** Validate that the current token/session is valid */
  validateToken(): Promise<boolean>;
}
