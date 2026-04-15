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

const TOKEN_TTL = 86400; // 24 hours

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
        // Check if token exists and is valid
        const token = await connection.get(`token:${userId}`);
        if (!token) {
          return { valid: false, reason: "No token in Redis" };
        }
        // TODO: Validate against Dhan API
        return { valid: true };
      }

      if (action === "GENERATE_TOTP") {
        // Decrypt TOTP credentials
        if (!user.dhan_credentials_enc || !user.dhan_credentials_iv) {
          return { skipped: true, reason: "No TOTP credentials stored" };
        }

        const creds = await vault.decrypt(
          userId,
          user.dhan_credentials_enc,
          user.dhan_credentials_iv,
        );

        if (!creds.totpSecret) {
          return { skipped: true, reason: "No TOTP secret in credentials" };
        }

        // TODO: Generate TOTP and fetch token from Dhan auth API
        // This will reuse the existing TokenService TOTP logic
        // For now, placeholder:
        return { skipped: true, reason: "TOTP generation not yet implemented in worker" };
      }

      if (action === "PROACTIVE_RENEW") {
        const currentToken = await connection.get(`token:${userId}`);
        if (!currentToken) {
          return { skipped: true, reason: "No current token to renew" };
        }

        // TODO: Call Dhan RenewToken API
        // This will reuse existing TokenService renewal logic
        return { skipped: true, reason: "Token renewal not yet implemented in worker" };
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
