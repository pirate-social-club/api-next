import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const alias = {
  "@pirate/contracts": new URL("../../packages/contracts/src/index.ts", import.meta.url).pathname,
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
