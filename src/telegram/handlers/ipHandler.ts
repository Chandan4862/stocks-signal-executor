/*
  IpHandler: Telegram command handlers for IP whitelisting management.

  Per-user commands:
    /ip_status — View current IP whitelist state
    /ip_sync   — Trigger manual IP sync for yourself

  Admin commands:
    /ip_whitelist_all — Enqueue IP sync jobs for ALL active users
*/

import type { Queue } from "bullmq";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { UserContext } from "../middleware/userResolver";
import { IpWhitelistService } from "../../services/ipWhitelistService";
import { AuditLogService } from "../../services/auditLogService";
import { UserRepository } from "../../modules/user/userRepository";
import type { IpSyncJob } from "../../queues/jobs";
import { makeJobId, todayKey } from "../../queues/jobs";
import { QUEUE_NAMES } from "../../queues/queueRegistry";

export class IpHandler {
  constructor(
    private pool: Pool,
    private redis: Redis,
    private queues: Map<string, Queue>,
    private adminChatId: string,
  ) {}

  /** /ip_status — Show IP whitelist state for the calling user */
  async handleIpStatus(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user) return;

    if (!user.dhan_client_id) {
      await ctx.reply("❌ No Dhan client ID configured. Send /setup_broker <id>");
      return;
    }

    const audit = new AuditLogService(this.pool, null, user.id);
    const ipService = new IpWhitelistService(this.pool, this.redis, audit);

    const dbState = await ipService.getDbStatus(user.id);
    const cached = await ipService.getCachedStatus(user.id);

    if (!dbState && !cached) {
      await ctx.reply(
        `📡 IP Whitelist Status\n\n` +
          `No IP whitelist data yet.\n` +
          `Run /ip_sync to perform initial sync with Dhan.`,
      );
      return;
    }

    const lines: string[] = [`📡 IP Whitelist Status\n`];

    if (dbState) {
      lines.push(`Orders Allowed: ${dbState.orders_allowed ? "✅ Yes" : "🚫 No"}`);
      lines.push(`IP Match: ${dbState.ip_match_status ?? "Unknown"}`);
      lines.push(`Detected IP: ${dbState.detected_ip ?? "—"}`);
      lines.push(`Primary IP: ${dbState.primary_ip ?? "—"}`);
      lines.push(`Secondary IP: ${dbState.secondary_ip ?? "—"}`);
      lines.push(``);

      const primaryCooldown = dbState.modify_date_primary
        ? `modifiable after ${dbState.modify_date_primary}`
        : "available";
      const secondaryCooldown = dbState.modify_date_secondary
        ? `modifiable after ${dbState.modify_date_secondary}`
        : "available";
      lines.push(`Primary Slot: ${primaryCooldown}`);
      lines.push(`Secondary Slot: ${secondaryCooldown}`);
      lines.push(``);

      lines.push(
        `Last Synced: ${dbState.last_synced_at ? new Date(dbState.last_synced_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "Never"}`,
      );
      if (dbState.last_set_at) {
        lines.push(
          `Last Set: ${new Date(dbState.last_set_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} (${dbState.last_set_slot})`,
        );
      }
      if (dbState.sync_error) {
        lines.push(`\n⚠️ Last Error: ${dbState.sync_error}`);
      }
    }

    if (cached) {
      lines.push(`\n📦 Cache: ordersAllowed=${cached.ordersAllowed}, synced=${cached.syncedAt}`);
    }

    await ctx.reply(lines.join("\n"));
  }

  /** /ip_sync — Trigger manual IP sync for the calling user */
  async handleIpSync(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user) return;

    if (!user.dhan_client_id) {
      await ctx.reply("❌ No Dhan client ID configured. Send /setup_broker <id>");
      return;
    }

    const token = await this.redis.get(`token:${user.id}`);
    if (!token) {
      await ctx.reply("❌ No valid token. Generate one first via /setup_totp");
      return;
    }

    const ipSyncQueue = this.queues.get(QUEUE_NAMES.IP_SYNC);
    if (!ipSyncQueue) {
      await ctx.reply("❌ IP sync queue not available.");
      return;
    }

    const jobId = makeJobId(["ip-sync", user.id, todayKey(), "manual", Date.now()]);
    await ipSyncQueue.add(
      "ip-sync",
      {
        userId: user.id,
        action: "IP_SYNC",
        dhanClientId: user.dhan_client_id,
        traceId: `manual-ip-sync-${user.id}-${Date.now()}`,
        enqueuedAt: new Date().toISOString(),
      } as IpSyncJob,
      { jobId },
    );

    await ctx.reply(
      "🔄 IP sync job enqueued.\nWorker will check and fix your IP whitelist shortly.",
    );
  }

  /** /ip_whitelist_all — Admin: enqueue IP sync jobs for ALL active users */
  async handleIpWhitelistAll(ctx: UserContext): Promise<void> {
    // Admin-only check
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== this.adminChatId) {
      await ctx.reply("❌ This command is admin-only.");
      return;
    }

    const ipSyncQueue = this.queues.get(QUEUE_NAMES.IP_SYNC);
    if (!ipSyncQueue) {
      await ctx.reply("❌ IP sync queue not available.");
      return;
    }

    const userRepo = new UserRepository(this.pool);
    const users = await userRepo.getActiveUsers();

    const traceId = `admin-ip-whitelist-all-${Date.now()}`;
    let enqueued = 0;

    for (const user of users) {
      if (!user.dhan_client_id) continue;

      // Only sync for users with a valid token
      const hasToken = await this.redis.exists(`token:${user.id}`);
      if (!hasToken) continue;

      const jobId = makeJobId(["ip-sync", user.id, todayKey(), "admin", Date.now()]);
      await ipSyncQueue.add(
        "ip-sync",
        {
          userId: user.id,
          action: "IP_SYNC",
          dhanClientId: user.dhan_client_id,
          traceId,
          enqueuedAt: new Date().toISOString(),
        } as IpSyncJob,
        { jobId },
      );
      enqueued++;
    }

    await ctx.reply(
      `✅ Enqueued ${enqueued} IP sync job(s) for active users.\n` +
        `Worker will process each user's IP whitelist.`,
    );
  }
}
