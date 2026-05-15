/*
  IpWhitelistService: Manages Dhan IP whitelisting for all users.

  Dhan requires IP whitelisting before placing orders.
  Each user (dhanClientId) has two slots: PRIMARY and SECONDARY.
  IPs can only be modified once every 7 days per slot.

  Responsibilities:
    1. Query Dhan IP status (GET /v2/ip/getIP)
    2. Set IP on a slot (POST /v2/ip/setIP)
    3. Orchestrate full sync per user (syncUserIp)
    4. Gate order placement (assertOrdersAllowed)
    5. Cache IP status in Redis (4h TTL)
    6. Persist state in Postgres (ip_whitelist table)

  Safety:
    - Redis distributed lock around setIp() to prevent races across workers
    - Never overwrites a working slot
    - Never calls POST if cooldown hasn't expired
*/

import type { Pool } from "pg";
import type Redis from "ioredis";
import axios from "axios";
import { AuditLogService } from "./auditLogService";
import { LifecycleEvents } from "../enums/trade";

// ─── Types ─────────────────────────────────────────────────────────

export interface DhanIpResponse {
  modifyDatePrimary: string | null;
  modifyDateSecondary: string | null;
  primaryIP: string | null;
  secondaryIP: string | null;
  detectedIP: string;
  ipMatchStatus: string;
  ordersAllowed: boolean;
}

export interface DhanSetIpResponse {
  message: string;
  status: string;
}

export interface IpCacheEntry {
  ordersAllowed: boolean;
  ipMatchStatus: string;
  detectedIp: string;
  syncedAt: string;
}

export interface IpSyncResult {
  success: boolean;
  ordersAllowed: boolean;
  action: "NO_CHANGE" | "IP_SET" | "BLOCKED";
  slot?: "PRIMARY" | "SECONDARY";
  error?: string;
}

export interface IpWhitelistRow {
  user_id: number;
  dhan_client_id: string;
  primary_ip: string | null;
  secondary_ip: string | null;
  detected_ip: string | null;
  ip_match_status: string | null;
  orders_allowed: boolean;
  modify_date_primary: string | null;
  modify_date_secondary: string | null;
  system_ip: string | null;
  last_synced_at: Date | null;
  last_set_at: Date | null;
  last_set_slot: string | null;
  sync_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Thrown by assertOrdersAllowed when orders cannot proceed. */
export class IpBlockedError extends Error {
  constructor(
    public readonly userId: number,
    public readonly reason: string,
  ) {
    super(`IP blocked for user ${userId}: ${reason}`);
    this.name = "IpBlockedError";
  }
}

// ─── Constants ─────────────────────────────────────────────────────

const IP_STATUS_CACHE_TTL = 14400; // 4 hours
const SET_LOCK_TTL = 60; // distributed lock around setIp

const REDIS_KEY = {
  ipStatus: (userId: number) => `ip:status:${userId}`,
  setLock: (userId: number) => `ip:setL ock:${userId}`,
} as const;

// ─── Service ───────────────────────────────────────────────────────

export class IpWhitelistService {
  constructor(
    private pool: Pool,
    private redis: Redis,
    private audit: AuditLogService,
  ) {}

  /* ---------------------------------------------------------------- */
  /*  Dhan API Calls                                                   */
  /* ---------------------------------------------------------------- */

  async getIpStatus(dhanToken: string, baseUrl: string): Promise<DhanIpResponse> {
    const { data } = await axios.get<DhanIpResponse>(`${baseUrl}/ip/getIP`, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "access-token": dhanToken,
      },
      timeout: 10_000,
    });
    return data;
  }

  async setIp(
    dhanToken: string,
    baseUrl: string,
    dhanClientId: string,
    ip: string,
    slot: "PRIMARY" | "SECONDARY",
  ): Promise<DhanSetIpResponse> {
    const { data } = await axios.post<DhanSetIpResponse>(
      `${baseUrl}/ip/setIP`,
      { dhanClientId, ip, ipFlag: slot },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "access-token": dhanToken,
        },
        timeout: 10_000,
      },
    );
    return data;
  }

  /* ---------------------------------------------------------------- */
  /*  Orchestration: Full sync per user                                */
  /* ---------------------------------------------------------------- */

  /**
   * Full IP sync flow for a single user:
   *   1. GET current IP state from Dhan
   *   2. If ordersAllowed → cache + persist → done
   *   3. If not → pick slot → POST setIP → verify → cache + persist
   *   4. If can't fix → return BLOCKED
   */
  async syncUserIp(
    userId: number,
    dhanClientId: string,
    dhanToken: string,
    baseUrl: string,
  ): Promise<IpSyncResult> {
    let ipState: DhanIpResponse;

    // Step 1: Query Dhan
    try {
      ipState = await this.getIpStatus(dhanToken, baseUrl);
    } catch (err: any) {
      const errorMsg = `GET /v2/ip/getIP failed: ${err?.message ?? String(err)}`;
      await this.audit.error(LifecycleEvents.IP_SYNC_FAILED, {
        userId,
        action: "syncUserIp.getIpStatus",
        error: errorMsg,
      });
      await this.persistSyncError(userId, dhanClientId, errorMsg);
      return { success: false, ordersAllowed: false, action: "BLOCKED", error: errorMsg };
    }

    // Step 2: Persist + cache
    await this.persistIpState(userId, dhanClientId, ipState);
    await this.cacheStatus(userId, {
      ordersAllowed: ipState.ordersAllowed,
      ipMatchStatus: ipState.ipMatchStatus,
      detectedIp: ipState.detectedIP,
      syncedAt: new Date().toISOString(),
    });

    await this.audit.info(LifecycleEvents.IP_SYNC_SUCCESS, {
      userId,
      ipMatchStatus: ipState.ipMatchStatus,
      ordersAllowed: ipState.ordersAllowed,
      detectedIp: ipState.detectedIP,
      primaryIp: ipState.primaryIP,
      secondaryIp: ipState.secondaryIP,
    });

    // Step 3: If already allowed, done
    if (ipState.ordersAllowed) {
      return { success: true, ordersAllowed: true, action: "NO_CHANGE" };
    }

    // Step 4: Attempt fix — acquire distributed lock
    const lockKey = REDIS_KEY.setLock(userId);
    const lockAcquired = await this.redis.set(lockKey, "1", "EX", SET_LOCK_TTL, "NX");
    if (!lockAcquired) {
      return {
        success: false,
        ordersAllowed: false,
        action: "BLOCKED",
        error: "Another worker is already syncing IP for this user",
      };
    }

    try {
      return await this.attemptIpFix(userId, dhanClientId, dhanToken, baseUrl, ipState);
    } finally {
      await this.redis.del(lockKey).catch(() => {});
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Pre-Order Gate                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Lightweight gate: are orders allowed?
   * Fast path: Redis cache hit → zero API calls.
   * Slow path: cache miss → GET /v2/ip/getIP → populate cache.
   * Throws IpBlockedError if orders are not allowed.
   */
  async assertOrdersAllowed(userId: number, dhanToken: string, baseUrl: string): Promise<void> {
    // 1. Try cache
    const cached = await this.getCachedStatus(userId);
    if (cached && cached.ordersAllowed) {
      return;
    }

    // 2. Cache miss or false → re-check with Dhan
    try {
      const ipState = await this.getIpStatus(dhanToken, baseUrl);
      await this.cacheStatus(userId, {
        ordersAllowed: ipState.ordersAllowed,
        ipMatchStatus: ipState.ipMatchStatus,
        detectedIp: ipState.detectedIP,
        syncedAt: new Date().toISOString(),
      });

      if (ipState.ordersAllowed) return;

      await this.audit.error(LifecycleEvents.IP_ORDERS_BLOCKED, {
        userId,
        ipMatchStatus: ipState.ipMatchStatus,
        detectedIp: ipState.detectedIP,
        ordersAllowed: false,
      });

      throw new IpBlockedError(
        userId,
        `IP mismatch — status: ${ipState.ipMatchStatus}, detected: ${ipState.detectedIP}`,
      );
    } catch (err) {
      if (err instanceof IpBlockedError) throw err;

      // API failed — if stale cache says allowed, let through
      if (cached && cached.ordersAllowed) return;

      throw new IpBlockedError(
        userId,
        `Cannot verify IP status: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Status Queries                                                    */
  /* ---------------------------------------------------------------- */

  async getDbStatus(userId: number): Promise<IpWhitelistRow | null> {
    const { rows } = await this.pool.query("SELECT * FROM ip_whitelist WHERE user_id = $1", [
      userId,
    ]);
    return rows[0] ?? null;
  }

  async getCachedStatus(userId: number): Promise<IpCacheEntry | null> {
    try {
      const raw = await this.redis.get(REDIS_KEY.ipStatus(userId));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Internal: Fix IP mismatch                                        */
  /* ---------------------------------------------------------------- */

  private async attemptIpFix(
    userId: number,
    dhanClientId: string,
    dhanToken: string,
    baseUrl: string,
    ipState: DhanIpResponse,
  ): Promise<IpSyncResult> {
    const systemIp = ipState.detectedIP;
    const slot = this.pickSlotForUpdate(ipState);

    if (!slot) {
      const reason =
        `Both IP slots locked. PRIMARY modifiable after ${ipState.modifyDatePrimary}, ` +
        `SECONDARY after ${ipState.modifyDateSecondary}. Detected IP: ${systemIp}`;

      await this.audit.critical(LifecycleEvents.IP_BLOCKED, {
        userId,
        dhanClientId,
        reason,
        modifyDatePrimary: ipState.modifyDatePrimary,
        modifyDateSecondary: ipState.modifyDateSecondary,
        detectedIp: systemIp,
      });

      return { success: false, ordersAllowed: false, action: "BLOCKED", error: reason };
    }

    // Idempotent: skip if slot already has correct IP
    const slotIp = slot === "PRIMARY" ? ipState.primaryIP : ipState.secondaryIP;
    if (slotIp === systemIp) {
      await this.audit.warn(LifecycleEvents.IP_SYNC_FAILED, {
        userId,
        reason: `${slot} already has correct IP (${systemIp}) but ordersAllowed=false`,
      });
      return {
        success: false,
        ordersAllowed: false,
        action: "BLOCKED",
        error: `${slot} slot matches but ordersAllowed=false`,
      };
    }

    // POST setIP
    try {
      const setResult = await this.setIp(dhanToken, baseUrl, dhanClientId, systemIp, slot);

      if (setResult.status !== "SUCCESS") {
        await this.audit.error(LifecycleEvents.IP_SET_FAILED, {
          userId,
          slot,
          ip: systemIp,
          response: setResult,
        });
        return {
          success: false,
          ordersAllowed: false,
          action: "BLOCKED",
          slot,
          error: `setIP returned: ${setResult.message}`,
        };
      }

      await this.audit.info(LifecycleEvents.IP_SET_SUCCESS, {
        userId,
        dhanClientId,
        slot,
        ip: systemIp,
      });

      await this.pool.query(
        `UPDATE ip_whitelist
         SET last_set_at = NOW(), last_set_slot = $1, sync_error = NULL, updated_at = NOW()
         WHERE user_id = $2`,
        [slot, userId],
      );
    } catch (err: any) {
      const errorMsg = `POST /v2/ip/setIP failed for ${slot}: ${err?.message ?? String(err)}`;
      await this.audit.error(LifecycleEvents.IP_SET_FAILED, { userId, slot, error: errorMsg });

      // Fallback: if PRIMARY failed, try SECONDARY
      if (slot === "PRIMARY" && this.isSlotAvailable(ipState.modifyDateSecondary)) {
        return this.attemptIpFix(userId, dhanClientId, dhanToken, baseUrl, {
          ...ipState,
          modifyDatePrimary: "9999-12-31", // Force skip PRIMARY on retry
        });
      }

      return { success: false, ordersAllowed: false, action: "BLOCKED", slot, error: errorMsg };
    }

    // Verify
    try {
      const verifyState = await this.getIpStatus(dhanToken, baseUrl);
      await this.persistIpState(userId, dhanClientId, verifyState);
      await this.cacheStatus(userId, {
        ordersAllowed: verifyState.ordersAllowed,
        ipMatchStatus: verifyState.ipMatchStatus,
        detectedIp: verifyState.detectedIP,
        syncedAt: new Date().toISOString(),
      });

      if (verifyState.ordersAllowed) {
        return { success: true, ordersAllowed: true, action: "IP_SET", slot };
      }

      return {
        success: false,
        ordersAllowed: false,
        action: "BLOCKED",
        slot,
        error: `setIP succeeded but ordersAllowed still false`,
      };
    } catch {
      // Verification failed but setIP succeeded — optimistic
      return { success: true, ordersAllowed: true, action: "IP_SET", slot };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Internal: Slot Selection                                         */
  /* ---------------------------------------------------------------- */

  private pickSlotForUpdate(response: DhanIpResponse): "PRIMARY" | "SECONDARY" | null {
    if (this.isSlotAvailable(response.modifyDatePrimary)) return "PRIMARY";
    if (this.isSlotAvailable(response.modifyDateSecondary)) return "SECONDARY";
    return null;
  }

  private isSlotAvailable(modifyDate: string | null): boolean {
    if (!modifyDate) return true;
    return new Date(modifyDate) <= new Date();
  }

  /* ---------------------------------------------------------------- */
  /*  Internal: Redis Cache                                            */
  /* ---------------------------------------------------------------- */

  private async cacheStatus(userId: number, entry: IpCacheEntry): Promise<void> {
    try {
      await this.redis.set(
        REDIS_KEY.ipStatus(userId),
        JSON.stringify(entry),
        "EX",
        IP_STATUS_CACHE_TTL,
      );
    } catch {
      // Non-critical
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Internal: Postgres Persistence                                   */
  /* ---------------------------------------------------------------- */

  private async persistIpState(
    userId: number,
    dhanClientId: string,
    ipState: DhanIpResponse,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO ip_whitelist (
           user_id, dhan_client_id,
           primary_ip, secondary_ip, detected_ip,
           ip_match_status, orders_allowed,
           modify_date_primary, modify_date_secondary,
           system_ip, last_synced_at, sync_error, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NULL, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           dhan_client_id = EXCLUDED.dhan_client_id,
           primary_ip = EXCLUDED.primary_ip,
           secondary_ip = EXCLUDED.secondary_ip,
           detected_ip = EXCLUDED.detected_ip,
           ip_match_status = EXCLUDED.ip_match_status,
           orders_allowed = EXCLUDED.orders_allowed,
           modify_date_primary = EXCLUDED.modify_date_primary,
           modify_date_secondary = EXCLUDED.modify_date_secondary,
           system_ip = EXCLUDED.system_ip,
           last_synced_at = NOW(),
           sync_error = NULL,
           updated_at = NOW()`,
        [
          userId,
          dhanClientId,
          ipState.primaryIP,
          ipState.secondaryIP,
          ipState.detectedIP,
          ipState.ipMatchStatus,
          ipState.ordersAllowed,
          ipState.modifyDatePrimary,
          ipState.modifyDateSecondary,
          ipState.detectedIP,
        ],
      );
    } catch (err: any) {
      console.error("[IpWhitelistService] DB persist failed:", err?.message);
    }
  }

  private async persistSyncError(
    userId: number,
    dhanClientId: string,
    error: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO ip_whitelist (user_id, dhan_client_id, sync_error, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET sync_error = EXCLUDED.sync_error, updated_at = NOW()`,
        [userId, dhanClientId, error],
      );
    } catch (err: any) {
      console.error("[IpWhitelistService] DB error persist failed:", err?.message);
    }
  }
}
