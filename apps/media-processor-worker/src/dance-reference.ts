import type {
  DanceReferenceQueueDependencies,
  DanceReferenceWorkflowAdvance,
  DanceReferenceWorkflowDependencies,
  DanceReferenceWorkflowPayload,
  DanceReferenceWorkflowResume,
} from "../../../packages/application/src/dance/reference-processing-wakeup.ts";
import { advanceDanceReferenceWorkflow } from "../../../packages/application/src/dance/reference-processing-wakeup.ts";
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

const isDanceReferenceProcessingEnabled = (value: string | undefined): boolean => value === "true";

const workflowStepOptions = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

export interface DanceReferenceWorkflowStep {
  readonly do: <T>(
    name: string,
    options: typeof workflowStepOptions,
    callback: () => Promise<T>,
  ) => Promise<T>;
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
      if (!isDanceReferenceProcessingEnabled(env.DANCE_REFERENCE_PROCESSING_ENABLED)) {
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
    if (!isDanceReferenceProcessingEnabled(env.DANCE_REFERENCE_PROCESSING_ENABLED)) {
      return { outcome: "inert" };
    }
    const composition = resolve(env);
    if (composition.workflow.processor === null) return { outcome: "inert" };
    let resume: DanceReferenceWorkflowResume | undefined;
    let sequence = 0;
    while (true) {
      const result = await step.do(
        `dance-reference-processing-${sequence}`,
        workflowStepOptions,
        () =>
          advanceDanceReferenceWorkflow(
            event.payload,
            event.instanceId,
            composition.workflow,
            resume,
          ),
      );
      if (result.outcome !== "waiting") return result;
      resume = result.resume;
      await step.sleep(`dance-reference-processing-poll-${sequence}`, "10 seconds");
      sequence += 1;
    }
  };
}
