import "dotenv/config";
import { loadConfig } from "./config";
import { Scheduler } from "./services/scheduler";
import { TelegramService } from "./services/telegramService";
import { AuditLogService } from "./services/auditLogService";
import { PostbackService } from "./services/postbackService";
import { StateStore } from "./services/stateStore";
import { ConfigService } from "./services/configService";
import { getRedis, closeRedis } from "./services/redisProvider";
import { createQueues, closeQueues } from "./queues/queueRegistry";
import { UserRepository } from "./modules/user/userRepository";
import { UserService } from "./modules/user/userService";
import { CredentialVault } from "./modules/auth/credentialVault";
import { OnboardingHandler } from "./telegram/handlers/onboardingHandler";
import { TradingHandler } from "./telegram/handlers/tradingHandler";
import { ConfigHandler } from "./telegram/handlers/configHandler";
import { IpHandler } from "./telegram/handlers/ipHandler";
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

  // --- Telegram + Audit ---
  const telegram = new TelegramService(config.telegram.botToken, config.telegram.loggerChatId);
  const notifQueue = queues.get("notification")!;
  const audit = new AuditLogService(store.pg, notifQueue);
  telegram.setAudit(audit);

  // --- ConfigService (long-lived, backed by PG pool) ---
  const configSvc = new ConfigService(store.pg);
  await configSvc.load();

  // --- Multi-tenant services ---
  const userRepo = new UserRepository(store.pool);
  const vault = new CredentialVault(config.masterEncryptionKey);
  const userService = new UserService(userRepo, vault, redis);

  // --- Telegram multi-user handlers ---
  const userResolver = new UserResolverMiddleware(userRepo);
  const onboardingHandler = new OnboardingHandler(userService, vault);
  const tradingHandler = new TradingHandler(userRepo, redis, queues, config, store.pool);
  const configHandler = new ConfigHandler(store.pool);
  const ipHandler = new IpHandler(store.pool, redis, queues, config.telegram.loggerChatId);

  // Wire handlers into TelegramService
  telegram.setMultiUserHandlers(
    userResolver,
    onboardingHandler,
    tradingHandler,
    configHandler,
    ipHandler,
  );

  // --- Scheduler (enqueue-only) ---
  const scheduler = new Scheduler(config, telegram, configSvc, queues, store, redis);
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
