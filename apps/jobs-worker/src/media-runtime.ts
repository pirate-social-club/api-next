import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { dispatchVideoPublicationWakeups } from "@pirate/application/video/publication-wakeup";
import { recoverVideoWorkflowLaunches } from "@pirate/application/video/workflow-recovery";
import { isWorkflowInstanceMissingError } from "@pirate/platform-cf/cloudflare-orchestration-primitives";
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
import { makeVideoPublicationWakeupStore } from "@pirate/platform-cf/video-publication-wakeup-repository";
import type { Layer } from "effect";
import { dispatchVideoEnrichment } from "../../../packages/application/src/video/enrichment-dispatch.ts";
import { makeVideoEnrichmentDispatchSource } from "../../../packages/platform-cf/src/video-enrichment-dispatch-source.ts";
import {
  makeVideoReservationCleanup,
  type VideoIngressAbortBucket,
} from "../../../packages/platform-cf/src/video-reservation-cleanup.ts";
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
import { dispatchSongSourceRecordings } from "./song-source-recording-dispatch.ts";
import {
  dispatchEligibleVideoAnalysisOutbox,
  makeVideoAnalysisOutboxDispatchSource,
} from "./video-analysis-outbox-dispatch.ts";

export type MediaJobsBindings = Readonly<{
  readonly MEDIA_INGRESS?: VideoIngressAbortBucket;
  readonly MEDIA_PROCESSING_ENABLED?: string;
  readonly VIDEO_ANALYSIS_ENABLED?: string;
  readonly VIDEO_DELIVERY_ENABLED?: string;
  readonly SONG_SOURCE_RECORDING_ENABLED?: string;
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

type DispatchPart = Readonly<{ selected: number; sent: number; failed: number }>;

export async function isolateMediaMaintenanceAction(
  stage: string,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(`media maintenance ${stage} unavailable`, error);
  }
}

export async function isolateMediaMaintenanceDispatch(
  stage: string,
  dispatch: () => Promise<DispatchPart>,
): Promise<DispatchPart> {
  try {
    return await dispatch();
  } catch (error) {
    console.error(`media maintenance ${stage} unavailable`, error);
    return { selected: 0, sent: 0, failed: 1 };
  }
}

/** Outbox launch and lost-instance recovery share one bounded scheduled tick. */
export async function runMediaMaintenance(
  dependencies: MediaMaintenanceDependencies,
): Promise<MediaMaintenanceResult> {
  const dispatch = await dependencies.dispatch();
  const sweep = await dependencies.sweep();
  return Object.freeze({ dispatch, sweep });
}

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
  const videoEnabled =
    env.VIDEO_ANALYSIS_ENABLED === "true" || env.VIDEO_DELIVERY_ENABLED === "true";
  if (videoEnabled && env.VIDEO_ANALYSIS_WORKFLOW === undefined) {
    console.error("media maintenance video Workflow binding unavailable");
  }
  let videoRecovery: Readonly<{
    outbox: ReturnType<typeof makeControlPlaneVideoAnalysisOutboxRepository>;
    store: ReturnType<typeof makeControlPlaneVideoPublicationStore>;
    launcher: ReturnType<typeof makeConfiguredVideoAnalysisWorkflowLauncher>;
  }> | null = null;
  if (env.VIDEO_ANALYSIS_ENABLED === "true" && env.VIDEO_ANALYSIS_WORKFLOW !== undefined) {
    try {
      videoRecovery = {
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
      };
    } catch (error) {
      console.error("media maintenance video Workflow configuration unavailable", error);
    }
  }
  if (env.VIDEO_ANALYSIS_ENABLED === "true" && env.MEDIA_INGRESS === undefined) {
    console.error("media maintenance video ingress binding unavailable");
  }
  const cleanup =
    env.MEDIA_INGRESS === undefined
      ? null
      : makeVideoReservationCleanup(runtime, env.MEDIA_INGRESS);
  const source = makeMediaOutboxDispatchSource(runtime);
  const enrichmentSource =
    env.VIDEO_DELIVERY_ENABLED === "true" && env.VIDEO_ANALYSIS_WORKFLOW !== undefined
      ? makeVideoEnrichmentDispatchSource(runtime)
      : null;
  const videoSource =
    videoRecovery === null ? null : makeVideoAnalysisOutboxDispatchSource(runtime);
  const store = makeMediaProcessingStore(runtime);
  const workflow = makeCloudflareMediaProcessingWorkflowLauncher(
    env.MEDIA_PROCESSING_WORKFLOW,
    isWorkflowInstanceMissingError,
  );
  return () =>
    runMediaMaintenance({
      dispatch: async () => {
        if (cleanup !== null) {
          await isolateMediaMaintenanceAction("video reservation cleanup", async () => {
            const result = await cleanup();
            if (result.selected > 0)
              console.log(JSON.stringify({ event: "video-reservation-cleanup", ...result }));
          });
        }
        if (videoRecovery !== null) {
          await isolateMediaMaintenanceAction("video Workflow recovery", () =>
            recoverVideoWorkflowLaunches(videoRecovery),
          );
          await isolateMediaMaintenanceAction("video publication wakeups", () =>
            dispatchVideoPublicationWakeups({
              ...videoRecovery,
              wakeups: makeVideoPublicationWakeupStore(runtime),
            }),
          );
        }
        const [song, video, enrichment, sourceRecording] = await Promise.all([
          dispatchEligibleMediaOutbox(source, queue),
          videoSource === null
            ? Promise.resolve({ selected: 0, sent: 0, failed: 0 })
            : isolateMediaMaintenanceDispatch("video analysis dispatch", () =>
                dispatchEligibleVideoAnalysisOutbox(videoSource, queue),
              ),
          enrichmentSource === null
            ? Promise.resolve({ selected: 0, sent: 0, failed: 0 })
            : isolateMediaMaintenanceDispatch("video enrichment dispatch", () =>
                dispatchVideoEnrichment(enrichmentSource, queue),
              ),
          env.SONG_SOURCE_RECORDING_ENABLED === "true"
            ? isolateMediaMaintenanceDispatch("song source-recording dispatch", () =>
                dispatchSongSourceRecordings(runtime, {
                  send: (message) =>
                    queue.send(message as unknown as { readonly outbox_id: string }),
                }),
              )
            : Promise.resolve({ selected: 0, sent: 0, failed: 0 }),
        ]);
        return Object.freeze({
          selected: song.selected + video.selected + enrichment.selected + sourceRecording.selected,
          sent: song.sent + video.sent + enrichment.sent + sourceRecording.sent,
          failed: song.failed + video.failed + enrichment.failed + sourceRecording.failed,
        });
      },
      sweep: () => sweepMissingMediaWorkflows({ store, workflow }),
    });
}
