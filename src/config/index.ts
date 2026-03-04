import { AppConfig, AppConfigSchema } from "./schema";

export function loadConfig(): AppConfig {
  const env = process.env;
  const bool = (v: any, def: boolean) => {
    if (v === undefined || v === null || v === "") return def;
    const s = String(v).toLowerCase();
    return s === "1" || s === "true" || s === "yes";
  };
  const parseResult = AppConfigSchema.safeParse({
    kite: {
      userId: env.KITE_USER_ID,
      password: env.KITE_PASSWORD,
      totpSecret: env.KITE_TOTP_SECRET,
      refreshWindowStart: env.SESSION_REFRESH_WINDOW_START,
      refreshWindowEnd: env.SESSION_REFRESH_WINDOW_END,
    },
    dhan: {
      clientId: env.DHAN_CLIENT_ID,
      pin: env.DHAN_PIN || undefined,
      totpSecret: env.DHAN_TOTP_SECRET || undefined,
    },
    apis: {
      activeTradesUrl: env.ACTIVE_TRADES_URL,
      closedTradesUrl: env.CLOSED_TRADES_URL,
    },
    redis: { url: env.REDIS_URL },
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
    },
    pollingIntervalMs: Number(env.POLLING_INTERVAL_MS || 15000),
    maxTradeCapital: Number(env.MAX_TRADE_CAPITAL || 10000),
    maxActiveTrades: Number(env.MAX_ACTIVE_TRADES || 10),
    useSuperOrder: bool(env.USE_SUPER_ORDER, true),
    env: (env.NODE_ENV as any) || "development",
    tsl: {
      incrementRs: Number(env.TSL_INCREMENT_RS || 2),
      initialSlPct: Number(env.TSL_INITIAL_SL_PCT || 3),
      trailingStepPct: Number(env.TSL_TRAILING_STEP_PCT || 1),
    },
  });

  if (!parseResult.success) {
    console.error("Invalid configuration:", parseResult.error.format());
    throw new Error("Config validation failed");
  }

  return parseResult.data;
}
