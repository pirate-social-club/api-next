import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { videoPlatformAliases as alias, videoPostgresAliases } from "../video-platform-aliases.ts";

export default defineConfig({
  resolve: { alias },
  plugins: [
    cloudflareTest(({ inject }) => ({
      main: "./apps/media-processor-worker/src/entrypoint.ts",
      miniflare: {
        alias: videoPostgresAliases,
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          VIDEO_TEST_DATABASE: inject("videoDatabase"),
          VIDEO_TEST_RESET: readFileSync(
            new URL("../../db/postgres/test-reset.sql", import.meta.url),
            "utf8",
          ),
        },
      },
    })),
  ],
  test: {
    // Cloudflare workers-sdk#12984: the aliases above select the published CommonJS entrypoints.

    globalSetup: ["./tests/workerd-video/global-setup.ts"],
    include: ["tests/workerd-video/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
