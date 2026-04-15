/*
 StateStore: Postgres abstraction for all application state.
 Evolved from pg.Client to pg.Pool for connection pooling across
 concurrent BullMQ workers.
*/

import { Pool, Client } from "pg";
import type { AppConfig } from "../config/schema";

export class StateStore {
  readonly pool: Pool;

  /** @deprecated Use pool.query() directly. Kept for backward compat during migration. */
  get pg(): Pool {
    return this.pool;
  }

  constructor(cfg: AppConfig) {
    this.pool = new Pool({
      host: cfg.postgres.host,
      port: cfg.postgres.port,
      database: cfg.postgres.database,
      user: cfg.postgres.user,
      password: cfg.postgres.password,
      max: 30, // Max connections in pool
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  async connect(): Promise<void> {
    // Pool connects lazily, but verify connectivity at boot
    const client = await this.pool.connect();
    client.release();
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  /** Convenience: run a query using the pool. */
  async query(sql: string, params?: any[]) {
    return this.pool.query(sql, params);
  }
}
