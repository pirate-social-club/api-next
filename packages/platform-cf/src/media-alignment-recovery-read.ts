import type { ControlPlaneStatement } from "@pirate/application";
import { Option, Schema } from "effect";
import {
  type AlignmentRecoveryFailedReason,
  sanitizeAlignmentRecoveryLookupFailure,
} from "../../application/src/media/alignment-recovery-diagnostics.ts";
import type { MediaProcessingStore } from "../../application/src/media/processing-contracts.ts";

type Row = Readonly<Record<string, unknown>>;
const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^\S(?:[\s\S]*\S)?$/u),
  Schema.makeFilter((value) => (value.includes("\u0000") ? "Identifier contains NUL" : undefined)),
);
const validIdentifier = (value: unknown): value is string =>
  Option.isSome(Schema.decodeUnknownOption(Identifier)(value));
const Revision = Schema.Union([Schema.Number, Schema.NumberFromString]).check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const ReadyArtifact = Schema.Struct({
  current_artifact_ref: Identifier,
  current_artifact_revision: Revision,
  artifact_sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  artifact: Schema.Record(Schema.String, Schema.Unknown),
});

/** Read recovery authority without converting uncertain storage into an alignment outcome. */
export function makeReadMediaAlignmentRecovery(
  execute: (statement: ControlPlaneStatement) => Promise<readonly Row[]>,
): MediaProcessingStore["readAlignmentRecovery"] {
  const alignmentFailureCodes = [
    "elevenlabs_key_missing",
    "key_invalid",
    "rate_limited",
    "provider_unavailable",
    "timeout",
    "invalid_response",
    "alignment_failed",
    "lyrics_missing",
    "audio_missing",
  ] as const;

  return async (authority) => {
    const postId = authority.postId;
    const audio = authority.audio;
    const publishedLyricsRevision = authority.publishedLyricsRevision;
    if (
      postId === null ||
      audio === null ||
      publishedLyricsRevision === null ||
      publishedLyricsRevision !== (authority.lyrics?.lyricsRevision ?? null)
    )
      return { kind: "stale", reason: "invalid_publication_binding" } as const;
    let query: AlignmentRecoveryFailedReason["query"] =
      "media-processing.alignment-recovery-authorization";
    try {
      const recovery = await execute({
        label: "media-processing.alignment-recovery-authorization",
        text: "SELECT state,recovery_action_id,attempt_id FROM media_alignment_recovery_actions WHERE community_id=$1 AND actor_user_id=$2 AND submission_id=$3 AND operation_id=$4 AND post_id=$5 AND audio_revision=$6 AND analysis_revision=$7 AND lyrics_revision=$8 AND canonical_audio_sha256=$9",
        values: [
          authority.communityId,
          authority.actorAccountId,
          authority.submissionId,
          authority.operationId,
          postId,
          authority.audioRevision,
          authority.analysisRevision,
          publishedLyricsRevision,
          audio.canonicalSha256,
        ],
        readonly: true,
      });
      if (recovery.length > 1) return { kind: "stale", reason: "multiple_recovery_rows" } as const;
      const recoveryRow = recovery[0];
      if (
        recoveryRow !== undefined &&
        (!validIdentifier(recoveryRow.recovery_action_id) ||
          !validIdentifier(recoveryRow.attempt_id) ||
          (recoveryRow.state !== "requested" && recoveryRow.state !== "completed"))
      )
        return { kind: "stale", reason: "malformed_recovery_identifiers" } as const;
      if (recoveryRow?.state === "requested") {
        const recoveryActionId = recoveryRow.recovery_action_id;
        const attemptId = recoveryRow.attempt_id;
        if (!validIdentifier(recoveryActionId) || !validIdentifier(attemptId))
          return { kind: "stale", reason: "malformed_recovery_identifiers" } as const;
        return { kind: "recovery", recoveryActionId, attemptId } as const;
      }
      const recoveryAttemptId =
        recoveryRow?.state === "completed" && typeof recoveryRow.attempt_id === "string"
          ? recoveryRow.attempt_id
          : undefined;
      query = "media-processing.alignment-recovery";
      const result = await execute({
        label: "media-processing.alignment-recovery",
        text: "SELECT projection.status,projection.failure_code,projection.current_artifact_ref,projection.current_artifact_revision,artifact.artifact_sha256,artifact.artifact FROM media_alignment_projections projection LEFT JOIN media_timed_lyrics_artifacts artifact ON artifact.artifact_ref=projection.current_artifact_ref AND artifact.artifact_revision=projection.current_artifact_revision AND artifact.community_id=projection.community_id AND artifact.actor_user_id=projection.actor_user_id AND artifact.submission_id=projection.submission_id AND artifact.operation_id=projection.operation_id AND artifact.post_id=projection.post_id AND artifact.audio_revision=projection.audio_revision AND artifact.analysis_revision=projection.analysis_revision AND artifact.canonical_audio_sha256=projection.canonical_audio_sha256 AND artifact.lyrics_revision=projection.lyrics_revision WHERE projection.community_id=$1 AND projection.actor_user_id=$2 AND projection.submission_id=$3 AND projection.operation_id=$4 AND projection.post_id=$5 AND projection.audio_revision=$6 AND projection.analysis_revision=$7 AND projection.canonical_audio_sha256=$8 AND projection.lyrics_revision IS NOT DISTINCT FROM $9",
        values: [
          authority.communityId,
          authority.actorAccountId,
          authority.submissionId,
          authority.operationId,
          postId,
          authority.audioRevision,
          authority.analysisRevision,
          audio.canonicalSha256,
          publishedLyricsRevision,
        ],
        readonly: true,
      });
      if (result.length !== 1)
        return { kind: "stale", reason: "invalid_projection_row_count" } as const;
      const row = result[0];
      if (row === undefined)
        return { kind: "stale", reason: "invalid_projection_row_count" } as const;
      if (row.status === "pending") return { kind: "pending" } as const;
      if (row.status === "unavailable") {
        const failureCode = row.failure_code;
        if (
          typeof failureCode !== "string" ||
          !(alignmentFailureCodes as readonly string[]).includes(failureCode)
        )
          return { kind: "stale", reason: "invalid_failure_code" } as const;
        return {
          kind: "committed",
          result: {
            kind: "alignment",
            status: "unavailable",
            failureCode: failureCode as (typeof alignmentFailureCodes)[number],
          },
          ...(recoveryAttemptId === undefined ? {} : { recoveryAttemptId }),
        } as const;
      }
      if (row.status === "ready") {
        const decoded = Schema.decodeUnknownOption(ReadyArtifact)(row);
        if (Option.isNone(decoded)) return { kind: "stale", reason: "malformed_artifact" } as const;
        const artifactRef = decoded.value.current_artifact_ref;
        const artifactSha256 = decoded.value.artifact_sha256;
        const artifact = decoded.value.artifact;
        return {
          kind: "committed",
          result: {
            kind: "alignment",
            status: "ready",
            artifactRef,
            artifactSha256,
            artifact,
          },
          ...(recoveryAttemptId === undefined ? {} : { recoveryAttemptId }),
        } as const;
      }
      return { kind: "stale", reason: "unknown_projection_status" } as const;
    } catch (error) {
      return {
        kind: "failed",
        reason: sanitizeAlignmentRecoveryLookupFailure(error, query),
      } as const;
    }
  };
}
