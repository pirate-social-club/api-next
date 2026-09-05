import { Effect } from "effect";
import {
  VIDEO_INGEST_POLICY_V1,
  VIDEO_POSTER_POLICY_V1,
  type VideoTrustedAnalysis,
} from "../../../domain/src/video-submission.ts";
import {
  MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
  type MediaTransformAttempt,
  type MediaTransformVideoJobInput,
} from "../media/transform.ts";
import {
  canonicalVideoCaptionSha256,
  type VideoAnalysisRuntimeServices,
  type VideoAnalysisSource,
  type VideoTransformCapability,
  videoTransformBinding,
} from "./analysis.ts";
import type { VideoAnalysisOutboxStore } from "./analysis-queue.ts";
import {
  acceptTrustedVideoAnalysis,
  type VideoAttemptReconciliationStore,
  type VideoSubmissionRecord,
} from "./publication.ts";
import {
  type VideoStage,
  type VideoStageFact,
  type VideoStageFactStore,
  validateVideoStageFact,
  verifyVideoStageArtifacts,
} from "./stage-facts.ts";
import { VideoWorkflowTerminalError } from "./workflow-errors.ts";

export const VIDEO_WORKFLOW_POLL_MS = 30_000;
export const VIDEO_WORKFLOW_CAPABILITY_MS = 30 * 60_000;
export const VIDEO_WORKFLOW_MAX_OBSERVATIONS =
  VIDEO_WORKFLOW_CAPABILITY_MS / VIDEO_WORKFLOW_POLL_MS;
export interface VideoWorkflowStep {
  do<T>(name: string, run: () => Promise<T>): Promise<T>;
  sleep(name: string, milliseconds: number): Promise<void>;
  waitForEvent(name: string, options: { type: string; timeout: "365 days" }): Promise<unknown>;
}
export type VideoWorkflowServices = VideoAnalysisRuntimeServices &
  Readonly<{
    outbox: Pick<VideoAnalysisOutboxStore, "get">;
    reconciliation: VideoAttemptReconciliationStore;
    stageFacts: VideoStageFactStore;
    verifySource: (submission: VideoSubmissionRecord) => Promise<void>;
    artifactHead: Parameters<typeof verifyVideoStageArtifacts>[1];
  }>;
export type VideoWorkflowResult = Readonly<{
  status: "published" | "stopped" | "superseded" | "reconciliation_required";
}>;
class Superseded extends VideoWorkflowTerminalError {
  constructor() {
    super("superseded");
  }
}

/** Payloads and durable step results contain identifiers, timestamps and bounded dispositions only. */
export async function runVideoAnalysisWorkflow(
  effectIdentity: string,
  step: VideoWorkflowStep,
  services: VideoWorkflowServices,
): Promise<VideoWorkflowResult> {
  const suffix = /:k([12])$/u.exec(effectIdentity);
  const continuation = suffix === null ? 0 : Number(suffix[1]);
  const baseIdentity = suffix === null ? effectIdentity : effectIdentity.slice(0, -3);
  const authority = async (): Promise<VideoSubmissionRecord> => {
    const intent = await services.outbox.get(baseIdentity);
    if (intent === null || intent.continuation !== continuation) throw new Superseded();
    const record = await services.store.getSubmissionByOperation(intent);
    if (
      record === null ||
      record.state.creationRevision !== intent.creationRevision ||
      record.state.videoRevision !== intent.videoRevision ||
      record.state.video?.canonicalSha256 !== intent.canonicalVideoSha256
    )
      throw new Superseded();
    return record;
  };
  const active = async () => {
    const record = await authority();
    if (
      record.state.status !== "processing" ||
      record.state.phase !== "analysis" ||
      record.state.reconciliationRequired
    )
      throw new Superseded();
    return record;
  };
  const source = (record: VideoSubmissionRecord): VideoAnalysisSource => {
    const video = record.state.video;
    if (video === null) throw new Superseded();
    return {
      operationId: record.state.operationId,
      videoRevision: record.state.videoRevision,
      immutableRef: video.immutableRef,
      canonicalSha256: video.canonicalSha256,
      byteLength: video.sizeBytes,
      mediaType: video.contentType,
    };
  };
  const facts = (record: VideoSubmissionRecord) => services.stageFacts.read(record.state);
  const fact = async <S extends VideoStage>(record: VideoSubmissionRecord, stage: S) => {
    const found = (await facts(record)).find((value) => value.stage === stage);
    if (found === undefined) return null;
    await verifyVideoStageArtifacts(found, services.artifactHead);
    return found as Extract<VideoStageFact, { stage: S }>;
  };
  const requiredFact = async <S extends VideoStage>(record: VideoSubmissionRecord, stage: S) => {
    const result = await fact(record, stage);
    if (result === null) throw new VideoWorkflowTerminalError("invalid_stage");
    return result;
  };
  const binding = (record: VideoSubmissionRecord, capability: VideoTransformCapability) =>
    videoTransformBinding(
      source(record),
      record.state.analysisRevision + 1,
      record.state.creationRevision,
      capability,
    );
  const attemptInput = async (
    record: VideoSubmissionRecord,
    capability: VideoTransformCapability,
    timestamp: number,
  ) => ({
    submissionId: record.state.submissionId,
    binding: await binding(record, capability),
    capability,
    initialAttempt: {
      version: "media-transform-attempt-v1",
      runtimeFence: {
        submittedAtMs: timestamp,
        runtimeDeadlineMs: timestamp + VIDEO_WORKFLOW_CAPABILITY_MS,
      },
    } as const,
  });
  const request = async (
    record: VideoSubmissionRecord,
    capability: VideoTransformCapability,
    attempt: MediaTransformAttempt,
  ): Promise<MediaTransformVideoJobInput> => {
    const video = source(record);
    const common = {
      binding: await binding(record, capability),
      source: {
        objectKey: video.immutableRef,
        sha256: video.canonicalSha256,
        byteLength: video.byteLength,
        mediaType: video.mediaType,
      },
      attempt,
    };
    if (capability === "probe")
      return { ...common, version: "media-transform-video-probe-input-v1" };
    if (capability === "audio")
      return {
        ...common,
        version: "media-transform-video-audio-input-v1",
        extractionPolicyVersion: MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
      };
    const probe = (await requiredFact(record, "probe")).snapshot;
    return {
      ...common,
      version: "media-transform-video-frames-input-v1",
      sourceDurationMs: probe.durationMs,
      sourceDimensions: { width: probe.width, height: probe.height },
      posterPolicy: VIDEO_POSTER_POLICY_V1,
      posterTimestampMs:
        record.state.posterTimestampMs ?? VIDEO_POSTER_POLICY_V1.defaultPosterTimestampMs,
    };
  };
  const failure = async (
    record: VideoSubmissionRecord,
    capability: VideoTransformCapability,
    evidenceRef: string,
    reason?: "poster_undecodable" | "poster_timestamp_out_of_range",
  ) => {
    await services.store.recordProcessingFailure({
      submission: record.state,
      observedEventSequence: record.eventSequence,
      failureCode: reason ?? (capability === "probe" ? "probe_failed" : "transform_failed"),
      evidenceRef,
    });
  };
  const enter = async (
    record: VideoSubmissionRecord,
    capability: VideoTransformCapability,
    state: "pending" | "required",
  ) => {
    await services.reconciliation.enterAttemptReconciliation({
      submission: record.state,
      observedEventSequence: record.eventSequence,
      requestId: (await binding(record, capability)).requestId,
      state,
      observation: { status: "unavailable", observedAt: services.nowIso() },
    });
  };
  try {
    const mode = await step.do("resolve-authority", async () => {
      const record = await authority();
      if (record.state.status === "published") return "published";
      if (record.state.analysis?.videoRevision === record.state.videoRevision) return "retained";
      await active();
      return "analyse";
    });
    if (mode === "published") return { status: "published" };
    if (mode === "analyse") {
      await step.do("verify-source", async () => {
        await services.verifySource(await active());
        return baseIdentity;
      });
      for (const capability of ["probe", "audio", "frames"] as const) {
        const accepted = await step.do(
          `${capability}-load-fact`,
          async () => (await fact(await active(), capability)) !== null,
        );
        if (accepted) continue;
        const timestamp = await step.do(`${capability}-timestamp`, async () => {
          await active();
          return Date.parse(services.nowIso());
        });
        await step.do(`${capability}-allocate`, async () => {
          const record = await active();
          if (await fact(record, capability)) return capability;
          const input = await attemptInput(record, capability, timestamp);
          const attempt = await services.transformAttempts.loadOrCreate(input);
          if (attempt.providerJobId === undefined) {
            const outcome = await Effect.runPromise(
              services.transform.allocate(await request(record, capability, attempt)),
            );
            if (outcome.status !== "submitted")
              throw new Error("video task allocation unavailable");
            await services.transformAttempts.advance({ ...input, attempt: outcome.attempt });
          }
          return input.binding.requestId;
        });
        const submitted = await step.do(`${capability}-submit`, async () => {
          const record = await active();
          if (await fact(record, capability)) return "accepted";
          const input = await attemptInput(record, capability, timestamp);
          let attempt = await services.transformAttempts.loadOrCreate(input);
          if (attempt.providerJobPhase !== "allocated") return "observe";
          attempt = await services.transformAttempts.advance({
            ...input,
            attempt: { ...attempt, providerJobPhase: "submitting" },
          });
          const outcome = await Effect.runPromise(
            services.transform.submit(await request(record, capability, attempt)),
          );
          if (outcome.status === "processing")
            await services.transformAttempts.advance({ ...input, attempt: outcome.attempt });
          else if (outcome.status === "rejected" && outcome.reason === "provider_rejected") {
            await failure(record, capability, `video-provider:${input.binding.requestId}:rejected`);
            return "failed";
          }
          return "observe";
        });
        if (submitted === "failed") return { status: "stopped" };
        let completed = submitted === "accepted";
        for (const window of ["runtime", "reconciliation"] as const) {
          if (completed) break;
          if (window === "reconciliation")
            await step.do(`${capability}-reconciliation-pending`, async () => {
              const record = await active();
              if (!(await fact(record, capability))) await enter(record, capability, "pending");
              return capability;
            });
          for (let index = 0; index < VIDEO_WORKFLOW_MAX_OBSERVATIONS; index += 1) {
            const name = `${capability}-${window}-${index}`;
            const result = await step.do(`${name}-observe`, async () => {
              const record = await active();
              if (await fact(record, capability)) return "accepted";
              const input = await attemptInput(record, capability, timestamp);
              const attempt = await services.transformAttempts.loadOrCreate(input);
              const deadline =
                attempt.runtimeFence.runtimeDeadlineMs +
                (window === "runtime" ? 0 : VIDEO_WORKFLOW_CAPABILITY_MS);
              const outcome = await Effect.runPromise(
                services.transform.observe(await request(record, capability, attempt)),
              );
              if (outcome.attempt.providerJobPhase === "started")
                await services.transformAttempts.advance({ ...input, attempt: outcome.attempt });
              if (
                outcome.status === "rejected" &&
                (outcome.reason === "poster_undecodable" ||
                  outcome.reason === "poster_timestamp_out_of_range")
              ) {
                const evidenceRef = `video-provider:${input.binding.requestId}:${outcome.reason}`;
                if (window === "reconciliation")
                  await services.reconciliation.resolveAttemptReconciliation({
                    submission: record.state,
                    observedEventSequence: record.eventSequence,
                    requestId: input.binding.requestId,
                    observation: { status: "failed", evidenceRef, observedAt: services.nowIso() },
                  });
                else await failure(record, capability, evidenceRef, outcome.reason);
                return "failed";
              }
              if (outcome.status === "rejected" && outcome.reason === "provider_rejected") {
                if (window === "reconciliation")
                  await services.reconciliation.resolveAttemptReconciliation({
                    submission: record.state,
                    observedEventSequence: record.eventSequence,
                    requestId: input.binding.requestId,
                    observation: {
                      status: "failed",
                      evidenceRef: `video-provider:${input.binding.requestId}:failed`,
                      observedAt: services.nowIso(),
                    },
                  });
                else
                  await failure(
                    record,
                    capability,
                    `video-provider:${input.binding.requestId}:failed`,
                  );
                return "failed";
              }
              if (outcome.status !== "completed")
                return Date.parse(services.nowIso()) >= deadline ? "deadline" : "pending";
              const snapshot =
                "probe" in outcome
                  ? {
                      ...outcome.probe,
                      ingestPolicyRevision: VIDEO_INGEST_POLICY_V1.policyRevision,
                    }
                  : "artifact" in outcome
                    ? outcome.artifact
                    : outcome.extraction;
              const refs =
                "artifact" in outcome
                  ? [outcome.artifact.artifactRef]
                  : "extraction" in outcome
                    ? outcome.extraction.frames.map((frame) => frame.artifactRef)
                    : [];
              const artifacts = await Promise.all(
                refs.map(async (artifactRef) => {
                  const receipt = await services.artifactHead(artifactRef);
                  if (receipt === null) throw new Error("sealed video artifact missing");
                  return { artifactRef, ...receipt };
                }),
              );
              const acceptedFact = validateVideoStageFact({
                stage: capability,
                adapterRevision: outcome.context.adapterRevision,
                snapshot,
                artifacts,
              });
              if (acceptedFact.stage === "recognition" || acceptedFact.stage === "safety")
                throw new VideoWorkflowTerminalError("invalid_stage");
              if (window === "reconciliation")
                await services.reconciliation.resolveAttemptReconciliation({
                  submission: record.state,
                  observedEventSequence: record.eventSequence,
                  requestId: input.binding.requestId,
                  observation: {
                    status: "completed",
                    fact: acceptedFact,
                    observedAt: services.nowIso(),
                  },
                });
              else
                await services.stageFacts.write({
                  submission: record.state,
                  observedEventSequence: record.eventSequence,
                  fact: acceptedFact,
                });
              return "accepted";
            });
            if (result === "failed") return { status: "stopped" };
            if (result === "accepted") {
              completed = true;
              break;
            }
            if (result === "deadline") break;
            await step.sleep(`${name}-sleep`, VIDEO_WORKFLOW_POLL_MS);
          }
        }
        if (!completed) {
          await step.do(`${capability}-reconciliation-required`, async () => {
            await enter(await active(), capability, "required");
            return capability;
          });
          return { status: "reconciliation_required" };
        }
      }
      await step.do("recognition", async () => {
        const record = await active();
        if (await fact(record, "recognition")) return "recognition";
        const audio = (await requiredFact(record, "audio")).snapshot;
        const snapshot = await services.analysisProviders.identifySoundtrack({
          operationId: record.state.operationId,
          extractedAudioRef: audio.artifactRef,
          extractedAudioSha256: audio.canonicalSha256,
        });
        await services.stageFacts.write({
          submission: record.state,
          observedEventSequence: record.eventSequence,
          fact: validateVideoStageFact({
            stage: "recognition",
            adapterRevision: snapshot.adapterRevision,
            snapshot,
            artifacts: [],
          }),
        });
        return "recognition";
      });
      await step.do("safety", async () => {
        const record = await active();
        if (await fact(record, "safety")) return "safety";
        const frames = (await requiredFact(record, "frames")).snapshot.frames;
        const snapshot = await services.analysisProviders.moderate({
          operationId: record.state.operationId,
          caption: record.state.caption,
          captionSha256: await canonicalVideoCaptionSha256(record.state.caption),
          frames,
        });
        await services.stageFacts.write({
          submission: record.state,
          observedEventSequence: record.eventSequence,
          fact: validateVideoStageFact({
            stage: "safety",
            adapterRevision: snapshot.adapterRevision,
            snapshot,
            artifacts: [],
          }),
        });
        return "safety";
      });
    }
    const decideAndPublish = async () => {
      const record = await authority();
      if (record.state.status === "published") return "published";
      if (record.state.status === "manual_review") return "review";
      if (record.state.status !== "processing" || record.state.reconciliationRequired)
        return "stopped";
      let analysis = record.state.analysis;
      if (analysis === null || analysis.videoRevision !== record.state.videoRevision) {
        const probe = await requiredFact(record, "probe");
        const audio = (await requiredFact(record, "audio")).snapshot;
        const frames = (await requiredFact(record, "frames")).snapshot;
        const recognition = (await requiredFact(record, "recognition")).snapshot;
        const safety = (await requiredFact(record, "safety")).snapshot;
        const video = source(record);
        analysis = {
          version: "video-trusted-analysis-v1",
          operationId: video.operationId,
          videoRevision: video.videoRevision,
          analysisRevision: record.state.analysisRevision + 1,
          finalizedVideoRef: video.immutableRef,
          canonicalVideoSha256: video.canonicalSha256,
          byteLength: video.byteLength,
          mediaType: video.mediaType,
          probe: probe.snapshot,
          audio: {
            intent: "original_audio",
            soundtrack:
              recognition.verification === null
                ? {
                    extractedAudioRef: audio.artifactRef,
                    extractedAudioSha256: audio.canonicalSha256,
                    verification: null,
                    exhaustion: recognition.exhaustion,
                    evidenceRef: recognition.evidenceRef,
                    policyRevision: audio.policyRevision,
                  }
                : {
                    extractedAudioRef: audio.artifactRef,
                    extractedAudioSha256: audio.canonicalSha256,
                    verification: recognition.verification,
                    policyRevision: audio.policyRevision,
                  },
          },
          frames: {
            posterPolicyRevision: frames.posterPolicyRevision,
            evidenceRef: frames.evidenceRef,
            adapterRevision: frames.adapterRevision,
            extracted: frames.frames,
          },
          safetyRequest: {
            requestId: safety.requestId,
            frameSha256s: frames.frames.map((frame) => frame.sha256),
            captionSha256: await canonicalVideoCaptionSha256(record.state.caption),
            evidenceRef: safety.evidenceRef,
            minorSafetyEvidenceRef: safety.minorSafetyEvidenceRef,
          },
          mediaSafety: safety.mediaSafety,
          captionSafety: safety.captionSafety,
          automatedRating: safety.automatedRating,
          safetyPolicyRevision: safety.policyRevision,
          adapterRevisions: {
            probe: probe.adapterRevision,
            acr: recognition.adapterRevision,
            frames: frames.adapterRevision,
            safety: safety.adapterRevision,
          },
        } satisfies VideoTrustedAnalysis;
      }
      await acceptTrustedVideoAnalysis(
        { submissionId: record.state.submissionId, analysis },
        services,
      );
      const after = await authority();
      return after.state.status === "published"
        ? "published"
        : after.state.status === "manual_review"
          ? "review"
          : "stopped";
    };
    const outcome = await step.do("decide-and-publish", decideAndPublish);
    if (outcome !== "review") return { status: outcome };
    await step.waitForEvent("publication-wakeup", {
      type: "video-publication",
      timeout: "365 days",
    });
    const published = await step.do("decide-and-publish-after-review", decideAndPublish);
    return { status: published === "published" ? "published" : "stopped" };
  } catch (error) {
    if (error instanceof Superseded) return { status: "superseded" };
    throw error;
  }
}
