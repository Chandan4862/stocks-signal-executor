/*
  TradeExecutionWorker: Processes trade entry jobs from the trade-execution queue.

  For each job:
  1. Loads user's Dhan credentials + token
  2. Creates a user-scoped DhanService instance
  3. Runs the existing TradeEntryService logic (UNCHANGED)
  4. Enqueues notification on success/failure

  Rate limited: 5 req/s global via BullMQ limiter.
*/

import { Worker, Queue, type Job } from "bullmq";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type { AppConfig } from "../config/schema";
import type { TradeExecutionJob, NotificationJob } from "../queues/jobs";
import { QUEUE_NAMES } from "../queues/queueRegistry";
import { DhanService } from "../services/dhanService";
import { TradeEntryService } from "../services/tradeEntryService";
import { AuditLogService } from "../services/auditLogService";
import { StateStore } from "../services/stateStore";
import { ConfigService } from "../services/configService";
import { UserRepository } from "../modules/user/userRepository";

export function createTradeExecutionWorker(
  connection: Redis,
  cfg: AppConfig,
  pool: Pool,
  notificationQueue: Queue<NotificationJob>,
): Worker<TradeExecutionJob> {
  const worker = new Worker<TradeExecutionJob>(
    QUEUE_NAMES.TRADE_EXECUTION,
    async (job: Job<TradeExecutionJob>) => {
      const { userId, signal, traceId } = job.data;

      // 1. Load user
      const userRepo = new UserRepository(pool);
      const user = await userRepo.findById(userId);
      if (!user || user.status !== "ACTIVE" || !user.trading_enabled) {
        return { skipped: true, reason: "User not active or trading disabled" };
      }

      if (!user.dhan_client_id) {
        return { skipped: true, reason: "No Dhan client ID configured" };
      }

      // 2. Get user's token from Redis
      const token = await connection.get(`token:${userId}`);
      if (!token) {
        return { skipped: true, reason: "No valid token available" };
      }

      // 3. Create user-scoped services
      const audit = new AuditLogService(pool, notificationQueue, userId);
      const dhan = new DhanService({ ...cfg, dhan: { clientId: user.dhan_client_id } }, audit);
      dhan.setToken(token);

      // 4. Create a user-scoped StateStore wrapper
      const store = new StateStore(cfg);
      // Override pool with the shared pool
      (store as any).pool = pool;

      // 5. Load user's config
      const configSvc = new ConfigService(pool);
      await configSvc.loadForUser(userId);

      // 6. Create remaining services
      const entryService = new TradeEntryService(cfg);
      const { QuantityResolverService } = await import("../services/quantityResolverService");
      const { TSLService } = await import("../services/tslService");
      const { InstrumentLookupService } = await import("../services/instrumentLookupService");
      const qtyResolver = new QuantityResolverService();
      const tsl = new TSLService(configSvc.tsl);
      const instrumentLookup = new InstrumentLookupService(pool);

      // 7. Run trade entry for this single signal + user
      await entryService.runBuyAndInitialSl(
        store,
        dhan,
        qtyResolver,
        tsl,
        audit,
        instrumentLookup,
        [signal],
        configSvc,
        userId,
      );

      return { success: true, userId, symbol: signal.sc_symbol };
    },
    {
      connection,
      concurrency: 5,
      limiter: {
        max: 5,
        duration: 1000, // 5 req/s global to Dhan
      },
      stalledInterval: 30000,
      maxStalledCount: 2,
    },
  );

  // Error handler — enqueue DLQ notification
  worker.on("failed", async (job, err) => {
    if (job && err && job.attemptsMade >= (job.opts.attempts ?? 3)) {
      console.error(
        `[TradeExecWorker] Job ${job.id} permanently failed after ${job.attemptsMade} attempts:`,
        err.message,
      );

      try {
        await notificationQueue.add("dlq-alert", {
          userId: job.data.userId,
          traceId: job.data.traceId,
          enqueuedAt: new Date().toISOString(),
          chatId: "",
          text:
            `🚨 Trade execution failed permanently\n` +
            `Symbol: ${job.data.signal?.sc_symbol ?? "unknown"}\n` +
            `Error: ${err.message}\n` +
            `Attempts: ${job.attemptsMade}\n` +
            `Manual review required.`,
          channel: "trades",
        });
      } catch {
        // Don't let notification failure propagate
      }
    }
  });

  return worker;
}
