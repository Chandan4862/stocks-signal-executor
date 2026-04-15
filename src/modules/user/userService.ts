/*
  UserService: Business logic for user lifecycle management.
  Orchestrates UserRepository + CredentialVault + Redis caching.
*/

import Redis from "ioredis";
import { UserRepository, type UserRow } from "./userRepository";
import { CredentialVault, type BrokerCredentials } from "../auth/credentialVault";

const USER_CACHE_TTL = 3600; // 1 hour

export class UserService {
  constructor(
    private repo: UserRepository,
    private vault: CredentialVault,
    private redis: Redis,
  ) {}

  // ─── Lookup ────────────────────────────────────────────────────────

  async findByTelegramChatId(chatId: string): Promise<UserRow | null> {
    // Fast path: Redis cache
    const cached = await this.redis.get(`user:${chatId}`);
    if (cached) {
      return JSON.parse(cached);
    }

    // Slow path: DB
    const user = await this.repo.findByTelegramChatId(chatId);
    if (user) {
      // Cache without sensitive fields
      const cacheable = { ...user, dhan_credentials_enc: null, dhan_credentials_iv: null };
      await this.redis.set(`user:${chatId}`, JSON.stringify(cacheable), "EX", USER_CACHE_TTL);
    }
    return user;
  }

  async findById(id: number): Promise<UserRow | null> {
    return this.repo.findById(id);
  }

  async getActiveUsers(): Promise<UserRow[]> {
    return this.repo.getActiveUsers();
  }

  // ─── Registration ──────────────────────────────────────────────────

  async register(data: {
    telegramChatId: string;
    telegramUsername?: string;
    displayName?: string;
  }): Promise<UserRow> {
    const existing = await this.repo.findByTelegramChatId(data.telegramChatId);
    if (existing) return existing;

    return this.repo.create(data);
  }

  // ─── Broker Setup ──────────────────────────────────────────────────

  async setDhanClientId(userId: number, clientId: string): Promise<void> {
    await this.repo.setDhanClientId(userId, clientId);
    await this.invalidateCache(userId);
  }

  async setDhanCredentials(userId: number, credentials: BrokerCredentials): Promise<void> {
    const { enc, iv } = await this.vault.encrypt(userId, credentials);
    await this.repo.setDhanCredentials(userId, enc, iv);
    await this.invalidateCache(userId);
  }

  async getDhanCredentials(userId: number): Promise<BrokerCredentials | null> {
    const user = await this.repo.findById(userId);
    if (!user?.dhan_credentials_enc || !user?.dhan_credentials_iv) return null;

    return this.vault.decrypt(userId, user.dhan_credentials_enc, user.dhan_credentials_iv);
  }

  // ─── State Management ──────────────────────────────────────────────

  async markOnboarded(userId: number): Promise<void> {
    await this.repo.markOnboarded(userId);
    await this.invalidateCache(userId);
  }

  async setTradingEnabled(userId: number, enabled: boolean): Promise<void> {
    await this.repo.setTradingEnabled(userId, enabled);
    await this.invalidateCache(userId);
  }

  async updateStatus(userId: number, status: UserRow["status"]): Promise<void> {
    await this.repo.updateStatus(userId, status);
    await this.invalidateCache(userId);
  }

  // ─── Guards ────────────────────────────────────────────────────────

  async countActiveTrades(userId: number): Promise<number> {
    return this.repo.countActiveTradesForUser(userId);
  }

  async getDeployedCapital(userId: number): Promise<number> {
    return this.repo.getDeployedCapitalForUser(userId);
  }

  // ─── Cache ─────────────────────────────────────────────────────────

  private async invalidateCache(userId: number): Promise<void> {
    const user = await this.repo.findById(userId);
    if (user) {
      await this.redis.del(`user:${user.telegram_chat_id}`);
    }
  }
}
