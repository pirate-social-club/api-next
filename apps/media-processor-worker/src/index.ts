import type {
  MediaProcessingEventType,
  MediaProcessingWorkflowPayload,
} from "../../../packages/application/src/media/processing-contracts.ts";
import type { MediaProcessingQueueDependencies } from "../../../packages/application/src/media/processing-queue.ts";
import {
  type MediaProcessingWorkflowDependencies,
  type MediaProcessingWorkflowResult,
  runMediaProcessingWorkflow,
} from "../../../packages/application/src/media/processing-workflow.ts";
import {
  consumeVideoAnalysisQueueMessage,
  type VideoAnalysisQueueDependencies,
} from "../../../packages/application/src/video/analysis-queue.ts";
import {
  type CloudflareWorkflowStepDo,
  PROCESSING_WORKFLOW_STEP_OPTIONS,
} from "../../../packages/platform-cf/src/cloudflare-orchestration-primitives.ts";
import { handleMediaProcessingQueueBatch } from "../../../packages/platform-cf/src/media-processing-cloudflare.ts";
import { isMediaProcessingEnabled } from "./posture.ts";

export { isMediaProcessingEnabled } from "./posture.ts";

export type MediaProcessorWorkerEnv = Readonly<{
  readonly MEDIA_PROCESSING_ENABLED?: string;
}>;

export type MediaProcessorComposition = Readonly<{
  readonly queue: MediaProcessingQueueDependencies;
  readonly videoAnalysis?: VideoAnalysisQueueDependencies;
  readonly workflow: MediaProcessingWorkflowDependencies;
}>;

export type ResolveMediaProcessorComposition<Env extends MediaProcessorWorkerEnv> = (
  env: Env,
) => MediaProcessorComposition;

const applyRuntimePosture = <Env extends MediaProcessorWorkerEnv>(
  env: Env,
  composition: MediaProcessorComposition,
): MediaProcessorComposition => ({
  ...composition,
  workflow: {
    ...composition.workflow,
    options: {
      ...composition.workflow.options,
      enabled:
        isMediaProcessingEnabled(env.MEDIA_PROCESSING_ENABLED) &&
        composition.workflow.options.enabled,
    },
  },
});

export function makeMediaProcessorQueueWorker<Env extends MediaProcessorWorkerEnv>(
  resolve: ResolveMediaProcessorComposition<Env>,
) {
  return {
    queue: async (
      batch: Parameters<typeof handleMediaProcessingQueueBatch>[0],
      env: Env,
    ): Promise<void> => {
      const composition = applyRuntimePosture(env, resolve(env));
      const songMessages: (typeof batch.messages)[number][] = [];
      const videoMessages: (typeof batch.messages)[number][] = [];
      for (const message of batch.messages) {
        if (
          typeof message.body === "object" &&
          message.body !== null &&
          !Array.isArray(message.body) &&
          (message.body as { readonly kind?: unknown }).kind === "video_analysis"
        ) {
          videoMessages.push(message);
        } else {
          songMessages.push(message);
        }
      }
      await Promise.all([
        handleMediaProcessingQueueBatch({ messages: songMessages }, composition.queue),
        Promise.all(
          videoMessages.map(async (message) => {
            if (composition.videoAnalysis === undefined) {
              message.retry({ delaySeconds: 30 });
              return;
            }
            const disposition = await consumeVideoAnalysisQueueMessage(
              message.body,
              composition.videoAnalysis,
            );
            if (disposition.disposition === "ack") {
              message.ack();
            } else if (disposition.disposition === "dlq") {
              message.retry();
            } else {
              message.retry({ delaySeconds: disposition.delaySeconds });
            }
          }),
        ),
      ]);
    },
  };
}

const nextEventType = (
  result: MediaProcessingWorkflowResult,
): Exclude<MediaProcessingEventType, "analysis_launch" | "workflow_replacement"> | null => {
  switch (result.outcome) {
    case "waiting_for_terms":
    case "action_required":
      return "decision_wakeup";
    case "manual_review":
      return "publication";
    case "published":
      // Publication persists alignment under the next Workflow revision.
      // Queue delivery launches that deterministic instance; this one is done.
      return null;
    case "published_without_alignment":
      return null;
    default:
      return null;
  }
};

export type MediaProcessingWorkflowEvent = Readonly<{
  readonly payload: Readonly<MediaProcessingWorkflowPayload>;
  readonly instanceId: string;
}>;

export interface MediaProcessingWorkflowStep
  extends CloudflareWorkflowStepDo<typeof PROCESSING_WORKFLOW_STEP_OPTIONS> {
  readonly waitForEvent: <T>(
    name: string,
    options: Readonly<{ readonly type: string; readonly timeout: string }>,
  ) => Promise<Readonly<{ readonly payload: Readonly<T>; readonly type: string }>>;
  readonly sleep: (name: string, duration: "10 seconds") => Promise<void>;
}

/**
 * The returned runner is wrapped by the later composition handoff's concrete
 * WorkflowEntrypoint. Each durable step resolves only identifiers, then the
 * application interpreter reloads PostgreSQL authority before any effect.
 */
export function makeMediaProcessingWorkflowRunner<Env extends MediaProcessorWorkerEnv>(
  resolve: ResolveMediaProcessorComposition<Env>,
) {
  return async (
    env: Env,
    event: MediaProcessingWorkflowEvent,
    step: MediaProcessingWorkflowStep,
  ): Promise<MediaProcessingWorkflowResult> => {
    const composition = applyRuntimePosture(env, resolve(env));
    let payload = event.payload;
    let eventType: MediaProcessingEventType | null = null;
    let sequence = 0;

    while (true) {
      const execution: Readonly<{
        eventType: MediaProcessingEventType;
        result: MediaProcessingWorkflowResult;
      }> = await step.do(
        `media-processing-${sequence}-${eventType ?? "launch"}`,
        PROCESSING_WORKFLOW_STEP_OPTIONS,
        async () => {
          const resolvedEventType =
            eventType ??
            (await composition.workflow.store.getOutbox(payload.outboxId))?.eventType ??
            null;
          if (resolvedEventType === null) {
            return {
              eventType: "analysis_launch" as const,
              result: { outcome: "inert" as const },
            };
          }
          return {
            eventType: resolvedEventType,
            result: await runMediaProcessingWorkflow(
              payload,
              resolvedEventType,
              composition.workflow,
            ),
          };
        },
      );
      eventType = execution.eventType;
      const { result } = execution;
      if (result.outcome === "waiting_for_provider") {
        await step.sleep(`media-processing-poll-${sequence}`, "10 seconds");
        sequence += 1;
        continue;
      }
      const expectedEvent = nextEventType(result);
      if (expectedEvent === null) return result;
      const wakeup = await step.waitForEvent<MediaProcessingWorkflowPayload>(
        `media-processing-wait-${sequence}-${expectedEvent}`,
        { type: expectedEvent, timeout: "365 days" },
      );
      payload = wakeup.payload;
      eventType = expectedEvent;
      sequence += 1;
    }
  };
}
