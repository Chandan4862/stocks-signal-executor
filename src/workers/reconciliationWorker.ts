/*
  ReconciliationWorker: Processes reconciliation jobs.

  Two phases:
  - CLOSED_TRADES: Analyst closed signals → cancel/sell matching trades
  - POSITION_RECONCILE: Holdings vs local state reconciliation (4 paths)

  Runs the existing TradeReconciliationService logic UNCHANGED.
  Rate limited: 5 req/s global via BullMQ limiter.
*/

import { Worker, type Job } from "bullmq";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type { AppConfig } from "../config/schema";
import type { ReconciliationJob, NotificationJob } from "../queues/jobs";
import { QUEUE_NAMES } from "../queues/queueRegistry";
import { DhanService } from "../services/dhanService";
import { TradeReconciliationService } from "../services/tradeReconciliationService";
import { AuditLogService } from "../services/auditLogService";
import { StateStore } from "../services/stateStore";
import { UserRepository } from "../modules/user/userRepository";
import type { ClosedTrade } from "../models/closedTrade";

import type { Queue } from "bullmq";

export function createReconciliationWorker(
  connection: Redis,
  cfg: AppConfig,
  pool: Pool,
  notificationQueue: Queue<NotificationJob>,
): Worker<ReconciliationJob> {
  const worker = new Worker<ReconciliationJob>(
    QUEUE_NAMES.TRADE_RECONCILIATION,
    async (job: Job<ReconciliationJob>) => {
      const { userId, phase, closedSignals } = job.data;

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
      const audit = new AuditLogService(pool, notificationQueue, userId);
      const dhan = new DhanService(
        { ...cfg, dhan: { clientId: user.dhan_client_id } },
        null,
        audit,
      );
      dhan.setToken(token);

      const store = new StateStore(cfg);
      (store as any).pool = pool;

      const reconService = new TradeReconciliationService(cfg);

      // 4. Run the appropriate phase with userId for tenant isolation
      if (phase === "CLOSED_TRADES" && closedSignals) {
        await reconService.processClosedTrades(
          store,
          dhan,
          audit,
          closedSignals as ClosedTrade[],
          userId,
        );
      } else if (phase === "POSITION_RECONCILE") {
        await reconService.reconcilePositions(store, dhan, audit, userId);
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
      `[ReconWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err?.message,
    );
  });

  return worker;
}
