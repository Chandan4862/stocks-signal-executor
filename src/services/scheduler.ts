/*
  Scheduler: Polls Active/Closed APIs on an interval; wraps retry/backoff.
  On each tick:
    1. Ensure valid token (Redis/DB/TOTP) — pause trading if unavailable
    2. Fetch Active/Closed trades and reconcile
    3. Execute BUY + initial SL for new trades
    4. Persist and notify
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
import { TelegramService } from "./telegramService";

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private cfg: AppConfig,
    private telegram: TelegramService,
  ) {}

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

        // Inject TokenService into TelegramService for /token and /renew
        this.telegram.setTokenService(tokens);

        const audit = new AuditLogService(store.pg);
        const instrumentLookup = new InstrumentLookupService(store.pg);

        console.log("Scheduler tick started at", new Date().toISOString());

        try {
          // ── Step 1: Ensure valid token ──
          const token = await tokens.getToken();
          if (!token) {
            const msg =
              "⚠️ *Trading paused*: No valid Dhan access token\\.\n\n" +
              "Submit a token via:\n" +
              "• `/token YOUR_ACCESS_TOKEN`\n" +
              "• Or configure `DHAN_PIN` \\+ `DHAN_TOTP_SECRET` for auto\\-generation";
            await this.telegram.notify(msg, "MarkdownV2");
            console.warn("Scheduler: no valid token — skipping tick");
            return;
          }

          // ── Step 2–4: Trade sync, execute, persist ──
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
