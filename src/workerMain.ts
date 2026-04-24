/*
  workerMain.ts: Bootstrap for the worker container.
  Creates all BullMQ workers and connects to Postgres + Redis.
  Runs as a separate process from the app container.
*/

import "dotenv/config";
import { Pool } from "pg";
import { loadConfig } from "./config";
import { createBullMQConnection } from "./services/redisProvider";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from "./queues/queueRegistry";
import { Queue } from "bullmq";
import { createTradeExecutionWorker } from "./workers/tradeExecutionWorker";
import { createMonitorWorker } from "./workers/monitorWorker";
import { createReconciliationWorker } from "./workers/reconciliationWorker";
import { createNotificationWorker } from "./workers/notificationWorker";
import { createTokenRenewalWorker } from "./workers/tokenRenewalWorker";
import type { NotificationJob } from "./queues/jobs";

async function main() {
  const config = loadConfig();
  console.log("[Worker] Starting worker process...");

  // ── Postgres connection pool ──
  const pool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    max: 30,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Verify DB connectivity
  const client = await pool.connect();
  client.release();
  console.log("[Worker] PostgreSQL connected");

  // ── Redis connections (BullMQ needs separate connections per worker) ──
  const tradeExecConn = createBullMQConnection(config);
  const monitorConn = createBullMQConnection(config);
  const reconConn = createBullMQConnection(config);
  const notifConn = createBullMQConnection(config);
  const tokenConn = createBullMQConnection(config);
  const queueConn = createBullMQConnection(config);
  console.log("[Worker] Redis connections created");

  // ── Notification queue (for DLQ alerts from other workers) ──
  const notificationQueue = new Queue<NotificationJob>(QUEUE_NAMES.NOTIFICATION, {
    connection: queueConn,
    defaultJobOptions: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.NOTIFICATION],
  });

  // ── Create a simple Telegram sender for the notification worker ──
  // In production this calls the Telegram API directly
  const { Telegraf } = await import("telegraf");
  const bot = new Telegraf(config.telegram.botToken);
  const telegramSender = {
    sendMessage: async (chatId: string, text: string, _parseMode?: string) => {
      await bot.telegram.sendMessage(chatId, text);
    },
  };

  // ── Start all workers ──
  const workers = [
    createTradeExecutionWorker(tradeExecConn, config, pool, notificationQueue),
    createMonitorWorker(monitorConn, config, pool, notificationQueue),
    createReconciliationWorker(reconConn, config, pool, notificationQueue),
    createNotificationWorker(
      notifConn,
      pool,
      telegramSender,
      config.telegram.loggerChatId,
      config.telegram.userChatId,
    ),
    createTokenRenewalWorker(tokenConn, config, pool),
  ];

  console.log(`[Worker] ${workers.length} workers started`);
  console.log(`[Worker] Listening on queues: ${Object.values(QUEUE_NAMES).join(", ")}`);

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    console.log(`\n[Worker] ${signal} received, shutting down...`);

    for (const w of workers) {
      await w.close();
    }

    await notificationQueue.close();
    await pool.end();

    // Close Redis connections
    tradeExecConn.disconnect();
    monitorConn.disconnect();
    reconConn.disconnect();
    notifConn.disconnect();
    tokenConn.disconnect();
    queueConn.disconnect();

    console.log("[Worker] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[Worker] Fatal boot error:", err);
  process.exit(1);
});
