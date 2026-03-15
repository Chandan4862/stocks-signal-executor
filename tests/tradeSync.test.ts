import { describe, it, expect, vi, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";

import { TradeSyncService } from "../src/services/tradeSyncService";
import { QuantityResolverService } from "../src/services/quantityResolverService";
import { TSLService } from "../src/services/tslService";
import { AuditLogService } from "../src/services/auditLogService";
import { StateStore } from "../src/services/stateStore";
import { DhanService, PlaceOrderResponse } from "../src/services/dhanService";
import { InstrumentLookupService } from "../src/services/instrumentLookupService";
import { RedisKeys } from "../src/state/redisKeys";

import activeApiResponse from "./fixtures/active-api-response.json";

// ─── Shared Config ──────────────────────────────────────────────────────────
const baseCfg = {
  kite: {},
  dhan: { clientId: "TEST_CLIENT" },
  apis: {
    activeTradesUrl: "http://test/active",
    closedTradesUrl: "http://test/closed",
  },
  redis: { url: "redis://localhost:6379" },
  postgres: { host: "", port: 5432, database: "", user: "", password: "" },
  telegram: { botToken: "tok", defaultChatId: "chat" },
  pollingIntervalMs: 1000,
  maxTradeCapital: 100000, // total portfolio cap
  perTradeCapital: 10000, // per-trade cap
  maxActiveTrades: 10,
  useSuperOrder: false,
  env: "development",
  tsl: { incrementRs: 2, initialSlPct: 3, trailingStepPct: 1 },
} as any;

// ─── DhanStub ───────────────────────────────────────────────────────────────
// Stubs placeForeverOrder with Dhan-style response.
// orderStatus follows Dhan API: "PENDING", "TRADED", "CANCELLED", "REJECTED"
class DhanStub extends DhanService {
  public placedOrders: any[] = [];

  async placeForeverOrder(req: any): Promise<PlaceOrderResponse> {
    this.placedOrders.push(req);
    return {
      orderId: `ORD_${req.correlationId || Date.now()}`,
      orderStatus: "PENDING", // Dhan returns PENDING for new Forever Orders
    };
  }
}

// ─── StoreStub ──────────────────────────────────────────────────────────────
// Configurable PG mock: accepts openCount and deployedCapital for guard queries.
// Shared Redis instance — flushed in beforeEach for test isolation
const sharedRedis = new (RedisMock as any)();

function createStore(
  cfg: any,
  opts: { openCount?: number; deployedCapital?: number } = {},
) {
  const { openCount = 0, deployedCapital = 0 } = opts;

  class StoreStub extends StateStore {
    constructor() {
      super(cfg);
      (this as any).redis = sharedRedis;
      (this as any).pg = {
        query: async (sql: string, _params: any[]) => {
          if (sql.includes("COUNT") && sql.includes("ANY")) {
            return { rows: [{ cnt: String(openCount) }] } as any;
          }
          if (sql.includes("SUM") && sql.includes("ANY")) {
            return { rows: [{ deployed: String(deployedCapital) }] } as any;
          }
          if (sql.includes("instrument_list_nse_eq")) {
            return { rows: [{ security_id: "3045" }] } as any;
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
// Overrides fetchActiveTrades to return fixture data instead of calling API.
class TradeSyncStub extends TradeSyncService {
  private fixtureOverride: any[];

  constructor(cfg: any, fixture: any[] = activeApiResponse) {
    super(cfg);
    this.fixtureOverride = fixture;
  }

  async fetchActiveTrades(): Promise<any[]> {
    // Re-use normalizeActive from super via mapping raw fixture data
    return this.fixtureOverride.map((this as any).normalizeActive);
  }
}

// ─── Helper ─────────────────────────────────────────────────────────────────
function createServices(store: StateStore, cfg: any = baseCfg) {
  const dhan = new DhanStub(cfg, {} as any, {} as any);
  const qtyResolver = new QuantityResolverService();
  const tsl = new TSLService(cfg.tsl);
  const audit = new AuditLogService((store as any).pg);
  const instrumentLookup = new InstrumentLookupService((store as any).pg);
  return { dhan, qtyResolver, tsl, audit, instrumentLookup };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runBuyAndInitialSl — cap enforcement", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await sharedRedis.flushall();
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

    // No trades should be placed
    expect(dhan.placedOrders).toHaveLength(0);
    // No idempotency keys set for any cash trade
    expect(await store.redis.get(RedisKeys.idempotencyBuy(101))).toBeNull();
    expect(await store.redis.get(RedisKeys.idempotencyBuy(102))).toBeNull();
    expect(await store.redis.get(RedisKeys.idempotencyBuy(104))).toBeNull();
  });

  it("skips trades when maxActiveTrades is exceeded (9 open + new = 10 max)", async () => {
    const store = createStore(baseCfg, { openCount: 9 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    // Only 1 cash trade in the fixture
    const tradeSync = new TradeSyncStub(baseCfg, [activeApiResponse[0]]);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    // 9 < 10 (maxActiveTrades), so 1 trade CAN be placed
    expect(dhan.placedOrders).toHaveLength(1);
    expect(await store.redis.get(RedisKeys.idempotencyBuy(101))).toBe("1");
  });

  // ── Max Deployed Capital Guard ──

  it("skips trade when deploying it would exceed maxTradeCapital", async () => {
    // Already deployed 95000, new trade at entry 510, qty = floor(10000/510) = 19
    // newCapital = 510 * 19 = 9690 → 95000 + 9690 = 104690 > 100000 → SKIP
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
    expect(await store.redis.get(RedisKeys.idempotencyBuy(101))).toBeNull();
  });

  it("allows trade when deployed capital has sufficient room", async () => {
    // Already deployed 50000, new trade at 510, qty=19, newCap=9690 → 59690 < 100000 → OK
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
    expect(await store.redis.get(RedisKeys.idempotencyBuy(101))).toBe("1");
  });

  // ── Options Instrument Skipped ──

  it("skips non-cash (options) instruments", async () => {
    const store = createStore(baseCfg, { openCount: 0, deployedCapital: 0 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    // Trade 103 is options
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
    expect(await store.redis.get(RedisKeys.idempotencyBuy(103))).toBeNull();
  });

  // ── Idempotency Guard ──

  it("skips trade when BUY idempotency key already exists", async () => {
    const store = createStore(baseCfg, { openCount: 0, deployedCapital: 0 });
    // Pre-set idempotency key for trade 101
    await store.redis.set(RedisKeys.idempotencyBuy(101), "1");

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
    // Full fixture: 101 (cash), 102 (cash), 103 (options), 104 (cash)
    const tradeSync = new TradeSyncStub(baseCfg);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    // 3 cash trades should be placed, options skipped
    expect(dhan.placedOrders).toHaveLength(3);
    expect(await store.redis.get(RedisKeys.idempotencyBuy(101))).toBe("1");
    expect(await store.redis.get(RedisKeys.idempotencyBuy(102))).toBe("1");
    expect(await store.redis.get(RedisKeys.idempotencyBuy(103))).toBeNull();
    expect(await store.redis.get(RedisKeys.idempotencyBuy(104))).toBe("1");
  });

  // ── Per-Trade Capital / Quantity ──

  it("derives correct quantity from perTradeCapital and entry price", async () => {
    const store = createStore(baseCfg, { openCount: 0, deployedCapital: 0 });
    const { dhan, qtyResolver, tsl, audit, instrumentLookup } =
      createServices(store);
    // Trade 101: entry_price = 510, perTradeCapital = 10000 → qty = floor(10000/510) = 19
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

  // ── Trade Snapshot Persisted Correctly ──

  it("persists trade snapshot with target and slTrigger in Redis", async () => {
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

    const snap = JSON.parse(
      (await store.redis.get(RedisKeys.trade(101))) || "{}",
    );

    expect(snap.state).toBe("AWAITING_ENTRY");
    expect(snap.securityId).toBe("3045");
    expect(snap.symbol).toBe("SBIN");
    expect(snap.entry_price).toBe(510);
    expect(snap.quantity).toBe(Math.floor(10000 / 510));
    expect(snap.target).toBe(600);
    expect(snap.slTrigger).toBe(480);
    expect(snap.buyOrderId).toBeDefined();
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
    // Execution limit price = trigger * 1.005 rounded to 1 decimal
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
    // Already deployed 15000, new trade = 510 * 19 = 9690 → 24690 > 20000 → SKIP
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
