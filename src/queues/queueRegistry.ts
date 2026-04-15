/*
  Queue Registry: Central factory for all BullMQ queues.
  Creates and manages queue instances with consistent configuration.
*/

import { Queue } from "bullmq";
import type Redis from "ioredis";

/** All queue names used in the system */
export const QUEUE_NAMES = {
  SIGNAL_FANOUT: "signal-fanout",
  TRADE_EXECUTION: "trade-execution",
  TRADE_MONITOR: "trade-monitor",
  TRADE_RECONCILIATION: "trade-reconciliation",
  NOTIFICATION: "notification",
  TOKEN_RENEWAL: "token-renewal",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Default job options per queue */
export const DEFAULT_JOB_OPTIONS: Record<
  QueueName,
  {
    attempts: number;
    backoff: { type: "exponential"; delay: number };
    removeOnComplete: { age: number };
    removeOnFail: { age: number };
  }
> = {
  [QUEUE_NAMES.SIGNAL_FANOUT]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 500 },
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
  },
  [QUEUE_NAMES.TRADE_EXECUTION]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
  },
  [QUEUE_NAMES.TRADE_MONITOR]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 604800 },
  },
  [QUEUE_NAMES.TRADE_RECONCILIATION]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
  },
  [QUEUE_NAMES.NOTIFICATION]: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 604800 },
  },
  [QUEUE_NAMES.TOKEN_RENEWAL]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
  },
};

/**
 * Create all BullMQ queues.
 * Returns a map of queue name → Queue instance.
 */
export function createQueues(connection: Redis): Map<QueueName, Queue> {
  const queues = new Map<QueueName, Queue>();

  for (const name of Object.values(QUEUE_NAMES)) {
    queues.set(
      name,
      new Queue(name, {
        connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS[name],
      }),
    );
  }

  return queues;
}

/**
 * Gracefully close all queues.
 */
export async function closeQueues(queues: Map<QueueName, Queue>): Promise<void> {
  for (const queue of queues.values()) {
    await queue.close();
  }
}
