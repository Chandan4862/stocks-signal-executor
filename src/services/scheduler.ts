/*
  Scheduler: Three-cadence execution model.

  Trade scan (9:30 AM IST + /trade command):
    - Phase 2: runBuyAndInitialSl     (analyst active trades)
    - Phase 4: processClosedTrades    (analyst closed trades)

  Monitor (4x/day — 10:30, 12:00, 13:30, 15:00 IST):
    - Phase 3: monitorPendingEntries  (Dhan order status)
    - Phase 5: monitorEnteredTrades   (exit order status)

  Reconcile (once/day — 16:00 IST, after market close):
    - Phase 6: reconcilePositions     (safety net)
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
  private tradeScanTimer: NodeJS.Timeout | null = null;
  private monitorTimers: NodeJS.Timeout[] = [];
  private reconcileTimer: NodeJS.Timeout | null = null;

  // 4x/day during market hours (IST: HH:MM)
  private static readonly MONITOR_TIMES = ["10:30", "12:00", "13:30", "15:00"];
  // Once after market close
  private static readonly RECONCILE_TIME = "16:00";

  constructor(
    private cfg: AppConfig,
    private telegram: TelegramService,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  start() {
    if (this.tradeScanTimer) return;

    // 1. Schedule trade scan at 9:30 AM IST
    this.scheduleTradeScan();

    // 2. Schedule monitor ticks (Phases 3+5) 4x/day during market hours
    this.scheduleMonitorTicks();

    // 3. Schedule reconciliation (Phase 6) once after market close
    this.scheduleReconciliation();

    console.log(
      `Scheduler started:\n` +
        `  Trade scan: 09:30 IST\n` +
        `  Monitor:    ${Scheduler.MONITOR_TIMES.join(", ")} IST\n` +
        `  Reconcile:  ${Scheduler.RECONCILE_TIME} IST`,
    );
  }

  stop() {
    if (this.tradeScanTimer) {
      clearTimeout(this.tradeScanTimer);
      this.tradeScanTimer = null;
    }
    for (const t of this.monitorTimers) clearTimeout(t);
    this.monitorTimers = [];
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Trade Scan — Phases 2+4 (analyst API, runs at 9:30 AM + /trade)   */
  /* ------------------------------------------------------------------ */

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

  /**
   * Public: trigger monitor manually (called by Telegram /monitor command).
   * Runs Phases 3 + 5 (pending entries + entered trades).
   */
  async runMonitor(): Promise<string> {
    try {
      await this.executeMonitorTick();
      return "✅ Monitor tick completed successfully.";
    } catch (err: any) {
      return `❌ Monitor failed: ${err?.message ?? "unknown error"}`;
    }
  }

  /**
   * Public: trigger reconciliation manually (called by Telegram /reconcile command).
   * Runs Phase 6 (holdings reconciliation).
   */
  async runReconciliation(): Promise<string> {
    try {
      await this.executeReconciliation();
      return "✅ Reconciliation completed successfully.";
    } catch (err: any) {
      return `❌ Reconciliation failed: ${err?.message ?? "unknown error"}`;
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

          // // Phase 2: Actives — scan and place Forever Orders
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
  private scheduleTradeScan(): void {
    this.tradeScanTimer = this.scheduleAtIST("09:30", async () => {
      await this.executeTradeScan().catch(() => {});
      this.scheduleTradeScan(); // re-schedule for next day
    });
    this.logSchedule("Trade scan", "09:30");
  }

  /* ------------------------------------------------------------------ */
  /*  Monitor — Phases 3+5 (4x/day during market hours)                 */
  /* ------------------------------------------------------------------ */

  private scheduleMonitorTicks(): void {
    for (const t of this.monitorTimers) clearTimeout(t);
    this.monitorTimers = [];

    for (const time of Scheduler.MONITOR_TIMES) {
      const timer = this.scheduleAtIST(time, async () => {
        await this.executeMonitorTick().catch(() => {});
        // Re-schedule all after the last one fires
        this.scheduleMonitorTicks();
      });
      this.monitorTimers.push(timer);
      this.logSchedule("Monitor tick", time);
    }
  }

  private async executeMonitorTick(): Promise<void> {
    await backoff(
      async () => {
        const { store, audit, tokens, dhan, tradeMonitor } =
          await this.initServices();

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
        } finally {
          await store.disconnect();
        }
      },
      { retries: 3, baseMs: 250 },
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Reconcile — Phase 6 (once/day after market close, 16:00 IST)      */
  /* ------------------------------------------------------------------ */

  private scheduleReconciliation(): void {
    this.reconcileTimer = this.scheduleAtIST(
      Scheduler.RECONCILE_TIME,
      async () => {
        await this.executeReconciliation().catch(() => {});
        this.scheduleReconciliation(); // re-schedule for next day
      },
    );
    this.logSchedule("Reconciliation", Scheduler.RECONCILE_TIME);
  }

  private async executeReconciliation(): Promise<void> {
    await backoff(
      async () => {
        const { store, audit, tokens, dhan, tradeReconciliation } =
          await this.initServices();

        try {
          const token = await tokens.getToken();
          if (!token) {
            await this.notifyNoToken(audit);
            return;
          }

          await audit.info(LifecycleEvents.DHAN_API_CALL, {
            action: "Scheduler.reconciliation",
            message: "Post-market reconciliation started",
            timestamp: new Date().toISOString(),
          });

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
  /*  Scheduling helpers                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Schedule a callback at a specific IST time (HH:MM).
   * If the time has already passed today, schedules for tomorrow.
   * Skips weekends (Saturday=6, Sunday=0).
   */
  private scheduleAtIST(
    time: string,
    callback: () => Promise<void>,
  ): NodeJS.Timeout {
    const [hours, mins] = time.split(":").map(Number);
    const now = new Date();

    const target = new Date(now);
    target.setHours(hours, mins, 0, 0);

    // If already past this time today, schedule for tomorrow
    if (now >= target) {
      target.setDate(target.getDate() + 1);
    }

    const msUntil = target.getTime() - now.getTime();

    return setTimeout(async () => {
      // Skip weekends
      const day = new Date().getDay();
      if (day !== 0 && day !== 6) {
        await callback();
      } else {
        // Still re-schedule on weekends so Monday fires
        await callback(); // callback handles re-scheduling
      }
    }, msUntil);
  }

  private logSchedule(label: string, time: string): void {
    const [hours, mins] = time.split(":").map(Number);
    const now = new Date();
    const target = new Date(now);
    target.setHours(hours, mins, 0, 0);
    if (now >= target) target.setDate(target.getDate() + 1);
    const hoursUntil = ((target.getTime() - now.getTime()) / 3600000).toFixed(
      1,
    );
    console.log(
      `  ${label} scheduled in ${hoursUntil}h (${target.toLocaleString("en-IN")})`,
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
