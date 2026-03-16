/*
 StateStore: Postgres abstraction for all application state.
*/

import { Client } from "pg";
import type { AppConfig } from "../config/schema";

export class StateStore {
  readonly pg: Client;

  constructor(cfg: AppConfig) {
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
  }
}
