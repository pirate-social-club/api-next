import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Concurrent agent sessions each run this suite. The default worker count
    // is one per core, which saturates a shared workstation.
    maxWorkers: 4,
    include: ["tests/node/**/*.test.ts"],
  },
});
