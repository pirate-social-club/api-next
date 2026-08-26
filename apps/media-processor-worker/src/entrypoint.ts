import type { MediaProcessingWorkflowPayload } from "@pirate/application/media/processing-contracts";
import type { MediaProcessingWorkflowResult } from "@pirate/application/media/processing-workflow";
import { makeCloudflareMediaWorkflowEntrypoint } from "@pirate/platform-cf/media-workflow-entrypoint";
import { type MediaProcessorRuntimeEnv, makeMediaProcessorComposition } from "./composition.ts";
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

export default makeMediaProcessorQueueWorker(makeMediaProcessorComposition);
