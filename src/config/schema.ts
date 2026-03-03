import { z } from "zod";

export const TslConfigSchema = z.object({
  incrementRs: z.number().positive(),
  initialSlPct: z.number().positive(),
  trailingStepPct: z.number().positive(),
});

export const AppConfigSchema = z.object({
  kite: z
    .object({
      userId: z.string().min(3),
      password: z.string().min(1),
      totpSecret: z.string().min(16),
      refreshWindowStart: z.string().regex(/^\d{2}:\d{2}$/),
      refreshWindowEnd: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .partial(),
  dhan: z.object({
    clientId: z.string().min(3),
    pin: z.string().optional(), // Login PIN — required for TOTP-based token generation
    totpSecret: z.string().optional(), // Base32 TOTP secret — enables auto token generation
  }),
  apis: z.object({
    activeTradesUrl: z.string().url(),
    closedTradesUrl: z.string().url(),
  }),
  redis: z.object({ url: z.string().min(5) }),
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
  }),
  pollingIntervalMs: z.number().int().positive(),
  maxTradeCapital: z.number().positive(),
  maxActiveTrades: z.number().int().positive(),
  useSuperOrder: z.boolean(),
  tsl: TslConfigSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
