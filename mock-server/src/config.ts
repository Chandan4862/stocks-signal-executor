/*
  Mock Server Configuration.
  All settings sourced from environment variables with sensible defaults.
*/

export interface MockConfig {
  port: number;
  mode: "allSuccess" | "random";
  failureRate: number; // 0.0 – 1.0, probability of failure in random mode
  maxLatencyMs: number; // max random latency in random mode
}

export function loadConfig(): MockConfig {
  return {
    port: parseInt(process.env.MOCK_PORT || "4000", 10),
    mode: (process.env.MOCK_MODE as MockConfig["mode"]) || "allSuccess",
    failureRate: parseFloat(process.env.FAILURE_RATE || "0.2"),
    maxLatencyMs: parseInt(process.env.MAX_LATENCY_MS || "500", 10),
  };
}
