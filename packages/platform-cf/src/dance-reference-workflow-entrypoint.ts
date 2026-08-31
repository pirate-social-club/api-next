import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { DanceReferenceWorkflowPayload } from "@pirate/application/dance/reference-processing-wakeup";

export type CloudflareDanceReferenceWorkflowRunner<Env, Result, Step> = (
  env: Env,
  event: Readonly<{
    readonly payload: Readonly<DanceReferenceWorkflowPayload>;
    readonly instanceId: string;
  }>,
  step: Step,
) => Promise<Result>;

export function makeCloudflareDanceReferenceWorkflowEntrypoint<Env, Result, Step>(
  runner: CloudflareDanceReferenceWorkflowRunner<Env, Result, Step>,
) {
  return class CloudflareDanceReferenceWorkflowEntrypoint extends WorkflowEntrypoint<
    Env,
    DanceReferenceWorkflowPayload
  > {
    override run(
      event: Readonly<WorkflowEvent<DanceReferenceWorkflowPayload>>,
      step: WorkflowStep,
    ): Promise<Result> {
      return runner(this.env, event, step as unknown as Step);
    }
  };
}
