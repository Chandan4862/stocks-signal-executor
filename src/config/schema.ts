import { z } from "zod";

/**
 * AppConfig: Infrastructure & secrets only.
 * Trading parameters (capital, TSL, etc.) are managed via ConfigService (DB-backed).
 */
export const AppConfigSchema = z.object({
  dhan: z.object({
    clientId: z.string().min(3),
    pin: z.string().optional(), // Login PIN — required for TOTP-based token generation
    totpSecret: z.string().optional(), // Base32 TOTP secret — enables auto token generation
  }),
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
  telegram: z.object({
    botToken: z.string().min(1),
    defaultChatId: z.string().min(1),
    tradesChatId: z.string().optional(),
  }),
  postbackPort: z.number().int().positive().optional(),
  env: z.enum(["development", "production", "test"]).default("development"),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
