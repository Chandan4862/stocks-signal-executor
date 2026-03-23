import "dotenv/config";
import { Client } from "pg";
import { loadConfig } from "./config";
import { Scheduler } from "./services/scheduler";
import { TelegramService } from "./services/telegramService";
import { AuditLogService } from "./services/auditLogService";
import { PostbackService } from "./services/postbackService";
import { StateStore } from "./services/stateStore";
import { TokenService } from "./services/tokenService";

async function main() {
  const config = loadConfig();

  // --- Telegram bot ---
  const telegram = new TelegramService(
    config.telegram.botToken,
    config.telegram.defaultChatId,
    config.telegram.tradesChatId,
  );
  await telegram.launch();

  // --- Boot TokenService early so /status, /token, /renew work immediately ---
  const bootStore = new StateStore(config);
  await bootStore.connect();
  const bootAudit = new AuditLogService(bootStore.pg, telegram);
  const tokenService = new TokenService(config, bootStore, bootAudit);
  telegram.setTokenService(tokenService);
  telegram.setAudit(bootAudit);

  // --- Scheduler ---
  const scheduler = new Scheduler(config, telegram);
  telegram.setScheduler(scheduler);
  scheduler.start();

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

    const postbackAudit = new AuditLogService(postbackPg, telegram);
    postback = new PostbackService(postbackPg, postbackAudit);
    postback.start(config.postbackPort);
  }

  // --- Graceful shutdown ---
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down…`);
    scheduler.stop();
    if (postback) await postback.stop();
    if (postbackPg) await postbackPg.end();
    await telegram.stop(signal);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal boot error:", err);
  process.exit(1);
});
