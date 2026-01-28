/*
 Scheduler: Polls Active/Closed APIs on an interval; wraps retry/backoff.
 Phase 1: skeleton that ticks and demonstrates structure.
*/

import type { AppConfig } from "../config/schema";
import { backoff } from "../utils/retry";

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private cfg: AppConfig) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error("Scheduler tick error:", err));
    }, this.cfg.pollingIntervalMs);
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
    // Phase 1: just log; Phase 2: call TradeSyncService, AuthService,
    await backoff(
      async () => {
        console.log("Scheduler tick at", new Date().toISOString());
      },
      { retries: 3, baseMs: 250 },
    );
  }
}
