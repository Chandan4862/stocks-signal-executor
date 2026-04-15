/*
  TokenRenewalWorker: Handles token renewal/generation jobs.

  Actions:
  - PROACTIVE_RENEW: Renew existing token via Dhan API
  - GENERATE_TOTP: Generate a new token via TOTP auto-generation
  - VALIDATE: Validate current token is still working

  Rate limited: 2 req/s global via BullMQ limiter.
*/

import { Worker, type Job } from "bullmq";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type { AppConfig } from "../config/schema";
import type { TokenRenewalJob } from "../queues/jobs";
import { QUEUE_NAMES } from "../queues/queueRegistry";
import { UserRepository } from "../modules/user/userRepository";
import { CredentialVault } from "../modules/auth/credentialVault";
import axios from "axios";
import { createHmac } from "crypto";

const TOKEN_TTL = 86400; // 24 hours
const DHAN_API_BASE = "https://api.dhan.co/v2";
const DHAN_AUTH_BASE = "https://auth.dhan.co";

export function createTokenRenewalWorker(
  connection: Redis,
  cfg: AppConfig,
  pool: Pool,
): Worker<TokenRenewalJob> {
  const vault = new CredentialVault(cfg.masterEncryptionKey);

  const worker = new Worker<TokenRenewalJob>(
    QUEUE_NAMES.TOKEN_RENEWAL,
    async (job: Job<TokenRenewalJob>) => {
      const { userId, action } = job.data;

      const userRepo = new UserRepository(pool);
      const user = await userRepo.findById(userId);
      if (!user || !user.dhan_client_id) {
        return { skipped: true, reason: "User or client ID not found" };
      }

      if (action === "VALIDATE") {
        const token = await connection.get(`token:${userId}`);
        if (!token) {
          return { valid: false, reason: "No token in Redis" };
        }
        // Quick validation via Dhan profile endpoint
        try {
          await axios.get(`${DHAN_API_BASE}/profile`, {
            headers: { "access-token": token },
            timeout: 10_000,
          });
          return { valid: true };
        } catch {
          return { valid: false, reason: "Token validation failed" };
        }
      }

      if (action === "GENERATE_TOTP") {
        if (!user.dhan_credentials_enc || !user.dhan_credentials_iv) {
          return { skipped: true, reason: "No TOTP credentials stored" };
        }

        const creds = await vault.decrypt(
          userId,
          user.dhan_credentials_enc,
          user.dhan_credentials_iv,
        );

        if (!creds.totpSecret || !creds.pin) {
          return { skipped: true, reason: "Missing PIN or TOTP secret" };
        }

        // Generate TOTP code
        const totp = generateTotpCode(creds.totpSecret);

        // Call Dhan auth API
        const { data } = await axios.post(`${DHAN_AUTH_BASE}/app/generateAccessToken`, null, {
          params: {
            dhanClientId: user.dhan_client_id,
            pin: creds.pin,
            totp,
          },
          timeout: 15_000,
        });

        if (!data.accessToken) {
          return { error: true, reason: "generateAccessToken response missing accessToken" };
        }

        // Store token in Redis with 24h TTL
        await connection.set(`token:${userId}`, data.accessToken, "EX", TOKEN_TTL);

        console.log(
          `[TokenWorker] Generated token for user ${userId} via TOTP (expires: ${data.expiryTime ?? "~24h"})`,
        );
        return { success: true, expiryTime: data.expiryTime };
      }

      if (action === "PROACTIVE_RENEW") {
        const currentToken = await connection.get(`token:${userId}`);
        if (!currentToken) {
          return { skipped: true, reason: "No current token to renew" };
        }

        try {
          const { data } = await axios.get(`${DHAN_API_BASE}/RenewToken`, {
            headers: {
              "access-token": currentToken,
              dhanClientId: user.dhan_client_id,
            },
            timeout: 10_000,
          });

          if (!data.accessToken) {
            return { error: true, reason: "RenewToken response missing accessToken" };
          }

          // Store renewed token
          await connection.set(`token:${userId}`, data.accessToken, "EX", TOKEN_TTL);

          console.log(
            `[TokenWorker] Renewed token for user ${userId} (expires: ${data.expiryTime ?? "~24h"})`,
          );
          return { success: true, expiryTime: data.expiryTime };
        } catch (err: any) {
          // If renewal fails, try TOTP generation as fallback
          if (user.dhan_credentials_enc && user.dhan_credentials_iv) {
            console.log(`[TokenWorker] Renewal failed for user ${userId}, trying TOTP fallback...`);
            // Re-dispatch as GENERATE_TOTP
            return { error: true, reason: `Renewal failed: ${err?.message}`, fallbackNeeded: true };
          }
          return { error: true, reason: `Renewal failed: ${err?.message}` };
        }
      }

      return { skipped: true, reason: `Unknown action: ${action}` };
    },
    {
      connection,
      concurrency: 2,
      limiter: {
        max: 2,
        duration: 1000, // 2 req/s global
      },
    },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[TokenWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message,
    );
  });

  return worker;
}

// ─── TOTP Generation (standalone, no TokenService dependency) ──────────

function generateTotpCode(secret: string): string {
  const keyBytes = base32Decode(secret);

  const epoch = Math.floor(Date.now() / 1000);
  const timeStep = Math.floor(epoch / 30);

  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(Math.floor(timeStep / 0x100000000), 0);
  timeBuffer.writeUInt32BE(timeStep & 0xffffffff, 4);

  const hmac = createHmac("sha1", keyBytes);
  hmac.update(timeBuffer);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, "0");
}

function base32Decode(encoded: string): Buffer {
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
