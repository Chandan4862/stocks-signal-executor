/*
  UserRepository: Database queries for user management.
  All queries are scoped — no cross-tenant data leakage.
*/

import type { Pool } from "pg";

export interface UserRow {
  id: number;
  telegram_chat_id: string;
  telegram_username: string | null;
  display_name: string | null;
  dhan_client_id: string | null;
  dhan_credentials_enc: Buffer | null;
  dhan_credentials_iv: Buffer | null;
  status: "ONBOARDING" | "ACTIVE" | "PAUSED" | "SUSPENDED";
  trading_enabled: boolean;
  onboarded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export class UserRepository {
  constructor(private pool: Pool) {}

  async findById(id: number): Promise<UserRow | null> {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return rows[0] ?? null;
  }

  async findByTelegramChatId(chatId: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE telegram_chat_id = $1", [
      chatId,
    ]);
    return rows[0] ?? null;
  }

  async getActiveUsers(): Promise<UserRow[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM users WHERE status = 'ACTIVE' AND trading_enabled = TRUE",
    );
    return rows;
  }

  async getAllUsers(): Promise<UserRow[]> {
    const { rows } = await this.pool.query("SELECT * FROM users ORDER BY id");
    return rows;
  }

  async create(data: {
    telegramChatId: string;
    telegramUsername?: string;
    displayName?: string;
  }): Promise<UserRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO users (telegram_chat_id, telegram_username, display_name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [data.telegramChatId, data.telegramUsername ?? null, data.displayName ?? null],
    );
    return rows[0];
  }

  async updateStatus(userId: number, status: UserRow["status"]): Promise<void> {
    await this.pool.query("UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2", [
      status,
      userId,
    ]);
  }

  async setTradingEnabled(userId: number, enabled: boolean): Promise<void> {
    await this.pool.query(
      "UPDATE users SET trading_enabled = $1, updated_at = NOW() WHERE id = $2",
      [enabled, userId],
    );
  }

  async setDhanClientId(userId: number, clientId: string): Promise<void> {
    await this.pool.query(
      "UPDATE users SET dhan_client_id = $1, updated_at = NOW() WHERE id = $2",
      [clientId, userId],
    );
  }

  async setDhanCredentials(userId: number, enc: Buffer, iv: Buffer): Promise<void> {
    await this.pool.query(
      `UPDATE users
       SET dhan_credentials_enc = $1, dhan_credentials_iv = $2, updated_at = NOW()
       WHERE id = $3`,
      [enc, iv, userId],
    );
  }

  async markOnboarded(userId: number): Promise<void> {
    await this.pool.query(
      "UPDATE users SET status = 'ACTIVE', onboarded_at = NOW(), updated_at = NOW() WHERE id = $1",
      [userId],
    );
  }

  async countActiveTradesForUser(userId: number): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT COUNT(*) as cnt FROM trades WHERE user_id = $1 AND state IN ('AWAITING_ENTRY', 'ENTERED')",
      [userId],
    );
    return parseInt(rows[0].cnt, 10);
  }

  async getDeployedCapitalForUser(userId: number): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(entry_price * quantity), 0) as total
       FROM trades
       WHERE user_id = $1 AND state IN ('AWAITING_ENTRY', 'ENTERED')`,
      [userId],
    );
    return parseFloat(rows[0].total);
  }
}
