/*
 TokenService: Manages broker access token lifecycle across Redis and Postgres.
 - Stores token with TTL in Redis (key: broker:token)
 - Persists token and expiry in Postgres token_store
*/

import type { AppConfig } from "../config/schema";
import { RedisKeys } from "../state/redisKeys";
import { StateStore } from "./stateStore";

export class TokenService {
  constructor(
    private cfg: AppConfig,
    private store: StateStore,
  ) {}

  async getToken(): Promise<string | null> {
    const redisToken = await this.store.redis.get(RedisKeys.brokerToken());
    if (redisToken) return redisToken;
    const res = await this.store.pg.query(
      "SELECT enctoken FROM token_store ORDER BY trade_date DESC LIMIT 1",
    );
    return res.rows[0]?.enctoken ?? null;
  }

  async setToken(token: string, expiresAt?: Date): Promise<void> {
    const ttlSeconds = expiresAt
      ? Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
      : 30 * 24 * 60 * 60; // default 30 days
    await this.store.redis.set(
      RedisKeys.brokerToken(),
      token,
      "EX",
      ttlSeconds,
    );

    await this.store.pg.query(
      "INSERT INTO token_store (trade_date, enctoken, expires_at) VALUES ($1, $2, $3)\n       ON CONFLICT (trade_date) DO UPDATE SET enctoken = EXCLUDED.enctoken, expires_at = EXCLUDED.expires_at",
      [new Date(), token, expiresAt ?? null],
    );
  }
}
