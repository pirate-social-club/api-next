import {
  runVideoAnalysisWorkflow,
  type VideoWorkflowResult,
  type VideoWorkflowServices,
} from "../../../packages/application/src/video/workflow.ts";
import {
  type CloudflareWorkflowStepDo,
  PROCESSING_WORKFLOW_STEP_OPTIONS,
} from "../../../packages/platform-cf/src/cloudflare-orchestration-primitives.ts";

export interface VideoAnalysisWorkflowStep
  extends CloudflareWorkflowStepDo<typeof PROCESSING_WORKFLOW_STEP_OPTIONS> {
  readonly sleep: (name: string, duration: number) => Promise<void>;
  readonly waitForEvent: (
    name: string,
    options: { type: string; timeout: "365 days" },
  ) => Promise<unknown>;
}
export function makeVideoAnalysisWorkflowRunner<Env>(
  resolve: (env: Env) => { readonly videoWorkflow?: VideoWorkflowServices },
) {
  return async (
    env: Env,
    event: { readonly payload: { readonly effectIdentity: string }; readonly instanceId: string },
    step: VideoAnalysisWorkflowStep,
  ): Promise<VideoWorkflowResult> => {
    const runtime = resolve(env).videoWorkflow;
    if (runtime === undefined) throw new Error("video Workflow runtime is not composed");
    if (
      Object.keys(event.payload).join(",") !== "effectIdentity" ||
      typeof event.payload.effectIdentity !== "string"
    )
      throw new Error("invalid video Workflow payload");
    return runVideoAnalysisWorkflow(
      event.payload.effectIdentity,
      {
        do: (name, run) => step.do(name, PROCESSING_WORKFLOW_STEP_OPTIONS, run),
        sleep: (name, duration) => step.sleep(name, duration),
        waitForEvent: (name, options) => step.waitForEvent(name, options),
      },
      runtime,
    );
  };
}
