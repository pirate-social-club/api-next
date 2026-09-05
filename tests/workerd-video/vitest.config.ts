import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const pgProtocol = require.resolve("pg-protocol", { paths: [require.resolve("pg")] });
const pgCloudflare = `${dirname(require.resolve("pg-cloudflare/package.json", { paths: [require.resolve("pg")] }))}/dist/index.js`;
const root = new URL("../../", import.meta.url).pathname;
// Match source subpaths before package roots, preserving each package's existing exports.
const exact = [
  "application",
  "platform-cf",
  "domain",
  "contracts",
  "verifier-response-contract",
].flatMap((name) => {
  const manifest = JSON.parse(readFileSync(`${root}packages/${name}/package.json`, "utf8")) as {
    exports: Record<string, string>;
  };
  return Object.entries(manifest.exports).map(([key, value]) => ({
    find: `@pirate/${name}${key === "." ? "" : key.slice(1)}`,
    replacement: `${root}packages/${name}/${value.slice(2)}`,
  }));
});
const alias = [
  { find: "pg-protocol", replacement: pgProtocol },
  { find: "pg-cloudflare", replacement: pgCloudflare },
  ...exact
    .filter(({ find }) => find.split("/").length > 2)
    .sort((a, b) => b.find.length - a.find.length),
  { find: /^@pirate\/application\/(.+)$/u, replacement: `${root}packages/application/src/$1.ts` },
  { find: /^@pirate\/platform-cf\/(.+)$/u, replacement: `${root}packages/platform-cf/src/$1.ts` },
  { find: /^@pirate\/domain\/(.+)$/u, replacement: `${root}packages/domain/src/$1.ts` },
  ...["application", "platform-cf", "domain", "contracts", "verifier-response-contract"].map(
    (name) => ({ find: `@pirate/${name}`, replacement: `${root}packages/${name}/src/index.ts` }),
  ),
];
export default defineConfig({
  resolve: { alias },
  plugins: [
    cloudflareTest(({ inject }) => ({
      main: "./apps/media-processor-worker/src/entrypoint.ts",
      miniflare: {
        alias: { "pg-protocol": pgProtocol, "pg-cloudflare": pgCloudflare },
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
