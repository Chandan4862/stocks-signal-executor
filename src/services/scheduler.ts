/*
  Scheduler: Polls Active/Closed APIs on an interval; wraps retry/backoff.
  On each tick:
    1. Ensure valid token (DB/TOTP) — pause trading if unavailable
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
import { LifecycleEvents } from "../enums/trade";

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private cfg: AppConfig,
    private telegram: TelegramService,
  ) {}

  start() {
    if (this.timer) return;
    this.tick().catch(() => {});
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

  // Scheduler.tick()
  //   └→ TokenService.getToken()
  //       └→ valid token? → DhanService uses it for all API calls
  //       └→ null?        → Telegram alert, tick skipped

  // DhanService (on 401/403)
  //   └→ TokenService.invalidateToken()  // clear cache
  //   └→ TokenService.getToken()         // falls through to DB → renew → TOTP

  private async tick(): Promise<void> {
    await backoff(
      async () => {
        const store = new StateStore(this.cfg);
        const tradeSync = new TradeSyncService(this.cfg);
        const qtyResolver = new QuantityResolverService();
        const tsl = new TSLService({
          incrementRs: this.cfg.tsl.incrementRs,
          initialSlPct: this.cfg.tsl.initialSlPct,
          trailingStepPct: this.cfg.tsl.trailingStepPct,
        });

        // Create audit early (Telegram-only until PG connects)
        let audit = new AuditLogService(null, this.telegram);

        // Connect Postgres
        try {
          await store.connect();
        } catch (err: any) {
          await audit.critical(LifecycleEvents.ERROR_OCCURRED, {
            action: "Scheduler.tick",
            error: "Failed to connect to Postgres DB",
            message: err?.message,
          });
          return;
        }

        // Upgrade audit with PG client now that connection is live
        audit = new AuditLogService(store.pg, this.telegram);
        const tokens = new TokenService(this.cfg, store, audit);
        const dhan = new DhanService(this.cfg, tokens, audit);

        // Inject TokenService into TelegramService for /token and /renew
        this.telegram.setTokenService(tokens);
        this.telegram.setAudit(audit);

        const instrumentLookup = new InstrumentLookupService(store.pg);

        await audit.info(LifecycleEvents.DHAN_API_CALL, {
          action: "Scheduler.tick",
          message: "Tick started",
          timestamp: new Date().toISOString(),
        });
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
            await audit.critical(LifecycleEvents.ERROR_OCCURRED, {
              action: "Scheduler.tick",
              error: "No valid token — trading paused",
            });
            return;
          }

          // ── Step 2–4: Trade sync, execute, persist ──

          // Phase 2: Actives - scan and place SINGLE Forever Orders
          await tradeSync.runBuyAndInitialSl(
            store,
            dhan,
            qtyResolver,
            tsl,
            audit,
            instrumentLookup,
          );

          // Phase 3: Monitor pending Forever Orders - attach OCO if TRADED
          await tradeSync.monitorPendingEntries(store, dhan, audit);

          // Phase 4: Handle external closures from Closed API
          await tradeSync.processClosedTrades(store, dhan, audit);

          // Phase 5: Monitor ENTERED trades - detect SL/target hits, manual exits
          await tradeSync.monitorEnteredTrades(store, dhan, audit);

          // Phase 6: Reconcile Dhan positions with local trades table
          await tradeSync.reconcilePositions(store, dhan, audit);
        } finally {
          await store.disconnect();
        }
      },
      { retries: 3, baseMs: 250 },
    );
  }
}
