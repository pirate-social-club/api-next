// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workers exists only in the Workers runtime
// @ts-ignore cloudflare:workers exists only in the Workers runtime
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workflows exists only in the Workers runtime
// @ts-ignore cloudflare:workflows exists only in the Workers runtime
import { NonRetryableError } from "cloudflare:workflows";

type CloudflareWorkflowRunner<Env, Payload, Result, Step> = (
  env: Env,
  event: Readonly<{
    readonly payload: Readonly<Payload>;
    readonly instanceId: string;
  }>,
  step: Step,
) => Promise<Result>;

/** Keep the Cloudflare superclass and serializability seam in platform-cf. */
export function makeCloudflareWorkflowEntrypoint<Env, Payload, Result, Step>(
  runner: CloudflareWorkflowRunner<Env, Payload, Result, Step>,
) {
  return class CloudflareWorkflowEntrypoint extends WorkflowEntrypoint<Env, Payload> {
    run(event: Readonly<WorkflowEvent<Payload>>, step: WorkflowStep): Promise<Result> {
      const env = (this as unknown as { readonly env: Env }).env;
      return runner(env, event, step as unknown as Step);
    }
  };
}

export function makeWorkflowNonRetryableError(message: string): Error {
  return new NonRetryableError(message);
}
