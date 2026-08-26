import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workspace packages resolve to source so the workerd pool bundles one
// program for both the worker main and the test modules.
const alias = {
  "@pirate/application/route-revalidation": new URL(
    "../../packages/application/src/route-revalidation/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/verification": new URL(
    "../../packages/application/src/verification/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/identity-account": new URL(
    "../../packages/application/src/use-cases/identity-account.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/session-exchange": new URL(
    "../../packages/application/src/use-cases/session-exchange.ts",
    import.meta.url,
  ).pathname,
  "@pirate/domain/verification": new URL(
    "../../packages/domain/src/verification/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/contracts": new URL("../../packages/contracts/src/index.ts", import.meta.url).pathname,
  "@pirate/domain": new URL("../../packages/domain/src/index.ts", import.meta.url).pathname,
  "@pirate/application": new URL("../../packages/application/src/index.ts", import.meta.url)
    .pathname,
  "@pirate/platform-cf/config": new URL(
    "../../packages/platform-cf/config/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf": new URL("../../packages/platform-cf/src/index.ts", import.meta.url)
    .pathname,
  "@pirate/verifier-response-contract": new URL(
    "../../packages/verifier-response-contract/src/index.ts",
    import.meta.url,
  ).pathname,
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
    // Each file imports the complete scheduled-worker graph. Serial workers
    // keep module transforms bounded now that the custody orchestration is
    // part of that graph, instead of starting seven identical bundles.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
