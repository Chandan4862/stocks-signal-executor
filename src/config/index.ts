import { AppConfig, AppConfigSchema } from "./schema";

/**
 * Load infrastructure config from environment variables.
 * Trading params (capital, TSL, etc.) are loaded from DB via ConfigService.
 */
export function loadConfig(): AppConfig {
  const env = process.env;

  const parseResult = AppConfigSchema.safeParse({
    dhan: {
      clientId: env.DHAN_CLIENT_ID,
      pin: env.DHAN_PIN || undefined,
      totpSecret: env.DHAN_TOTP_SECRET || undefined,
    },
    apis: {
      activeTradesUrl: env.ACTIVE_TRADES_URL,
      closedTradesUrl: env.CLOSED_TRADES_URL,
    },
    postgres: {
      host: env.PG_HOST,
      port: Number(env.PG_PORT || 5432),
      database: env.PG_DATABASE,
      user: env.PG_USER,
      password: env.PG_PASSWORD,
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      defaultChatId: env.TELEGRAM_CHAT_ID,
      tradesChatId: env.TELEGRAM_TRADES_CHAT_ID || undefined,
    },
    postbackPort: env.POSTBACK_PORT ? Number(env.POSTBACK_PORT) : undefined,
    env: (env.NODE_ENV as any) || "development",
  });

  if (!parseResult.success) {
    console.error("Invalid configuration:", parseResult.error.format());
    throw new Error("Config validation failed");
  }

  return parseResult.data;
}
