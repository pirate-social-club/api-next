import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import {
  MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
  type MediaTransformVideoJobInput,
  type MediaTransformVideoJobs,
} from "@pirate/application/media/transform";
import {
  validateVideoStageFact,
  verifyVideoStageArtifacts,
} from "@pirate/application/video/stage-facts";
import { VIDEO_INGEST_POLICY_V1, VIDEO_POSTER_POLICY_V1 } from "@pirate/domain";
import { Effect, type Layer } from "effect";
import { mediaProcessingPhysicalObjectKey } from "./media-immutable-object-key.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";
import { makeControlPlaneVideoStageFactStore } from "./video-stage-fact-repository.ts";

type AttemptRow = Readonly<{
  request_id: string;
  submission_id: string;
  operation_id: string;
  video_revision: string;
  creation_revision: string;
  analysis_revision: string;
  canonical_video_sha256: string;
  capability: "probe" | "audio" | "frames";
  submitted_at_ms: string;
  runtime_deadline_ms: string;
  provider_job_id: string;
  provider_job_phase: "submitting" | "started";
  last_observation: { status: string; observedAt: string } | null;
}>;

/** This service has no allocate, submit, grant issuer, or publication port. */
export function makeVideoReconciliationOperator(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  dependencies: Readonly<{
    observer: Pick<MediaTransformVideoJobs, "observe">;
    artifactHead: Parameters<typeof verifyVideoStageArtifacts>[1];
    nowIso?: () => string;
  }>,
) {
  const store = makeControlPlaneVideoPublicationStore(runtime);
  const facts = makeControlPlaneVideoStageFactStore(runtime);
  const list = async (submissionId: string): Promise<readonly AttemptRow[]> =>
    Effect.runPromise(
      Effect.provide(runtime)(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<AttemptRow>({
            label: "video-reconciliation-operator.list",
            readonly: true,
            text: `SELECT a.request_id,a.submission_id,a.operation_id,a.video_revision,
          a.creation_revision,a.analysis_revision,a.canonical_video_sha256,a.capability,
          a.submitted_at_ms,a.runtime_deadline_ms,a.provider_job_id,a.provider_job_phase,
          a.last_observation FROM media_video_transform_attempts a
          JOIN media_post_submissions s ON s.submission_id=a.submission_id
          WHERE a.submission_id=$1 AND a.reconciliation_state='required'
            AND a.video_revision=(s.video_state_snapshot->>'videoRevision')::bigint
            AND a.creation_revision=(s.video_state_snapshot->>'creationRevision')::bigint
          ORDER BY a.capability,a.request_id`,
            values: [submissionId],
          });
          return result.rows;
        }),
      ),
    );
  return {
    list,
    resolve: async (submissionId: string, requestId: string, apply: boolean) => {
      const attempt = (await list(submissionId)).find((row) => row.request_id === requestId);
      if (attempt === undefined) throw new Error("attempt is not in required reconciliation");
      const record = await store.getSubmissionByOperation({
        submissionId,
        operationId: attempt.operation_id,
      });
      if (
        record === null ||
        record.state.video === null ||
        !record.state.reconciliationRequired ||
        record.state.videoRevision !== Number(attempt.video_revision) ||
        record.state.creationRevision !== Number(attempt.creation_revision) ||
        record.state.analysisRevision + 1 !== Number(attempt.analysis_revision) ||
        record.state.video.canonicalSha256 !== attempt.canonical_video_sha256
      )
        throw new Error("operator authority fence rejected");
      const video = record.state.video;
      const common = {
        binding: {
          requestId,
          operationId: attempt.operation_id,
          videoRevision: Number(attempt.video_revision),
          creationRevision: Number(attempt.creation_revision),
          analysisRevision: Number(attempt.analysis_revision),
          canonicalVideoSha256: attempt.canonical_video_sha256,
        },
        source: {
          objectKey: mediaProcessingPhysicalObjectKey(video.immutableRef),
          sha256: video.canonicalSha256,
          byteLength: video.sizeBytes,
          mediaType: video.contentType,
        },
        attempt: {
          version: "media-transform-attempt-v1" as const,
          providerJobId: attempt.provider_job_id,
          providerJobPhase: attempt.provider_job_phase,
          runtimeFence: {
            submittedAtMs: Number(attempt.submitted_at_ms),
            runtimeDeadlineMs: Number(attempt.runtime_deadline_ms),
          },
        },
      };
      let input: MediaTransformVideoJobInput;
      if (attempt.capability === "probe")
        input = { ...common, version: "media-transform-video-probe-input-v1" };
      else if (attempt.capability === "audio")
        input = {
          ...common,
          version: "media-transform-video-audio-input-v1",
          extractionPolicyVersion: MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
        };
      else {
        const probe = (await facts.read(record.state)).find((fact) => fact.stage === "probe");
        if (probe?.stage !== "probe") throw new Error("operator probe fact missing");
        input = {
          ...common,
          version: "media-transform-video-frames-input-v1",
          sourceDurationMs: probe.snapshot.durationMs,
          sourceDimensions: { width: probe.snapshot.width, height: probe.snapshot.height },
          posterPolicy: VIDEO_POSTER_POLICY_V1,
          posterTimestampMs:
            record.state.posterTimestampMs ?? VIDEO_POSTER_POLICY_V1.defaultPosterTimestampMs,
        };
      }
      // Dry run lists the candidate only: observe can seal outputs and therefore is a write path.
      if (!apply) return { requestId, outcome: "would_observe" };
      const observed = await Effect.runPromise(dependencies.observer.observe(input));
      const observedAt = (dependencies.nowIso ?? (() => new Date().toISOString()))();
      let observation: Parameters<typeof store.resolveAttemptReconciliation>[0]["observation"];
      if (observed.status === "completed") {
        const snapshot =
          "probe" in observed
            ? { ...observed.probe, ingestPolicyRevision: VIDEO_INGEST_POLICY_V1.policyRevision }
            : "artifact" in observed
              ? observed.artifact
              : observed.extraction;
        const refs =
          "artifact" in observed
            ? [observed.artifact.artifactRef]
            : "extraction" in observed
              ? observed.extraction.frames.map((frame) => frame.artifactRef)
              : [];
        const artifacts = await Promise.all(
          refs.map(async (artifactRef) => {
            const identity = await dependencies.artifactHead(artifactRef);
            if (identity === null) throw new Error("operator sealed artifact missing");
            return { artifactRef, ...identity };
          }),
        );
        const fact = validateVideoStageFact({
          stage: attempt.capability,
          snapshot,
          artifacts,
          adapterRevision: observed.context.adapterRevision,
        });
        if (fact.stage === "recognition" || fact.stage === "safety")
          throw new Error("operator stage rejected");
        await verifyVideoStageArtifacts(fact, dependencies.artifactHead);
        observation = { status: "completed", observedAt, fact };
      } else if (observed.status === "rejected" && observed.reason === "provider_rejected") {
        observation = {
          status: "failed",
          observedAt,
          evidenceRef: observed.evidenceRef ?? `video-provider:${requestId}:failed`,
        };
      } else if (observed.status === "not_found" || observed.status === "processing") {
        observation = {
          status: "workflow_terminal",
          observedAt,
          evidenceRef: `video-operator:${requestId}:${observed.status}`,
        };
      } else {
        // Transport, malformed and unavailable outcomes never mutate PostgreSQL.
        return { requestId, outcome: "unchanged_unavailable" };
      }
      const resolved = await store.resolveAttemptReconciliation({
        submission: record.state,
        observedEventSequence: record.eventSequence,
        requestId,
        observation,
      });
      return {
        requestId,
        outcome: observation.status,
        submissionStatus: resolved.state.status,
        reconciliationRequired: resolved.state.reconciliationRequired,
        eventSequence: resolved.eventSequence,
      };
    },
  };
}
