/**
 * Integration test: Capital guard validations with real Postgres.
 *
 * Tests PER_TRADE_CAPITAL and MAX_TRADE_CAPITAL guards in TradeEntryService.
 *
 * Prerequisites:
 *   docker compose up -d stock_postgres
 *   npx vitest run tests/integration/capitalGuards.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { StateStore } from "../../src/services/stateStore";
import { AuditLogService } from "../../src/services/auditLogService";
import { TradeEntryService } from "../../src/services/tradeEntryService";
import { QuantityResolverService } from "../../src/services/quantityResolverService";
import { TSLService } from "../../src/services/tslService";
import { InstrumentLookupService } from "../../src/services/instrumentLookupService";
import {
  cfg,
  MockDhanService,
  createDefaultDhanState,
  createTestDb,
  dropTestDb,
  cleanTables,
  getTradeState,
} from "./helpers";

describe("Capital Guards Integration", () => {
  let store: StateStore;
  let audit: AuditLogService;
  let tradeEntry: TradeEntryService;
  let qtyResolver: QuantityResolverService;
  let tsl: TSLService;
  let instrumentLookup: InstrumentLookupService;

  beforeAll(async () => {
    await createTestDb();

    store = new StateStore(cfg);
    await store.connect();
    audit = new AuditLogService(store.pg);
    tradeEntry = new TradeEntryService(cfg);
    qtyResolver = new QuantityResolverService();
    tsl = new TSLService({
      incrementRs: cfg.tsl.incrementRs,
      initialSlPct: cfg.tsl.initialSlPct,
      trailingStepPct: cfg.tsl.trailingStepPct,
    });
    instrumentLookup = new InstrumentLookupService(store.pg);
  }, 30000);

  afterAll(async () => {
    await store.disconnect();
    await dropTestDb();
  });

  beforeEach(async () => {
    await cleanTables(store);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PER_TRADE_CAPITAL — price too high → qty derives to 0
  // cfg.perTradeCapital = 10000, entry_price = 15000 → qty = floor(10000/15000) = 0 → skip
  // ═══════════════════════════════════════════════════════════════════════

  it("PER_TRADE_CAPITAL — trade skipped when price exceeds per-trade capital", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    // Seed instrument lookup
    await store.pg.query(
      `INSERT INTO instrument_list_nse_eq (security_id, underlying_symbol, instrument_type, series, exch_id)
       VALUES ('9015', 'EXPENSIVE', 'ES', 'EQ', 'NSE')`,
    );

    // entry_price = 15000, perTradeCapital = 10000 → qty = floor(10000/15000) = 0
    const activeTrades = [
      {
        id: 9015,
        sc_symbol: "EXPENSIVE",
        entry_price: 15000,
        target_price_1: 16000,
        stoploss_price: 14000,
        instrument_type: "cash",
        asset_class: "equity",
        reco_type: "buy",
        cmp: 15000,
      },
    ];

    await tradeEntry.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
      activeTrades as any,
    );

    // Trade should NOT be inserted (qty = 0 → skipped)
    const trade = await getTradeState(store, 9015);
    expect(trade).toBeNull();

    // No order should have been placed
    const orderCalls = dhan.calls.filter(
      (c) => c.method === "placeForeverOrder",
    );
    expect(orderCalls).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // MAX_TRADE_CAPITAL — total deployed capital exceeded
  // cfg.maxTradeCapital = 100000, existing deployed = 95000, new = 10000 → exceeds → skip
  // ═══════════════════════════════════════════════════════════════════════

  it("MAX_TRADE_CAPITAL — trade skipped when total deployed capital would be exceeded", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    // Seed instrument lookup
    await store.pg.query(
      `INSERT INTO instrument_list_nse_eq (security_id, underlying_symbol, instrument_type, series, exch_id)
       VALUES ('9016', 'NEWSTOCK', 'ES', 'EQ', 'NSE')`,
    );

    // Seed existing trades that already consume 95000 of the 100000 max capital
    // Trade A: entry_price=1000, qty=50 → deployed = 50000
    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, buy_order_id)
       VALUES (9100, 'STOCKA', 'STOCKA', 'NSE', 'buy', 1000, 50, 'ENTERED', 'A111', 'FO_A')`,
    );
    // Trade B: entry_price=900, qty=50 → deployed = 45000
    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, buy_order_id)
       VALUES (9101, 'STOCKB', 'STOCKB', 'NSE', 'buy', 900, 50, 'AWAITING_ENTRY', 'B222', 'FO_B')`,
    );
    // Total deployed: 50000 + 45000 = 95000

    // New trade: entry_price=1000, perTradeCapital=10000 → qty = 10 → capital = 10000
    // 95000 + 10000 = 105000 > maxTradeCapital (100000) → SKIP
    const activeTrades = [
      {
        id: 9016,
        sc_symbol: "NEWSTOCK",
        entry_price: 1000,
        target_price_1: 1200,
        stoploss_price: 900,
        instrument_type: "cash",
        asset_class: "equity",
        reco_type: "buy",
        cmp: 1000,
      },
    ];

    await tradeEntry.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
      activeTrades as any,
    );

    // Trade should NOT be inserted (max capital exceeded)
    const trade = await getTradeState(store, 9016);
    expect(trade).toBeNull();

    // No order should have been placed
    const orderCalls = dhan.calls.filter(
      (c) => c.method === "placeForeverOrder",
    );
    expect(orderCalls).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // MAX_ACTIVE_TRADES — trade count limit reached
  // cfg.maxActiveTrades = 10, existing = 10 → skip
  // ═══════════════════════════════════════════════════════════════════════

  it("MAX_ACTIVE_TRADES — trade skipped when max active trade count reached", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    // Seed instrument lookup
    await store.pg.query(
      `INSERT INTO instrument_list_nse_eq (security_id, underlying_symbol, instrument_type, series, exch_id)
       VALUES ('9017', 'NEWSTOCK2', 'ES', 'EQ', 'NSE')`,
    );

    // Seed 10 existing active trades (maxActiveTrades = 10)
    for (let i = 0; i < 10; i++) {
      await store.pg.query(
        `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, buy_order_id)
         VALUES ($1, $2, $2, 'NSE', 'buy', 100, 1, 'ENTERED', $3, $4)`,
        [8000 + i, `STOCK${i}`, `SEC${i}`, `FO_${i}`],
      );
    }

    const activeTrades = [
      {
        id: 9017,
        sc_symbol: "NEWSTOCK2",
        entry_price: 500,
        target_price_1: 600,
        stoploss_price: 450,
        instrument_type: "cash",
        asset_class: "equity",
        reco_type: "buy",
        cmp: 500,
      },
    ];

    await tradeEntry.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
      activeTrades as any,
    );

    // Trade should NOT be inserted (max active trades reached)
    const trade = await getTradeState(store, 9017);
    expect(trade).toBeNull();

    const orderCalls = dhan.calls.filter(
      (c) => c.method === "placeForeverOrder",
    );
    expect(orderCalls).toHaveLength(0);
  });
});
