/*
  Scheduler: Multi-tenant enqueue-only model.

  Instead of executing trades directly, the scheduler now:
  1. Fetches shared signals (active/closed trades from analyst API)
  2. Looks up all active users with trading enabled
  3. Enqueues per-user jobs into BullMQ queues

  Workers (separate process) pick up and execute the jobs.

  Cadences remain the same:
    09:00 — Market closed check
    09:20 — Trade scan → signal-fanout → per-user trade-execution jobs
    10:00–14:00 — Pending entry monitor → per-user trade-monitor jobs
    11:00–15:00 — Entered trade monitor → per-user trade-monitor jobs
    14:30 — Closed trades scan → per-user reconciliation jobs
    16:00 — Position reconciliation → per-user reconciliation jobs
*/

import { DateTime } from "luxon";
import type { Queue } from "bullmq";
import type Redis from "ioredis";
import type { AppConfig } from "../config/schema";
import { backoff } from "../utils/retry";
import { StateStore } from "./stateStore";
import { TradeSyncService } from "./tradeSyncService";
import { AuditLogService } from "./auditLogService";
import { HolidayService } from "./holidayService";
import { ConfigService } from "./configService";
import { TelegramService } from "./telegramService";
import { LifecycleEvents } from "../enums/trade";
import { UserRepository } from "../modules/user/userRepository";
import { QUEUE_NAMES, type QueueName } from "../queues/queueRegistry";
import {
  makeJobId,
  todayKey,
  type TradeExecutionJob,
  type TradeMonitorJob,
  type ReconciliationJob,
  type TokenRenewalJob,
} from "../queues/jobs";

export class Scheduler {
  private tradeScanTimer: NodeJS.Timeout | null = null;
  private pendingEntryTimers: NodeJS.Timeout[] = [];
  private enteredTradeTimers: NodeJS.Timeout[] = [];
  private closedTradesTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private marketClosedCheckTimer: NodeJS.Timeout | null = null;
  private tokenRenewalTimer: NodeJS.Timeout | null = null;

  /** Set daily at 09:00 IST — true if today is a weekend or holiday */
  private marketClosedToday = false;

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
    private queues: Map<QueueName, Queue>,
    private store: StateStore,
    private redis: Redis,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  start() {
    if (this.tradeScanTimer) return;

    // 0. Schedule market-closed check at 09:00 IST
    this.scheduleMarketClosedCheck();

    // 1. Schedule trade scan at 09:20 AM IST
    this.scheduleTradeScan();

    // 2. Schedule pending entry monitor — 10:00–14:00
    this.schedulePendingEntryMonitor();

    // 3. Schedule entered trade monitor — 11:00–15:00
    this.scheduleEnteredTradeMonitor();

    // 4. Schedule closed trades scan at 14:30 IST
    this.scheduleClosedTradesScan();

    // 5. Schedule reconciliation at 16:00 IST
    this.scheduleReconciliation();

    // 6. Schedule daily token renewal at 08:00 IST
    this.scheduleTokenRenewal();

    console.log(
      `Scheduler started (enqueue-only mode):\n` +
        `  Market check:    09:00 IST\n` +
        `  Token renewal:   08:00 IST\n` +
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
    if (this.marketClosedCheckTimer) {
      clearTimeout(this.marketClosedCheckTimer);
      this.marketClosedCheckTimer = null;
    }
    if (this.tokenRenewalTimer) {
      clearTimeout(this.tokenRenewalTimer);
      this.tokenRenewalTimer = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Trade Scan — Fan out signals to per-user execution jobs            */
  /* ------------------------------------------------------------------ */

  async runTradeScan(): Promise<string> {
    try {
      await this.enqueueTradeEntry();
      return "✅ Trade scan completed — jobs enqueued for all active users.";
    } catch (err: any) {
      return `❌ Trade scan failed: ${err?.message ?? "unknown error"}`;
    }
  }

  async runMonitor(): Promise<string> {
    try {
      await this.enqueueMonitorJobs("PENDING_ENTRIES");
      await this.enqueueMonitorJobs("ENTERED_TRADES");
      return "✅ Monitor jobs enqueued for all active users.";
    } catch (err: any) {
      return `❌ Monitor enqueue failed: ${err?.message ?? "unknown error"}`;
    }
  }

  async runReconciliation(): Promise<string> {
    try {
      await this.enqueueReconciliationJobs("POSITION_RECONCILE");
      return "✅ Reconciliation jobs enqueued for all active users.";
    } catch (err: any) {
      return `❌ Reconciliation enqueue failed: ${err?.message ?? "unknown error"}`;
    }
  }

  async runClosedTradesScan(): Promise<string> {
    try {
      await this.executeClosedTradesScan();
      return "✅ Closed trades scan completed — reconciliation jobs enqueued.";
    } catch (err: any) {
      return `❌ Closed trades scan failed: ${err?.message ?? "unknown error"}`;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Signal Fanout: Fetch signals → enqueue per-user trade-exec jobs    */
  /* ------------------------------------------------------------------ */

  private async enqueueTradeEntry(): Promise<void> {
    if (this.marketClosedToday) {
      console.log("  ⏸ Trade scan skipped (market closed today)");
      return;
    }

    const notifQueue = this.queues.get(QUEUE_NAMES.NOTIFICATION) ?? null;
    const audit = new AuditLogService(this.store.pg, notifQueue);
    const tradeSync = new TradeSyncService(this.cfg);
    const userRepo = new UserRepository(this.store.pool);

    await audit.info(LifecycleEvents.DHAN_API_CALL, {
      action: "Scheduler.tradeScan",
      message: "Trade scan started (enqueue-only)",
      timestamp: new Date().toISOString(),
    });

    // 1. Fetch shared signals (one API call, shared across all users)
    const actives = await tradeSync.fetchActiveTrades();
    if (!actives || actives.length === 0) {
      await audit.info(LifecycleEvents.DHAN_API_CALL, {
        action: "Scheduler.tradeScan",
        message: "No active signals found",
      });
      return;
    }

    // 2. Get all active users with trading enabled
    const users = await userRepo.getActiveUsers();
    if (users.length === 0) {
      await audit.info(LifecycleEvents.DHAN_API_CALL, {
        action: "Scheduler.tradeScan",
        message: "No active users found",
      });
      return;
    }

    // 3. Enqueue per-user trade execution jobs (one job per user × signal)
    const execQueue = this.queues.get(QUEUE_NAMES.TRADE_EXECUTION);
    if (!execQueue) throw new Error("Trade execution queue not found");

    const traceId = `scan-${todayKey()}-${Date.now()}`;
    let enqueued = 0;

    for (const user of users) {
      // Check if user has a valid token in Redis
      const hasToken = await this.redis.exists(`token:${user.id}`);
      if (!hasToken) continue;

      for (const signal of actives) {
        const jobId = makeJobId(["exec", user.id, signal.id, todayKey()]);
        await execQueue.add(
          "trade-entry",
          {
            userId: user.id,
            phase: "ENTRY",
            signal,
            traceId,
            enqueuedAt: new Date().toISOString(),
          } as TradeExecutionJob,
          { jobId },
        );
        enqueued++;
      }
    }

    await audit.info(LifecycleEvents.DHAN_API_CALL, {
      action: "Scheduler.tradeScan",
      message: `Enqueued ${enqueued} trade execution jobs for ${users.length} users × ${actives.length} signals`,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Monitor: Enqueue per-user monitor jobs                             */
  /* ------------------------------------------------------------------ */

  private async enqueueMonitorJobs(phase: "PENDING_ENTRIES" | "ENTERED_TRADES"): Promise<void> {
    if (this.marketClosedToday) {
      console.log(`  ⏸ Monitor (${phase}) skipped (market closed today)`);
      return;
    }

    const userRepo = new UserRepository(this.store.pool);
    const users = await userRepo.getActiveUsers();
    const monitorQueue = this.queues.get(QUEUE_NAMES.TRADE_MONITOR);
    if (!monitorQueue) return;

    const timeSlot = DateTime.now().setZone("Asia/Kolkata").toFormat("HHmm");
    const traceId = `mon-${phase}-${todayKey()}-${timeSlot}`;

    for (const user of users) {
      const hasToken = await this.redis.exists(`token:${user.id}`);
      if (!hasToken) continue;

      const jobId = makeJobId(["monitor", user.id, phase, todayKey(), timeSlot]);
      await monitorQueue.add(
        "monitor",
        {
          userId: user.id,
          phase,
          traceId,
          enqueuedAt: new Date().toISOString(),
        } as TradeMonitorJob,
        { jobId },
      );
    }

    console.log(`  📤 Enqueued ${phase} monitor jobs for ${users.length} users`);
  }

  /* ------------------------------------------------------------------ */
  /*  Closed Trades: Fetch closed signals → enqueue recon jobs           */
  /* ------------------------------------------------------------------ */

  private async executeClosedTradesScan(): Promise<void> {
    if (this.marketClosedToday) {
      console.log("  ⏸ Closed trades scan skipped (market closed today)");
      return;
    }

    const tradeSync = new TradeSyncService(this.cfg);
    const userRepo = new UserRepository(this.store.pool);

    const closed = await tradeSync.fetchClosedTrades();
    if (!closed || closed.length === 0) return;

    const users = await userRepo.getActiveUsers();
    const reconQueue = this.queues.get(QUEUE_NAMES.TRADE_RECONCILIATION);
    if (!reconQueue) return;

    const traceId = `closed-${todayKey()}-${Date.now()}`;

    for (const user of users) {
      const hasToken = await this.redis.exists(`token:${user.id}`);
      if (!hasToken) continue;

      const jobId = makeJobId(["recon-closed", user.id, todayKey()]);
      await reconQueue.add(
        "closed-trades",
        {
          userId: user.id,
          phase: "CLOSED_TRADES",
          closedSignals: closed,
          traceId,
          enqueuedAt: new Date().toISOString(),
        } as ReconciliationJob,
        { jobId },
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Reconciliation: Enqueue per-user reconciliation jobs               */
  /* ------------------------------------------------------------------ */

  private async enqueueReconciliationJobs(
    phase: "CLOSED_TRADES" | "POSITION_RECONCILE",
  ): Promise<void> {
    const userRepo = new UserRepository(this.store.pool);
    const users = await userRepo.getActiveUsers();
    const reconQueue = this.queues.get(QUEUE_NAMES.TRADE_RECONCILIATION);
    if (!reconQueue) return;

    const traceId = `recon-${phase}-${todayKey()}-${Date.now()}`;

    for (const user of users) {
      const hasToken = await this.redis.exists(`token:${user.id}`);
      if (!hasToken) continue;

      const jobId = makeJobId(["recon", user.id, phase, todayKey()]);
      await reconQueue.add(
        "reconciliation",
        {
          userId: user.id,
          phase,
          traceId,
          enqueuedAt: new Date().toISOString(),
        } as ReconciliationJob,
        { jobId },
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Token Renewal: Proactive daily renewal for all users               */
  /* ------------------------------------------------------------------ */

  private scheduleTokenRenewal(): void {
    this.tokenRenewalTimer = this.scheduleAtIST("08:00", async () => {
      await this.enqueueTokenRenewalJobs().catch(() => {});
      this.scheduleTokenRenewal();
    });
    this.logSchedule("Token renewal", "08:00");
  }

  private async enqueueTokenRenewalJobs(): Promise<void> {
    console.log("Enqueuing token renewal jobs for all active users");
    const userRepo = new UserRepository(this.store.pool);
    const users = await userRepo.getActiveUsers();
    const tokenQueue = this.queues.get(QUEUE_NAMES.TOKEN_RENEWAL);
    if (!tokenQueue) return;

    const traceId = `token-${todayKey()}`;

    for (const user of users) {
      // Only renew for users with TOTP credentials
      if (!user.dhan_credentials_enc) continue;

      const jobId = makeJobId(["token-renew", user.id, todayKey()]);
      await tokenQueue.add(
        "proactive-renew",
        {
          userId: user.id,
          action: "GENERATE_TOTP",
          traceId,
          enqueuedAt: new Date().toISOString(),
        } as TokenRenewalJob,
        { jobId },
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Market Closed Check — 09:00 IST daily                             */
  /* ------------------------------------------------------------------ */

  private scheduleMarketClosedCheck(): void {
    this.marketClosedCheckTimer = this.scheduleAtIST("09:00", async () => {
      await this.executeMarketClosedCheck().catch(() => {});
      this.scheduleMarketClosedCheck(); // re-schedule for next day
    });
    this.logSchedule("Market closed check", "09:00");
  }

  private async executeMarketClosedCheck(): Promise<void> {
    try {
      const holidaySvc = new HolidayService(this.store.pg);
      const result = await holidaySvc.isMarketClosed();

      this.marketClosedToday = result.closed;

      if (result.closed) {
        console.log(`📅 Market closed today: ${result.reason}`);

        if (result.type === "holiday") {
          const today = DateTime.now().setZone("Asia/Kolkata").toFormat("dd-MMM-yyyy");
          await this.telegram.notify(
            `📅 *Market closed today* — ${result.reason} \\(${today}\\)\n\n` +
              `Trading schedules are paused for the day\\.`,
            "MarkdownV2",
          );
        }
      } else {
        console.log("✅ Market open today — all schedules active");
      }
    } catch (err: any) {
      this.marketClosedToday = false;
      console.error("Market closed check failed (assuming open):", err?.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Schedule Timers                                                    */
  /* ------------------------------------------------------------------ */

  private scheduleTradeScan(): void {
    this.tradeScanTimer = this.scheduleAtIST("09:20", async () => {
      await this.enqueueTradeEntry().catch(() => {});
      this.scheduleTradeScan();
    });
    this.logSchedule("Trade scan", "09:20");
  }

  private schedulePendingEntryMonitor(): void {
    for (const t of this.pendingEntryTimers) clearTimeout(t);
    this.pendingEntryTimers = [];

    for (const time of Scheduler.PENDING_ENTRY_TIMES) {
      const timer = this.scheduleAtIST(time, async () => {
        await this.enqueueMonitorJobs("PENDING_ENTRIES").catch(() => {});
        this.schedulePendingEntryMonitor();
      });
      this.pendingEntryTimers.push(timer);
      this.logSchedule("Pending entries", time);
    }
  }

  private scheduleEnteredTradeMonitor(): void {
    for (const t of this.enteredTradeTimers) clearTimeout(t);
    this.enteredTradeTimers = [];

    for (const time of Scheduler.ENTERED_TRADE_TIMES) {
      const timer = this.scheduleAtIST(time, async () => {
        await this.enqueueMonitorJobs("ENTERED_TRADES").catch(() => {});
        this.scheduleEnteredTradeMonitor();
      });
      this.enteredTradeTimers.push(timer);
      this.logSchedule("Entered trades", time);
    }
  }

  private scheduleClosedTradesScan(): void {
    this.closedTradesTimer = this.scheduleAtIST(Scheduler.CLOSED_TRADES_TIME, async () => {
      await this.executeClosedTradesScan().catch(() => {});
      this.scheduleClosedTradesScan();
    });
    this.logSchedule("Closed trades scan", Scheduler.CLOSED_TRADES_TIME);
  }

  private scheduleReconciliation(): void {
    this.reconcileTimer = this.scheduleAtIST(Scheduler.RECONCILE_TIME, async () => {
      await this.enqueueReconciliationJobs("POSITION_RECONCILE").catch(() => {});
      this.scheduleReconciliation();
    });
    this.logSchedule("Reconciliation", Scheduler.RECONCILE_TIME);
  }

  /* ------------------------------------------------------------------ */
  /*  Scheduling helpers                                                 */
  /* ------------------------------------------------------------------ */

  private scheduleAtIST(time: string, callback: () => Promise<void>): NodeJS.Timeout {
    const [hours, mins] = time.split(":").map(Number);
    const IST = "Asia/Kolkata";

    let target = DateTime.now()
      .setZone(IST)
      .set({ hour: hours, minute: mins, second: 0, millisecond: 0 });

    if (target <= DateTime.now().setZone(IST)) {
      target = target.plus({ days: 1 });
    }

    const msUntil = target.toMillis() - Date.now();

    return setTimeout(async () => {
      const day = DateTime.now().setZone(IST).weekday; // 1=Mon, 7=Sun
      if (day !== 6 && day !== 7) {
        await callback();
      } else {
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
}
