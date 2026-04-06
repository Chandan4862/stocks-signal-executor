import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share a single test DB —
    // run test files sequentially to avoid DROP/CREATE races.
    fileParallelism: false,
  },
});
