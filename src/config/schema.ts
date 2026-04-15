import { z } from "zod";

/**
 * AppConfig: Infrastructure & secrets only.
 * Trading parameters (capital, TSL, etc.) are managed via ConfigService (DB-backed).
 *
 * In multi-tenant mode:
 * - dhan section is optional (each user provides own credentials)
 * - redis section is required (BullMQ + token storage)
 * - masterEncryptionKey is required (credential vault encryption)
 */
export const AppConfigSchema = z.object({
  dhan: z
    .object({
      clientId: z.string().min(3),
      pin: z.string().optional(), // Login PIN — required for TOTP-based token generation
      totpSecret: z.string().optional(), // Base32 TOTP secret — enables auto token generation
    })
    .optional(), // Optional in multi-tenant (each user has own creds)
  apis: z.object({
    activeTradesUrl: z.string().url(),
    closedTradesUrl: z.string().url(),
  }),
  postgres: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string().min(1),
  }),
  redis: z.object({
    host: z.string().min(1).default("localhost"),
    port: z.number().int().positive().default(6379),
    password: z.string().optional(),
    db: z.number().int().min(0).default(0),
  }),
  telegram: z.object({
    botToken: z.string().min(1),
    defaultChatId: z.string().min(1),
    tradesChatId: z.string().optional(),
  }),
  masterEncryptionKey: z.string().min(32), // AES-256 key for credential vault
  postbackPort: z.number().int().positive().optional(),
  env: z.enum(["development", "production", "test"]).default("development"),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
