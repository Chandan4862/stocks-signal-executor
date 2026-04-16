/*
  ConfigService: DB-backed runtime trading configuration.

  Trading parameters (capital limits, TSL settings, etc.) are stored in
  the `app_config` Postgres table instead of .env, allowing live updates
  via Telegram /config without restarts.

  Usage:
    const configSvc = new ConfigService(pg);
    await configSvc.load();            // reads all rows into memory
    const cap = configSvc.maxTradeCapital;  // typed getter (number)
    await configSvc.set('per_trade_capital', '3000');  // update DB + cache
*/

import type { Client, Pool } from "pg";

/** All recognised config keys and their default values. */
const DEFAULTS: Record<string, string> = {
  max_trade_capital: "25000",
  per_trade_capital: "2000",
  max_active_trades: "10",
  tsl_increment_rs: "2",
  tsl_initial_sl_pct: "3",
  tsl_trailing_step_pct: "1",
};

/** Human-readable descriptions for /config display. */
const DESCRIPTIONS: Record<string, string> = {
  max_trade_capital: "Max total deployed capital (₹)",
  per_trade_capital: "Capital per trade (₹)",
  max_active_trades: "Max concurrent active trades",
  tsl_increment_rs: "Trailing SL increment (₹)",
  tsl_initial_sl_pct: "Initial SL % below entry",
  tsl_trailing_step_pct: "Trailing step % of CMP",
};

export class ConfigService {
  /** In-memory cache of config values. */
  private cache: Map<string, string> = new Map();

  constructor(private pg: Client | Pool) {}

  /* ------------------------------------------------------------------ */
  /*  Load / Refresh                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Load all config rows from DB into memory.
   * Missing keys are filled with hardcoded defaults.
   * Call once after DB connection is established.
   */
  async load(): Promise<void> {
    // Start with defaults
    for (const [k, v] of Object.entries(DEFAULTS)) {
      this.cache.set(k, v);
    }

    // Override with DB values
    try {
      const res = await this.pg.query("SELECT key, value FROM app_config");
      for (const row of res.rows) {
        this.cache.set(row.key, row.value);
      }
    } catch (err: any) {
      console.error("ConfigService: failed to load from DB, using defaults:", err?.message);
    }
  }

  /**
   * Load global defaults + per-user overrides from user_config table.
   * Call this in worker context where each job operates on a specific user.
   */
  async loadForUser(userId: number): Promise<void> {
    // Load global config first
    await this.load();

    // Then overlay user-specific overrides
    try {
      const res = await this.pg.query("SELECT key, value FROM user_config WHERE user_id = $1", [
        userId,
      ]);
      for (const row of res.rows) {
        this.cache.set(row.key, row.value);
      }
    } catch (err: any) {
      console.error(`ConfigService: failed to load user_config for user ${userId}:`, err?.message);
    }
  }

  /**
   * Set a per-user config override.
   */
  async setForUser(
    userId: number,
    key: string,
    value: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (!DEFAULTS[key]) {
      const validKeys = Object.keys(DEFAULTS).join(", ");
      return { ok: false, message: `Unknown key "${key}".\nValid keys: ${validKeys}` };
    }

    const parsed = Number(value);
    if (isNaN(parsed) || parsed <= 0) {
      return { ok: false, message: `Invalid value "${value}" — must be a positive number.` };
    }

    try {
      await this.pg.query(
        `INSERT INTO user_config (user_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [userId, key, value],
      );
      this.cache.set(key, value);
      return { ok: true, message: `✅ ${key} updated to ${value}` };
    } catch (err: any) {
      return { ok: false, message: `DB error: ${err?.message ?? "unknown"}` };
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Typed getters                                                      */
  /* ------------------------------------------------------------------ */

  get maxTradeCapital(): number {
    return this.num("max_trade_capital");
  }

  get perTradeCapital(): number {
    return this.num("per_trade_capital");
  }

  get maxActiveTrades(): number {
    return this.num("max_active_trades");
  }

  get tsl() {
    return {
      incrementRs: this.num("tsl_increment_rs"),
      initialSlPct: this.num("tsl_initial_sl_pct"),
      trailingStepPct: this.num("tsl_trailing_step_pct"),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Mutators                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Update a single config key. Validates the key is recognised and
   * the value is a valid positive number. Persists to DB + refreshes cache.
   *
   * Returns a result object for the caller (Telegram) to display.
   */
  async set(key: string, value: string): Promise<{ ok: boolean; message: string }> {
    if (!DEFAULTS[key]) {
      const validKeys = Object.keys(DEFAULTS).join(", ");
      return {
        ok: false,
        message: `Unknown key "${key}".\nValid keys: ${validKeys}`,
      };
    }

    const parsed = Number(value);
    if (isNaN(parsed) || parsed <= 0) {
      return {
        ok: false,
        message: `Invalid value "${value}" — must be a positive number.`,
      };
    }

    try {
      await this.pg.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value],
      );
      this.cache.set(key, value);
      return {
        ok: true,
        message: `✅ ${key} updated to ${value}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `DB error: ${err?.message ?? "unknown"}`,
      };
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Display                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Returns a formatted string of all current config values.
   * Used by Telegram /config command.
   */
  getAll(): string {
    const lines: string[] = ["⚙️ Trading Configuration\n"];
    for (const key of Object.keys(DEFAULTS)) {
      const val = this.cache.get(key) ?? DEFAULTS[key];
      const desc = DESCRIPTIONS[key] ?? "";
      lines.push(`  ${key}: ${val}  (${desc})`);
    }
    lines.push("\nUpdate: /config <key> <value>");
    return lines.join("\n");
  }

  /**
   * Returns formatted config display with markers showing which values
   * are user-overridden vs global defaults.
   * ✏️ = user override, 🌐 = global default
   */
  getAllWithOverrides(userOverrides: Set<string>): string {
    const lines: string[] = ["⚙️ Your Trading Configuration\n"];
    for (const key of Object.keys(DEFAULTS)) {
      const val = this.cache.get(key) ?? DEFAULTS[key];
      const desc = DESCRIPTIONS[key] ?? "";
      const marker = userOverrides.has(key) ? "✏️" : "🌐";
      const defaultVal = DEFAULTS[key];
      const defaultHint = userOverrides.has(key) ? ` [default: ${defaultVal}]` : "";
      lines.push(`  ${marker} ${key}: ${val}  (${desc})${defaultHint}`);
    }
    lines.push("\n✏️ = your override  🌐 = global default");
    lines.push("\nCommands:");
    lines.push("  /config <key> <value> — set a value");
    lines.push("  /config reset <key> — revert to default");
    lines.push("  /config reset all — revert all overrides");
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ */
  /*  Internal                                                           */
  /* ------------------------------------------------------------------ */

  private num(key: string): number {
    const val = this.cache.get(key) ?? DEFAULTS[key];
    return Number(val);
  }
}
