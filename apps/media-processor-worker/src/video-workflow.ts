import {
  runVideoEnrichmentWorkflow,
  type VideoEnrichmentServices,
} from "../../../packages/application/src/video/enrichment-workflow.ts";
import {
  runVideoAnalysisWorkflow,
  type VideoWorkflowResult,
  type VideoWorkflowServices,
} from "../../../packages/application/src/video/workflow.ts";
import { VideoWorkflowTerminalError } from "../../../packages/application/src/video/workflow-errors.ts";
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
  resolve: (env: Env) => {
    readonly videoWorkflow?: VideoWorkflowServices;
    readonly videoEnrichmentWorkflow?: VideoEnrichmentServices;
  },
  nonRetryableError: (message: string) => Error,
) {
  return async (
    env: Env,
    event: { readonly payload: { readonly effectIdentity: string }; readonly instanceId: string },
    step: VideoAnalysisWorkflowStep,
  ): Promise<VideoWorkflowResult | { outcome: "enrichment_complete" }> => {
    const composition = resolve(env);
    if (
      typeof event.payload.effectIdentity === "string" &&
      event.payload.effectIdentity.startsWith("video-enrichment:")
    ) {
      if (
        Object.keys(event.payload).join(",") !== "effectIdentity" ||
        composition.videoEnrichmentWorkflow === undefined
      )
        throw new Error("video enrichment runtime is not composed or payload is invalid");
      return runVideoEnrichmentWorkflow(
        event.payload.effectIdentity,
        {
          do: (name, run) => step.do(name, PROCESSING_WORKFLOW_STEP_OPTIONS, run),
          sleep: (name, duration) => step.sleep(name, duration),
        },
        composition.videoEnrichmentWorkflow,
      );
    }
    const runtime = composition.videoWorkflow;
    if (runtime === undefined) throw new Error("video Workflow runtime is not composed");
    if (
      Object.keys(event.payload).join(",") !== "effectIdentity" ||
      typeof event.payload.effectIdentity !== "string"
    )
      throw new Error("invalid video Workflow payload");
    return runVideoAnalysisWorkflow(
      event.payload.effectIdentity,
      {
        do: (name, run) =>
          step.do(name, PROCESSING_WORKFLOW_STEP_OPTIONS, async () => {
            try {
              return await run();
            } catch (error) {
              if (error instanceof VideoWorkflowTerminalError)
                throw nonRetryableError(error.message);
              throw error;
            }
          }),
        sleep: (name, duration) => step.sleep(name, duration),
        waitForEvent: (name, options) => step.waitForEvent(name, options),
      },
      runtime,
    );
  };
}
