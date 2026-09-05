import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { videoPlatformAliases as alias, videoPostgresAliases } from "../video-platform-aliases.ts";

export default defineConfig({
  resolve: { alias },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./apps/video-source-gateway/wrangler.jsonc" },
      miniflare: { alias: videoPostgresAliases },
    }),
  ],
  test: { include: ["tests/workerd-video-source/**/*.test.ts"] },
});
