import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { DanceAttemptWorkflowPayload } from "@pirate/application/dance/attempt-processing-wakeup";

export type CloudflareDanceAttemptWorkflowRunner<Env, Result> = (
  env: Env,
  event: Readonly<{
    readonly payload: Readonly<DanceAttemptWorkflowPayload>;
    readonly instanceId: string;
  }>,
  step: WorkflowStep,
) => Promise<Result>;

export function makeCloudflareDanceAttemptWorkflowEntrypoint<Env, Result>(
  runner: CloudflareDanceAttemptWorkflowRunner<Env, Result>,
) {
  return class CloudflareDanceAttemptWorkflowEntrypoint extends WorkflowEntrypoint<
    Env,
    DanceAttemptWorkflowPayload
  > {
    override run(
      event: Readonly<WorkflowEvent<DanceAttemptWorkflowPayload>>,
      step: WorkflowStep,
    ): Promise<Result> {
      return runner(this.env, event, step);
    }
  };
}
