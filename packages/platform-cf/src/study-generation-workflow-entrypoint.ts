// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workers exists only in the Workers runtime
// @ts-ignore cloudflare:workers exists only in the Workers runtime
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export type CloudflareStudyGenerationWorkflowRunner<Env, Payload, Result, Step> = (
  env: Env,
  event: Readonly<{ readonly payload: Readonly<Payload>; readonly instanceId: string }>,
  step: Step,
) => Promise<Result>;

export const makeCloudflareStudyGenerationWorkflowEntrypoint = <Env, Payload, Result, Step>(
  runner: CloudflareStudyGenerationWorkflowRunner<Env, Payload, Result, Step>,
) =>
  class CloudflareStudyGenerationWorkflowEntrypoint extends WorkflowEntrypoint<Env, Payload> {
    run(event: Readonly<WorkflowEvent<Payload>>, step: WorkflowStep): Promise<Result> {
      const env = (this as unknown as { readonly env: Env }).env;
      return runner(env, event, step as unknown as Step);
    }
  };
