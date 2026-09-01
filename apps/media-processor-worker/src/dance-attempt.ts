import type { DanceAttemptProcessingDisposition } from "../../../packages/application/src/dance/attempt-processing.ts";
import type {
  DanceAttemptQueueDependencies,
  DanceAttemptWorkflowDependencies,
  DanceAttemptWorkflowPayload,
} from "../../../packages/application/src/dance/attempt-processing-wakeup.ts";
import { advanceDanceAttemptWorkflow } from "../../../packages/application/src/dance/attempt-processing-wakeup.ts";
import { handleDanceAttemptQueueBatch } from "../../../packages/platform-cf/src/dance-attempt-processing-cloudflare.ts";

export type DanceAttemptProcessorWorkerEnv = Readonly<{
  readonly DANCE_ATTEMPT_PROCESSING_ENABLED?: string;
}>;

export type DanceAttemptProcessorComposition = Readonly<{
  readonly queue: DanceAttemptQueueDependencies;
  readonly workflow: DanceAttemptWorkflowDependencies;
}>;

export type ResolveDanceAttemptProcessorComposition<Env extends DanceAttemptProcessorWorkerEnv> = (
  env: Env,
) => DanceAttemptProcessorComposition;

const isDanceAttemptProcessingEnabled = (value: string | undefined): boolean => value === "true";

const workflowStepOptions = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

export interface DanceAttemptWorkflowStep {
  readonly do: <T>(
    name: string,
    options: typeof workflowStepOptions,
    callback: () => Promise<T>,
  ) => Promise<T>;
}

export function makeDanceAttemptQueueWorker<Env extends DanceAttemptProcessorWorkerEnv>(
  resolve: ResolveDanceAttemptProcessorComposition<Env>,
) {
  return {
    queue: async (
      batch: Parameters<typeof handleDanceAttemptQueueBatch>[0],
      env: Env,
    ): Promise<void> => {
      if (!isDanceAttemptProcessingEnabled(env.DANCE_ATTEMPT_PROCESSING_ENABLED)) {
        for (const message of batch.messages) message.retry({ delaySeconds: 900 });
        return;
      }
      const composition = resolve(env);
      if (composition.workflow.adapter === null) {
        for (const message of batch.messages) message.retry({ delaySeconds: 900 });
        return;
      }
      await handleDanceAttemptQueueBatch(batch, composition.queue);
    },
  };
}

export function makeDanceAttemptWorkflowRunner<Env extends DanceAttemptProcessorWorkerEnv>(
  resolve: ResolveDanceAttemptProcessorComposition<Env>,
) {
  return async (
    env: Env,
    event: Readonly<{
      readonly payload: Readonly<DanceAttemptWorkflowPayload>;
      readonly instanceId: string;
    }>,
    step: DanceAttemptWorkflowStep,
  ): Promise<DanceAttemptProcessingDisposition> => {
    if (!isDanceAttemptProcessingEnabled(env.DANCE_ATTEMPT_PROCESSING_ENABLED)) {
      return { kind: "inert" };
    }
    const composition = resolve(env);
    if (composition.workflow.adapter === null) return { kind: "inert" };
    return step.do("dance-attempt-processing", workflowStepOptions, () =>
      advanceDanceAttemptWorkflow(event.payload, event.instanceId, composition.workflow),
    );
  };
}
