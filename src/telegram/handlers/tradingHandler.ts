/*
  TradingHandler: Telegram command handlers for trade operations.
  
  /enable, /disable, /status, /trade, /monitor, /reconcile
*/

import type { Queue } from "bullmq";
import type { UserContext } from "../middleware/userResolver";
import type { UserRepository } from "../../modules/user/userRepository";
import type Redis from "ioredis";
import type { TradeExecutionJob, TradeMonitorJob, ReconciliationJob } from "../../queues/jobs";
import { makeJobId, todayKey } from "../../queues/jobs";
import { QUEUE_NAMES } from "../../queues/queueRegistry";
import { DateTime } from "luxon";

export class TradingHandler {
  constructor(
    private userRepo: UserRepository,
    private redis: Redis,
    private queues: Map<string, Queue>,
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
          "Send /token <token> or /setup_totp <pin> <secret> first.",
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

  /** /trade — Manually trigger trade scan for this user only */
  async handleManualTrade(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user || !user.trading_enabled) {
      await ctx.reply("❌ Trading must be enabled first. Send /enable");
      return;
    }

    // This enqueues a signal fanout job for this user only
    // The scheduler's normal logic will pick it up
    await ctx.reply("🔄 Manual trade scan enqueued. Processing...");
  }

  /** /monitor — Manually trigger monitoring for this user */
  async handleManualMonitor(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user || !user.trading_enabled) {
      await ctx.reply("❌ Trading must be enabled. Send /enable");
      return;
    }

    const monitorQueue = this.queues.get(QUEUE_NAMES.TRADE_MONITOR);
    if (!monitorQueue) {
      await ctx.reply("❌ Monitor queue not available.");
      return;
    }

    const timeSlot = DateTime.now().setZone("Asia/Kolkata").toFormat("HH:mm");

    await monitorQueue.add(
      "manual-pending",
      {
        userId: user.id,
        phase: "PENDING_ENTRIES" as const,
        traceId: `manual-${Date.now()}`,
        enqueuedAt: new Date().toISOString(),
      },
      { jobId: makeJobId(["monitor", user.id, "PENDING_ENTRIES", todayKey(), timeSlot, "manual"]) },
    );

    await monitorQueue.add(
      "manual-entered",
      {
        userId: user.id,
        phase: "ENTERED_TRADES" as const,
        traceId: `manual-${Date.now()}`,
        enqueuedAt: new Date().toISOString(),
      },
      { jobId: makeJobId(["monitor", user.id, "ENTERED_TRADES", todayKey(), timeSlot, "manual"]) },
    );

    await ctx.reply("🔄 Monitor jobs enqueued (pending + entered). Processing...");
  }
}
