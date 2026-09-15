import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const alias = {
  "@pirate/contracts": new URL("../../packages/contracts/src/index.ts", import.meta.url).pathname,
  "@pirate/domain": new URL("../../packages/domain/src/index.ts", import.meta.url).pathname,
  "@pirate/application/data/registration-workflow": new URL(
    "../../packages/application/src/data/registration-workflow.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/data/registration-workflow-queue": new URL(
    "../../packages/application/src/data/registration-workflow-queue.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/media/source-recording-authority": new URL(
    "../../packages/application/src/media/source-recording-authority.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/cloudflare-workflow-entrypoint": new URL(
    "../../packages/platform-cf/src/cloudflare-workflow-entrypoint.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/data/registration-workflow-cloudflare": new URL(
    "../../packages/platform-cf/src/data/registration-workflow-cloudflare.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/media-processing-cloudflare": new URL(
    "../../packages/platform-cf/src/media-processing-cloudflare.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/song-source-recording-consumer": new URL(
    "../../packages/platform-cf/src/song-source-recording-consumer.ts",
    import.meta.url,
  ).pathname,
};

export default defineConfig({
  resolve: { alias },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/workerd-song-workflows/wrangler.jsonc" },
      miniflare: { alias },
    }),
  ],
  test: {
    include: ["tests/workerd-song-workflows/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
