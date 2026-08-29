// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workers exists only in the Workers runtime
// @ts-ignore cloudflare:workers exists only in the Workers runtime
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export interface CloudflareStudyGenerationWorkflowBinding<Payload> {
  readonly createBatch: (
    options: readonly { readonly id: string; readonly params: Payload }[],
  ) => Promise<readonly unknown[]>;
}

export const makeCloudflareStudyGenerationWorkflowLauncher = <Payload>(
  binding: CloudflareStudyGenerationWorkflowBinding<Payload>,
) => ({
  create: async (instanceId: string, payload: Payload): Promise<"created" | "already_exists"> => {
    const created = await binding.createBatch([{ id: instanceId, params: payload }]);
    if (created.length === 1) return "created";
    if (created.length === 0) return "already_exists";
    throw new Error("Study Workflow createBatch returned an unexpected instance count");
  },
});

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
