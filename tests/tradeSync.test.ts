import { describe, it, expect, vi, beforeEach } from "vitest";

import { TradeSyncService } from "../src/services/tradeSyncService";
import { TradeEntryService } from "../src/services/tradeEntryService";
import { QuantityResolverService } from "../src/services/quantityResolverService";
import { TSLService } from "../src/services/tslService";
import { AuditLogService } from "../src/services/auditLogService";
import { StateStore } from "../src/services/stateStore";
import { DhanService, PlaceOrderResponse } from "../src/services/dhanService";
import { InstrumentLookupService } from "../src/services/instrumentLookupService";

import activeApiResponse from "./fixtures/active-api-response.json";
// npx vitest run tests/tradeSync.test.ts 2>&1
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
  public placedOrders: any[] = [];

  async placeForeverOrder(req: any): Promise<PlaceOrderResponse> {
    this.placedOrders.push(req);
    return {
      orderId: `ORD_${req.correlationId || Date.now()}`,
      orderStatus: "PENDING",
    };
  }
}

// ─── StoreStub ──────────────────────────────────────────────────────────────
// Tracks all PG queries for assertion. Configurable openCount and deployedCapital.
function createStore(
  cfg: any,
  opts: {
    openCount?: number;
    deployedCapital?: number;
    existingIdempotencyKeys?: string[];
  } = {},
) {
  const {
    openCount = 0,
    deployedCapital = 0,
    existingIdempotencyKeys = [],
  } = opts;
  const executedQueries: { sql: string; params: any[] }[] = [];

  class StoreStub extends StateStore {
    public queries = executedQueries;

    constructor() {
      super(cfg);
      (this as any).pg = {
        query: async (sql: string, params: any[] = []) => {
          executedQueries.push({ sql, params });

          // Idempotency check
          if (sql.includes("FROM idempotency") && sql.includes("SELECT")) {
            const key = params[0];
            if (existingIdempotencyKeys.includes(key)) {
              return { rows: [{ action_key: key }] } as any;
            }
            return { rows: [] } as any;
          }
          // Idempotency insert
          if (sql.includes("INTO idempotency")) {
            return { rows: [] } as any;
          }
          // Trade count guard
          if (sql.includes("COUNT") && sql.includes("ANY")) {
            return { rows: [{ cnt: String(openCount) }] } as any;
          }
          // Capital guard
          if (sql.includes("SUM") && sql.includes("ANY")) {
            return { rows: [{ deployed: String(deployedCapital) }] } as any;
          }
          // Instrument lookup
          if (sql.includes("instrument_list_nse_eq")) {
            return { rows: [{ security_id: "3045" }] } as any;
          }
          // Trade insert/update
          if (sql.includes("INTO trades") || sql.includes("UPDATE trades")) {
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

// ─── TradeSyncStub ──────────────────────────────────────────────────────────
class TradeSyncStub extends TradeSyncService {
  private fixtureOverride: any[];
  private entryService: TradeEntryService;

  constructor(cfg: any, fixture: any[] = activeApiResponse) {
    super(cfg);
    this.fixtureOverride = fixture;
    this.entryService = new TradeEntryService(cfg);
  }

  async fetchActiveTrades(): Promise<any[]> {
    return this.fixtureOverride.map((this as any).normalizeActive);
  }

  // Delegate to TradeEntryService — keeps all test call-sites unchanged
  async runBuyAndInitialSl(
    store: any, dhan: any, qtyResolver: any, tslService: any,
    audit: any, instrumentLookup: any,
  ): Promise<void> {
    const actives = await this.fetchActiveTrades();
    return this.entryService.runBuyAndInitialSl(
      store, dhan, qtyResolver, tslService, audit, instrumentLookup, actives,
    );
  }
}

// ─── Helper ─────────────────────────────────────────────────────────────────
function createServices(store: StateStore, cfg: any = baseCfg) {
  const audit = new AuditLogService((store as any).pg);
  const dhan = new DhanStub(cfg, {} as any, audit);
  const qtyResolver = new QuantityResolverService();
  const tsl = new TSLService(cfg.tsl);
  const instrumentLookup = new InstrumentLookupService((store as any).pg);
  return { dhan, qtyResolver, tsl, audit, instrumentLookup };
}

/** Helper: check if any PG query was an INSERT INTO trades */
function findTradeInserts(store: any): any[] {
  return store.queries.filter(
    (q: any) => q.sql.includes("INTO trades") && q.sql.includes("INSERT"),
  );
}

/** Helper: check if any PG query was an INSERT INTO idempotency */
function findIdempotencyInserts(store: any): any[] {
  return store.queries.filter((q: any) => q.sql.includes("INTO idempotency"));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runBuyAndInitialSl — cap enforcement (Postgres-only)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Max Active Trades Guard ──

  it("skips ALL trades when maxActiveTrades is already reached", async () => {
    const store = createStore(baseCfg, { openCount: 10 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const tradeSync = new TradeSyncStub(baseCfg);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    expect(dhan.placedOrders).toHaveLength(0);
    expect(findTradeInserts(store)).toHaveLength(0);
  });

  it("allows trade when 1 slot remains (9 open + new = 10 max)", async () => {
    const store = createStore(baseCfg, { openCount: 9 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const tradeSync = new TradeSyncStub(baseCfg, [activeApiResponse[0]]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    expect(dhan.placedOrders).toHaveLength(1);
    expect(findIdempotencyInserts(store)).toHaveLength(1);
  });

  // ── Max Deployed Capital Guard ──

  it("skips trade when deploying it would exceed maxTradeCapital", async () => {
    const store = createStore(baseCfg, {
      openCount: 5,
      deployedCapital: 95000,
    });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const tradeSync = new TradeSyncStub(baseCfg, [activeApiResponse[0]]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    expect(dhan.placedOrders).toHaveLength(0);
    expect(findTradeInserts(store)).toHaveLength(0);
  });

  it("allows trade when deployed capital has sufficient room", async () => {
    const store = createStore(baseCfg, {
      openCount: 3,
      deployedCapital: 50000,
    });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const tradeSync = new TradeSyncStub(baseCfg, [activeApiResponse[0]]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    expect(dhan.placedOrders).toHaveLength(1);
    expect(findTradeInserts(store)).toHaveLength(1);
  });

  // ── Options Instrument Skipped ──

  it("skips non-cash (options) instruments", async () => {
    const store = createStore(baseCfg, { openCount: 0, deployedCapital: 0 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const tradeSync = new TradeSyncStub(baseCfg, [activeApiResponse[2]]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    expect(dhan.placedOrders).toHaveLength(0);
    expect(findTradeInserts(store)).toHaveLength(0);
  });

  // ── Idempotency Guard ──

  it("skips trade when BUY idempotency key already exists in PG", async () => {
    const store = createStore(baseCfg, {
      openCount: 0,
      deployedCapital: 0,
      existingIdempotencyKeys: ["buy:101"],
    });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const tradeSync = new TradeSyncStub(baseCfg, [activeApiResponse[0]]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    expect(dhan.placedOrders).toHaveLength(0);
  });

  // ── Happy Path: Multiple Trades ──

  it("places orders for all valid cash trades (skips options)", async () => {
    const store = createStore(baseCfg, { openCount: 0, deployedCapital: 0 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const tradeSync = new TradeSyncStub(baseCfg);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    // 3 cash trades placed, options skipped
    expect(dhan.placedOrders).toHaveLength(3);
    expect(findTradeInserts(store)).toHaveLength(3);
    expect(findIdempotencyInserts(store)).toHaveLength(3);
  });

  // ── Per-Trade Capital / Quantity ──

  it("derives correct quantity from perTradeCapital and entry price", async () => {
    const store = createStore(baseCfg, { openCount: 0, deployedCapital: 0 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const tradeSync = new TradeSyncStub(baseCfg, [activeApiResponse[0]]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    expect(dhan.placedOrders).toHaveLength(1);
    expect(dhan.placedOrders[0].quantity).toBe(Math.floor(10000 / 510));
  });

  // ── Trade Record Persisted Correctly ──

  it("persists trade record with target and sl_trigger in Postgres", async () => {
    const store = createStore(baseCfg, { openCount: 0, deployedCapital: 0 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const tradeSync = new TradeSyncStub(baseCfg, [activeApiResponse[0]]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    const inserts = findTradeInserts(store);
    expect(inserts).toHaveLength(1);

    const params = inserts[0].params;
    // params: [id, symbol, entryPrice, qty, securityId, symbol, orderId, target, slTrigger, capital]
    expect(params[0]).toBe(101); // id
    expect(params[1]).toBe("SBIN"); // tradingsymbol
    expect(params[2]).toBe(510); // entry_price
    expect(params[3]).toBe(Math.floor(10000 / 510)); // quantity
    expect(params[4]).toBe("3045"); // security_id
    expect(params[5]).toBe("SBIN"); // symbol
    expect(params[7]).toBe(600); // target
    expect(params[8]).toBe(480); // sl_trigger
    expect(params[9]).toBe(10000); // capital
  });

  // ── Dhan Forever Order Request Shape ──

  it("sends correct Forever Order request to Dhan", async () => {
    const store = createStore(baseCfg, { openCount: 0, deployedCapital: 0 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const tradeSync = new TradeSyncStub(baseCfg, [activeApiResponse[0]]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    const order = dhan.placedOrders[0];
    expect(order.dhanClientId).toBe("TEST_CLIENT");
    expect(order.orderFlag).toBe("SINGLE");
    expect(order.transactionType).toBe("BUY");
    expect(order.exchangeSegment).toBe("NSE_EQ");
    expect(order.productType).toBe("CNC");
    expect(order.orderType).toBe("LIMIT");
    expect(order.validity).toBe("DAY");
    expect(order.securityId).toBe("3045");
    expect(order.triggerPrice).toBe(510);
    expect(order.price).toBe(Number((510 * 1.005).toFixed(1)));
  });

  // ── Edge: Zero Entry Price ──

  it("skips trade with zero entry price", async () => {
    const store = createStore(baseCfg, { openCount: 0, deployedCapital: 0 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const zeroPrice = {
      ...activeApiResponse[0],
      id: 999,
      entry_price: 0,
      cmp: 0,
    };
    const tradeSync = new TradeSyncStub(baseCfg, [zeroPrice]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    expect(dhan.placedOrders).toHaveLength(0);
  });

  // ── Edge: Missing Symbol ──

  it("skips trade with missing sc_symbol", async () => {
    const store = createStore(baseCfg, { openCount: 0, deployedCapital: 0 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    const noSymbol = { ...activeApiResponse[0], id: 998, sc_symbol: "" };
    const tradeSync = new TradeSyncStub(baseCfg, [noSymbol]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    expect(dhan.placedOrders).toHaveLength(0);
  });

  // ── Custom Config: Lower maxActiveTrades ──

  it("respects custom maxActiveTrades = 2", async () => {
    const customCfg = { ...baseCfg, maxActiveTrades: 2 };
    const store = createStore(customCfg, { openCount: 2 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } = createServices(
      store,
      customCfg,
    );
    const tradeSync = new TradeSyncStub(customCfg, [activeApiResponse[0]]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    expect(dhan.placedOrders).toHaveLength(0);
  });

  // ── Custom Config: Lower maxTradeCapital ──

  it("respects custom maxTradeCapital = 20000", async () => {
    const customCfg = { ...baseCfg, maxTradeCapital: 20000 };
    const store = createStore(customCfg, {
      openCount: 1,
      deployedCapital: 15000,
    });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } = createServices(
      store,
      customCfg,
    );
    const tradeSync = new TradeSyncStub(customCfg, [activeApiResponse[0]]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    expect(dhan.placedOrders).toHaveLength(0);
  });
});
