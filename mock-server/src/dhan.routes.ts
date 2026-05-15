/*
  Dhan API Mock Routes.
  Simulates all Dhan v2 endpoints used by the trading bot.

  Endpoints:
  - POST   /v2/orders              — place order
  - PUT    /v2/orders/:orderId     — modify order
  - DELETE /v2/orders/:orderId     — cancel order
  - GET    /v2/orders              — list all orders
  - GET    /v2/orders/:orderId     — get single order
  - POST   /v2/forever/orders      — place forever (GTT) order
  - PUT    /v2/forever/orders/:id  — modify forever order
  - DELETE /v2/forever/orders/:id  — cancel forever order
  - GET    /v2/forever/orders      — list forever orders
  - GET    /v2/positions           — list positions
  - GET    /v2/holdings            — list holdings
  - GET    /v2/profile             — user profile (token validation)
  - GET    /v2/RenewToken          — renew access token
  - POST   /app/generateAccessToken — TOTP-based token generation
*/

import { Router } from "express";
import { store } from "./state";

// securityId → tradingSymbol mapping (matches instrument_list_nse_eq in test DB)
const SYMBOL_MAP: Record<string, string> = {
  "2885": "RELIANCE",
  "1594": "INFY",
  "11536": "TCS",
  "1333": "HDFCBANK",
};

function resolveSymbol(securityId: string, fallback?: string): string {
  return SYMBOL_MAP[securityId] || fallback || `SYM_${securityId}`;
}

const router = Router();

// ─── Regular Orders ───────────────────────────────────────────────────

router.post("/v2/orders", (req, res) => {
  const body = req.body;
  const correlationId = body.correlationId || "";

  // Idempotency guard
  if (correlationId && store.idempotencyKeys.has(correlationId)) {
    // Return the existing order
    for (const order of store.orders.values()) {
      if (order.correlationId === correlationId) {
        return res.json({ orderId: order.orderId, orderStatus: order.orderStatus });
      }
    }
  }

  const orderId = store.generateOrderId();
  if (correlationId) store.idempotencyKeys.add(correlationId);

  const order = {
    orderId,
    correlationId,
    orderStatus: "TRADED" as const,
    transactionType: body.transactionType || "BUY",
    exchangeSegment: body.exchangeSegment || "NSE_EQ",
    productType: body.productType || "CNC",
    orderType: body.orderType || "MARKET",
    validity: body.validity || "DAY",
    tradingSymbol: body.tradingSymbol || resolveSymbol(body.securityId),
    securityId: body.securityId || "0",
    quantity: body.quantity || 1,
    price: body.price || 0,
    triggerPrice: body.triggerPrice,
    filledQty: body.quantity || 1,
    averagePrice: body.price || 100,
    dhanClientId: body.dhanClientId || "MOCK",
    createdAt: new Date().toISOString(),
  };
  store.orders.set(orderId, order);

  // If it's a SELL, reduce holdings
  if (order.transactionType === "SELL") {
    const holding = store.holdings.get(order.securityId);
    if (holding) {
      holding.totalQty -= order.quantity;
      holding.availableQty -= order.quantity;
      if (holding.totalQty <= 0) {
        store.holdings.delete(order.securityId);
      }
    }
  }

  console.log(
    `  📦 Order placed: ${orderId} ${order.transactionType} ${order.tradingSymbol} x${order.quantity}`,
  );
  res.json({ orderId, orderStatus: "TRADED" });
});

router.post("/v2/super/orders", (req, res) => {
  // Super orders behave like regular orders in mock
  const orderId = store.generateOrderId();
  console.log(`  📦 Super order placed: ${orderId}`);
  res.json({ orderId, orderStatus: "TRADED" });
});

router.put("/v2/orders/:orderId", (req, res) => {
  const order = store.orders.get(req.params.orderId);
  if (!order) {
    return res.status(404).json({ errorCode: "DH-904", message: "Order not found" });
  }
  // Apply modifications
  Object.assign(order, req.body);
  res.json({ orderId: order.orderId, orderStatus: order.orderStatus });
});

router.delete("/v2/orders/:orderId", (req, res) => {
  const order = store.orders.get(req.params.orderId);
  if (order) {
    order.orderStatus = "CANCELLED";
    console.log(`  🚫 Order cancelled: ${req.params.orderId}`);
  }
  res.json({ orderId: req.params.orderId, orderStatus: "CANCELLED" });
});

router.get("/v2/orders/:orderId", (req, res) => {
  const order = store.orders.get(req.params.orderId);
  if (!order) {
    return res.status(404).json({ errorCode: "DH-904", message: "Order not found" });
  }
  res.json(order);
});

router.get("/v2/orders", (_req, res) => {
  res.json(Array.from(store.orders.values()));
});

// ─── Forever (GTT) Orders ─────────────────────────────────────────────

router.post("/v2/forever/orders", (req, res) => {
  const body = req.body;
  const orderId = store.generateOrderId();

  const fo = {
    orderId,
    orderStatus: "PENDING" as const,
    transactionType: body.transactionType || "BUY",
    exchangeSegment: body.exchangeSegment || "NSE_EQ",
    productType: body.productType || "CNC",
    orderType: body.orderType || "LIMIT",
    tradingSymbol: body.tradingSymbol || resolveSymbol(body.securityId),
    securityId: body.securityId || "0",
    quantity: body.quantity || 1,
    price: body.price || 0,
    triggerPrice: body.triggerPrice || body.price || 0,
    dhanClientId: body.dhanClientId || "MOCK",
    createdAt: new Date().toISOString(),
  };
  store.foreverOrders.set(orderId, fo);

  console.log(
    `  ⏰ Forever order placed: ${orderId} ${fo.transactionType} ${fo.tradingSymbol} trigger@${fo.triggerPrice}`,
  );
  res.json({ orderId, orderStatus: "PENDING" });
});

router.put("/v2/forever/orders/:orderId", (req, res) => {
  const fo = store.foreverOrders.get(req.params.orderId);
  if (!fo) {
    return res.status(404).json({ errorCode: "DH-904", message: "Forever order not found" });
  }
  Object.assign(fo, req.body);
  res.json({ orderId: fo.orderId, orderStatus: fo.orderStatus });
});

router.delete("/v2/forever/orders/:orderId", (req, res) => {
  const fo = store.foreverOrders.get(req.params.orderId);
  if (fo) {
    fo.orderStatus = "CANCELLED";
    console.log(`  🚫 Forever order cancelled: ${req.params.orderId}`);
  }
  res.json({ orderId: req.params.orderId, orderStatus: "CANCELLED" });
});

router.get("/v2/forever/orders", (_req, res) => {
  res.json(Array.from(store.foreverOrders.values()));
});

// ─── Portfolio ────────────────────────────────────────────────────────

router.get("/v2/positions", (_req, res) => {
  res.json(Array.from(store.positions.values()));
});

router.get("/v2/holdings", (_req, res) => {
  res.json(Array.from(store.holdings.values()));
});

// ─── Auth / Token ─────────────────────────────────────────────────────

router.get("/v2/profile", (req, res) => {
  const token = req.headers["access-token"];
  if (!token) {
    return res.status(401).json({ errorCode: "DH-902", message: "Missing access token" });
  }
  res.json({
    dhanClientId: req.headers.dhanclientid || "MOCK_CLIENT",
    name: "Mock Trader",
    email: "mock@trader.dev",
    tokenValidity: "31/12/2026 23:59",
  });
});

router.get("/v2/RenewToken", (req, res) => {
  const token = req.headers["access-token"];
  if (!token) {
    return res.status(401).json({ errorCode: "DH-902", message: "Missing access token" });
  }
  const newToken = `mock_renewed_${Date.now()}`;
  const expiryTime = new Date(Date.now() + 86400 * 1000).toISOString();
  console.log(`  🔑 Token renewed → ${newToken.slice(0, 20)}...`);
  res.json({ accessToken: newToken, expiryTime });
});

router.post("/app/generateAccessToken", (req, res) => {
  const { dhanClientId, pin, totp } = req.query as Record<string, string>;
  if (!dhanClientId || !pin || !totp) {
    return res.status(400).json({
      errorCode: "DH-901",
      message: "Missing required parameters: dhanClientId, pin, totp",
    });
  }
  const accessToken = `mock_totp_${Date.now()}`;
  const expiryTime = new Date(Date.now() + 86400 * 1000).toISOString();
  console.log(`  🔑 Token generated via TOTP for ${dhanClientId} → ${accessToken.slice(0, 20)}...`);
  res.json({ accessToken, expiryTime });
});

// ─── IP Whitelist ─────────────────────────────────────────────────────

router.get("/v2/ip/getIP", (req, res) => {
  const token = req.headers["access-token"];
  if (!token) {
    return res.status(401).json({ errorCode: "DH-902", message: "Missing access token" });
  }

  const { ipState } = store;
  let ipMatchStatus = "NO_MATCH";
  let ordersAllowed = false;

  if (ipState.detectedIP === ipState.primaryIP) {
    ipMatchStatus = "PRIMARY_MATCH";
    ordersAllowed = true;
  } else if (ipState.detectedIP === ipState.secondaryIP) {
    ipMatchStatus = "SECONDARY_MATCH";
    ordersAllowed = true;
  }

  res.json({
    modifyDatePrimary: ipState.modifyDatePrimary,
    modifyDateSecondary: ipState.modifyDateSecondary,
    primaryIP: ipState.primaryIP,
    secondaryIP: ipState.secondaryIP,
    detectedIP: ipState.detectedIP,
    ipMatchStatus,
    ordersAllowed,
  });
});

router.post("/v2/ip/setIP", (req, res) => {
  const token = req.headers["access-token"];
  if (!token) {
    return res.status(401).json({ errorCode: "DH-902", message: "Missing access token" });
  }

  const { dhanClientId, ip, ipFlag } = req.body;
  if (!dhanClientId || !ip || !ipFlag) {
    return res.status(400).json({ errorCode: "DH-901", message: "Missing required parameters" });
  }

  const nextModifyDate = new Date(Date.now() + 7 * 86400 * 1000).toISOString().split("T")[0];

  if (ipFlag === "PRIMARY") {
    store.ipState.primaryIP = ip;
    store.ipState.modifyDatePrimary = nextModifyDate;
  } else if (ipFlag === "SECONDARY") {
    store.ipState.secondaryIP = ip;
    store.ipState.modifyDateSecondary = nextModifyDate;
  } else {
    return res.status(400).json({ errorCode: "DH-901", message: "Invalid ipFlag" });
  }

  console.log(`  🌐 IP updated: ${ipFlag} -> ${ip} for client ${dhanClientId}`);
  res.json({ message: "IP saved successfully", status: "SUCCESS" });
});

// ─── Admin / Debug ────────────────────────────────────────────────────

/** POST /admin/trigger-forever/:orderId — Simulate a forever order triggering */
router.post("/admin/trigger-forever/:orderId", (req, res) => {
  const fo = store.foreverOrders.get(req.params.orderId);
  if (!fo) {
    return res.status(404).json({ error: "Forever order not found" });
  }
  store.triggerForeverOrder(req.params.orderId);
  console.log(
    `  ⚡ Forever order triggered: ${req.params.orderId} → regular order ${fo.triggeredOrderId}`,
  );
  res.json({ triggered: true, foreverOrderId: fo.orderId, regularOrderId: fo.triggeredOrderId });
});

/** POST /admin/holding-ltp — Update a holding's last traded price */
router.post("/admin/holding-ltp", (req, res) => {
  const { securityId, lastTradedPrice } = req.body;
  const holding = store.holdings.get(String(securityId));
  if (!holding) {
    return res.status(404).json({ error: "Holding not found", securityId });
  }
  holding.lastTradedPrice = lastTradedPrice;
  holding.pnl = (lastTradedPrice - holding.avgCostPrice) * holding.totalQty;
  console.log(`  📊 Holding LTP updated: ${holding.tradingSymbol} → ₹${lastTradedPrice}`);
  res.json({ updated: true, symbol: holding.tradingSymbol, lastTradedPrice });
});

/** POST /admin/reset — Reset all state */
router.post("/admin/reset", (_req, res) => {
  store.reset();
  console.log("  🔄 State reset");
  res.json({ reset: true });
});

/** GET /admin/state — Dump current state for debugging */
router.get("/admin/state", (_req, res) => {
  res.json({
    orders: Array.from(store.orders.values()),
    foreverOrders: Array.from(store.foreverOrders.values()),
    holdings: Array.from(store.holdings.values()),
    positions: Array.from(store.positions.values()),
    idempotencyKeys: Array.from(store.idempotencyKeys),
  });
});

export default router;
