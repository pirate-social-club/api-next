import {
  type DataRegistrationWorkflowStep,
  makeDataRegistrationWorkflowRunner,
} from "../../apps/data-registration-worker/src/index.ts";
import {
  type MediaProcessingWorkflowStep,
  makeMediaProcessingWorkflowRunner,
} from "../../apps/media-processor-worker/src/index.ts";
import type {
  DataRegistrationWorkflowDependencies,
  DataRegistrationWorkflowResult,
  DataRegistrationWorkflowWirePayload,
} from "../../packages/application/src/data/registration-workflow.ts";
import type { DataRegistrationQueueDependencies } from "../../packages/application/src/data/registration-workflow-queue.ts";
import type {
  MediaProcessingAuthority,
  MediaProcessingStore,
  MediaProcessingWorkflowPayload,
} from "../../packages/application/src/media/processing-contracts.ts";
import type { MediaProcessingQueueDependencies } from "../../packages/application/src/media/processing-queue.ts";
import type {
  MediaProcessingWorkflowDependencies,
  MediaProcessingWorkflowResult,
} from "../../packages/application/src/media/processing-workflow.ts";
import {
  makeCloudflareWorkflowEntrypoint,
  makeWorkflowNonRetryableError,
} from "../../packages/platform-cf/src/cloudflare-workflow-entrypoint.ts";

type TestEnv = Readonly<{
  MEDIA_PROCESSING_ENABLED?: string;
  DATA_REGISTRATION_ENABLED?: string;
}>;

const mediaAuthority = {
  submissionId: "submission-1",
  operationId: "operation-1",
  workflowRevision: 1,
  status: "blocked",
} as MediaProcessingAuthority;

const mediaStore = {
  getOutbox: async () => ({
    outboxId: "outbox-1",
    eventType: "analysis_launch" as const,
    submissionId: mediaAuthority.submissionId,
    operationId: mediaAuthority.operationId,
    workflowRevision: mediaAuthority.workflowRevision,
    workflowInstanceId: "media-operation-1-r1",
    deliveryAttempts: 1,
    state: "delivered" as const,
    claimFence: 1,
    claimOwner: null,
  }),
  loadAuthority: async () => mediaAuthority,
} as unknown as MediaProcessingStore;

const mediaWorkflow = {
  store: mediaStore,
  providers: null,
  options: {
    enabled: true,
    workerId: "workerd-song-workflow-test",
    now: () => 1,
    policyRevision: "policy-v1",
    transformAdapterRevision: "transform-v1",
    metadataAdapterRevision: "metadata-v1",
    classifierTimeoutMs: 1_000,
    transformRuntimeMs: 1_000,
    maximumSampleBytes: 1_000,
  },
} satisfies MediaProcessingWorkflowDependencies;

const mediaRunner = makeMediaProcessingWorkflowRunner<TestEnv>(
  () => ({
    queue: {} as MediaProcessingQueueDependencies,
    workflow: mediaWorkflow,
  }),
  makeWorkflowNonRetryableError,
);

const CloudflareMediaProcessingWorkflow = makeCloudflareWorkflowEntrypoint<
  TestEnv,
  MediaProcessingWorkflowPayload,
  MediaProcessingWorkflowResult,
  MediaProcessingWorkflowStep
>(mediaRunner);

export class MediaProcessingWorkflow extends CloudflareMediaProcessingWorkflow {}

const dataWorkflow = {
  options: { enabled: true },
} as DataRegistrationWorkflowDependencies;

const dataRunner = makeDataRegistrationWorkflowRunner<TestEnv>(() => ({
  queue: {} as DataRegistrationQueueDependencies,
  workflow: dataWorkflow,
}));

const CloudflareDataRegistrationWorkflow = makeCloudflareWorkflowEntrypoint<
  TestEnv,
  DataRegistrationWorkflowWirePayload,
  DataRegistrationWorkflowResult,
  DataRegistrationWorkflowStep
>(dataRunner);

export class DataRegistrationWorkflow extends CloudflareDataRegistrationWorkflow {}

export default {
  fetch: () => new Response("not found", { status: 404 }),
};
