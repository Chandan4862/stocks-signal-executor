/*
 Scheduler: Polls Active/Closed APIs on an interval; wraps retry/backoff.
 Phase 1: skeleton that ticks and demonstrates structure.
*/

import type { AppConfig } from "../config/schema";
import { backoff } from "../utils/retry";
import { StateStore } from "./stateStore";
import { DhanService } from "./dhanService";
import { TokenService } from "./tokenService";
import { TradeSyncService } from "./tradeSyncService";
import { QuantityResolverService } from "./quantityResolverService";
import { TSLService } from "./tslService";
import { AuditLogService } from "./auditLogService";
import { InstrumentLookupService } from "./instrumentLookupService";

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private cfg: AppConfig) {}

  start() {
    if (this.timer) return;
    this.tick().catch((err) => console.error("Scheduler tick error:", err));
    // this.timer = setInterval(() => {
    //   this.tick().catch((err) => console.error("Scheduler tick error:", err));
    // }, this.cfg.pollingIntervalMs);
    console.log(
      "Scheduler started with interval",
      this.cfg.pollingIntervalMs,
      "ms",
    );
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    // Phase 2: orchestrate token check, trade sync, BUY + initial SL
    await backoff(
      async () => {
        const store = new StateStore(this.cfg);
        const tokens = new TokenService(this.cfg, store);
        const dhan = new DhanService(this.cfg, tokens);
        const tradeSync = new TradeSyncService(this.cfg);
        const qtyResolver = new QuantityResolverService();
        const tsl = new TSLService({
          incrementRs: this.cfg.tsl.incrementRs,
          initialSlPct: this.cfg.tsl.initialSlPct,
          trailingStepPct: this.cfg.tsl.trailingStepPct,
        });
        // Connect PG (Redis auto connects)
        try {
          await store.connect();
        } catch {
          console.error("Failed to connect to Postgres DB");
        }
        const audit = new AuditLogService(store.pg);
        const instrumentLookup = new InstrumentLookupService(store.pg);
        console.log("Scheduler tick started at", new Date().toISOString());
        try {
          await tradeSync.runBuyAndInitialSl(
            store,
            dhan,
            qtyResolver,
            tsl,
            audit,
            instrumentLookup,
          );
        } finally {
          await store.disconnect();
        }
      },
      { retries: 3, baseMs: 250 },
    );
  }
}
