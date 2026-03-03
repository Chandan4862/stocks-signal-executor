import "dotenv/config";
import { loadConfig } from "./config";
import { Scheduler } from "./services/scheduler";
import { TelegramService } from "./services/telegramService";

async function main() {
  const config = loadConfig();
  console.log("Stocks Signal Executor booting with config:", config);

  // --- Telegram bot ---
  const telegram = new TelegramService(
    config.telegram.botToken,
    config.telegram.defaultChatId,
  );
  await telegram.launch();

  // --- Scheduler ---
  const scheduler = new Scheduler(config, telegram);
  scheduler.start();

  // --- Graceful shutdown ---
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down…`);
    scheduler.stop();
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
