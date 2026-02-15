import { describe, it, expect, vi, beforeEach } from "vitest";
import nock from "nock";
import RedisMock from "ioredis-mock";

import { TradeSyncService } from "../src/services/tradeSyncService";
import { QuantityResolverService } from "../src/services/quantityResolverService";
import { TSLService } from "../src/services/tslService";
import { AuditLogService } from "../src/services/auditLogService";
import { StateStore } from "../src/services/stateStore";
import { DhanService } from "../src/services/dhanService";
import { InstrumentLookupService } from "../src/services/instrumentLookupService";
import { RedisKeys } from "../src/state/redisKeys";
import { TokenService } from "../src/services/tokenService";

const cfg = {
  kite: {},
  dhan: { clientId: "CLIENT" },
  apis: {
    activeTradesUrl: "http://feed.local/active",
    closedTradesUrl: "http://feed.local/closed",
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

// Stub Store
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

// Stub TokenService to provide a fake access token
class TokenStub extends TokenService {
  async getToken(): Promise<string | null> {
    return "FAKE_TOKEN";
  }
}

describe("TradeSync integration: fetch + Super Order", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    nock.cleanAll();
  });

  it("flows through: fetch feed → place Super Order via Dhan", async () => {
    // Mock Active feed
    nock("http://feed.local")
      .get("/active")
      .reply(200, [
        {
          id: 11,
          sc_symbol: "SBIN",
          instrument: "SEC123",
          cmp: 500,
          entry_price: 500,
          stoploss_price: 485,
        },
      ]);

    // No real HTTP call; stub DhanService placeSuperOrder

    const store = new StoreStub();
    const tokens = new TokenStub(cfg, store);
    class DhanStub extends DhanService {
      async placeSuperOrder(req: any) {
        return { orderId: req.correlationId || "oid", orderStatus: "success" };
      }
    }
    const dhan = new DhanStub(cfg, tokens);
    const tradeSync = new TradeSyncService(cfg);
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

    // Verify Redis effects
    expect(await store.redis.get(RedisKeys.idempotencyBuy(11))).toBe("1");
    // No separate SL snapshot with super order
    expect(await store.redis.get(RedisKeys.tsl(11))).toBeNull();

    // Dhan stub returned successfully
  });
});
