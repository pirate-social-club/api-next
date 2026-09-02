import type { DanceAttemptProcessingDisposition } from "../../../packages/application/src/dance/attempt-processing.ts";
import type {
  DanceAttemptQueueDependencies,
  DanceAttemptWorkflowDependencies,
  DanceAttemptWorkflowPayload,
} from "../../../packages/application/src/dance/attempt-processing-wakeup.ts";
import { advanceDanceAttemptWorkflow } from "../../../packages/application/src/dance/attempt-processing-wakeup.ts";
import {
  type CloudflareWorkflowStepDo,
  isExplicitlyEnabled,
  PROCESSING_WORKFLOW_STEP_OPTIONS,
} from "../../../packages/platform-cf/src/cloudflare-orchestration-primitives.ts";
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

export interface DanceAttemptWorkflowStep
  extends CloudflareWorkflowStepDo<typeof PROCESSING_WORKFLOW_STEP_OPTIONS> {}

export function makeDanceAttemptQueueWorker<Env extends DanceAttemptProcessorWorkerEnv>(
  resolve: ResolveDanceAttemptProcessorComposition<Env>,
) {
  return {
    queue: async (
      batch: Parameters<typeof handleDanceAttemptQueueBatch>[0],
      env: Env,
    ): Promise<void> => {
      if (!isExplicitlyEnabled(env.DANCE_ATTEMPT_PROCESSING_ENABLED)) {
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
    if (!isExplicitlyEnabled(env.DANCE_ATTEMPT_PROCESSING_ENABLED)) {
      return { kind: "inert" };
    }
    const composition = resolve(env);
    if (composition.workflow.adapter === null) return { kind: "inert" };
    return step.do("dance-attempt-processing", PROCESSING_WORKFLOW_STEP_OPTIONS, () =>
      advanceDanceAttemptWorkflow(event.payload, event.instanceId, composition.workflow),
    );
  };
}
