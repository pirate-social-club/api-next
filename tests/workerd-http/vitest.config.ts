import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const alias = {
  "@pirate/application/use-cases/identity-account": new URL(
    "../../packages/application/src/use-cases/identity-account.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/current-user": new URL(
    "../../packages/application/src/use-cases/current-user.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/profile": new URL(
    "../../packages/application/src/use-cases/profile.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/session-authentication": new URL(
    "../../packages/application/src/use-cases/session-authentication.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/session-exchange": new URL(
    "../../packages/application/src/use-cases/session-exchange.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/identity-registration-handler": new URL(
    "../../packages/application/src/use-cases/identity-registration-handler.ts",
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
  "@pirate/platform-cf": new URL("../../packages/platform-cf/src/index.ts", import.meta.url)
    .pathname,
  "@pirate/platform-cf/registration-rate-limiter": new URL(
    "../../packages/platform-cf/src/registration-rate-limiter.ts",
    import.meta.url,
  ).pathname,
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/workerd-http/wrangler.jsonc" },
      miniflare: { alias },
    }),
  ],
  resolve: { alias },
  test: {
    include: ["tests/workerd-http/**/*.test.ts"],
  },
});
