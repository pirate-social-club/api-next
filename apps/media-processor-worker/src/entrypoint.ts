import type { MediaProcessingWorkflowPayload } from "@pirate/application/media/processing-contracts";
import type { MediaProcessingWorkflowResult } from "@pirate/application/media/processing-workflow";
import { makeCloudflareDanceReferenceWorkflowEntrypoint } from "@pirate/platform-cf/dance-reference-workflow-entrypoint";
import { makeCloudflareMediaWorkflowEntrypoint } from "@pirate/platform-cf/media-workflow-entrypoint";
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

const concreteWorkflowRunner = makeMediaProcessingWorkflowRunner(makeMediaProcessorComposition);
const CloudflareMediaProcessingWorkflow = makeCloudflareMediaWorkflowEntrypoint<
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
const CloudflareDanceReferenceProcessingWorkflow = makeCloudflareDanceReferenceWorkflowEntrypoint<
  DanceReferenceProcessorRuntimeEnv,
  DanceReferenceWorkflowResult,
  DanceReferenceWorkflowStep
>(danceReferenceRunner);

/** Dormant until a reviewed processor injection and separate binding exist. */
export class DanceReferenceProcessingWorkflow extends CloudflareDanceReferenceProcessingWorkflow {}

export default makeMediaProcessorQueueWorker(makeMediaProcessorComposition);
