import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { DataRegistrationWorkflowPayload } from "@pirate/application/data/registration-workflow";

export type CloudflareDataRegistrationWorkflowRunner<Env, Result, Step> = (
  env: Env,
  event: Readonly<{
    payload: Readonly<DataRegistrationWorkflowPayload>;
    instanceId: string;
  }>,
  step: Step,
) => Promise<Result>;

export function makeCloudflareDataRegistrationWorkflowEntrypoint<Env, Result, Step>(
  runner: CloudflareDataRegistrationWorkflowRunner<Env, Result, Step>,
) {
  return class CloudflareDataRegistrationWorkflowEntrypoint extends WorkflowEntrypoint<
    Env,
    DataRegistrationWorkflowPayload
  > {
    override run(
      event: Readonly<WorkflowEvent<DataRegistrationWorkflowPayload>>,
      step: WorkflowStep,
    ): Promise<Result> {
      return runner(this.env, event, step as unknown as Step);
    }
  };
}
