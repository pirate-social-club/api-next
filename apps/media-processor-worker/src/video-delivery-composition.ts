import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import type { Layer } from "effect";
import { VIDEO_ENRICHMENT_POLICY } from "../../../packages/application/src/video/enrichment-workflow.ts";
import { makeConfiguredVideoAnalysisWorkflowLauncher } from "../../../packages/platform-cf/src/video-analysis-workflow-cloudflare.ts";
import { makeVideoEnrichmentExecutionStore } from "../../../packages/platform-cf/src/video-enrichment-execution-store.ts";
import { makeVideoPosterAuthority } from "../../../packages/platform-cf/src/video-poster-authority.ts";
import { makeVideoSourceGrantIssuer } from "../../../packages/platform-cf/src/video-source-grant-issuer.ts";
import { makeVideoStreamIngestStore } from "../../../packages/platform-cf/src/video-stream-ingest-repository.ts";
import { makeVideoStreamTransport } from "../../../packages/platform-cf/src/video-stream-transport.ts";
import { makeVideoThumbnailStore } from "../../../packages/platform-cf/src/video-thumbnail-repository.ts";
import { makeVideoThumbnailVerifier } from "../../../packages/platform-cf/src/video-thumbnail-verifier.ts";
import type { MediaProcessorRuntimeEnv } from "./composition.ts";

export function makeVideoDeliveryComposition(
  env: MediaProcessorRuntimeEnv,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  if (env.VIDEO_DELIVERY_ENABLED !== "true") return {};
  if (
    env.MEDIA_PROCESSING_ENABLED !== "true" ||
    env.VIDEO_ANALYSIS_WORKFLOW === undefined ||
    env.MEDIA_DERIVED_ARTIFACTS === undefined
  )
    throw new Error("Video delivery requires processing, Workflow and artifact bindings");
  const required = (value: string | undefined, name: string) => {
    if (!value?.trim() || value === "PENDING")
      throw new Error(`${name} is required for video delivery`);
    return value;
  };
  const origin = required(env.VIDEO_SOURCE_GATEWAY_ORIGIN, "VIDEO_SOURCE_GATEWAY_ORIGIN");
  const executions = makeVideoEnrichmentExecutionStore(runtime);
  const launcher = makeConfiguredVideoAnalysisWorkflowLauncher(env.VIDEO_ANALYSIS_WORKFLOW, {
    accountId: env.VIDEO_WORKFLOW_ACCOUNT_ID,
    workflowName: env.VIDEO_WORKFLOW_NAME,
    scriptName: env.VIDEO_WORKFLOW_SCRIPT_NAME,
    readToken: env.VIDEO_WORKFLOW_READ_TOKEN,
  });
  return {
    videoEnrichment: { executions, launcher },
    videoEnrichmentWorkflow: {
      executions,
      nowMs: Date.now,
      stream: {
        store: makeVideoStreamIngestStore(runtime, {
          leaseOwner: `video-delivery-${crypto.randomUUID()}`,
          leaseMs: VIDEO_ENRICHMENT_POLICY.leaseMs,
        }),
        transport: makeVideoStreamTransport({
          // The reviewed topology keeps Stream and Workflows in the same account;
          // a cross-account deployment requires a separate explicit configuration.
          accountId: required(env.VIDEO_WORKFLOW_ACCOUNT_ID, "VIDEO_WORKFLOW_ACCOUNT_ID"),
          apiToken: required(env.VIDEO_STREAM_API_TOKEN, "VIDEO_STREAM_API_TOKEN"),
          sourceGatewayOrigin: origin,
          grants: makeVideoSourceGrantIssuer(runtime, origin, "stream"),
          fetch,
          nowMs: Date.now,
        }),
        nowMs: Date.now,
        deadlines: (nowMs: number) => ({
          acceptanceDeadlineMs: nowMs + VIDEO_ENRICHMENT_POLICY.acceptanceMs,
          encodingDeadlineMs: nowMs + VIDEO_ENRICHMENT_POLICY.encodingMs,
        }),
      },
      thumbnail: {
        store: makeVideoThumbnailStore(runtime, { leaseMs: VIDEO_ENRICHMENT_POLICY.leaseMs }),
        verify: makeVideoThumbnailVerifier({
          resolveArtifact: makeVideoPosterAuthority(runtime),
          bucket: env.MEDIA_DERIVED_ARTIFACTS,
        }),
      },
    },
  };
}
