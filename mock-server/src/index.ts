/*
  Mock Server Entry Point.
  Single Express server simulating Dhan API + Signal APIs on one port.

  Usage:
    MOCK_MODE=allSuccess npm start    # deterministic success
    MOCK_MODE=random npm start        # random failures + latency
*/

import express from "express";
import { loadConfig } from "./config";
import { createMockMiddleware } from "./mock.controller";
import dhanRoutes from "./dhan.routes";
import tradesRoutes from "./trades.routes";

const config = loadConfig();
const app = express();

// Parse JSON bodies
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// Mock middleware — injects failures/latency in random mode
app.use(createMockMiddleware(config));

// Mount routes
app.use(dhanRoutes);
app.use(tradesRoutes);

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    mode: config.mode,
    failureRate: config.mode === "random" ? config.failureRate : 0,
    uptime: process.uptime(),
  });
});

// 404 fallback
app.use((req, res) => {
  console.log(`  ⚠️  Unhandled route: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found", path: req.path });
});

// Start server
app.listen(config.port, () => {
  console.log(`\n🧪 Mock Server started on port ${config.port}`);
  console.log(`   Mode: ${config.mode}`);
  if (config.mode === "random") {
    console.log(`   Failure rate: ${(config.failureRate * 100).toFixed(0)}%`);
    console.log(`   Max latency: ${config.maxLatencyMs}ms`);
  }
  console.log(`\n   Endpoints:`);
  console.log(`   ├─ Dhan API:     http://localhost:${config.port}/v2/...`);
  console.log(`   ├─ Auth API:     http://localhost:${config.port}/app/generateAccessToken`);
  console.log(`   ├─ Active Trades: http://localhost:${config.port}/api/active-trades`);
  console.log(`   ├─ Closed Trades: http://localhost:${config.port}/api/closed-trades`);
  console.log(`   ├─ Admin:        http://localhost:${config.port}/admin/...`);
  console.log(`   └─ Health:       http://localhost:${config.port}/health`);
  console.log("");
});
