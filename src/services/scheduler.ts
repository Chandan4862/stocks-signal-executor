/*
  Scheduler: Three-cadence execution model.

  Trade scan (9:30 AM IST + /trade command):
    - Phase 2: runBuyAndInitialSl     (analyst active trades)

  Monitor (hourly: 10:00–15:00 IST + /monitor command):
    - Phase 3: monitorPendingEntries  (Dhan order status)
    - Phase 5: monitorEnteredTrades   (holdings-based sell)

  Closed trades scan (15:00 IST):
    - Phase 4: processClosedTrades    (analyst closed trades)

  Reconcile (once/day — 16:00 IST, after market close):
    - Phase 6: reconcilePositions     (safety net)
*/

import { DateTime } from "luxon";
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
import { ConfigService } from "./configService";
import { TelegramService } from "./telegramService";
import { LifecycleEvents } from "../enums/trade";

export class Scheduler {
  private tradeScanTimer: NodeJS.Timeout | null = null;
  private pendingEntryTimers: NodeJS.Timeout[] = [];
  private enteredTradeTimers: NodeJS.Timeout[] = [];
  private closedTradesTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;

  // Pending entries: 10:00–14:00 (entries rarely trigger after 14:00)
  private static readonly PENDING_ENTRY_TIMES = ["10:00", "11:00", "12:00", "13:00", "14:00"];
  // Entered trades: 11:00–15:00 (LTP needs time to settle; 15:00 is last sell window)
  private static readonly ENTERED_TRADE_TIMES = ["11:00", "12:00", "13:00", "14:00", "15:00"];
  // Before market close (1h buffer before 15:30)
  private static readonly CLOSED_TRADES_TIME = "14:30";
  // After market close
  private static readonly RECONCILE_TIME = "16:00";

  constructor(
    private cfg: AppConfig,
    private telegram: TelegramService,
    private configSvc: ConfigService,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  start() {
    if (this.tradeScanTimer) return;

    // 1. Schedule trade scan at 09:20 AM IST (Phase 2 only)
    this.scheduleTradeScan();

    // 2. Schedule pending entry monitor (Phase 3) — 10:00–14:00
    this.schedulePendingEntryMonitor();

    // 3. Schedule entered trade monitor (Phase 5) — 11:00–15:00
    this.scheduleEnteredTradeMonitor();

    // 4. Schedule closed trades scan (Phase 4) at 14:30 IST
    this.scheduleClosedTradesScan();

    // 5. Schedule reconciliation (Phase 6) once after market close
    this.scheduleReconciliation();

    console.log(
      `Scheduler started:\n` +
        `  Trade scan:      09:20 IST\n` +
        `  Pending entries: ${Scheduler.PENDING_ENTRY_TIMES.join(", ")} IST\n` +
        `  Entered trades:  ${Scheduler.ENTERED_TRADE_TIMES.join(", ")} IST\n` +
        `  Closed trades:   ${Scheduler.CLOSED_TRADES_TIME} IST\n` +
        `  Reconcile:       ${Scheduler.RECONCILE_TIME} IST`,
    );
  }

  stop() {
    if (this.tradeScanTimer) {
      clearTimeout(this.tradeScanTimer);
      this.tradeScanTimer = null;
    }
    for (const t of this.pendingEntryTimers) clearTimeout(t);
    this.pendingEntryTimers = [];
    for (const t of this.enteredTradeTimers) clearTimeout(t);
    this.enteredTradeTimers = [];
    if (this.closedTradesTimer) {
      clearTimeout(this.closedTradesTimer);
      this.closedTradesTimer = null;
    }
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Trade Scan — Phase 2 (analyst active trades, runs at 9:30 AM)     */
  /* ------------------------------------------------------------------ */

  /**
   * Public: trigger trade scan manually (called by Telegram /trade command).
   * Runs Phase 2 only (fetch active trades, place Forever BUY orders).
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
   * Runs Phases 3 + 5 (pending entries + holdings-based sell).
   */
  async runMonitor(): Promise<string> {
    try {
      await this.executePendingEntryMonitor();
      await this.executeEnteredTradeMonitor();
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
          configSvc,
          tradeSync,
          tradeEntry,
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
            configSvc,
          );
        } finally {
          await store.disconnect();
        }
      },
      { retries: 3, baseMs: 250 },
    );
  }

  /** Schedule next 09:20 AM IST run. Re-schedules itself daily. */
  private scheduleTradeScan(): void {
    this.tradeScanTimer = this.scheduleAtIST("09:20", async () => {
      await this.executeTradeScan().catch(() => {});
      this.scheduleTradeScan(); // re-schedule for next day
    });
    this.logSchedule("Trade scan", "09:20");
  }

  /* ------------------------------------------------------------------ */
  /*  Monitor — Phase 3: Pending Entries (10:00–14:00 IST)              */
  /* ------------------------------------------------------------------ */

  private schedulePendingEntryMonitor(): void {
    for (const t of this.pendingEntryTimers) clearTimeout(t);
    this.pendingEntryTimers = [];

    for (const time of Scheduler.PENDING_ENTRY_TIMES) {
      const timer = this.scheduleAtIST(time, async () => {
        await this.executePendingEntryMonitor().catch(() => {});
        this.schedulePendingEntryMonitor();
      });
      this.pendingEntryTimers.push(timer);
      this.logSchedule("Pending entries", time);
    }
  }

  private async executePendingEntryMonitor(): Promise<void> {
    await backoff(
      async () => {
        const { store, audit, tokens, dhan, tradeMonitor } = await this.initServices();

        try {
          const token = await tokens.getToken();
          if (!token) {
            await this.notifyNoToken(audit);
            return;
          }

          await audit.info(LifecycleEvents.DHAN_API_CALL, {
            action: "Scheduler.pendingEntryMonitor",
            message: "Pending entry monitor started",
            timestamp: new Date().toISOString(),
          });

          // Phase 3: Monitor pending Forever Orders — mark ENTERED if TRADED
          await tradeMonitor.monitorPendingEntries(store, dhan, audit);
        } finally {
          await store.disconnect();
        }
      },
      { retries: 3, baseMs: 250 },
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Monitor — Phase 5: Entered Trades (11:00–15:00 IST)              */
  /* ------------------------------------------------------------------ */

  private scheduleEnteredTradeMonitor(): void {
    for (const t of this.enteredTradeTimers) clearTimeout(t);
    this.enteredTradeTimers = [];

    for (const time of Scheduler.ENTERED_TRADE_TIMES) {
      const timer = this.scheduleAtIST(time, async () => {
        await this.executeEnteredTradeMonitor().catch(() => {});
        this.scheduleEnteredTradeMonitor();
      });
      this.enteredTradeTimers.push(timer);
      this.logSchedule("Entered trades", time);
    }
  }

  private async executeEnteredTradeMonitor(): Promise<void> {
    await backoff(
      async () => {
        const { store, audit, tokens, dhan, tradeMonitor } = await this.initServices();

        try {
          const token = await tokens.getToken();
          if (!token) {
            await this.notifyNoToken(audit);
            return;
          }

          await audit.info(LifecycleEvents.DHAN_API_CALL, {
            action: "Scheduler.enteredTradeMonitor",
            message: "Entered trade monitor started",
            timestamp: new Date().toISOString(),
          });

          // Phase 5: Monitor ENTERED trades — check holdings, sell if target/SL hit
          await tradeMonitor.monitorEnteredTrades(store, dhan, audit);
        } finally {
          await store.disconnect();
        }
      },
      { retries: 3, baseMs: 250 },
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Closed Trades — Phase 4 (14:30 IST, before market close)          */
  /* ------------------------------------------------------------------ */

  private scheduleClosedTradesScan(): void {
    this.closedTradesTimer = this.scheduleAtIST(Scheduler.CLOSED_TRADES_TIME, async () => {
      await this.executeClosedTradesScan().catch(() => {});
      this.scheduleClosedTradesScan(); // re-schedule for next day
    });
    this.logSchedule("Closed trades scan", Scheduler.CLOSED_TRADES_TIME);
  }

  private async executeClosedTradesScan(): Promise<void> {
    await backoff(
      async () => {
        const { store, audit, tokens, dhan, tradeSync, tradeReconciliation } =
          await this.initServices();

        try {
          const token = await tokens.getToken();
          if (!token) {
            await this.notifyNoToken(audit);
            return;
          }

          await audit.info(LifecycleEvents.DHAN_API_CALL, {
            action: "Scheduler.closedTradesScan",
            message: "Closed trades scan started",
            timestamp: new Date().toISOString(),
          });

          // Phase 4: Handle external closures from Closed API
          const closed = await tradeSync.fetchClosedTrades();
          await tradeReconciliation.processClosedTrades(store, dhan, audit, closed);
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
    this.reconcileTimer = this.scheduleAtIST(Scheduler.RECONCILE_TIME, async () => {
      await this.executeReconciliation().catch(() => {});
      this.scheduleReconciliation(); // re-schedule for next day
    });
    this.logSchedule("Reconciliation", Scheduler.RECONCILE_TIME);
  }

  private async executeReconciliation(): Promise<void> {
    await backoff(
      async () => {
        const { store, audit, tokens, dhan, tradeReconciliation } = await this.initServices();

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
  private scheduleAtIST(time: string, callback: () => Promise<void>): NodeJS.Timeout {
    const [hours, mins] = time.split(":").map(Number);
    const IST = "Asia/Kolkata";

    let target = DateTime.now()
      .setZone(IST)
      .set({ hour: hours, minute: mins, second: 0, millisecond: 0 });

    // If already past this time today (in IST), schedule for tomorrow
    if (target <= DateTime.now().setZone(IST)) {
      target = target.plus({ days: 1 });
    }

    const msUntil = target.toMillis() - Date.now();

    return setTimeout(async () => {
      // Skip weekends (IST day)
      const day = DateTime.now().setZone(IST).weekday; // 1=Mon, 7=Sun
      if (day !== 6 && day !== 7) {
        await callback();
      } else {
        // Still re-schedule on weekends so Monday fires
        await callback(); // callback handles re-scheduling
      }
    }, msUntil);
  }

  private logSchedule(label: string, time: string): void {
    const [hours, mins] = time.split(":").map(Number);
    const IST = "Asia/Kolkata";

    let target = DateTime.now()
      .setZone(IST)
      .set({ hour: hours, minute: mins, second: 0, millisecond: 0 });

    if (target <= DateTime.now().setZone(IST)) {
      target = target.plus({ days: 1 });
    }

    const hoursUntil = ((target.toMillis() - Date.now()) / 3600000).toFixed(1);
    console.log(
      `  ${label} scheduled in ${hoursUntil}h (${target.toFormat("dd/MM/yyyy, hh:mm:ss a")} IST)`,
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

    // Reload runtime trading config from DB (picks up any /config changes)
    await this.configSvc.load();

    // TSL uses DB-backed config values (freshly loaded)
    const tsl = new TSLService(this.configSvc.tsl);

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
      configSvc: this.configSvc,
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
