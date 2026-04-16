/*
  Trade Signal API Mock Routes.
  Simulates the external Active/Closed Trades signal APIs.

  Endpoints:
  - GET /api/active-trades  — returns active trade signals
  - GET /api/closed-trades  — returns closed trade signals
  - POST /admin/signals     — admin: set custom signals for testing
*/

import { Router } from "express";

const router = Router();

// ─── Default Signal Data ──────────────────────────────────────────────

const DEFAULT_ACTIVE_TRADES = [
  {
    id: 1001,
    reco_id: 1001,
    asset_class: "equity",
    instrument_type: "cash",
    instrument: "STK",
    reco_type: "buy",
    reco_category: "swing",
    sc_id: "11536",
    sc_symbol: "RELIANCE",
    sc_name: "Reliance Industries Ltd",
    cmp: 2450.5,
    entry_condition: "greater_than",
    entry_price: 2460,
    entry_price_2: null,
    target_condition: "greater_than",
    target_price_1: 2650,
    target_price_2: null,
    stoploss_condition: "less_than",
    stoploss_price: 2380,
    unrealized_pl: 0,
    unrealized_pl_p: 0,
    target_return: 7.72,
    call_status: "active",
    rationale: "Strong breakout above resistance with volume confirmation",
    strategy_name: "Momentum Breakout",
    analyst_name: "Mock Analyst",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 1002,
    reco_id: 1002,
    asset_class: "equity",
    instrument_type: "cash",
    instrument: "STK",
    reco_type: "buy",
    reco_category: "swing",
    sc_id: "2885",
    sc_symbol: "INFY",
    sc_name: "Infosys Limited",
    cmp: 1480.0,
    entry_condition: "between",
    entry_price: 1470,
    entry_price_2: 1500,
    target_condition: "greater_than",
    target_price_1: 1620,
    target_price_2: null,
    stoploss_condition: "less_than",
    stoploss_price: 1420,
    unrealized_pl: 0,
    unrealized_pl_p: 0,
    target_return: 8.16,
    call_status: "active",
    rationale: "Mean reversion setup near support zone",
    strategy_name: "Support Bounce",
    analyst_name: "Mock Analyst",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 1003,
    reco_id: 1003,
    asset_class: "equity",
    instrument_type: "cash",
    instrument: "STK",
    reco_type: "buy",
    reco_category: "positional",
    sc_id: "11630",
    sc_symbol: "TCS",
    sc_name: "Tata Consultancy Services Ltd",
    cmp: 3720.0,
    entry_condition: "greater_than",
    entry_price: 3750,
    target_condition: "greater_than",
    target_price_1: 4100,
    target_price_2: null,
    stoploss_condition: "less_than",
    stoploss_price: 3580,
    unrealized_pl: 0,
    unrealized_pl_p: 0,
    target_return: 9.33,
    call_status: "active",
    rationale: "Sector rotation into IT — channel breakout",
    strategy_name: "Channel Breakout",
    analyst_name: "Mock Analyst",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const DEFAULT_CLOSED_TRADES = [
  {
    id: 2001,
    reco_id: 2001,
    asset_class: "equity",
    instrument_type: "cash",
    instrument: "STK",
    reco_type: "buy",
    sc_id: "14366",
    sc_symbol: "HDFCBANK",
    sc_name: "HDFC Bank Limited",
    cmp: 1680.0,
    entry_price: 1620,
    stoploss_price: 1560,
    target_price_1: 1750,
    call_status: "closed",
    closed_on_dt: new Date(Date.now() - 86400000).toISOString(),
    rationale: "Target hit — booking profits",
    analyst_name: "Mock Analyst",
    created_at: new Date(Date.now() - 604800000).toISOString(),
    updated_at: new Date(Date.now() - 86400000).toISOString(),
    meta: {
      exit_price: 1750,
      exit_price_condition: "target_hit",
      isclosed: true,
      status: "closed",
      realized_pl_p: 8.02,
    },
  },
];

// Mutable state — can be replaced via admin API
let activeTrades = [...DEFAULT_ACTIVE_TRADES];
let closedTrades = [...DEFAULT_CLOSED_TRADES];

// ─── Signal Endpoints ─────────────────────────────────────────────────

router.get("/api/active-trades", (_req, res) => {
  // The real API wraps in { list: { data: [...] } } or returns array directly
  // Our TradeSyncService handles both formats
  console.log(`  📡 Active trades queried → ${activeTrades.length} signals`);
  res.json({ list: { data: activeTrades } });
});

router.get("/api/closed-trades", (_req, res) => {
  console.log(`  📡 Closed trades queried → ${closedTrades.length} signals`);
  res.json({ list: { data: closedTrades } });
});

// ─── Admin: Manage Signals ────────────────────────────────────────────

/** POST /admin/signals — Replace active/closed signals */
router.post("/admin/signals", (req, res) => {
  const { active, closed } = req.body;
  if (active) activeTrades = active;
  if (closed) closedTrades = closed;
  console.log(`  📝 Signals updated: ${activeTrades.length} active, ${closedTrades.length} closed`);
  res.json({ active: activeTrades.length, closed: closedTrades.length });
});

/** POST /admin/signals/add-active — Add a single active trade signal */
router.post("/admin/signals/add-active", (req, res) => {
  const signal = { id: Date.now(), ...req.body };
  activeTrades.push(signal);
  console.log(`  📝 Added active signal: ${signal.sc_symbol}`);
  res.json(signal);
});

/** POST /admin/signals/close/:id — Move an active trade to closed */
router.post("/admin/signals/close/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const idx = activeTrades.findIndex((t) => t.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: "Active trade not found" });
  }
  const [trade] = activeTrades.splice(idx, 1);
  closedTrades.push({
    ...trade,
    call_status: "closed",
    closed_on_dt: new Date().toISOString(),
    meta: {
      exit_price: (trade.cmp ?? trade.entry_price) * 1.05,
      exit_price_condition: "target_hit",
      isclosed: true,
      status: "closed",
      realized_pl_p: 5.0,
    },
  } as any);
  console.log(`  📝 Signal closed: ${trade.sc_symbol} (id: ${id})`);
  res.json({ closed: true, id, symbol: trade.sc_symbol });
});

/** POST /admin/signals/reset — Reset to defaults */
router.post("/admin/signals/reset", (_req, res) => {
  activeTrades = [...DEFAULT_ACTIVE_TRADES];
  closedTrades = [...DEFAULT_CLOSED_TRADES];
  console.log("  🔄 Signals reset to defaults");
  res.json({ reset: true });
});

/** GET /admin/signals — View current signals */
router.get("/admin/signals", (_req, res) => {
  res.json({ active: activeTrades, closed: closedTrades });
});

export default router;
