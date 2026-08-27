import type {
  DataRegistrationWorkflowDependencies,
  DataRegistrationWorkflowPayload,
  DataRegistrationWorkflowResult,
} from "../../../packages/application/src/data/registration-workflow.ts";
import { advanceDataRegistrationWorkflow } from "../../../packages/application/src/data/registration-workflow.ts";
import type { DataRegistrationQueueDependencies } from "../../../packages/application/src/data/registration-workflow-queue.ts";
import { handleDataRegistrationQueueBatch } from "../../../packages/platform-cf/src/data/registration-workflow-cloudflare.ts";
import { isDataRegistrationEnabled } from "./posture.ts";

export type DataRegistrationWorkerEnv = Readonly<{
  DATA_REGISTRATION_ENABLED?: string;
}>;

export type DataRegistrationWorkerComposition = Readonly<{
  queue: DataRegistrationQueueDependencies;
  workflow: DataRegistrationWorkflowDependencies;
}>;

export type ResolveDataRegistrationComposition<Env extends DataRegistrationWorkerEnv> = (
  env: Env,
) => DataRegistrationWorkerComposition;

const workflowStepOptions = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

export interface DataRegistrationWorkflowStep {
  readonly do: <T>(
    name: string,
    options: typeof workflowStepOptions,
    callback: () => Promise<T>,
  ) => Promise<T>;
  readonly sleep: (name: string, duration: "15 seconds") => Promise<void>;
}

const withPosture = <Env extends DataRegistrationWorkerEnv>(
  env: Env,
  composition: DataRegistrationWorkerComposition,
): DataRegistrationWorkerComposition => ({
  ...composition,
  workflow: {
    ...composition.workflow,
    options: {
      enabled:
        isDataRegistrationEnabled(env.DATA_REGISTRATION_ENABLED) &&
        composition.workflow.options.enabled,
    },
  },
});

export function makeDataRegistrationQueueWorker<Env extends DataRegistrationWorkerEnv>(
  resolve: ResolveDataRegistrationComposition<Env>,
) {
  return {
    queue: async (
      batch: Parameters<typeof handleDataRegistrationQueueBatch>[0],
      env: Env,
    ): Promise<void> => {
      if (!isDataRegistrationEnabled(env.DATA_REGISTRATION_ENABLED)) {
        for (const message of batch.messages) message.retry({ delaySeconds: 900 });
        return;
      }
      await handleDataRegistrationQueueBatch(batch, withPosture(env, resolve(env)).queue);
    },
  };
}

export function makeDataRegistrationWorkflowRunner<Env extends DataRegistrationWorkerEnv>(
  resolve: ResolveDataRegistrationComposition<Env>,
) {
  return async (
    env: Env,
    event: Readonly<{ payload: DataRegistrationWorkflowPayload; instanceId: string }>,
    step: DataRegistrationWorkflowStep,
  ): Promise<DataRegistrationWorkflowResult> => {
    const composition = withPosture(env, resolve(env));
    let sequence = 0;
    while (true) {
      const result = await step.do(`data-registration-${sequence}`, workflowStepOptions, async () =>
        advanceDataRegistrationWorkflow(event.payload, composition.workflow),
      );
      if (
        result.outcome === "registered" ||
        result.outcome === "failed" ||
        result.outcome === "inert"
      ) {
        return result;
      }
      if (result.outcome === "waiting") {
        await step.sleep(`data-registration-poll-${sequence}`, "15 seconds");
      }
      sequence += 1;
    }
  };
}
