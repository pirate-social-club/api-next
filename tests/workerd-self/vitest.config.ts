import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const alias = {
  "@pirate/application": new URL("../../packages/application/src/index.ts", import.meta.url)
    .pathname,
  "@pirate/application/verification": new URL(
    "../../packages/application/src/verification/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/domain": new URL("../../packages/domain/src/index.ts", import.meta.url).pathname,
  "@pirate/domain/verification": new URL(
    "../../packages/domain/src/verification/index.ts",
    import.meta.url,
  ).pathname,
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/workerd-self/wrangler.jsonc" },
      miniflare: { alias },
    }),
  ],
  resolve: { alias },
  test: {
    include: ["tests/workerd-self/**/*.test.ts"],
  },
});
