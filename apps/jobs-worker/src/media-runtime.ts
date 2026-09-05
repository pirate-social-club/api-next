import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { recoverVideoWorkflowLaunches } from "@pirate/application/video/workflow-recovery";
import {
  type CloudflareMediaWorkflowBinding,
  makeCloudflareMediaProcessingWorkflowLauncher,
} from "@pirate/platform-cf/media-processing-cloudflare";
import { makeMediaProcessingStore } from "@pirate/platform-cf/media-processing-store";
import { makeControlPlaneVideoAnalysisOutboxRepository } from "@pirate/platform-cf/video-analysis-outbox-repository";
import {
  makeConfiguredVideoAnalysisWorkflowLauncher,
  type VideoAnalysisWorkflowBinding,
  type VideoWorkflowStatusFetch,
} from "@pirate/platform-cf/video-analysis-workflow-cloudflare";
import { makeControlPlaneVideoPublicationStore } from "@pirate/platform-cf/video-publication-repository";
import type { Layer } from "effect";
import {
  dispatchEligibleMediaOutbox,
  type MediaOutboxDispatchQueue,
  type MediaOutboxDispatchResult,
  makeMediaOutboxDispatchSource,
} from "./media-outbox-dispatch.ts";
import {
  type MediaWorkflowSweepResult,
  sweepMissingMediaWorkflows,
} from "./media-workflow-sweep.ts";
import {
  dispatchEligibleVideoAnalysisOutbox,
  makeVideoAnalysisOutboxDispatchSource,
} from "./video-analysis-outbox-dispatch.ts";

export type MediaJobsBindings = Readonly<{
  readonly MEDIA_PROCESSING_ENABLED?: string;
  readonly VIDEO_ANALYSIS_ENABLED?: string;
  readonly VIDEO_ANALYSIS_WORKFLOW?: VideoAnalysisWorkflowBinding;
  readonly VIDEO_WORKFLOW_ACCOUNT_ID?: string;
  readonly VIDEO_WORKFLOW_NAME?: string;
  readonly VIDEO_WORKFLOW_SCRIPT_NAME?: string;
  readonly VIDEO_WORKFLOW_READ_TOKEN?: string;
  readonly MEDIA_PROCESSING_QUEUE?: MediaOutboxDispatchQueue;
  readonly MEDIA_PROCESSING_WORKFLOW?: CloudflareMediaWorkflowBinding;
}>;

export type MediaMaintenanceResult = Readonly<{
  readonly dispatch: MediaOutboxDispatchResult;
  readonly sweep: MediaWorkflowSweepResult;
}>;

export type MediaMaintenanceDependencies = Readonly<{
  readonly dispatch: () => Promise<MediaOutboxDispatchResult>;
  readonly sweep: () => Promise<MediaWorkflowSweepResult>;
}>;

/** Outbox launch and lost-instance recovery share one bounded scheduled tick. */
export async function runMediaMaintenance(
  dependencies: MediaMaintenanceDependencies,
): Promise<MediaMaintenanceResult> {
  const dispatch = await dependencies.dispatch();
  const sweep = await dependencies.sweep();
  return Object.freeze({ dispatch, sweep });
}

const workflowIsNeverMissingByThrownError = (): boolean => false;

export function makeMediaMaintenance(
  env: MediaJobsBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  workflowFetch: VideoWorkflowStatusFetch = fetch,
): (() => Promise<MediaMaintenanceResult>) | null {
  if (env.MEDIA_PROCESSING_ENABLED !== "true") return null;
  if (env.MEDIA_PROCESSING_QUEUE === undefined || env.MEDIA_PROCESSING_WORKFLOW === undefined) {
    throw new Error("media Queue and Workflow bindings are required when processing is enabled");
  }
  const queue = env.MEDIA_PROCESSING_QUEUE;
  if (env.VIDEO_ANALYSIS_ENABLED === "true" && env.VIDEO_ANALYSIS_WORKFLOW === undefined) {
    throw new Error("video Workflow binding is required when video analysis is enabled");
  }
  const videoRecovery =
    env.VIDEO_ANALYSIS_ENABLED === "true" && env.VIDEO_ANALYSIS_WORKFLOW !== undefined
      ? {
          outbox: makeControlPlaneVideoAnalysisOutboxRepository(runtime),
          store: makeControlPlaneVideoPublicationStore(runtime),
          launcher: makeConfiguredVideoAnalysisWorkflowLauncher(
            env.VIDEO_ANALYSIS_WORKFLOW,
            {
              accountId: env.VIDEO_WORKFLOW_ACCOUNT_ID,
              workflowName: env.VIDEO_WORKFLOW_NAME,
              scriptName: env.VIDEO_WORKFLOW_SCRIPT_NAME,
              readToken: env.VIDEO_WORKFLOW_READ_TOKEN,
            },
            workflowFetch,
          ),
        }
      : null;
  const source = makeMediaOutboxDispatchSource(runtime);
  const videoSource =
    env.VIDEO_ANALYSIS_ENABLED === "true" ? makeVideoAnalysisOutboxDispatchSource(runtime) : null;
  const store = makeMediaProcessingStore(runtime);
  const workflow = makeCloudflareMediaProcessingWorkflowLauncher(
    env.MEDIA_PROCESSING_WORKFLOW,
    workflowIsNeverMissingByThrownError,
  );
  return () =>
    runMediaMaintenance({
      dispatch: async () => {
        if (videoRecovery !== null) await recoverVideoWorkflowLaunches(videoRecovery);
        const [song, video] = await Promise.all([
          dispatchEligibleMediaOutbox(source, queue),
          videoSource === null
            ? Promise.resolve({ selected: 0, sent: 0, failed: 0 })
            : dispatchEligibleVideoAnalysisOutbox(videoSource, queue),
        ]);
        return Object.freeze({
          selected: song.selected + video.selected,
          sent: song.sent + video.sent,
          failed: song.failed + video.failed,
        });
      },
      sweep: () => sweepMissingMediaWorkflows({ store, workflow }),
    });
}
