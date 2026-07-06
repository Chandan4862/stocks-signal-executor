import "dotenv/config";
import { loadConfig } from "../config";
import { createBullMQConnection } from "../services/redisProvider";
import { Queue } from "bullmq";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../queues/queueRegistry";
import { exec } from "child_process";

import { promisify } from "util";

const execAsync = promisify(exec);

async function main() {
  const config = loadConfig();
  const redis = createBullMQConnection(config);

  const queues = new Map<string, Queue>();
  for (const name of Object.values(QUEUE_NAMES)) {
    queues.set(
      name,
      new Queue(name, {
        connection: redis,
        defaultJobOptions: DEFAULT_JOB_OPTIONS[name],
      }),
    );
  }

  console.log("📊 Starting Load Test Monitor...");
  console.log("Press Ctrl+C to exit.\n");

  setInterval(async () => {
    try {
      let totalActive = 0;
      const queueData: { name: string; counts: any }[] = [];

      for (const [name, queue] of queues.entries()) {
        const counts = await queue.getJobCounts("waiting", "active", "completed", "failed");
        queueData.push({ name, counts });
        totalActive += counts.active;
      }

      let dockerOutput = "";
      try {
        const { stdout } = await execAsync(
          'docker stats --no-stream --format "{{.Name}}: CPU {{.CPUPerc}} | MEM {{.MemUsage}}"',
        );
        dockerOutput = stdout.trim();
      } catch (err: any) {
        dockerOutput = `Error fetching docker stats: ${err.message}`;
      }

      console.clear();
      console.log(`=== Queue Metrics (${new Date().toLocaleTimeString()}) ===`);
      console.log(
        "Queue Name".padEnd(25) +
          "| " +
          "Waiting".padEnd(10) +
          "| " +
          "Active".padEnd(10) +
          "| " +
          "Completed".padEnd(12) +
          "| " +
          "Failed".padEnd(10),
      );
      console.log("-".repeat(70));

      for (const q of queueData) {
        console.log(
          q.name.padEnd(25) +
            String(q.counts.waiting).padEnd(10) +
            String(q.counts.active).padEnd(10) +
            String(q.counts.completed).padEnd(12) +
            String(q.counts.failed).padEnd(10),
        );
      }

      console.log("\n=== Docker Stats ===");
      console.log(dockerOutput);
      console.log(`\nWorkers processing: ${totalActive} jobs active.`);
    } catch (err) {
      console.error("Error fetching metrics:", err);
    }
  }, 3000);
}

main().catch(console.error);
