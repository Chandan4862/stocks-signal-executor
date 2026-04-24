/*
  TradingHandler: Telegram command handlers for trade operations.

  Per-user commands (each user triggers jobs for themselves only):
    /enable, /disable, /status
    /trade, /monitor, /reconcile, /closedtrades
*/

import type { Queue } from "bullmq";
import type { UserContext } from "../middleware/userResolver";
import type { UserRepository } from "../../modules/user/userRepository";
import type Redis from "ioredis";
import type { TradeExecutionJob, TradeMonitorJob, ReconciliationJob } from "../../queues/jobs";
import { makeJobId, todayKey } from "../../queues/jobs";
import { QUEUE_NAMES } from "../../queues/queueRegistry";
import { TradeSyncService } from "../../services/tradeSyncService";
import type { AppConfig } from "../../config/schema";
import { DateTime } from "luxon";

export class TradingHandler {
  constructor(
    private userRepo: UserRepository,
    private redis: Redis,
    private queues: Map<string, Queue>,
    private cfg: AppConfig,
  ) {}

  /** /enable — Start auto-trading */
  async handleEnable(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user) return;

    if (user.status !== "ACTIVE") {
      await ctx.reply("❌ Complete setup first. Send /register");
      return;
    }

    // Check prerequisites
    if (!user.dhan_client_id) {
      await ctx.reply("❌ No Dhan client ID configured. Send /setup_broker <id>");
      return;
    }

    const token = await this.redis.get(`token:${user.id}`);
    if (!token && !user.dhan_credentials_enc) {
      await ctx.reply(
        "❌ No valid token or TOTP configured.\n" +
          "Send /setup_totp <pin> <secret> to enable auto-token generation.",
      );
      return;
    }

    await this.userRepo.setTradingEnabled(user.id, true);
    await ctx.reply(
      "🟢 Auto-trading ENABLED.\n" +
        "You'll receive signals starting next market open (09:20 IST).",
    );
  }

  /** /disable — Pause auto-trading */
  async handleDisable(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user) return;

    await this.userRepo.setTradingEnabled(user.id, false);
    await ctx.reply(
      "🔴 Auto-trading DISABLED.\n" +
        "Existing positions remain open. No new trades will be placed.",
    );
  }

  /** /status — Check token validity and trade counts */
  async handleStatus(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user) return;

    const token = await this.redis.get(`token:${user.id}`);
    const tokenTTL = token ? await this.redis.ttl(`token:${user.id}`) : 0;
    const activeTrades = await this.userRepo.countActiveTradesForUser(user.id);
    const capital = await this.userRepo.getDeployedCapitalForUser(user.id);

    const tokenStatus = token
      ? `✅ Valid (expires in ${Math.round(tokenTTL / 3600)}h)`
      : "❌ No token";

    const totpStatus = user.dhan_credentials_enc
      ? "✅ Configured (auto-renew)"
      : "❌ Not configured";

    await ctx.reply(
      `📊 Status\n\n` +
        `Trading: ${user.trading_enabled ? "🟢 ENABLED" : "🔴 DISABLED"}\n` +
        `Token: ${tokenStatus}\n` +
        `TOTP: ${totpStatus}\n` +
        `Active Trades: ${activeTrades}\n` +
        `Deployed Capital: ₹${capital.toFixed(2)}\n` +
        `Dhan Client: ${user.dhan_client_id ?? "Not set"}`,
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Per-user manual trigger commands                                    */
  /* ------------------------------------------------------------------ */

  /** /trade — Fetch signals & enqueue trade execution jobs for THIS user */
  async handleManualTrade(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user || !user.trading_enabled) {
      await ctx.reply("❌ Trading must be enabled first. Send /enable");
      return;
    }

    const token = await this.redis.get(`token:${user.id}`);
    if (!token) {
      await ctx.reply("❌ No valid token. Generate one first via /setup_totp");
      return;
    }

    const execQueue = this.queues.get(QUEUE_NAMES.TRADE_EXECUTION);
    if (!execQueue) {
      await ctx.reply("❌ Trade execution queue not available.");
      return;
    }

    await ctx.reply("🔄 Fetching signals and enqueuing trade jobs...");

    try {
      // Fetch shared signals
      const tradeSync = new TradeSyncService(this.cfg);
      const actives = await tradeSync.fetchActiveTrades();

      if (!actives || actives.length === 0) {
        await ctx.reply("ℹ️ No active signals found.");
        return;
      }

      const traceId = `manual-trade-${user.id}-${Date.now()}`;
      let enqueued = 0;

      for (const signal of actives) {
        //Math.random().toString(36).substring(2, 10)
        const jobId = makeJobId([
          "exec",
          user.id,
          signal.id,
          todayKey(),
          "manual",
          Math.random().toString(36).substring(2, 10),
        ]);
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

      await ctx.reply(
        `✅ Enqueued ${enqueued} trade execution job(s) for ${actives.length} signal(s).\n` +
          `Worker will process shortly.`,
      );
    } catch (err: any) {
      await ctx.reply(`❌ Trade scan error: ${err?.message ?? "unknown"}`);
    }
  }

  /** /monitor — Enqueue pending + entered monitor jobs for THIS user */
  async handleManualMonitor(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user || !user.trading_enabled) {
      await ctx.reply("❌ Trading must be enabled. Send /enable");
      return;
    }

    const token = await this.redis.get(`token:${user.id}`);
    if (!token) {
      await ctx.reply("❌ No valid token.");
      return;
    }

    const monitorQueue = this.queues.get(QUEUE_NAMES.TRADE_MONITOR);
    if (!monitorQueue) {
      await ctx.reply("❌ Monitor queue not available.");
      return;
    }

    const timeSlot = DateTime.now().setZone("Asia/Kolkata").toFormat("HHmm");
    const traceId = `manual-monitor-${user.id}-${Date.now()}`;

    await monitorQueue.add(
      "manual-pending",
      {
        userId: user.id,
        phase: "PENDING_ENTRIES" as const,
        traceId,
        enqueuedAt: new Date().toISOString(),
      } as TradeMonitorJob,
      { jobId: makeJobId(["monitor", user.id, "PENDING_ENTRIES", todayKey(), timeSlot, "manual"]) },
    );

    await monitorQueue.add(
      "manual-entered",
      {
        userId: user.id,
        phase: "ENTERED_TRADES" as const,
        traceId,
        enqueuedAt: new Date().toISOString(),
      } as TradeMonitorJob,
      { jobId: makeJobId(["monitor", user.id, "ENTERED_TRADES", todayKey(), timeSlot, "manual"]) },
    );

    await ctx.reply("✅ Monitor jobs enqueued (pending + entered). Worker will process shortly.");
  }

  /** /reconcile — Enqueue position reconciliation job for THIS user */
  async handleManualReconcile(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user || !user.trading_enabled) {
      await ctx.reply("❌ Trading must be enabled. Send /enable");
      return;
    }

    const token = await this.redis.get(`token:${user.id}`);
    if (!token) {
      await ctx.reply("❌ No valid token.");
      return;
    }

    const reconQueue = this.queues.get(QUEUE_NAMES.TRADE_RECONCILIATION);
    if (!reconQueue) {
      await ctx.reply("❌ Reconciliation queue not available.");
      return;
    }

    const traceId = `manual-recon-${user.id}-${Date.now()}`;
    const jobId = makeJobId(["recon", user.id, "POSITION_RECONCILE", todayKey(), "manual"]);

    await reconQueue.add(
      "reconciliation",
      {
        userId: user.id,
        phase: "POSITION_RECONCILE",
        traceId,
        enqueuedAt: new Date().toISOString(),
      } as ReconciliationJob,
      { jobId },
    );

    await ctx.reply("✅ Reconciliation job enqueued. Worker will cross-check your holdings.");
  }

  /** /closedtrades — Fetch closed signals & enqueue reconciliation for THIS user */
  async handleManualClosedTrades(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user || !user.trading_enabled) {
      await ctx.reply("❌ Trading must be enabled. Send /enable");
      return;
    }

    const token = await this.redis.get(`token:${user.id}`);
    if (!token) {
      await ctx.reply("❌ No valid token.");
      return;
    }

    const reconQueue = this.queues.get(QUEUE_NAMES.TRADE_RECONCILIATION);
    if (!reconQueue) {
      await ctx.reply("❌ Reconciliation queue not available.");
      return;
    }

    await ctx.reply("🔄 Fetching closed trade signals...");

    try {
      const tradeSync = new TradeSyncService(this.cfg);
      const closed = await tradeSync.fetchClosedTrades();

      if (!closed || closed.length === 0) {
        await ctx.reply("ℹ️ No closed signals found.");
        return;
      }

      const traceId = `manual-closed-${user.id}-${Date.now()}`;
      const jobId = makeJobId(["recon-closed", user.id, todayKey(), "manual"]);

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

      await ctx.reply(
        `✅ Found ${closed.length} closed signal(s). Reconciliation job enqueued.\n` +
          `Worker will cancel SL orders and exit positions.`,
      );
    } catch (err: any) {
      await ctx.reply(`❌ Closed trades scan error: ${err?.message ?? "unknown"}`);
    }
  }
}
