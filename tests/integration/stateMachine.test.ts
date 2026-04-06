/**
 * Integration test: State Machine lifecycle with real Postgres.
 *
 * Only external APIs are mocked (analyst API + Dhan API).
 * All services (TradeEntryService, TradeMonitorService, TradeReconciliationService,
 * TradeHelpers) run against a real Postgres database.
 *
 * Prerequisites:
 *   docker compose up -d stock_postgres
 *   npx vitest run tests/integration/stateMachine.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { StateStore } from "../../src/services/stateStore";
import { AuditLogService } from "../../src/services/auditLogService";
import { TradeEntryService } from "../../src/services/tradeEntryService";
import { TradeMonitorService } from "../../src/services/tradeMonitorService";
import { TradeReconciliationService } from "../../src/services/tradeReconciliationService";
import { QuantityResolverService } from "../../src/services/quantityResolverService";
import { TSLService } from "../../src/services/tslService";
import { InstrumentLookupService } from "../../src/services/instrumentLookupService";
import { ConfigService } from "../../src/services/configService";
import {
  cfg,
  MockDhanService,
  createDefaultDhanState,
  createTestDb,
  dropTestDb,
  cleanTables,
  getTradeState,
} from "./helpers";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("State Machine Integration", () => {
  let store: StateStore;
  let audit: AuditLogService;
  let tradeEntry: TradeEntryService;
  let tradeMonitor: TradeMonitorService;
  let tradeReconciliation: TradeReconciliationService;
  let qtyResolver: QuantityResolverService;
  let tsl: TSLService;
  let instrumentLookup: InstrumentLookupService;
  let configSvc: ConfigService;

  beforeAll(async () => {
    await createTestDb();

    store = new StateStore(cfg);
    await store.connect();
    audit = new AuditLogService(store.pg);
    tradeEntry = new TradeEntryService(cfg);
    tradeMonitor = new TradeMonitorService(cfg);
    tradeReconciliation = new TradeReconciliationService(cfg);
    qtyResolver = new QuantityResolverService();
    configSvc = new ConfigService(store.pg);
    await configSvc.load();
    tsl = new TSLService(configSvc.tsl);
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
  // Scenario 1: Happy path — full lifecycle
  // RunBuy → AWAITING_ENTRY → monitor → ENTERED → monitor → CLOSED
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 1: Full lifecycle — buy → enter → sell at target", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    // ── Phase 2: RunBuy ──
    const activeTrades = [
      {
        id: 5001,
        sc_symbol: "HDFCBANK",
        entry_price: 1500,
        target_price_1: 1650,
        stoploss_price: 1400,
        instrument_type: "cash",
        asset_class: "equity",
        reco_type: "buy",
        cmp: 1490,
      },
    ];

    // Simulate instrument lookup returning a valid securityId
    await store.pg.query(
      `INSERT INTO instrument_list_nse_eq (security_id, underlying_symbol, instrument_type, series, exch_id)
       VALUES ('1333', 'HDFCBANK', 'ES', 'EQ', 'NSE')`,
    );

    await tradeEntry.runBuyAndInitialSl(
      store,
      dhan,
      qtyResolver,
      tsl,
      audit,
      instrumentLookup,
      activeTrades as any,
      configSvc,
    );

    let trade = await getTradeState(store, 5001);
    expect(trade).not.toBeNull();
    expect(trade.state).toBe("AWAITING_ENTRY");
    expect(trade.buy_order_id).toBe("FO_123");
    expect(trade.sell_order_id).toBeNull();

    // ── Phase 3: monitorPendingEntries → entry triggers ──
    dhanState.foreverOrders = [{ orderId: "FO_123", orderStatus: "TRIGGERED" }];
    dhanState.regularOrders = [
      {
        algoId: "FO_123",
        orderStatus: "TRADED",
        averageTradedPrice: 1505,
        filledQty: 6,
      },
    ];

    await tradeMonitor.monitorPendingEntries(store, dhan, audit);

    trade = await getTradeState(store, 5001);
    expect(trade.state).toBe("ENTERED");
    expect(Number(trade.entry_price)).toBe(1505);
    expect(trade.quantity).toBe(6);
    expect(trade.entered_at).not.toBeNull();

    // ── Phase 5: monitorEnteredTrades → target hit ──
    // Need to backdate entered_at so same-day skip doesn't trigger
    await store.pg.query(
      `UPDATE trades SET entered_at = NOW() - INTERVAL '2 days' WHERE id = 5001`,
    );

    dhanState.holdings = [
      {
        tradingSymbol: "HDFCBANK",
        securityId: "1333",
        totalQty: 6,
        lastTradedPrice: 1660,
      },
    ];

    await tradeMonitor.monitorEnteredTrades(store, dhan, audit);

    trade = await getTradeState(store, 5001);
    expect(trade.state).toBe("CLOSED");
    expect(Number(trade.exit_price)).toBe(1660);
    expect(trade.sell_order_id).toBe("SELL_456");
    expect(trade.exited_at).not.toBeNull();

    // Verify PnL recorded
    const pnl = await store.pg.query(
      "SELECT * FROM pnl_records WHERE trade_id = 5001",
    );
    expect(pnl.rows).toHaveLength(1);
    expect(Number(pnl.rows[0].realized_pnl)).toBe((1660 - 1505) * 6);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 2: Sell fails → sell_order_id cleared → retry succeeds
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 2: Sell fails then retries on next tick", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    // Seed an ENTERED trade directly
    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, target, sl_trigger, entered_at)
       VALUES (5002, 'INFY', 'INFY', 'NSE', 'buy', 1800, 5, 'ENTERED', '2222', 2000, 1700, NOW() - INTERVAL '2 days')`,
    );

    // Holdings show SL hit
    dhanState.holdings = [
      {
        tradingSymbol: "INFY",
        securityId: "2222",
        totalQty: 5,
        lastTradedPrice: 1690,
      },
    ];

    // First attempt: API fails
    dhanState.placeOrderResult = () => new Error("Dhan API timeout");

    await tradeMonitor.monitorEnteredTrades(store, dhan, audit);

    let trade = await getTradeState(store, 5002);
    expect(trade.state).toBe("ENTERED"); // stays ENTERED
    expect(trade.sell_order_id).toBeNull(); // cleared after failure

    // Second attempt: API succeeds
    dhanState.placeOrderResult = () => ({
      orderId: "SELL_RETRY",
      orderStatus: "TRADED",
    });

    await tradeMonitor.monitorEnteredTrades(store, dhan, audit);

    trade = await getTradeState(store, 5002);
    expect(trade.state).toBe("CLOSED");
    expect(trade.sell_order_id).toBe("SELL_RETRY");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 3: Atomic sell guard — concurrent sell attempts
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 3: Atomic sell guard prevents duplicate sells", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, target, sl_trigger, entered_at)
       VALUES (5003, 'TCS', 'TCS', 'NSE', 'buy', 3500, 3, 'ENTERED', '3333', 3800, 3300, NOW() - INTERVAL '2 days')`,
    );

    dhanState.holdings = [
      {
        tradingSymbol: "TCS",
        securityId: "3333",
        totalQty: 3,
        lastTradedPrice: 3810,
      },
    ];

    // Run monitor twice concurrently
    await Promise.all([
      tradeMonitor.monitorEnteredTrades(store, dhan, audit),
      tradeMonitor.monitorEnteredTrades(store, dhan, audit),
    ]);

    // Only ONE sell order should have been placed
    const sellCalls = dhan.calls.filter((c) => c.method === "placeOrder");
    expect(sellCalls).toHaveLength(1);

    const trade = await getTradeState(store, 5003);
    expect(trade.state).toBe("CLOSED");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 4: markEntered state guard — can't overwrite CLOSED
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 4: markEntered does not overwrite CLOSED state", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    // Trade is already CLOSED
    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, buy_order_id)
       VALUES (5004, 'RELIANCE', 'RELIANCE', 'NSE', 'buy', 2500, 4, 'CLOSED', '4444', 'FO_CLOSED')`,
    );

    // Dhan shows the forever order as triggered + child traded
    dhanState.foreverOrders = [
      { orderId: "FO_CLOSED", orderStatus: "TRIGGERED" },
    ];
    dhanState.regularOrders = [
      {
        algoId: "FO_CLOSED",
        orderStatus: "TRADED",
        averageTradedPrice: 2510,
        filledQty: 4,
      },
    ];

    await tradeMonitor.monitorPendingEntries(store, dhan, audit);

    // Should NOT have overwritten CLOSED → ENTERED
    const trade = await getTradeState(store, 5004);
    expect(trade.state).toBe("CLOSED");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 5: UPSERT guard — RunBuy doesn't reset ENTERED to AWAITING
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 5: RunBuy does not reset ENTERED trade to AWAITING_ENTRY", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    // Trade already ENTERED
    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, buy_order_id, entered_at)
       VALUES (5005, 'WIPRO', 'WIPRO', 'NSE', 'buy', 450, 20, 'ENTERED', '5555', 'FO_OLD', NOW() - INTERVAL '1 day')`,
    );
    // Mark as processed in idempotency
    await store.pg.query(
      `INSERT INTO idempotency (action_key) VALUES ('buy:5005')`,
    );

    await store.pg.query(
      `INSERT INTO instrument_list_nse_eq (security_id, underlying_symbol, instrument_type, series, exch_id)
       VALUES ('5555', 'WIPRO', 'ES', 'EQ', 'NSE')`,
    );

    // Analyst still has this trade as active
    const activeTrades = [
      {
        id: 5005,
        sc_symbol: "WIPRO",
        entry_price: 450,
        target: 500,
        sl: 420,
        instrument_type: "cash",
        reco_action: "buy",
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
      configSvc,
    );

    const trade = await getTradeState(store, 5005);
    expect(trade.state).toBe("ENTERED"); // NOT reset to AWAITING_ENTRY
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 6: processClosedTrades — analyst closes AWAITING_ENTRY
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 6: Analyst closes trade before entry — cancel buy, mark CLOSED", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, buy_order_id, reco_id)
       VALUES (5006, 'SBIN', 'SBIN', 'NSE', 'buy', 800, 12, 'AWAITING_ENTRY', '6666', 'FO_SBIN', 5006)`,
    );

    const closedTrades = [
      { id: 5006, sc_symbol: "SBIN", exit_price: 810, cmp: 810 },
    ];

    await tradeReconciliation.processClosedTrades(
      store,
      dhan,
      audit,
      closedTrades as any,
    );

    const trade = await getTradeState(store, 5006);
    expect(trade.state).toBe("CLOSED");
    expect(
      dhan.calls.filter((c) => c.method === "cancelForeverOrder"),
    ).toHaveLength(1);
    expect(dhan.calls.filter((c) => c.method === "placeOrder")).toHaveLength(0); // no sell
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 7: processClosedTrades — analyst closes ENTERED trade
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 7: Analyst closes ENTERED trade — sell and mark CLOSED_BY_ANALYST", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, reco_id, entered_at)
       VALUES (5007, 'AXISBANK', 'AXISBANK', 'NSE', 'buy', 1050, 9, 'ENTERED', '7777', 5007, NOW() - INTERVAL '3 days')`,
    );

    const closedTrades = [
      { id: 5007, sc_symbol: "AXISBANK", exit_price: 1100, cmp: 1100 },
    ];

    await tradeReconciliation.processClosedTrades(
      store,
      dhan,
      audit,
      closedTrades as any,
    );

    const trade = await getTradeState(store, 5007);
    expect(trade.state).toBe("CLOSED_BY_ANALYST");
    expect(trade.sell_order_id).toBe("SELL_456");
    expect(Number(trade.exit_price)).toBe(1100);

    const pnl = await store.pg.query(
      "SELECT * FROM pnl_records WHERE trade_id = 5007",
    );
    expect(pnl.rows).toHaveLength(1);
    expect(Number(pnl.rows[0].realized_pnl)).toBe((1100 - 1050) * 9);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 8: Reconciliation Path A — AWAITING_ENTRY + holding exists
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 8: Reconciliation Path A — holding found for AWAITING_ENTRY trade", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, buy_order_id)
       VALUES (5008, 'ITC', 'ITC', 'NSE', 'buy', 440, 22, 'AWAITING_ENTRY', '8888', 'FO_ITC')`,
    );

    dhanState.holdings = [
      {
        securityId: "8888",
        tradingSymbol: "ITC",
        totalQty: 22,
        avgCostPrice: 442,
        lastTradedPrice: 450,
      },
    ];

    await tradeReconciliation.reconcilePositions(store, dhan, audit);

    const trade = await getTradeState(store, 5008);
    expect(trade.state).toBe("ENTERED");
    expect(Number(trade.entry_price)).toBe(442);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 9: Reconciliation Path B — ENTERED + no holding
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 9: Reconciliation Path B — no holding for ENTERED trade", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, entered_at)
       VALUES (5009, 'TATASTEEL', 'TATASTEEL', 'NSE', 'buy', 155, 60, 'ENTERED', '9999', NOW() - INTERVAL '2 days')`,
    );

    dhanState.holdings = []; // no holdings

    await tradeReconciliation.reconcilePositions(store, dhan, audit);

    const trade = await getTradeState(store, 5009);
    expect(trade.state).toBe("CLOSED");
    expect(trade.exited_at).not.toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 10: Reconciliation Path D — stale sell_order_id cleared
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 10: Path D clears stale sell_order_id for retry", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, sell_order_id, entered_at)
       VALUES (5010, 'BHARTIARTL', 'BHARTIARTL', 'NSE', 'buy', 1600, 6, 'ENTERED', '1010', 'STALE_SELL', NOW() - INTERVAL '2 days')`,
    );

    dhanState.holdings = [
      {
        securityId: "1010",
        tradingSymbol: "BHARTIARTL",
        totalQty: 6,
        lastTradedPrice: 1620,
      },
    ];

    await tradeReconciliation.reconcilePositions(store, dhan, audit);

    let trade = await getTradeState(store, 5010);
    expect(trade.state).toBe("ENTERED"); // state unchanged
    expect(trade.sell_order_id).toBeNull(); // cleared for retry

    // Now next monitor tick should be able to retry the sell
    dhanState.holdings[0].lastTradedPrice = 1400; // SL hit
    await store.pg.query(`UPDATE trades SET sl_trigger = 1500 WHERE id = 5010`);

    await tradeMonitor.monitorEnteredTrades(store, dhan, audit);

    trade = await getTradeState(store, 5010);
    expect(trade.state).toBe("CLOSED");
    expect(trade.sell_order_id).toBe("SELL_456");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 11: S5 recovery — server was down when entry triggered
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 11: S5 startup recovery — child order found after forever order gone", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, buy_order_id)
       VALUES (5011, 'LT', 'LT', 'NSE', 'buy', 3400, 3, 'AWAITING_ENTRY', '1111', 'FO_LT')`,
    );

    // Forever order gone (not in list), but child order exists as TRADED
    dhanState.foreverOrders = []; // gone
    dhanState.regularOrders = [
      {
        algoId: "FO_LT",
        orderStatus: "TRADED",
        averageTradedPrice: 3410,
        filledQty: 3,
      },
    ];

    await tradeMonitor.monitorPendingEntries(store, dhan, audit);

    const trade = await getTradeState(store, 5011);
    expect(trade.state).toBe("ENTERED");
    expect(Number(trade.entry_price)).toBe(3410);
    expect(trade.quantity).toBe(3);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 12: Cancel on forever order rejection
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 12: Forever order CANCELLED → trade CANCELLED", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, buy_order_id)
       VALUES (5012, 'MARUTI', 'MARUTI', 'NSE', 'buy', 12000, 1, 'AWAITING_ENTRY', '1212', 'FO_MARUTI')`,
    );

    dhanState.foreverOrders = [
      { orderId: "FO_MARUTI", orderStatus: "CANCELLED" },
    ];

    await tradeMonitor.monitorPendingEntries(store, dhan, audit);

    const trade = await getTradeState(store, 5012);
    expect(trade.state).toBe("CANCELLED");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 13: Forever order EMPTY → Recovered in Reconciliation
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 13: Forever order EMPTY → Recovered in Reconcillation → trade CANCELLED", async () => {
    const dhanState = createDefaultDhanState();
    const dhan = new MockDhanService(dhanState);

    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, buy_order_id)
       VALUES (5012, 'MARUTI', 'MARUTI', 'NSE', 'buy', 12000, 1, 'AWAITING_ENTRY', '1212', 'FO_MARUTI')`,
    );

    dhanState.foreverOrders = [];

    await tradeMonitor.monitorPendingEntries(store, dhan, audit);
    await tradeReconciliation.reconcilePositions(store, dhan, audit);

    const trade = await getTradeState(store, 5012);
    expect(trade.state).toBe("CANCELLED");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 14: Cancel buy fails on analyst close — trade still CLOSED
  // ═══════════════════════════════════════════════════════════════════════

  it("Scenario 14: cancelForeverOrder fails but trade still marks CLOSED", async () => {
    const dhanState = createDefaultDhanState();
    dhanState.cancelForeverOrderResult = () => new Error("API down");
    const dhan = new MockDhanService(dhanState);

    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, symbol, exchange, reco_type, entry_price, quantity, state, security_id, buy_order_id, reco_id)
       VALUES (5013, 'BAJAJ', 'BAJAJ', 'NSE', 'buy', 7500, 1, 'AWAITING_ENTRY', '1313', 'FO_BAJAJ', 5013)`,
    );

    const closedTrades = [{ id: 5013, sc_symbol: "BAJAJ", exit_price: 7600 }];

    await tradeReconciliation.processClosedTrades(
      store,
      dhan,
      audit,
      closedTrades as any,
    );

    const trade = await getTradeState(store, 5013);
    expect(trade.state).toBe("CLOSED"); // still CLOSED despite cancel failure
  });
});
