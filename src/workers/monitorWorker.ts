/*
  MonitorWorker: Processes trade monitoring jobs from the trade-monitor queue.

  Two phases:
  - PENDING_ENTRIES: Check if Forever BUY orders triggered → mark ENTERED
  - ENTERED_TRADES: Check holdings LTP → sell if target/SL hit

  Both phases run the existing TradeMonitorService logic UNCHANGED.
  Rate limited: 5 req/s global via BullMQ limiter.
*/

import { Worker, type Job } from "bullmq";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type { AppConfig } from "../config/schema";
import type { TradeMonitorJob } from "../queues/jobs";
import { QUEUE_NAMES } from "../queues/queueRegistry";
import { DhanService } from "../services/dhanService";
import { TradeMonitorService } from "../services/tradeMonitorService";
import { AuditLogService } from "../services/auditLogService";
import { StateStore } from "../services/stateStore";
import { UserRepository } from "../modules/user/userRepository";

export function createMonitorWorker(
  connection: Redis,
  cfg: AppConfig,
  pool: Pool,
): Worker<TradeMonitorJob> {
  const worker = new Worker<TradeMonitorJob>(
    QUEUE_NAMES.TRADE_MONITOR,
    async (job: Job<TradeMonitorJob>) => {
      const { userId, phase } = job.data;

      // 1. Load user
      const userRepo = new UserRepository(pool);
      const user = await userRepo.findById(userId);
      if (!user || user.status !== "ACTIVE" || !user.trading_enabled) {
        return { skipped: true, reason: "User not active" };
      }

      if (!user.dhan_client_id) {
        return { skipped: true, reason: "No Dhan client ID" };
      }

      // 2. Get token
      const token = await connection.get(`token:${userId}`);
      if (!token) {
        return { skipped: true, reason: "No valid token" };
      }

      // 3. Create user-scoped services
      const audit = new AuditLogService(pool, null, userId);
      const dhan = new DhanService(
        { ...cfg, dhan: { clientId: user.dhan_client_id } },
        null,
        audit,
      );
      dhan.setToken(token);

      const store = new StateStore(cfg);
      (store as any).pool = pool;

      const monitorService = new TradeMonitorService(cfg);

      // 4. Run the appropriate phase with userId for tenant isolation
      if (phase === "PENDING_ENTRIES") {
        await monitorService.monitorPendingEntries(store, dhan, audit, userId);
      } else if (phase === "ENTERED_TRADES") {
        await monitorService.monitorEnteredTrades(store, dhan, audit, userId);
      }

      return { success: true, userId, phase };
    },
    {
      connection,
      concurrency: 5,
      limiter: {
        max: 5,
        duration: 1000,
      },
      stalledInterval: 30000,
      maxStalledCount: 2,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[MonitorWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err?.message,
    );
  });

  return worker;
}
