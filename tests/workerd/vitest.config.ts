import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";

// Workspace packages resolve to source so the workerd pool bundles one
// program for both the worker main and the test modules.
const alias = {
  "@pirate/application/video/stage-facts": new URL(
    "../../packages/application/src/video/stage-facts.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/video/workflow-recovery": new URL(
    "../../packages/application/src/video/workflow-recovery.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/video-analysis-outbox-repository": new URL(
    "../../packages/platform-cf/src/video-analysis-outbox-repository.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/video-publication-repository": new URL(
    "../../packages/platform-cf/src/video-publication-repository.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/video-analysis-workflow-cloudflare": new URL(
    "../../packages/platform-cf/src/video-analysis-workflow-cloudflare.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/post-slug": new URL(
    "../../packages/application/src/post-slug.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/content/community-moderation-runtime": new URL(
    "../../packages/application/src/use-cases/content/community-moderation-runtime.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/hns-edge-status": new URL(
    "../../packages/application/src/use-cases/hns-edge-status.ts",
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
  "@pirate/application/dance/reference-processing-wakeup": new URL(
    "../../packages/application/src/dance/reference-processing-wakeup.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/dance/reference-processing": new URL(
    "../../packages/application/src/dance/reference-processing.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/dance/attempt-processing-wakeup": new URL(
    "../../packages/application/src/dance/attempt-processing-wakeup.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/dance/attempt-processing": new URL(
    "../../packages/application/src/dance/attempt-processing.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/dance/attempt-callback": new URL(
    "../../packages/application/src/dance/attempt-callback.ts",
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
  "@pirate/application/namespace-ownership": new URL(
    "../../packages/application/src/namespace-ownership/index.ts",
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
  "@pirate/platform-cf/cloudflare-workflow-entrypoint": new URL(
    "../../packages/platform-cf/src/cloudflare-workflow-entrypoint.ts",
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
  "@pirate/platform-cf/dance-reference-processing-repository": new URL(
    "../../packages/platform-cf/src/dance-reference-processing-repository.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf": new URL("../../packages/platform-cf/src/index.ts", import.meta.url)
    .pathname,
  "@pirate/verifier-response-contract": new URL(
    "../../packages/verifier-response-contract/src/index.ts",
    import.meta.url,
  ).pathname,
};

const productionJobsConfiguration = unstable_readConfig(
  {
    config: new URL("../../apps/jobs-worker/wrangler.jsonc", import.meta.url).pathname,
    env: "production",
  },
  // Omitting the production learner-audio binding is intentional and tested.
  { hideWarnings: true },
);

export default defineConfig({
  resolve: { alias },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./apps/jobs-worker/wrangler.jsonc" },
      miniflare: {
        alias,
        bindings: { PRODUCTION_JOBS_CONFIGURATION: JSON.stringify(productionJobsConfiguration) },
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
          {
            name: "pirate-http-worker",
            modules: true,
            compatibilityDate: "2026-08-01",
            durableObjects: {
              KARAOKE_ATTEMPT: { className: "KaraokeAttemptDO", useSQLite: true },
            },
            script: `
              import { DurableObject } from "cloudflare:workers";
              export class KaraokeAttemptDO extends DurableObject {
                async redriveFinalization() {
                  return { outcome: "idle", rearmed: [] };
                }
              }
              export default { fetch() { return new Response("not found", { status: 404 }); } };
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
