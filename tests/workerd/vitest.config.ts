import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workspace packages resolve to source so the workerd pool bundles one
// program for both the worker main and the test modules.
const alias = {
  "@pirate/application": new URL("../../packages/application/src/index.ts", import.meta.url)
    .pathname,
  "@pirate/platform-cf": new URL("../../packages/platform-cf/src/index.ts", import.meta.url)
    .pathname,
};

export default defineConfig({
  resolve: { alias },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./apps/jobs-worker/wrangler.jsonc" },
      miniflare: { alias },
    }),
  ],
  test: {
    include: ["tests/workerd/**/*.test.ts"],
  },
});
