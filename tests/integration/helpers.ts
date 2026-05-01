/**
 * Shared helpers for integration tests.
 *
 * Provides: test config, MockDhanService, DB create/drop/clean utilities,
 * and a getTradeState helper.
 *
 * Usage:
 *   import { cfg, MockDhanService, createDefaultDhanState, ... } from "./helpers";
 */

import { Client } from "pg";
import type { AppConfig } from "../../src/config/schema";
import { StateStore } from "../../src/services/stateStore";
import { AuditLogService } from "../../src/services/auditLogService";
import { DhanService, PlaceOrderResponse } from "../../src/services/dhanService";

// ─── Test Config ────────────────────────────────────────────────────────────

export const TEST_DB = "stocks_executor_test";

export const cfg: AppConfig = {
  dhan: { clientId: "TEST_CLIENT" },
  apis: {
    activeTradesUrl: "http://mock/active",
    closedTradesUrl: "http://mock/closed",
  },
  postgres: {
    host: process.env.PG_HOST || "localhost",
    port: Number(process.env.PG_PORT) || 7432,
    database: TEST_DB,
    user: process.env.PG_USER || "postgres",
    password: process.env.PG_PASSWORD || "postgres",
  },
  telegram: { botToken: "fake", defaultChatId: "fake" },
  env: "test",
} as any;

// ─── Mock DhanService ───────────────────────────────────────────────────────

export interface MockDhanState {
  foreverOrders: any[];
  regularOrders: any[];
  holdings: any[];
  placeForeverOrderResult: () => PlaceOrderResponse | Error;
  placeOrderResult: () => PlaceOrderResponse | Error;
  cancelForeverOrderResult: () => any | Error;
}

export class MockDhanService extends DhanService {
  public state: MockDhanState;
  public calls: { method: string; args: any[] }[] = [];

  constructor(dhanState: MockDhanState) {
    super(cfg, {} as any, new AuditLogService(null));
    this.state = dhanState;
  }

  async getForeverOrders(): Promise<any[]> {
    this.calls.push({ method: "getForeverOrders", args: [] });
    return this.state.foreverOrders;
  }

  async getOrders(): Promise<any[]> {
    this.calls.push({ method: "getOrders", args: [] });
    return this.state.regularOrders;
  }

  async getHoldings(): Promise<any[]> {
    this.calls.push({ method: "getHoldings", args: [] });
    return this.state.holdings;
  }

  async placeForeverOrder(req: any): Promise<PlaceOrderResponse> {
    this.calls.push({ method: "placeForeverOrder", args: [req] });
    const result = this.state.placeForeverOrderResult();
    if (result instanceof Error) throw result;
    return result as PlaceOrderResponse;
  }

  async placeOrder(req: any): Promise<PlaceOrderResponse> {
    this.calls.push({ method: "placeOrder", args: [req] });
    const result = this.state.placeOrderResult();
    if (result instanceof Error) throw result;
    return result as PlaceOrderResponse;
  }

  async cancelForeverOrder(orderId: string): Promise<any> {
    this.calls.push({ method: "cancelForeverOrder", args: [orderId] });
    const result = this.state.cancelForeverOrderResult();
    if (result instanceof Error) throw result;
    return result;
  }
}

// ─── Default Mock State ─────────────────────────────────────────────────────

export function createDefaultDhanState(): MockDhanState {
  return {
    foreverOrders: [],
    regularOrders: [],
    holdings: [],
    placeForeverOrderResult: () => ({
      orderId: "FO_123",
      orderStatus: "PENDING",
    }),
    placeOrderResult: () => ({ orderId: "SELL_456", orderStatus: "TRADED" }),
    cancelForeverOrderResult: () => ({
      orderId: "X",
      orderStatus: "CANCELLED",
    }),
  };
}

// ─── DB Helpers ─────────────────────────────────────────────────────────────

export async function createTestDb() {
  const adminPg = new Client({
    host: cfg.postgres.host,
    port: cfg.postgres.port,
    database: "postgres",
    user: cfg.postgres.user,
    password: cfg.postgres.password,
  });
  await adminPg.connect();

  // Terminate lingering connections, then recreate
  await adminPg.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEST_DB],
  );
  await adminPg.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await adminPg.query(`CREATE DATABASE ${TEST_DB}`);
  await adminPg.end();

  // Apply schema + migrations
  const schemaPg = new Client({
    host: cfg.postgres.host,
    port: cfg.postgres.port,
    database: TEST_DB,
    user: cfg.postgres.user,
    password: cfg.postgres.password,
  });
  await schemaPg.connect();

  const fs = await import("fs");
  const path = await import("path");
  const schemaDir = path.resolve(__dirname, "../../db");
  const schema = fs.readFileSync(path.join(schemaDir, "schema.sql"), "utf-8");
  await schemaPg.query(schema);

  const migrationsDir = path.join(schemaDir, "migrations");
  const migrations = fs.readdirSync(migrationsDir).sort();
  for (const m of migrations) {
    const sql = fs.readFileSync(path.join(migrationsDir, m), "utf-8");
    await schemaPg.query(sql);
  }

  await schemaPg.end();
}

export async function dropTestDb() {
  const admin = new Client({
    host: cfg.postgres.host,
    port: cfg.postgres.port,
    database: "postgres",
    user: cfg.postgres.user,
    password: cfg.postgres.password,
  });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEST_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.end();
}

export async function cleanTables(store: StateStore) {
  await store.pg.query("DELETE FROM pnl_records");
  await store.pg.query("DELETE FROM audit_logs");
  await store.pg.query("DELETE FROM idempotency");
  await store.pg.query("DELETE FROM trades");
  await store.pg.query("DELETE FROM app_config");
}

export async function getTradeState(store: StateStore, id: number) {
  const res = await store.pg.query("SELECT * FROM trades WHERE id = $1", [id]);
  return res.rows[0] ?? null;
}
