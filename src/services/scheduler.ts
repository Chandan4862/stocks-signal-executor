/*
  Scheduler: Two-cadence execution model.

  Fast loop (1 hour):
    - Phase 3: monitorPendingEntries  (Dhan order status)
    - Phase 5: monitorEnteredTrades   (exit order status)
    - Phase 6: reconcilePositions     (safety net)

  Slow trigger (9:30 AM + /trade command):
    - Phase 2: runBuyAndInitialSl     (analyst active trades)
    - Phase 4: processClosedTrades    (analyst closed trades)
*/

import type { AppConfig } from "../config/schema";
import { backoff } from "../utils/retry";
import { StateStore } from "./stateStore";
import { DhanService } from "./dhanService";
import { TokenService } from "./tokenService";
import { TradeSyncService } from "./tradeSyncService";
import { TradeEntryService } from "./tradeEntryService";
import { TradeMonitorService } from "./tradeMonitorService";
import { TradeReconciliationService } from "./tradeReconciliationService";
import { QuantityResolverService } from "./quantityResolverService";
import { TSLService } from "./tslService";
import { AuditLogService } from "./auditLogService";
import { InstrumentLookupService } from "./instrumentLookupService";
import { TelegramService } from "./telegramService";
import { LifecycleEvents } from "../enums/trade";

export class Scheduler {
  private monitorTimer: NodeJS.Timeout | null = null;
  private tradeScanTimer: NodeJS.Timeout | null = null;

  constructor(
    private cfg: AppConfig,
    private telegram: TelegramService,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  start() {
    if (this.monitorTimer) return;

    // 1. Run monitor tick immediately, then every hour
    // this.monitorTick().catch(() => {});
    // this.monitorTimer = setInterval(
    //   () => this.monitorTick().catch(() => {}),
    //   this.cfg.pollingIntervalMs, // default ~1 hour
    // );

    // 2. Schedule trade scan at 9:30 AM IST
    // this.scheduleTradeScan();

    console.log(
      `Scheduler started: monitor every ${this.cfg.pollingIntervalMs}ms, trade scan at 09:30 IST`,
    );
  }

  stop() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.tradeScanTimer) {
      clearTimeout(this.tradeScanTimer);
      this.tradeScanTimer = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Trade Scan — Phases 2+4 (analyst API, runs at 9:30 AM + /trade)   */
  /* ------------------------------------------------------------------ */

  // Scheduler.monitorTick()
  //   └→ Phases 3,5,6 — Dhan order monitoring (hourly)

  // Scheduler.runTradeScan()
  //   └→ Phases 2,4 — Analyst API scan (9:30 AM + /trade command)

  /**
   * Public: trigger trade scan manually (called by Telegram /trade command).
   * Runs Phases 2 + 4 (fetch analyst trades, place orders, handle closures).
   */
  async runTradeScan(): Promise<string> {
    try {
      await this.executeTradeScan();
      return "✅ Trade scan completed successfully.";
    } catch (err: any) {
      return `❌ Trade scan failed: ${err?.message ?? "unknown error"}`;
    }
  }

  private async executeTradeScan(): Promise<void> {
    await backoff(
      async () => {
        const {
          store,
          audit,
          tokens,
          dhan,
          tradeSync,
          tradeEntry,
          tradeReconciliation,
          qtyResolver,
          tsl,
          instrumentLookup,
        } = await this.initServices();

        try {
          const token = await tokens.getToken();
          if (!token) {
            await this.notifyNoToken(audit);
            return;
          }

          await audit.info(LifecycleEvents.DHAN_API_CALL, {
            action: "Scheduler.tradeScan",
            message: "Trade scan started",
            timestamp: new Date().toISOString(),
          });

          // Phase 2: Actives — scan and place Forever Orders
          const actives = await tradeSync.fetchActiveTrades();
          await tradeEntry.runBuyAndInitialSl(
            store,
            dhan,
            qtyResolver,
            tsl,
            audit,
            instrumentLookup,
            actives,
          );

          // Phase 4: Handle external closures from Closed API
          const closed = await tradeSync.fetchClosedTrades();
          await tradeReconciliation.processClosedTrades(
            store,
            dhan,
            audit,
            closed,
          );
        } finally {
          await store.disconnect();
        }
      },
      { retries: 3, baseMs: 250 },
    );
  }

  /** Schedule next 9:30 AM IST run. Re-schedules itself daily. */
  //   Boot at 20:34 IST (Monday)
  //   → scheduleTradeScan()
  //   → target = Tomorrow 09:30 IST (Tuesday)
  //   → setTimeout(13h)

  // Tuesday 09:30 IST
  //   → Timer fires
  //   → day = 2 (Tuesday) → not weekend → executeTradeScan() ✅
  //   → scheduleTradeScan() again
  //   → target = Wednesday 09:30 IST
  //   → setTimeout(24h)

  // Saturday 09:30 IST
  //   → Timer fires
  //   → day = 6 (Saturday) → weekend → SKIP ❌
  //   → scheduleTradeScan() again
  //   → target = Sunday 09:30 IST (will also skip)
  /**********************************************/
  //   Server stops at 22:00 (Monday)
  //   → setTimeout for Tuesday 09:30 is gone ❌

  // Server restarts at 08:00 (Tuesday)
  //   → scheduler.start() called
  //   → scheduleTradeScan() runs
  //   → now = 08:00, target = TODAY 09:30 (not past yet)
  //   → setTimeout(1.5 hours) ✅ — catches it!

  // Server restarts at 10:00 (Tuesday)
  //   → scheduleTradeScan() runs
  //   → now = 10:00, target = 09:30 (already past)
  //   → target pushed to TOMORROW 09:30
  //   → setTimeout(23.5 hours)
  //   → ⚠️ MISSED today's 9:30 scan

  private scheduleTradeScan(): void {
    const now = new Date();

    // Target 9:30 AM IST today
    const target = new Date(now);
    target.setHours(9, 30, 0, 0);

    // If already past 9:30, schedule for tomorrow
    if (now >= target) {
      target.setDate(target.getDate() + 1);
    }

    const msUntil = target.getTime() - now.getTime();

    this.tradeScanTimer = setTimeout(async () => {
      // Skip weekends (Saturday=6, Sunday=0)
      const day = new Date().getDay();
      if (day !== 0 && day !== 6) {
        await this.executeTradeScan().catch(() => {});
      }

      // Re-schedule for next day
      this.scheduleTradeScan();
    }, msUntil);

    const hoursUntil = (msUntil / 3600000).toFixed(1);
    console.log(
      `Trade scan scheduled in ${hoursUntil}h (${target.toLocaleString("en-IN")})`,
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Monitor Tick — Phases 3,5,6 (Dhan monitoring, runs hourly)        */
  /* ------------------------------------------------------------------ */

  private async monitorTick(): Promise<void> {
    await backoff(
      async () => {
        const {
          store,
          audit,
          tokens,
          dhan,
          tradeMonitor,
          tradeReconciliation,
        } = await this.initServices();

        try {
          const token = await tokens.getToken();
          if (!token) {
            await this.notifyNoToken(audit);
            return;
          }

          await audit.info(LifecycleEvents.DHAN_API_CALL, {
            action: "Scheduler.monitorTick",
            message: "Monitor tick started",
            timestamp: new Date().toISOString(),
          });

          // Phase 3: Monitor pending Forever Orders — attach OCO if TRADED
          await tradeMonitor.monitorPendingEntries(store, dhan, audit);

          // Phase 5: Monitor ENTERED trades — detect SL/target hits, manual exits
          await tradeMonitor.monitorEnteredTrades(store, dhan, audit);

          // Phase 6: Reconcile Dhan positions with local trades table
          await tradeReconciliation.reconcilePositions(store, dhan, audit);
        } finally {
          await store.disconnect();
        }
      },
      { retries: 3, baseMs: 250 },
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Shared helpers                                                     */
  /* ------------------------------------------------------------------ */

  private async initServices() {
    const store = new StateStore(this.cfg);
    const tradeSync = new TradeSyncService(this.cfg);
    const tradeEntry = new TradeEntryService(this.cfg);
    const tradeMonitor = new TradeMonitorService(this.cfg);
    const tradeReconciliation = new TradeReconciliationService(this.cfg);
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
        action: "Scheduler.initServices",
        error: "Failed to connect to Postgres DB",
        message: err?.message,
      });
      throw err;
    }

    // Upgrade audit with PG client now that connection is live
    audit = new AuditLogService(store.pg, this.telegram);
    const tokens = new TokenService(this.cfg, store, audit);
    const dhan = new DhanService(this.cfg, tokens, audit);

    // Inject services into TelegramService
    this.telegram.setTokenService(tokens);
    this.telegram.setAudit(audit);

    const instrumentLookup = new InstrumentLookupService(store.pg);

    return {
      store,
      audit,
      tokens,
      dhan,
      tradeSync,
      tradeEntry,
      tradeMonitor,
      tradeReconciliation,
      qtyResolver,
      tsl,
      instrumentLookup,
    };
  }

  private async notifyNoToken(audit: AuditLogService): Promise<void> {
    const msg =
      "⚠️ *Trading paused*: No valid Dhan access token\\.\n\n" +
      "Submit a token via:\n" +
      "• `/token YOUR_ACCESS_TOKEN`\n" +
      "• Or configure `DHAN_PIN` \\+ `DHAN_TOTP_SECRET` for auto\\-generation";
    await this.telegram.notify(msg, "MarkdownV2");
    await audit.critical(LifecycleEvents.ERROR_OCCURRED, {
      action: "Scheduler",
      error: "No valid token — trading paused",
    });
  }
}
