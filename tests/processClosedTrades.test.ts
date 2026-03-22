import { describe, it, expect, vi, beforeEach } from "vitest";

import { TradeReconciliationService } from "../src/services/tradeReconciliationService";
import { TradeSyncService } from "../src/services/tradeSyncService";
import { AuditLogService } from "../src/services/auditLogService";
import { StateStore } from "../src/services/stateStore";
import { DhanService, PlaceOrderResponse } from "../src/services/dhanService";

import closedApiResponse from "./fixtures/closed-api-response.json";

// npx vitest run tests/processClosedTrades.test.ts 2>&1

// ─── Shared Config ──────────────────────────────────────────────────────────
const baseCfg = {
  kite: {},
  dhan: { clientId: "TEST_CLIENT" },
  apis: {
    activeTradesUrl: "http://test/active",
    closedTradesUrl: "http://test/closed",
  },
  postgres: { host: "", port: 5432, database: "", user: "", password: "" },
  telegram: { botToken: "tok", defaultChatId: "chat" },
  pollingIntervalMs: 1000,
  maxTradeCapital: 100000,
  perTradeCapital: 10000,
  maxActiveTrades: 10,
  useSuperOrder: false,
  env: "development",
  tsl: { incrementRs: 2, initialSlPct: 3, trailingStepPct: 1 },
} as any;

// ─── DhanStub ───────────────────────────────────────────────────────────────
class DhanStub extends DhanService {
  public cancelledOrders: string[] = [];
  public placedOrders: any[] = [];

  async cancelForeverOrder(orderId: string): Promise<any> {
    this.cancelledOrders.push(orderId);
    return { orderId, orderStatus: "CANCELLED" };
  }

  async placeOrder(req: any): Promise<PlaceOrderResponse> {
    this.placedOrders.push(req);
    return {
      orderId: `SELL_${req.correlationId || Date.now()}`,
      orderStatus: "TRADED",
    };
  }
}

// ─── StoreStub ──────────────────────────────────────────────────────────────
// Configurable: provide `localTrades` map of id → trade row to simulate DB state.
function createStore(
  cfg: any,
  localTrades: Record<number, any> = {},
) {
  const executedQueries: { sql: string; params: any[] }[] = [];

  class StoreStub extends StateStore {
    public queries = executedQueries;

    constructor() {
      super(cfg);
      (this as any).pg = {
        query: async (sql: string, params: any[] = []) => {
          executedQueries.push({ sql, params });

          // SELECT trade by id
          if (sql.includes("FROM trades") && sql.includes("SELECT")) {
            const id = params[0];
            if (localTrades[id]) {
              return { rows: [localTrades[id]] } as any;
            }
            return { rows: [] } as any;
          }
          // UPDATE trades
          if (sql.includes("UPDATE trades")) {
            return { rows: [] } as any;
          }
          // INSERT INTO pnl_records
          if (sql.includes("INTO pnl_records")) {
            return { rows: [] } as any;
          }
          // Audit log insert
          if (sql.includes("INTO audit_logs")) {
            return { rows: [] } as any;
          }
          return { rows: [] } as any;
        },
      };
    }
    async connect() {}
    async disconnect() {}
  }
  return new StoreStub();
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function createServices(store: StateStore, cfg: any = baseCfg) {
  const audit = new AuditLogService((store as any).pg);
  const dhan = new DhanStub(cfg, {} as any, audit);
  return { dhan, audit };
}

/** Normalize raw closed API items using TradeSyncService */
function getClosedTrades() {
  const svc = new TradeSyncService(baseCfg);
  // Access private normalizer for test setup
  const data = (closedApiResponse as any).list.data;
  return data.map((svc as any).normalizeClosed);
}

function findUpdates(store: any, stateValue: string): any[] {
  return store.queries.filter(
    (q: any) => q.sql.includes("UPDATE trades") && q.sql.includes(stateValue),
  );
}

function findPnlInserts(store: any): any[] {
  return store.queries.filter((q: any) => q.sql.includes("INTO pnl_records"));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("processClosedTrades — Phase 4", () => {
  const closedTrades = getClosedTrades();
  // Pick a cash trade for tests: JINDALSTEL (id=1435 from fixture, "Book Profit")
  const cashTrade = closedTrades.find((t: any) => t.id === 1435);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Trade not found in local DB ──

  it("skips closed trades not found in local DB (no-op)", async () => {
    const store = createStore(baseCfg); // empty local trades
    const { dhan, audit } = createServices(store);
    const reconciliation = new TradeReconciliationService(baseCfg);

    await reconciliation.processClosedTrades(store, dhan, audit, [cashTrade]);

    expect(dhan.cancelledOrders).toHaveLength(0);
    expect(dhan.placedOrders).toHaveLength(0);
    expect(findUpdates(store, "CLOSED")).toHaveLength(0);
  });

  // ── Already CLOSED locally ──

  it("skips trades already in CLOSED state", async () => {
    const store = createStore(baseCfg, {
      1435: { id: 1435, state: "CLOSED", symbol: "JINDALSTEL" },
    });
    const { dhan, audit } = createServices(store);
    const reconciliation = new TradeReconciliationService(baseCfg);

    await reconciliation.processClosedTrades(store, dhan, audit, [cashTrade]);

    expect(dhan.cancelledOrders).toHaveLength(0);
    expect(dhan.placedOrders).toHaveLength(0);
  });

  it("skips trades already in CLOSED_BY_ANALYST state", async () => {
    const store = createStore(baseCfg, {
      1435: { id: 1435, state: "CLOSED_BY_ANALYST", symbol: "JINDALSTEL" },
    });
    const { dhan, audit } = createServices(store);
    const reconciliation = new TradeReconciliationService(baseCfg);

    await reconciliation.processClosedTrades(store, dhan, audit, [cashTrade]);

    expect(dhan.cancelledOrders).toHaveLength(0);
    expect(dhan.placedOrders).toHaveLength(0);
  });

  // ── AWAITING_ENTRY: cancel pending Forever order ──

  it("cancels pending buy order and marks CLOSED when trade was AWAITING_ENTRY", async () => {
    const store = createStore(baseCfg, {
      1435: {
        id: 1435,
        state: "AWAITING_ENTRY",
        symbol: "JINDALSTEL",
        buy_order_id: "FOREVER_BUY_123",
      },
    });
    const { dhan, audit } = createServices(store);
    const reconciliation = new TradeReconciliationService(baseCfg);

    await reconciliation.processClosedTrades(store, dhan, audit, [cashTrade]);

    // Should cancel the pending Forever order
    expect(dhan.cancelledOrders).toEqual(["FOREVER_BUY_123"]);
    // Should update state to CLOSED
    expect(findUpdates(store, "CLOSED")).toHaveLength(1);
    // Should NOT place a market sell (no position held)
    expect(dhan.placedOrders).toHaveLength(0);
  });

  it("marks CLOSED even if no buy_order_id (edge case)", async () => {
    const store = createStore(baseCfg, {
      1435: {
        id: 1435,
        state: "AWAITING_ENTRY",
        symbol: "JINDALSTEL",
        buy_order_id: null,
      },
    });
    const { dhan, audit } = createServices(store);
    const reconciliation = new TradeReconciliationService(baseCfg);

    await reconciliation.processClosedTrades(store, dhan, audit, [cashTrade]);

    // No order to cancel
    expect(dhan.cancelledOrders).toHaveLength(0);
    // Should still update state to CLOSED
    expect(findUpdates(store, "CLOSED")).toHaveLength(1);
  });

  // ── ENTERED: cancel exit order + market sell ──

  it("cancels exit order, places market SELL, records PnL when trade was ENTERED", async () => {
    const store = createStore(baseCfg, {
      1435: {
        id: 1435,
        state: "ENTERED",
        symbol: "JINDALSTEL",
        security_id: "3045",
        quantity: 8,
        entry_price: 1232,
        exit_order_id: "FOREVER_EXIT_456",
      },
    });
    const { dhan, audit } = createServices(store);
    const reconciliation = new TradeReconciliationService(baseCfg);

    await reconciliation.processClosedTrades(store, dhan, audit, [cashTrade]);

    // Should cancel exit Forever order
    expect(dhan.cancelledOrders).toEqual(["FOREVER_EXIT_456"]);
    // Should place market SELL
    expect(dhan.placedOrders).toHaveLength(1);
    const sellOrder = dhan.placedOrders[0];
    expect(sellOrder.transactionType).toBe("SELL");
    expect(sellOrder.orderType).toBe("MARKET");
    expect(sellOrder.productType).toBe("CNC");
    expect(sellOrder.securityId).toBe("3045");
    expect(sellOrder.quantity).toBe(8);
    // Should update state to CLOSED_BY_ANALYST
    expect(findUpdates(store, "CLOSED_BY_ANALYST")).toHaveLength(1);
    // Should record PnL
    expect(findPnlInserts(store)).toHaveLength(1);
  });

  it("uses CMP as exit price from closed trade data", async () => {
    const store = createStore(baseCfg, {
      1435: {
        id: 1435,
        state: "ENTERED",
        symbol: "JINDALSTEL",
        security_id: "3045",
        quantity: 8,
        entry_price: 1232,
        exit_order_id: "FOREVER_EXIT_456",
      },
    });
    const { dhan, audit } = createServices(store);
    const reconciliation = new TradeReconciliationService(baseCfg);

    await reconciliation.processClosedTrades(store, dhan, audit, [cashTrade]);

    // exit_price in UPDATE should use ct.cmp (1244.20 for JINDALSTEL)
    const updateQueries = store.queries.filter(
      (q: any) => q.sql.includes("UPDATE trades") && q.sql.includes("exit_price"),
    );
    expect(updateQueries.length).toBeGreaterThan(0);
    expect(updateQueries[0].params[0]).toBe(1244.2);
  });

  it("liquidates even if no exit_order_id (edge case)", async () => {
    const store = createStore(baseCfg, {
      1435: {
        id: 1435,
        state: "ENTERED",
        symbol: "JINDALSTEL",
        security_id: "3045",
        quantity: 5,
        entry_price: 1232,
        exit_order_id: null,
      },
    });
    const { dhan, audit } = createServices(store);
    const reconciliation = new TradeReconciliationService(baseCfg);

    await reconciliation.processClosedTrades(store, dhan, audit, [cashTrade]);

    // No order to cancel
    expect(dhan.cancelledOrders).toHaveLength(0);
    // Should still place market sell
    expect(dhan.placedOrders).toHaveLength(1);
    expect(dhan.placedOrders[0].transactionType).toBe("SELL");
  });

  // ── Multiple closed trades in single batch ──

  it("processes multiple closed trades in a single call", async () => {
    // Two trades: one AWAITING_ENTRY, one ENTERED
    const mglTrade = closedTrades.find((t: any) => t.id === 1448); // MGL
    const store = createStore(baseCfg, {
      1435: {
        id: 1435,
        state: "AWAITING_ENTRY",
        symbol: "JINDALSTEL",
        buy_order_id: "BUY_1",
      },
      1448: {
        id: 1448,
        state: "ENTERED",
        symbol: "MGL",
        security_id: "9999",
        quantity: 10,
        entry_price: 1200,
        exit_order_id: "EXIT_2",
      },
    });
    const { dhan, audit } = createServices(store);
    const reconciliation = new TradeReconciliationService(baseCfg);

    await reconciliation.processClosedTrades(store, dhan, audit, [cashTrade, mglTrade]);

    // First trade: cancelled buy order
    expect(dhan.cancelledOrders).toContain("BUY_1");
    // Second trade: cancelled exit order + market sell
    expect(dhan.cancelledOrders).toContain("EXIT_2");
    expect(dhan.placedOrders).toHaveLength(1); // only ENTERED one gets a sell
    expect(dhan.placedOrders[0].securityId).toBe("9999");
  });

  // ── Error resilience ──

  it("does not crash when processClosedTrades receives empty array", async () => {
    const store = createStore(baseCfg);
    const { dhan, audit } = createServices(store);
    const reconciliation = new TradeReconciliationService(baseCfg);

    await expect(
      reconciliation.processClosedTrades(store, dhan, audit, []),
    ).resolves.toBeUndefined();
  });

  // ── Full fixture: processes all 13 closed trades, only acts on local matches ──

  it("processes full API response — only acts on trades present in local DB", async () => {
    // Only JINDALSTEL (1435) and TATACHEM (1422) exist locally
    const store = createStore(baseCfg, {
      1435: {
        id: 1435,
        state: "AWAITING_ENTRY",
        symbol: "JINDALSTEL",
        buy_order_id: "BUY_JS",
      },
      1422: {
        id: 1422,
        state: "ENTERED",
        symbol: "TATACHEM",
        security_id: "5050",
        quantity: 14,
        entry_price: 690,
        exit_order_id: "EXIT_TC",
      },
    });
    const { dhan, audit } = createServices(store);
    const reconciliation = new TradeReconciliationService(baseCfg);

    await reconciliation.processClosedTrades(store, dhan, audit, closedTrades);

    // JINDALSTEL: AWAITING_ENTRY → cancel buy
    expect(dhan.cancelledOrders).toContain("BUY_JS");
    // TATACHEM: ENTERED → cancel exit + market sell
    expect(dhan.cancelledOrders).toContain("EXIT_TC");
    expect(dhan.placedOrders).toHaveLength(1);
    expect(dhan.placedOrders[0].securityId).toBe("5050");
    expect(dhan.placedOrders[0].quantity).toBe(14);
  });
});
