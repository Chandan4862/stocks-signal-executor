/*
  NotificationWorker: Sole Telegram sender — all notifications flow through this worker.

  Channel routing:
    "admin"   → loggerChatId (errors, critical alerts, system notifications)
    "trades"  → userChatId (trade entry/exit/SL/target alerts)
    "default" → per-user telegram_chat_id (personal DMs, looked up from DB)

  Rate limited: 10 msg/s global via BullMQ limiter.
*/

import { Worker, type Job } from "bullmq";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type { NotificationJob } from "../queues/jobs";
import { QUEUE_NAMES } from "../queues/queueRegistry";
import { UserRepository } from "../modules/user/userRepository";

export interface TelegramSender {
  sendMessage(chatId: string, text: string, parseMode?: string): Promise<void>;
}

export function createNotificationWorker(
  connection: Redis,
  pool: Pool,
  telegramSender: TelegramSender,
  loggerChatId: string,
  userChatId?: string,
): Worker<NotificationJob> {
  const worker = new Worker<NotificationJob>(
    QUEUE_NAMES.NOTIFICATION,
    async (job: Job<NotificationJob>) => {
      const { userId, chatId, text, parseMode, channel } = job.data;

      // Resolve chatId: explicit override wins
      let targetChatId = chatId;

      if (!targetChatId) {
        switch (channel) {
          case "admin":
            // Errors/critical → admin logger channel
            targetChatId = loggerChatId;
            break;

          case "trades":
            // Trade alerts → user-facing channel (falls back to logger)
            targetChatId = userChatId || loggerChatId;
            break;

          case "default":
          default:
            // Per-user DMs: look up their personal chat ID from DB
            if (userId) {
              const userRepo = new UserRepository(pool);
              const user = await userRepo.findById(userId);
              targetChatId = user?.telegram_chat_id ?? loggerChatId;
            } else {
              targetChatId = loggerChatId;
            }
        }
      }

      if (!targetChatId) {
        throw new Error(`No chat ID resolvable for notification job ${job.id}`);
      }

      await telegramSender.sendMessage(targetChatId, text, parseMode);

      return { sent: true, chatId: targetChatId, channel };
    },
    {
      connection,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 1000, // 10 msg/s global
      },
    },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[NotifWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message,
    );
  });

  return worker;
}
