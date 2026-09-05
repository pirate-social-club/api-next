import type { DanceReferenceWorkflowPayload } from "@pirate/application/dance/reference-processing-wakeup";
import type { MediaProcessingWorkflowPayload } from "@pirate/application/media/processing-contracts";
import type { MediaProcessingWorkflowResult } from "@pirate/application/media/processing-workflow";
import { makeCloudflareWorkflowEntrypoint } from "@pirate/platform-cf/cloudflare-workflow-entrypoint";
import type { VideoWorkflowResult } from "../../../packages/application/src/video/workflow.ts";
import { type MediaProcessorRuntimeEnv, makeMediaProcessorComposition } from "./composition.ts";
import {
  type DanceReferenceWorkflowResult,
  type DanceReferenceWorkflowStep,
  makeDanceReferenceWorkflowRunner,
} from "./dance-reference.ts";
import {
  type DanceReferenceProcessorRuntimeEnv,
  makeDanceReferenceProcessorComposition,
} from "./dance-reference-composition.ts";
import {
  type MediaProcessingWorkflowStep,
  makeMediaProcessingWorkflowRunner,
  makeMediaProcessorQueueWorker,
} from "./index.ts";
import {
  makeVideoAnalysisWorkflowRunner,
  type VideoAnalysisWorkflowStep,
} from "./video-workflow.ts";

const concreteWorkflowRunner = makeMediaProcessingWorkflowRunner(makeMediaProcessorComposition);
const CloudflareMediaProcessingWorkflow = makeCloudflareWorkflowEntrypoint<
  MediaProcessorRuntimeEnv,
  MediaProcessingWorkflowPayload,
  MediaProcessingWorkflowResult,
  MediaProcessingWorkflowStep
>(concreteWorkflowRunner);

/** Concrete durable interpreter registered by Wrangler under a fixed class name. */
export class MediaProcessingWorkflow extends CloudflareMediaProcessingWorkflow {}

const danceReferenceRunner = makeDanceReferenceWorkflowRunner(
  makeDanceReferenceProcessorComposition,
);
const CloudflareDanceReferenceProcessingWorkflow = makeCloudflareWorkflowEntrypoint<
  DanceReferenceProcessorRuntimeEnv,
  DanceReferenceWorkflowPayload,
  DanceReferenceWorkflowResult,
  DanceReferenceWorkflowStep
>(danceReferenceRunner);

/** Dormant until a reviewed processor injection and separate binding exist. */
export class DanceReferenceProcessingWorkflow extends CloudflareDanceReferenceProcessingWorkflow {}

const videoAnalysisRunner = makeVideoAnalysisWorkflowRunner(makeMediaProcessorComposition);
const CloudflareVideoAnalysisWorkflow = makeCloudflareWorkflowEntrypoint<
  MediaProcessorRuntimeEnv,
  { readonly effectIdentity: string },
  VideoWorkflowResult,
  VideoAnalysisWorkflowStep
>(videoAnalysisRunner);

/** The status API verifies this fixed class name before establishing missing instances. */
export class VideoAnalysisWorkflow extends CloudflareVideoAnalysisWorkflow {}

export default makeMediaProcessorQueueWorker(makeMediaProcessorComposition);
