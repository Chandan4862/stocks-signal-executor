/*
  NotificationWorker: Sends Telegram messages from the notification queue.
  Rate limited: 10 msg/s global via BullMQ limiter.

  Resolves chatId from userId if not provided.
  Supports two channels: 'default' (error chat) and 'trades' (trade alerts).
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
  defaultChatId: string,
  tradesChatId?: string,
): Worker<NotificationJob> {
  const worker = new Worker<NotificationJob>(
    QUEUE_NAMES.NOTIFICATION,
    async (job: Job<NotificationJob>) => {
      const { userId, chatId, text, parseMode, channel } = job.data;

      // Resolve chatId: explicit > user's chat > default
      let targetChatId = chatId;

      if (!targetChatId && userId) {
        const userRepo = new UserRepository(pool);
        const user = await userRepo.findById(userId);
        targetChatId = user?.telegram_chat_id ?? "";
      }

      // Channel routing
      if (channel === "trades" && tradesChatId) {
        targetChatId = tradesChatId;
      }

      if (!targetChatId) {
        targetChatId = defaultChatId;
      }

      if (!targetChatId) {
        throw new Error(`No chat ID resolvable for notification job ${job.id}`);
      }

      await telegramSender.sendMessage(targetChatId, text, parseMode);

      return { sent: true, chatId: targetChatId };
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
