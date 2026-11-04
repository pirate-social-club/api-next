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
import { alignmentRecoveryAuthority } from "../../packages/application/src/media/alignment-recovery.test-fixture.ts";
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
import { songInterpreterProviders } from "../../packages/platform-cf/src/media-song-interpreter.pg-fixture.ts";

type TestEnv = Readonly<{
  MEDIA_PROCESSING_ENABLED?: string;
  DATA_REGISTRATION_ENABLED?: string;
  RECOVERY_STATE: KVNamespace;
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
  (env) => ({
    queue: {} as MediaProcessingQueueDependencies,
    workflow: {
      ...mediaWorkflow,
      store: {
        ...mediaStore,
        getOutbox: async (outboxId) =>
          outboxId === "outbox-1"
            ? mediaStore.getOutbox(outboxId)
            : {
                outboxId,
                eventType: "workflow_replacement",
                submissionId: "recovery-submission",
                operationId: outboxId,
                workflowRevision: 3,
                workflowInstanceId: `media-${outboxId}-r3`,
                deliveryAttempts: 1,
                state: "delivered",
                claimFence: 1,
                claimOwner: null,
              },
        loadAuthority: async (_submissionId, operationId) =>
          operationId === "operation-1"
            ? mediaAuthority
            : alignmentRecoveryAuthority({ operationId }),
        readAlignmentRecovery: async (authority) => {
          const key = `lookups:${authority.operationId}`;
          const count = Number((await env.RECOVERY_STATE.get(key)) ?? 0) + 1;
          await env.RECOVERY_STATE.put(key, String(count));
          if (authority.operationId === "recovery-stale")
            return { kind: "stale", reason: "invalid_projection_row_count" };
          if (
            authority.operationId === "recovery-failed" ||
            (authority.operationId === "recovery-transient" && count < 3) ||
            (authority.operationId === "recovery-reset" && [1, 2, 4, 5].includes(count))
          )
            return {
              kind: "failed",
              reason: {
                errorClass: "ControlPlaneAcquireFailed",
                code: null,
                query: "media-processing.alignment-recovery-authorization",
              },
            };
          return {
            kind: "recovery",
            recoveryActionId: "recovery-action",
            attemptId: "recovery-attempt",
          };
        },
        startAttempt: async (input) => {
          if (input.authority.operationId === "recovery-exhausted") return { kind: "exhausted" };
          if (
            input.authority.operationId === "recovery-reset" &&
            (await env.RECOVERY_STATE.get("lookups:recovery-reset")) === "3"
          )
            return { kind: "busy" };
          return {
            kind: "run",
            lease: {
              attemptId: input.attemptId,
              attemptNumber: 1,
              stage: input.stage,
              claimOwner: input.workerId,
              claimFence: 1,
            },
          };
        },
        commitAlignment: async (authority, result) => {
          await env.RECOVERY_STATE.put(
            `completed:${authority.operationId}`,
            JSON.stringify(result),
          );
          return "committed";
        },
        completeAttempt: async () => true,
      },
      providers: {
        ...songInterpreterProviders,
        alignment: {
          align: async (input) => {
            const key = `providers:${input.operationId}`;
            const count = Number((await env.RECOVERY_STATE.get(key)) ?? 0) + 1;
            await env.RECOVERY_STATE.put(key, String(count));
            return { status: "unavailable", failureCode: "alignment_failed" };
          },
        },
      },
    },
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
