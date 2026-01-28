import "dotenv/config";
import { loadConfig } from "./config";
import { Scheduler } from "./services/scheduler";

async function main() {
  const config = loadConfig();
  console.log("Stocks Signal Executor booting with config:", {
    pollingIntervalMs: config.pollingIntervalMs,
    maxTradeCapital: config.maxTradeCapital,
    tsl: config.tsl,
  });

  const scheduler = new Scheduler(config);
  scheduler.start();
}

main().catch((err) => {
  console.error("Fatal boot error:", err);
  process.exit(1);
});
