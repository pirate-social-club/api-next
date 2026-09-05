import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const alias = {
  "@pirate/platform-cf/video-source-gateway": new URL(
    "../../packages/platform-cf/src/video-source-gateway.ts",
    import.meta.url,
  ).pathname,
};
export default defineConfig({
  resolve: { alias },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./apps/video-source-gateway/wrangler.jsonc" },
      miniflare: { alias },
    }),
  ],
  test: { include: ["tests/workerd-video-source/**/*.test.ts"] },
});
