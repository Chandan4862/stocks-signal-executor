/*
  In-Memory State Store for the mock server.
  Tracks orders, forever orders, holdings, and signals.
  Provides consistency: placed order → appears in getOrders,
  triggered forever order → order appears + holding created.
*/

export interface MockOrder {
  orderId: string;
  correlationId?: string;
  algoId?: string;
  orderStatus: "PENDING" | "TRADED" | "REJECTED" | "CANCELLED";
  transactionType: "BUY" | "SELL";
  exchangeSegment: string;
  productType: string;
  orderType: string;
  validity: string;
  tradingSymbol: string;
  securityId: string;
  quantity: number;
  price: number;
  triggerPrice?: number;
  filledQty: number;
  averagePrice: number;
  dhanClientId: string;
  createdAt: string;
}

export interface MockForeverOrder {
  orderId: string;
  orderStatus: "PENDING" | "TRIGGERED" | "CANCELLED";
  transactionType: "BUY" | "SELL";
  exchangeSegment: string;
  productType: string;
  orderType: string;
  tradingSymbol: string;
  securityId: string;
  quantity: number;
  price: number;
  triggerPrice: number;
  dhanClientId: string;
  createdAt: string;
  // When triggered, the resulting regular orderId
  triggeredOrderId?: string;
}

export interface MockHolding {
  exchange: string;
  tradingSymbol: string;
  securityId: string;
  isin: string;
  totalQty: number;
  dpQty: number;
  t1Qty: number;
  availableQty: number;
  collateralQty: number;
  avgCostPrice: number;
  lastTradedPrice: number;
  pnl: number;
}

export interface MockPosition {
  tradingSymbol: string;
  securityId: string;
  exchangeSegment: string;
  positionType: string;
  buyQty: number;
  sellQty: number;
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  realizedProfit: number;
  unrealizedProfit: number;
  dhanClientId: string;
}

export interface MockIpState {
  primaryIP: string | null;
  secondaryIP: string | null;
  detectedIP: string;
  modifyDatePrimary: string | null;
  modifyDateSecondary: string | null;
}

class StateStore {
  orders: Map<string, MockOrder> = new Map();
  foreverOrders: Map<string, MockForeverOrder> = new Map();
  holdings: Map<string, MockHolding> = new Map();
  positions: Map<string, MockPosition> = new Map();
  idempotencyKeys: Set<string> = new Set();

  ipState: MockIpState = {
    primaryIP: "1.2.3.4",
    secondaryIP: null,
    detectedIP: "1.2.3.4",
    modifyDatePrimary: new Date(Date.now() - 86400 * 1000).toISOString().split("T")[0], // yesterday
    modifyDateSecondary: new Date(Date.now() - 86400 * 1000).toISOString().split("T")[0],
  };

  private nextOrderId = 100001;

  generateOrderId(): string {
    return String(this.nextOrderId++);
  }

  /** Simulate: forever order triggers → creates regular order + holding */
  triggerForeverOrder(foreverOrderId: string): void {
    const fo = this.foreverOrders.get(foreverOrderId);
    if (!fo || fo.orderStatus !== "PENDING") return;

    const regularOrderId = this.generateOrderId();
    fo.orderStatus = "TRIGGERED";
    fo.triggeredOrderId = regularOrderId;

    // Create the resulting regular order
    const order: MockOrder = {
      orderId: regularOrderId,
      algoId: foreverOrderId,
      orderStatus: "TRADED",
      transactionType: fo.transactionType,
      exchangeSegment: fo.exchangeSegment,
      productType: fo.productType,
      orderType: "MARKET",
      validity: "DAY",
      tradingSymbol: fo.tradingSymbol,
      securityId: fo.securityId,
      quantity: fo.quantity,
      price: fo.triggerPrice,
      filledQty: fo.quantity,
      averagePrice: fo.triggerPrice,
      dhanClientId: fo.dhanClientId,
      createdAt: new Date().toISOString(),
    };
    this.orders.set(regularOrderId, order);

    // If BUY, add to holdings
    if (fo.transactionType === "BUY") {
      const existing = this.holdings.get(fo.securityId);
      if (existing) {
        const totalCost = existing.avgCostPrice * existing.totalQty + fo.triggerPrice * fo.quantity;
        existing.totalQty += fo.quantity;
        existing.availableQty += fo.quantity;
        existing.avgCostPrice = totalCost / existing.totalQty;
      } else {
        this.holdings.set(fo.securityId, {
          exchange: "NSE",
          tradingSymbol: fo.tradingSymbol,
          securityId: fo.securityId,
          isin: `INE${fo.securityId}`,
          totalQty: fo.quantity,
          dpQty: fo.quantity,
          t1Qty: 0,
          availableQty: fo.quantity,
          collateralQty: 0,
          avgCostPrice: fo.triggerPrice,
          lastTradedPrice: fo.triggerPrice * 1.02,
          pnl: fo.triggerPrice * fo.quantity * 0.02,
        });
      }
    }
  }

  /** Reset all state */
  reset(): void {
    this.orders.clear();
    this.foreverOrders.clear();
    this.holdings.clear();
    this.positions.clear();
    this.idempotencyKeys.clear();
    this.nextOrderId = 100001;
    this.ipState = {
      primaryIP: "1.2.3.4",
      secondaryIP: null,
      detectedIP: "1.2.3.4",
      modifyDatePrimary: new Date(Date.now() - 86400 * 1000).toISOString().split("T")[0],
      modifyDateSecondary: new Date(Date.now() - 86400 * 1000).toISOString().split("T")[0],
    };
  }
}

// Singleton
export const store = new StateStore();
