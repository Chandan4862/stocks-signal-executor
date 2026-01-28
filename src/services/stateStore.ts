/*
 StateStore: Redis & Postgres abstraction (Phase 1: connection stubs).
*/

import IORedis from "ioredis";
import { Client } from "pg";
import type { AppConfig } from "../config/schema";

export class StateStore {
  readonly redis: IORedis;
  readonly pg: Client;

  constructor(cfg: AppConfig) {
    this.redis = new IORedis(cfg.redis.url);
    this.pg = new Client({
      host: cfg.postgres.host,
      port: cfg.postgres.port,
      database: cfg.postgres.database,
      user: cfg.postgres.user,
      password: cfg.postgres.password,
    });
  }

  async connect(): Promise<void> {
    await this.pg.connect();
  }

  async disconnect(): Promise<void> {
    await this.pg.end();
    await this.redis.quit();
  }
}
