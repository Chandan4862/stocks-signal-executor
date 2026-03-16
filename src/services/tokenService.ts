/*
  TokenService: Manages Dhan access token lifecycle.

  Dhan Auth Model (https://dhanhq.co/docs/v2/authentication/):
  ─────────────────────────────────────────────────────────────
  • Access tokens are valid for ~24 hours.
  • Tokens can be generated:
      1. Manually from web.dhan.co (Access Token tab)
      2. Programmatically via TOTP: POST https://auth.dhan.co/app/generateAccessToken
  • Active tokens can be renewed for another 24h:
      GET https://api.dhan.co/v2/RenewToken  (headers: access-token, dhanClientId)
  • Token validity can be checked via:
      GET https://api.dhan.co/v2/profile → { tokenValidity: "DD/MM/YYYY HH:mm" }

  Storage:
  • In-memory cache (fast path within same process)
  • Postgres `token_store` row (durable fallback + audit)
*/

import axios from "axios";
import type { AppConfig } from "../config/schema";
import { StateStore } from "./stateStore";
import { AuditLogService } from "./auditLogService";
import { LifecycleEvents } from "../enums/trade";

/** Profile response from GET /v2/profile */
export interface DhanProfile {
  dhanClientId: string;
  tokenValidity: string; // "DD/MM/YYYY HH:mm"
  activeSegment: string;
  ddpi: string;
  mtf: string;
  dataPlan: string;
  dataValidity: string;
}

/** Response from generateAccessToken */
interface GenerateTokenResponse {
  dhanClientId: string;
  dhanClientName: string;
  dhanClientUcc: string;
  givenPowerOfAttorney: boolean;
  accessToken: string;
  expiryTime: string; // ISO-ish: "YYYY-MM-DDTHH:mm:ss.SSS"
}

/** Response from RenewToken */
interface RenewTokenResponse {
  dhanClientId: string;
  dhanClientName: string;
  dhanClientUcc: string;
  givenPowerOfAttorney: boolean;
  accessToken: string;
  expiryTime: string;
}

const DHAN_AUTH_BASE = "https://auth.dhan.co";
const DHAN_API_BASE = "https://api.dhan.co/v2";

export class TokenService {
  /** In-memory token cache — replaces Redis fast path */
  private cachedToken: string | null = null;
  private cachedTokenExpiry: Date | null = null;

  constructor(
    private cfg: AppConfig,
    private store: StateStore,
    private audit: AuditLogService,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Get a valid access token. Resolution order:
   *  1. In-memory cache (fast path)
   *  2. Postgres token_store (durable fallback)
   *  3. If found but expired, attempt renewal via RenewToken API
   *  4. If TOTP credentials are configured, attempt auto-generation
   *
   * Returns null only if no token can be obtained.
   */
  async getToken(): Promise<string | null> {
    // 1. Check in-memory cache
    if (this.cachedToken && !this.isExpired()) {
      return this.cachedToken;
    }

    // 2. Check environment variable (initial seed)
    const envToken = process.env.DHAN_ACCESS_TOKEN;
    if (envToken) {
      this.audit
        .info(LifecycleEvents.TOKEN_REFRESHED, {
          action: "getToken",
          message: "Using DHAN_ACCESS_TOKEN from environment",
        })
        .catch(() => {});
      const isValid = await this.validateToken(envToken);
      if (isValid) {
        await this.persistToken(envToken);
        return envToken;
      }
      this.audit
        .warn(LifecycleEvents.ERROR_OCCURRED, {
          action: "getToken",
          error: "Environment token is invalid/expired",
        })
        .catch(() => {});
    }

    // 3. Check Postgres (durable fallback)
    const dbRow = await this.loadFromDb();
    if (dbRow) {
      const isValid = await this.validateToken(dbRow.token);
      if (isValid) {
        // Re-cache in memory
        this.cachedToken = dbRow.token;
        this.cachedTokenExpiry = dbRow.expiresAt;
        return dbRow.token;
      }
      // Token exists but is invalid/expired → try renewal
      this.audit
        .info(LifecycleEvents.TOKEN_REFRESHED, {
          action: "getToken",
          message: "DB token expired, attempting renewal",
        })
        .catch(() => {});
      const renewed = await this.renewToken(dbRow.token);
      if (renewed) return renewed;
    }

    // 4. Try TOTP-based generation if credentials are configured
    const generated = await this.generateViaTotp();
    if (generated) return generated;

    // 5. No token available
    await this.audit.critical(LifecycleEvents.ERROR_OCCURRED, {
      action: "getToken",
      error:
        "No valid token found. Submit via Telegram /token or configure TOTP.",
    });
    return null;
  }

  /**
   * Store a token submitted externally (e.g. via Telegram /token command).
   * Validates with Dhan profile API before persisting.
   * Returns true if the token was valid and stored, false otherwise.
   */
  async setToken(token: string, expiresAt?: Date): Promise<boolean> {
    const isValid = await this.validateToken(token);
    if (!isValid) {
      this.audit
        .warn(LifecycleEvents.ERROR_OCCURRED, {
          action: "setToken",
          error: "Submitted token failed validation",
        })
        .catch(() => {});
      return false;
    }

    // If no explicit expiry given, try to get it from profile
    let expiry = expiresAt;
    if (!expiry) {
      const profile = await this.fetchProfile(token);
      if (profile) {
        expiry = this.parseTokenValidity(profile.tokenValidity);
      }
    }

    await this.persistToken(token, expiry);
    this.audit
      .info(LifecycleEvents.TOKEN_REFRESHED, {
        action: "setToken",
        message: "Token stored successfully",
      })
      .catch(() => {});
    return true;
  }

  /**
   * Validate a token by calling the Dhan profile endpoint.
   * Returns the profile on success, null on failure.
   */
  async validateToken(token: string): Promise<boolean> {
    const profile = await this.fetchProfile(token);
    return profile !== null;
  }

  /**
   * Attempt to renew the current active token.
   * Returns the new token on success, null on failure.
   */
  async renewToken(currentToken: string): Promise<string | null> {
    try {
      const { data } = await axios.get<RenewTokenResponse>(
        `${DHAN_API_BASE}/RenewToken`,
        {
          headers: {
            "access-token": currentToken,
            dhanClientId: this.cfg.dhan.clientId,
          },
          timeout: 10_000,
        },
      );

      if (!data.accessToken) {
        await this.audit.warn(LifecycleEvents.ERROR_OCCURRED, {
          action: "renewToken",
          error: "RenewToken response missing accessToken",
          responseBody: data,
        });
        return null;
      }

      const expiry = data.expiryTime ? new Date(data.expiryTime) : undefined;
      await this.persistToken(data.accessToken, expiry);
      await this.audit.info(LifecycleEvents.TOKEN_REFRESHED, {
        action: "renewToken",
        message: "Token renewed successfully",
        expiryTime: data.expiryTime,
      });
      return data.accessToken;
    } catch (err: any) {
      await this.audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "renewToken",
        ...this.extractDhanError(err),
      });
      return null;
    }
  }

  /**
   * Generate a new token using TOTP-based auth.
   * Requires DHAN_PIN and DHAN_TOTP_SECRET (or DHAN_TOTP) in config.
   * Returns the new token on success, null on failure.
   */

  // What is TOTP?
  // TOTP (Time-based One-Time Password) is a way for your server to
  // generate the same 6-digit code that an authenticator app
  // (like Google Authenticator) would show — without human intervention.

  async generateViaTotp(): Promise<string | null> {
    const pin = this.cfg.dhan.pin;
    const totpSecret = this.cfg.dhan.totpSecret;

    if (!pin || !totpSecret) {
      return null; // TOTP credentials not configured — skip silently
    }

    try {
      // Generate TOTP code from the secret
      const totp = await this.generateTotpCode(totpSecret);

      const { data } = await axios.post<GenerateTokenResponse>(
        `${DHAN_AUTH_BASE}/app/generateAccessToken`,
        null,
        {
          params: {
            dhanClientId: this.cfg.dhan.clientId,
            pin,
            totp,
          },
          timeout: 15_000,
        },
      );

      if (!data.accessToken) {
        await this.audit.warn(LifecycleEvents.ERROR_OCCURRED, {
          action: "generateViaTotp",
          error: "generateAccessToken response missing accessToken",
          responseBody: data,
        });
        return null;
      }

      const expiry = data.expiryTime ? new Date(data.expiryTime) : undefined;
      await this.persistToken(data.accessToken, expiry);
      await this.audit.info(LifecycleEvents.TOKEN_REFRESHED, {
        action: "generateViaTotp",
        message: "Token generated via TOTP",
        expiryTime: data.expiryTime,
      });
      return data.accessToken;
    } catch (err: any) {
      await this.audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "generateViaTotp",
        ...this.extractDhanError(err),
      });
      return null;
    }
  }

  /**
   * Fetch the Dhan user profile using an access token.
   * This serves as both a validation ping and metadata fetch.
   */
  async fetchProfile(token: string): Promise<DhanProfile | null> {
    try {
      const { data } = await axios.get<DhanProfile>(
        `${DHAN_API_BASE}/profile`,
        {
          headers: { "access-token": token },
          timeout: 10_000,
        },
      );
      return data;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        this.audit
          .warn(LifecycleEvents.ERROR_OCCURRED, {
            action: "fetchProfile",
            error: "Token validation failed (unauthorized)",
            httpStatus: status,
          })
          .catch(() => {});
      } else {
        this.audit
          .warn(LifecycleEvents.ERROR_OCCURRED, {
            action: "fetchProfile",
            ...this.extractDhanError(err),
          })
          .catch(() => {});
      }
      return null;
    }
  }

  /**
   * Force-clear cached token (prevents re-use).
   * Useful when a 401 is received mid-session.
   */
  async invalidateToken(): Promise<void> {
    this.cachedToken = null;
    this.cachedTokenExpiry = null;
    this.audit
      .info(LifecycleEvents.TOKEN_REFRESHED, {
        action: "invalidateToken",
        message: "Cached token invalidated",
      })
      .catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  /** Extract Dhan-specific error details from an axios error for audit context. */
  private extractDhanError(err: any): Record<string, any> {
    const status = err?.response?.status;
    const body = err?.response?.data;
    return {
      error: err?.message ?? String(err),
      httpStatus: status,
      dhanErrorCode: body?.errorCode ?? body?.internalErrorCode ?? undefined,
      dhanMessage:
        body?.errorMessage ??
        body?.internalErrorMessage ??
        body?.message ??
        undefined,
      responseBody: body,
    };
  }

  /** Check if in-memory cached token is expired. */
  private isExpired(): boolean {
    if (!this.cachedTokenExpiry) return false;
    return this.cachedTokenExpiry.getTime() <= Date.now();
  }

  /** Persist token to both in-memory cache and Postgres. */
  private async persistToken(token: string, expiresAt?: Date): Promise<void> {
    // Cache in memory
    this.cachedToken = token;
    this.cachedTokenExpiry = expiresAt ?? null;

    // Save to Postgres
    await this.saveToDb(token, expiresAt);
  }

  /** Save token + expiry to Postgres for durability and audit. */
  private async saveToDb(token: string, expiresAt?: Date): Promise<void> {
    try {
      await this.store.pg.query(
        `INSERT INTO token_store (trade_date, enctoken, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (trade_date)
         DO UPDATE SET enctoken = EXCLUDED.enctoken,
                       expires_at = EXCLUDED.expires_at`,
        [new Date(), token, expiresAt ?? null],
      );
    } catch (err: any) {
      await this.audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "saveToDb",
        error: "DB persist failed",
        message: err?.message,
      });
    }
  }

  /** Load the most recent token from Postgres. */
  private async loadFromDb(): Promise<{
    token: string;
    expiresAt: Date | null;
  } | null> {
    try {
      const res = await this.store.pg.query(
        "SELECT enctoken, expires_at FROM token_store ORDER BY trade_date DESC LIMIT 1",
      );
      if (!res.rows[0]?.enctoken) return null;
      return {
        token: res.rows[0].enctoken,
        expiresAt: res.rows[0].expires_at
          ? new Date(res.rows[0].expires_at)
          : null,
      };
    } catch (err: any) {
      await this.audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "loadFromDb",
        error: "DB load failed",
        message: err?.message,
      });
      return null;
    }
  }

  /**
   * Parse Dhan's tokenValidity format "DD/MM/YYYY HH:mm" into a Date.
   */
  private parseTokenValidity(validity: string): Date | undefined {
    // Format: "30/03/2025 15:37"
    const match = validity.match(
      /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/,
    );
    if (!match) return undefined;
    const [, dd, mm, yyyy, hh, min] = match;
    // Dhan likely reports in IST — store as-is for TTL calculation
    return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00+05:30`);
  }

  /**
   * Generate a TOTP code from the shared secret.
   * Uses the standard RFC 6238 algorithm: HMAC-SHA1, 6 digits, 30s step.
   */
  private async generateTotpCode(secret: string): Promise<string> {
    const { createHmac } = await import("crypto");

    // Decode base32 secret
    const keyBytes = this.base32Decode(secret);

    // Current time step (30-second window)
    const epoch = Math.floor(Date.now() / 1000);
    const timeStep = Math.floor(epoch / 30);

    // Convert time step to 8-byte big-endian buffer
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeUInt32BE(Math.floor(timeStep / 0x100000000), 0);
    timeBuffer.writeUInt32BE(timeStep & 0xffffffff, 4);

    // HMAC-SHA1
    const hmac = createHmac("sha1", keyBytes);
    hmac.update(timeBuffer);
    const hash = hmac.digest();

    // Dynamic truncation
    const offset = hash[hash.length - 1] & 0x0f;
    const code =
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff);

    return String(code % 1_000_000).padStart(6, "0");
  }

  /** Decode a base32-encoded string into a Buffer. */
  private base32Decode(encoded: string): Buffer {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const cleaned = encoded.replace(/[=\s]/g, "").toUpperCase();
    let bits = "";
    for (const char of cleaned) {
      const val = alphabet.indexOf(char);
      if (val === -1) throw new Error(`Invalid base32 character: ${char}`);
      bits += val.toString(2).padStart(5, "0");
    }
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.substring(i, i + 8), 2));
    }
    return Buffer.from(bytes);
  }
}
