/*
  IpSyncWorker: Processes IP whitelist sync/fix jobs from the ip-sync queue.

  Job types:
  - IP_SYNC: Proactive sync (from /enable or /ip_whitelist_all)
  - IP_FIX: Reactive fix when workers detect ordersAllowed=false

  Rate limited: 2 req/s. Concurrency: 2.
*/

import { Worker, Queue, type Job } from "bullmq";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type { AppConfig } from "../config/schema";
import type { IpSyncJob, NotificationJob } from "../queues/jobs";
import { QUEUE_NAMES } from "../queues/queueRegistry";
import { IpWhitelistService } from "../services/ipWhitelistService";
import { AuditLogService } from "../services/auditLogService";
import { UserRepository } from "../modules/user/userRepository";

function getDhanBaseUrl(cfg: AppConfig): string {
  return process.env.DHAN_API_BASE_URL
    ? `${process.env.DHAN_API_BASE_URL}/v2`
    : "https://api.dhan.co/v2";
}

export function createIpSyncWorker(
  connection: Redis,
  cfg: AppConfig,
  pool: Pool,
  notificationQueue: Queue<NotificationJob>,
): Worker<IpSyncJob> {
  const worker = new Worker<IpSyncJob>(
    QUEUE_NAMES.IP_SYNC,
    async (job: Job<IpSyncJob>) => {
      const { userId, action } = job.data;

      const userRepo = new UserRepository(pool);
      const user = await userRepo.findById(userId);
      if (!user || user.status !== "ACTIVE") {
        return { skipped: true, reason: "User not active" };
      }
      if (!user.dhan_client_id) {
        return { skipped: true, reason: "No Dhan client ID" };
      }

      const token = await connection.get(`token:${userId}`);
      if (!token) {
        return { skipped: true, reason: "No valid token available" };
      }

      const audit = new AuditLogService(pool, notificationQueue, userId);
      const ipService = new IpWhitelistService(pool, connection, audit);
      const baseUrl = getDhanBaseUrl(cfg);

      const result = await ipService.syncUserIp(userId, user.dhan_client_id, token, baseUrl);

      // Alert on failure
      if (!result.ordersAllowed && result.action === "BLOCKED") {
        try {
          await notificationQueue.add("ip-alert", {
            userId,
            traceId: job.data.traceId,
            enqueuedAt: new Date().toISOString(),
            text:
              `🚨 IP Whitelist BLOCKED\n` +
              `User: ${user.display_name ?? user.telegram_username ?? `#${userId}`}\n` +
              `Client: ${user.dhan_client_id}\n` +
              `Action: ${action}\n` +
              `Error: ${result.error ?? "Unknown"}\n` +
              `Orders are blocked until IP is resolved.`,
            channel: "admin",
          });
        } catch {
          // Don't let notification failure propagate
        }
      }

      return result;
    },
    {
      connection,
      concurrency: 2,
      limiter: { max: 2, duration: 1000 },
    },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[IpSyncWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message,
    );
  });

  return worker;
}
