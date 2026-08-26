import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export type CloudflareMediaWorkflowRunner<Env, Payload, Result, Step> = (
  env: Env,
  event: Readonly<{
    readonly payload: Readonly<Payload>;
    readonly instanceId: string;
  }>,
  step: Step,
) => Promise<Result>;

/** Keep the Cloudflare superclass and serializability seam in platform-cf. */
export function makeCloudflareMediaWorkflowEntrypoint<Env, Payload, Result, Step>(
  runner: CloudflareMediaWorkflowRunner<Env, Payload, Result, Step>,
) {
  return class CloudflareMediaWorkflowEntrypoint extends WorkflowEntrypoint<Env, Payload> {
    override run(event: Readonly<WorkflowEvent<Payload>>, step: WorkflowStep): Promise<Result> {
      return runner(this.env, event, step as unknown as Step);
    }
  };
}
