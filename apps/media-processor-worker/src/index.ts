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
import { handleMediaProcessingQueueBatch } from "../../../packages/platform-cf/src/media-processing-cloudflare.ts";
import { isMediaProcessingEnabled } from "./posture.ts";

export { isMediaProcessingEnabled } from "./posture.ts";

export type MediaProcessorWorkerEnv = Readonly<{
  readonly MEDIA_PROCESSING_ENABLED?: string;
}>;

export type MediaProcessorComposition = Readonly<{
  readonly queue: MediaProcessingQueueDependencies;
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
      await handleMediaProcessingQueueBatch(batch, composition.queue);
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

const workflowStepOptions = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

export type MediaProcessingWorkflowEvent = Readonly<{
  readonly payload: Readonly<MediaProcessingWorkflowPayload>;
  readonly instanceId: string;
}>;

export interface MediaProcessingWorkflowStep {
  readonly do: <T>(
    name: string,
    options: typeof workflowStepOptions,
    callback: () => Promise<T>,
  ) => Promise<T>;
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
        workflowStepOptions,
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
