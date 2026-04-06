/**
 * Integration test: ConfigService with real Postgres.
 *
 * Covers: load, set, getAll, typed getters, validation, defaults,
 *         reload behaviour, and edge cases.
 *
 * Prerequisites:
 *   docker compose up -d stock_postgres
 *   npx vitest run tests/integration/configService.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { StateStore } from "../../src/services/stateStore";
import { ConfigService } from "../../src/services/configService";
import {
  cfg,
  createTestDb,
  dropTestDb,
  cleanTables,
} from "./helpers";

describe("ConfigService Integration", () => {
  let store: StateStore;
  let configSvc: ConfigService;

  beforeAll(async () => {
    await createTestDb();
    store = new StateStore(cfg);
    await store.connect();
  }, 30000);

  afterAll(async () => {
    await store.disconnect();
    await dropTestDb();
  });

  beforeEach(async () => {
    await cleanTables(store);
    configSvc = new ConfigService(store.pg);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // load() — from empty table
  // ═══════════════════════════════════════════════════════════════════════

  it("load() uses hardcoded defaults when app_config table is empty", async () => {
    await configSvc.load();

    expect(configSvc.maxTradeCapital).toBe(25000);
    expect(configSvc.perTradeCapital).toBe(2000);
    expect(configSvc.maxActiveTrades).toBe(10);
    expect(configSvc.tsl).toEqual({
      incrementRs: 2,
      initialSlPct: 3,
      trailingStepPct: 1,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // load() — DB values override defaults
  // ═══════════════════════════════════════════════════════════════════════

  it("load() overrides defaults with DB values", async () => {
    await store.pg.query(
      "INSERT INTO app_config (key, value) VALUES ('max_trade_capital', '50000')",
    );
    await store.pg.query(
      "INSERT INTO app_config (key, value) VALUES ('per_trade_capital', '5000')",
    );

    await configSvc.load();

    expect(configSvc.maxTradeCapital).toBe(50000);
    expect(configSvc.perTradeCapital).toBe(5000);
    // Unset keys still use defaults
    expect(configSvc.maxActiveTrades).toBe(10);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // load() — partial DB rows (some keys present, others default)
  // ═══════════════════════════════════════════════════════════════════════

  it("load() with partial DB rows fills missing keys from defaults", async () => {
    await store.pg.query(
      "INSERT INTO app_config (key, value) VALUES ('tsl_increment_rs', '5')",
    );

    await configSvc.load();

    expect(configSvc.tsl.incrementRs).toBe(5);
    expect(configSvc.tsl.initialSlPct).toBe(3); // default
    expect(configSvc.tsl.trailingStepPct).toBe(1); // default
  });

  // ═══════════════════════════════════════════════════════════════════════
  // set() — valid key and value
  // ═══════════════════════════════════════════════════════════════════════

  it("set() persists to DB and updates cache", async () => {
    await configSvc.load();

    const result = await configSvc.set("per_trade_capital", "3000");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("3000");

    // In-memory cache updated immediately
    expect(configSvc.perTradeCapital).toBe(3000);

    // DB has the value
    const dbRow = await store.pg.query(
      "SELECT value FROM app_config WHERE key = 'per_trade_capital'",
    );
    expect(dbRow.rows[0].value).toBe("3000");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // set() — unknown key rejected
  // ═══════════════════════════════════════════════════════════════════════

  it("set() rejects unknown keys", async () => {
    await configSvc.load();

    const result = await configSvc.set("nonexistent_key", "100");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Unknown key");
    expect(result.message).toContain("nonexistent_key");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // set() — invalid value rejected (not a positive number)
  // ═══════════════════════════════════════════════════════════════════════

  it("set() rejects non-numeric values", async () => {
    await configSvc.load();

    const result = await configSvc.set("per_trade_capital", "abc");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Invalid value");
  });

  it("set() rejects zero", async () => {
    await configSvc.load();

    const result = await configSvc.set("per_trade_capital", "0");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("positive number");
  });

  it("set() rejects negative numbers", async () => {
    await configSvc.load();

    const result = await configSvc.set("max_trade_capital", "-5000");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("positive number");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // set() — upsert behaviour (update existing key)
  // ═══════════════════════════════════════════════════════════════════════

  it("set() upserts — updates existing DB row", async () => {
    await store.pg.query(
      "INSERT INTO app_config (key, value) VALUES ('max_active_trades', '5')",
    );
    await configSvc.load();
    expect(configSvc.maxActiveTrades).toBe(5);

    const result = await configSvc.set("max_active_trades", "15");
    expect(result.ok).toBe(true);
    expect(configSvc.maxActiveTrades).toBe(15);

    // DB should have updated value (not duplicate row)
    const dbRows = await store.pg.query(
      "SELECT value FROM app_config WHERE key = 'max_active_trades'",
    );
    expect(dbRows.rows).toHaveLength(1);
    expect(dbRows.rows[0].value).toBe("15");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // reload() — picks up external DB changes
  // ═══════════════════════════════════════════════════════════════════════

  it("load() called again picks up changes made directly in DB", async () => {
    await configSvc.load();
    expect(configSvc.maxTradeCapital).toBe(25000); // default

    // Simulate external change (e.g. manual DB update)
    await store.pg.query(
      "INSERT INTO app_config (key, value) VALUES ('max_trade_capital', '75000')",
    );

    // Before reload — still sees old cached value
    expect(configSvc.maxTradeCapital).toBe(25000);

    // After reload — picks up new value
    await configSvc.load();
    expect(configSvc.maxTradeCapital).toBe(75000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // getAll() — formatted display
  // ═══════════════════════════════════════════════════════════════════════

  it("getAll() returns formatted string with all keys and descriptions", async () => {
    await configSvc.load();

    const output = configSvc.getAll();

    expect(output).toContain("Trading Configuration");
    expect(output).toContain("max_trade_capital");
    expect(output).toContain("per_trade_capital");
    expect(output).toContain("tsl_increment_rs");
    expect(output).toContain("/config <key> <value>");
    // Should show the default values
    expect(output).toContain("25000");
    expect(output).toContain("2000");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // set() then getAll() — reflects updated value
  // ═══════════════════════════════════════════════════════════════════════

  it("getAll() reflects values after set()", async () => {
    await configSvc.load();
    await configSvc.set("per_trade_capital", "9999");

    const output = configSvc.getAll();
    expect(output).toContain("9999");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Typed getters — decimal values
  // ═══════════════════════════════════════════════════════════════════════

  it("set() accepts decimal values for TSL params", async () => {
    await configSvc.load();

    const result = await configSvc.set("tsl_initial_sl_pct", "2.5");

    expect(result.ok).toBe(true);
    expect(configSvc.tsl.initialSlPct).toBe(2.5);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Extra unknown keys in DB are ignored by getAll/getters
  // ═══════════════════════════════════════════════════════════════════════

  it("unknown keys in DB are loaded into cache but not shown in getAll()", async () => {
    await store.pg.query(
      "INSERT INTO app_config (key, value) VALUES ('secret_feature', '42')",
    );
    await configSvc.load();

    // getAll() only shows DEFAULTS keys
    const output = configSvc.getAll();
    expect(output).not.toContain("secret_feature");
  });
});
