import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workspace packages resolve to source so the workerd pool bundles one
// program for both the worker main and the test modules.
const alias = {
  "@pirate/application/use-cases/content/community-moderation-runtime": new URL(
    "../../packages/application/src/use-cases/content/community-moderation-runtime.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/route-revalidation": new URL(
    "../../packages/application/src/route-revalidation/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/data/registration-workflow-queue": new URL(
    "../../packages/application/src/data/registration-workflow-queue.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/data/registration-workflow": new URL(
    "../../packages/application/src/data/registration-workflow.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/data/registration-persistence": new URL(
    "../../packages/application/src/data/registration-persistence.ts",
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
  "@pirate/platform-cf/media-processing-cloudflare": new URL(
    "../../packages/platform-cf/src/media-processing-cloudflare.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/media-processing-store": new URL(
    "../../packages/platform-cf/src/media-processing-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/media-workflow-entrypoint": new URL(
    "../../packages/platform-cf/src/media-workflow-entrypoint.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/data/registration-workflow-cloudflare": new URL(
    "../../packages/platform-cf/src/data/registration-workflow-cloudflare.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/data-registration-repository": new URL(
    "../../packages/platform-cf/src/data-registration-repository.ts",
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
      miniflare: {
        alias,
        workers: [
          {
            name: "pirate-media-processor-worker",
            modules: true,
            compatibilityDate: "2026-08-01",
            script: `
              import { WorkflowEntrypoint } from "cloudflare:workers";
              export class MediaProcessingWorkflow extends WorkflowEntrypoint {
                async run() { return { outcome: "inert" }; }
              }
            `,
          },
          {
            name: "pirate-data-registration-worker",
            modules: true,
            compatibilityDate: "2026-08-01",
            script: `
              import { WorkflowEntrypoint } from "cloudflare:workers";
              export class DataRegistrationWorkflow extends WorkflowEntrypoint {
                async run() { return { outcome: "inert" }; }
              }
            `,
          },
        ],
      },
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
