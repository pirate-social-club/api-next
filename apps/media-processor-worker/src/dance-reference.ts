import { Effect } from "effect";
import type {
  DanceReferenceQueueDependencies,
  DanceReferenceWorkflowAdvance,
  DanceReferenceWorkflowDependencies,
  DanceReferenceWorkflowPayload,
  DanceReferenceWorkflowResume,
} from "../../../packages/application/src/dance/reference-processing-wakeup.ts";
import { advanceDanceReferenceWorkflow } from "../../../packages/application/src/dance/reference-processing-wakeup.ts";
import {
  type CloudflareWorkflowStepDo,
  isExplicitlyEnabled,
  PROCESSING_WORKFLOW_STEP_OPTIONS,
} from "../../../packages/platform-cf/src/cloudflare-orchestration-primitives.ts";
import { handleDanceReferenceQueueBatch } from "../../../packages/platform-cf/src/dance-reference-processing-cloudflare.ts";

export type DanceReferenceProcessorWorkerEnv = Readonly<{
  readonly DANCE_REFERENCE_PROCESSING_ENABLED?: string;
}>;

export type DanceReferenceProcessorComposition = Readonly<{
  readonly queue: DanceReferenceQueueDependencies;
  readonly workflow: DanceReferenceWorkflowDependencies;
}>;

export type ResolveDanceReferenceProcessorComposition<
  Env extends DanceReferenceProcessorWorkerEnv,
> = (env: Env) => DanceReferenceProcessorComposition;

export interface DanceReferenceWorkflowStep
  extends CloudflareWorkflowStepDo<typeof PROCESSING_WORKFLOW_STEP_OPTIONS> {
  readonly sleep: (name: string, duration: "10 seconds") => Promise<void>;
}

export type DanceReferenceWorkflowResult = Exclude<
  DanceReferenceWorkflowAdvance,
  { readonly outcome: "waiting" }
>;

export function makeDanceReferenceQueueWorker<Env extends DanceReferenceProcessorWorkerEnv>(
  resolve: ResolveDanceReferenceProcessorComposition<Env>,
) {
  return {
    queue: async (
      batch: Parameters<typeof handleDanceReferenceQueueBatch>[0],
      env: Env,
    ): Promise<void> => {
      if (!isExplicitlyEnabled(env.DANCE_REFERENCE_PROCESSING_ENABLED)) {
        for (const message of batch.messages) message.retry({ delaySeconds: 900 });
        return;
      }
      const composition = resolve(env);
      if (composition.workflow.processor === null) {
        for (const message of batch.messages) message.retry({ delaySeconds: 900 });
        return;
      }
      await handleDanceReferenceQueueBatch(batch, composition.queue);
    },
  };
}

export function makeDanceReferenceWorkflowRunner<Env extends DanceReferenceProcessorWorkerEnv>(
  resolve: ResolveDanceReferenceProcessorComposition<Env>,
) {
  return async (
    env: Env,
    event: Readonly<{
      readonly payload: DanceReferenceWorkflowPayload;
      readonly instanceId: string;
    }>,
    step: DanceReferenceWorkflowStep,
  ): Promise<DanceReferenceWorkflowResult> => {
    if (!isExplicitlyEnabled(env.DANCE_REFERENCE_PROCESSING_ENABLED)) {
      return { outcome: "inert" };
    }
    const composition = resolve(env);
    if (composition.workflow.processor === null) return { outcome: "inert" };
    let resume: DanceReferenceWorkflowResume | undefined;
    let sequence = 0;
    while (true) {
      const result = await step.do(
        `dance-reference-processing-${sequence}`,
        PROCESSING_WORKFLOW_STEP_OPTIONS,
        () =>
          Effect.runPromise(
            advanceDanceReferenceWorkflow(
              event.payload,
              event.instanceId,
              composition.workflow,
              resume,
            ),
          ),
      );
      if (result.outcome !== "waiting") return result;
      resume = result.resume;
      await step.sleep(`dance-reference-processing-poll-${sequence}`, "10 seconds");
      sequence += 1;
    }
  };
}
