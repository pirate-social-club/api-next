import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const alias = {
  "@pirate/application/use-cases/content/community-moderation-runtime": new URL(
    "../../packages/application/src/use-cases/content/community-moderation-runtime.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/namespace-ownership": new URL(
    "../../packages/application/src/namespace-ownership/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/route-revalidation": new URL(
    "../../packages/application/src/route-revalidation/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application": new URL("../../packages/application/src/index.ts", import.meta.url)
    .pathname,
  "@pirate/contracts": new URL("../../packages/contracts/src/index.ts", import.meta.url).pathname,
  "@pirate/domain/verification": new URL(
    "../../packages/domain/src/verification/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/domain": new URL("../../packages/domain/src/index.ts", import.meta.url).pathname,
  "@pirate/platform-cf/postgres": new URL(
    "../../packages/platform-cf/src/postgres.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/namespace-ownership-hns-control-observer-hsd-private-transport": new URL(
    "../../packages/platform-cf/src/namespace-ownership/hns-control-observer-hsd-private-transport.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/namespace-ownership-hns-control-observer-postgres": new URL(
    "../../packages/platform-cf/src/namespace-ownership/hns-control-observer-postgres.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/namespace-ownership-hns-private-driver-transport": new URL(
    "../../packages/platform-cf/src/namespace-ownership/hns-private-driver-transport.ts",
    import.meta.url,
  ).pathname,
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/workerd-hns-verifier/wrangler.jsonc" },
      miniflare: { alias },
    }),
  ],
  resolve: { alias },
  test: {
    include: ["tests/workerd-hns-verifier/**/*.test.ts"],
  },
});
