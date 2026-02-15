import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradeSyncService } from "../src/services/tradeSyncService";
import { QuantityResolverService } from "../src/services/quantityResolverService";
import { TSLService } from "../src/services/tslService";
import { AuditLogService } from "../src/services/auditLogService";
import { StateStore } from "../src/services/stateStore";
import { DhanService } from "../src/services/dhanService";
import { InstrumentLookupService } from "../src/services/instrumentLookupService";
import { RedisKeys } from "../src/state/redisKeys";

// Use ioredis-mock for Redis
import RedisMock from "ioredis-mock";

const cfg = {
  kite: {},
  dhan: { clientId: "CLIENT" },
  apis: {
    activeTradesUrl: "http://test/active",
    closedTradesUrl: "http://test/closed",
  },
  redis: { url: "redis://localhost:6379" },
  postgres: { host: "", port: 5432, database: "", user: "", password: "" },
  telegram: { botToken: "x", defaultChatId: "y" },
  pollingIntervalMs: 1000,
  maxTradeCapital: 25000,
  maxActiveTrades: 10,
  useSuperOrder: true,
  tsl: { incrementRs: 2, initialSlPct: 3, trailingStepPct: 1 },
} as any;

// Mock axios to return a single ActiveTrade
import axios from "axios";
vi.mock("axios");

// Stub DhanService responses
class DhanStub extends DhanService {
  async placeSuperOrder(req: any) {
    return { orderId: req.correlationId || "oid", orderStatus: "success" };
  }
}

// Stub StateStore using ioredis-mock and a noop pg client
class StoreStub extends StateStore {
  constructor() {
    super(cfg);
    (this as any).redis = new (RedisMock as any)();
    // Mock pg client to avoid real DB and provide count=0
    (this as any).pg = {
      query: async (sql: string, params: any[]) => {
        if (sql.includes("COUNT")) {
          return { rows: [{ cnt: "0" }] } as any;
        }
        if (sql.includes("instrument_list_nse_eq")) {
          return { rows: [{ security_id: "3045" }] } as any;
        }
        return { rows: [] } as any;
      },
    };
  }
  async connect() {}
  async disconnect() {
    await (this as any).redis.quit?.();
  }
}

describe("TradeSync Super Order unit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("places Super Order and sets idempotency keys", async () => {
    // Mock Active trades response
    (axios.get as any).mockResolvedValueOnce({
      data: [
        {
          id: 1,
          sc_symbol: "SBIN",
          instrument: "12345",
          cmp: 600,
          entry_price: 600,
          meta_data: JSON.stringify({ entry_price: 600, stoploss_price: 582 }),
        },
      ],
    });

    const tradeSync = new TradeSyncService(cfg);
    const store = new StoreStub();
    const dhan = new DhanStub(cfg, {} as any);
    const qtyResolver = new QuantityResolverService();
    const tsl = new TSLService(cfg.tsl);
    const audit = new AuditLogService((store as any).pg);
    const instrumentLookup = new InstrumentLookupService((store as any).pg);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    const buyKey = await store.redis.get(RedisKeys.idempotencyBuy(1));
    expect(buyKey).toBe("1");

    const tradeSnap = JSON.parse(
      (await store.redis.get(RedisKeys.trade(1))) || "{}",
    );
    expect(tradeSnap.quantity).toBe(Math.floor(25000 / 600));
    expect(tradeSnap.state).toBe("OPEN");

    // No separate SL snapshot when using super order
    const tslSnap = await store.redis.get(RedisKeys.tsl(1));
    expect(tslSnap).toBeNull();
  });

  it("skips when BUY idempotency exists", async () => {
    (axios.get as any).mockResolvedValueOnce({
      data: [
        {
          id: 2,
          sc_symbol: "SBIN",
          instrument: "12345",
          cmp: 600,
          entry_price: 600,
        },
      ],
    });

    const tradeSync = new TradeSyncService(cfg);
    const store = new StoreStub();
    await store.redis.set(RedisKeys.idempotencyBuy(2), "1");

    const dhan = new DhanStub(cfg, {} as any);
    const qtyResolver = new QuantityResolverService();
    const tsl = new TSLService(cfg.tsl);
    const audit = new AuditLogService((store as any).pg);
    const instrumentLookup = new InstrumentLookupService((store as any).pg);

    await tradeSync.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
    );

    const tradeSnap = await store.redis.get(RedisKeys.trade(2));
    expect(tradeSnap).toBeNull();
  });
});
