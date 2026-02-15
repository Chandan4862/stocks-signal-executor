import { describe, it, expect, vi } from "vitest";
import axios from "axios";
import RedisMock from "ioredis-mock";

import { TradeSyncService } from "../src/services/tradeSyncService";
import { QuantityResolverService } from "../src/services/quantityResolverService";
import { TSLService } from "../src/services/tslService";
import { AuditLogService } from "../src/services/auditLogService";
import { StateStore } from "../src/services/stateStore";
import { DhanService } from "../src/services/dhanService";
import { InstrumentLookupService } from "../src/services/instrumentLookupService";
import { RedisKeys } from "../src/state/redisKeys";

vi.mock("axios");

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
  maxTradeCapital: 10000,
  maxActiveTrades: 10,
  tsl: { incrementRs: 2, initialSlPct: 3, trailingStepPct: 1 },
} as any;

class DhanStub extends DhanService {
  async placeSuperOrder(req: any): Promise<any> {
    throw new Error("Should not place order when cap reached");
  }
}

class StoreStub extends StateStore {
  constructor() {
    super(cfg);
    (this as any).redis = new (RedisMock as any)();
  }
  async connect() {}
  async disconnect() {
    await (this as any).redis.quit?.();
  }
}

describe("Portfolio cap enforcement", () => {
  it("skips BUY when 10 OPEN trades already exist", async () => {
    // Mock Postgres to report 10 ENTERED trades (open positions)
    const store = new StoreStub();
    (store as any).pg = {
      query: async (sql: string, params: any[]) => {
        if (sql.includes("COUNT")) {
          return { rows: [{ cnt: "10" }] } as any;
        }
        if (sql.includes("instrument_list_nse_eq")) {
          return { rows: [{ security_id: "3045" }] } as any;
        }
        return { rows: [] } as any;
      },
    };

    // Mock a new Active
    (axios.get as any).mockResolvedValueOnce({
      data: [
        {
          id: 99,
          sc_symbol: "SBIN",
          instrument: "SEC",
          cmp: 500,
          entry_price: 500,
          stoploss_price: 485,
        },
      ],
    });

    const tradeSync = new TradeSyncService(cfg);
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

    // Verify no BUY idempotency key was set
    expect(await store.redis.get(RedisKeys.idempotencyBuy(99))).toBeNull();
    // Verify no new trade snapshot
    expect(await store.redis.get(RedisKeys.trade(99))).toBeNull();
  });
});
