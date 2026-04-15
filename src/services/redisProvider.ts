/*
  RedisProvider: Shared Redis connection for BullMQ and application caching.
  Provides both a standard ioredis client and a BullMQ-compatible connection factory.
*/

import Redis from "ioredis";
import type { AppConfig } from "../config/schema";

let _redis: Redis | null = null;

/**
 * Get or create the shared Redis connection.
 * Uses lazy initialization — first call creates the connection.
 */
export function getRedis(cfg: AppConfig): Redis {
  if (_redis) return _redis;

  _redis = new Redis({
    host: cfg.redis.host,
    port: cfg.redis.port,
    password: cfg.redis.password || undefined,
    db: cfg.redis.db,
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false, // Required by BullMQ
    retryStrategy: (times: number) => {
      if (times > 10) return null; // Stop retrying after 10 attempts
      return Math.min(times * 200, 5000); // Exponential backoff, max 5s
    },
  });

  _redis.on("error", (err) => {
    console.error("Redis connection error:", err.message);
  });

  _redis.on("connect", () => {
    console.log(`Redis connected: ${cfg.redis.host}:${cfg.redis.port}/${cfg.redis.db}`);
  });

  return _redis;
}

/**
 * BullMQ connection factory — creates a new Redis connection each time.
 * BullMQ requires separate connections for Queue and Worker instances.
 */
export function createBullMQConnection(cfg: AppConfig): Redis {
  return new Redis({
    host: cfg.redis.host,
    port: cfg.redis.port,
    password: cfg.redis.password || undefined,
    db: cfg.redis.db,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/**
 * Gracefully close the shared Redis connection.
 */
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
