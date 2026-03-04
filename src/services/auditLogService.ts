/*
 AuditLogService: Immutable event journal persisted to Postgres audit_logs table.
 Falls back to console.log if no DB client is provided or on write failure.
*/

import type { Client } from "pg";
import { LifecycleEvents } from "../enums/trade";

export class AuditLogService {
  private pg: Client | null;

  constructor(pg?: Client | null) {
    this.pg = pg ?? null;
  }

  async record(
    event: LifecycleEvents,
    payload: Record<string, any>,
    logToDb = true,
  ): Promise<void> {
    const tradeId = payload.id ?? null;

    if (this.pg && logToDb) {
      try {
        await this.pg.query(
          `INSERT INTO audit_logs (trade_id, event, payload) VALUES ($1, $2, $3)`,
          [tradeId, event, JSON.stringify(payload)],
        );
        return;
      } catch (err: any) {
        // DB write failed — fall through to console
        console.error(
          "AuditLogService: DB write failed, falling back to console",
          err?.message,
        );
      }
    }

    console.log("AUDIT", event, payload);
  }
}
