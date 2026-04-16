import "dotenv/config";
import { loadConfig } from "./config";
import { Scheduler } from "./services/scheduler";
import { TelegramService } from "./services/telegramService";
import { AuditLogService } from "./services/auditLogService";
import { PostbackService } from "./services/postbackService";
import { StateStore } from "./services/stateStore";
import { TokenService } from "./services/tokenService";
import { ConfigService } from "./services/configService";
import { getRedis, closeRedis } from "./services/redisProvider";
import { createQueues, closeQueues } from "./queues/queueRegistry";
import { UserRepository } from "./modules/user/userRepository";
import { UserService } from "./modules/user/userService";
import { CredentialVault } from "./modules/auth/credentialVault";
import { OnboardingHandler } from "./telegram/handlers/onboardingHandler";
import { TradingHandler } from "./telegram/handlers/tradingHandler";
import { ConfigHandler } from "./telegram/handlers/configHandler";
import { UserResolverMiddleware } from "./telegram/middleware/userResolver";
import { Client } from "pg";

async function main() {
  const config = loadConfig();

  // --- Postgres (long-lived pool) ---
  const store = new StateStore(config);
  await store.connect();
  console.log("✅ Postgres pool connected");

  // --- Redis ---
  const redis = getRedis(config);
  console.log("✅ Redis initialized");

  // --- BullMQ Queues ---
  const queues = createQueues(redis);
  console.log(`✅ ${queues.size} BullMQ queues created`);

  // --- Audit (global, with PG + notification queue) ---
  const telegram = new TelegramService(
    config.telegram.botToken,
    config.telegram.loggerChatId,
    config.telegram.userChatId,
  );
  const notifQueue = queues.get("notification")!;
  const audit = new AuditLogService(store.pg, notifQueue);

  // --- ConfigService (long-lived, backed by PG pool) ---
  const configSvc = new ConfigService(store.pg);
  await configSvc.load();
  telegram.setConfigService(configSvc);

  // --- Token Service (for legacy single-user /token + /renew commands) ---
  const tokenService = new TokenService(config, store, audit);
  telegram.setTokenService(tokenService);
  telegram.setAudit(audit);

  // --- Multi-tenant services ---
  const userRepo = new UserRepository(store.pool);
  const vault = new CredentialVault(config.masterEncryptionKey);
  const userService = new UserService(userRepo, vault, redis);

  // --- Telegram multi-user handlers ---
  const userResolver = new UserResolverMiddleware(userRepo);
  const onboardingHandler = new OnboardingHandler(userService, vault, redis);
  const tradingHandler = new TradingHandler(userRepo, redis, queues);
  const configHandler = new ConfigHandler(store.pool);

  // Wire handlers into TelegramService
  telegram.setMultiUserHandlers(userResolver, onboardingHandler, tradingHandler, configHandler);

  // --- Scheduler (enqueue-only) ---
  const scheduler = new Scheduler(config, telegram, configSvc, queues, store, redis);
  telegram.setScheduler(scheduler);
  scheduler.start();

  // --- Launch Telegram bot ---
  await telegram.launch();

  // --- Postback Webhook Server (optional) ---
  let postback: PostbackService | undefined;
  let postbackPg: Client | undefined;

  if (config.postbackPort) {
    postbackPg = new Client({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
    });
    await postbackPg.connect();

    const postbackAudit = new AuditLogService(postbackPg, notifQueue);
    postback = new PostbackService(postbackPg, postbackAudit);
    postback.start(config.postbackPort);
  }

  // --- Graceful shutdown ---
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down…`);
    scheduler.stop();
    if (postback) await postback.stop();
    if (postbackPg) await postbackPg.end();
    await closeQueues(queues);
    await telegram.stop(signal);
    await store.disconnect();
    await closeRedis();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal boot error:", err);
  process.exit(1);
});
