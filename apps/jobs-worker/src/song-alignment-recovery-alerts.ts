import { AlertCollector, ControlPlaneDb } from "@pirate/application";
import { Effect, Option, Schema } from "effect";
import { isWorkflowInstanceMissingError } from "../../../packages/platform-cf/src/cloudflare-orchestration-primitives.ts";
import {
  type CloudflareMediaWorkflowBinding,
  makeCloudflareMediaProcessingWorkflowLauncher,
} from "../../../packages/platform-cf/src/media-processing-cloudflare.ts";

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:/-]{1,256}$/u));
const Candidate = Schema.Struct({
  operation_id: Identity,
  workflow_revision: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
});
const LookupCandidate = Schema.Struct({ ...Candidate.fields, workflow_instance_id: Identity });

const EXHAUSTED_SQL = `SELECT submission.operation_id,
       submission.workflow_revision::text AS workflow_revision
  FROM media_alignment_recovery_actions recovery
  JOIN media_post_submissions submission
    ON submission.community_id=recovery.community_id
   AND submission.actor_user_id=recovery.actor_user_id
   AND submission.submission_id=recovery.submission_id
   AND submission.operation_id=recovery.operation_id
   AND submission.post_id=recovery.post_id
   AND submission.audio_revision=recovery.audio_revision
   AND submission.analysis_revision=recovery.analysis_revision
  JOIN media_processing_attempts attempt
    ON attempt.attempt_id=recovery.attempt_id||'-n3'
   AND attempt.community_id=recovery.community_id
   AND attempt.actor_user_id=recovery.actor_user_id
   AND attempt.submission_id=recovery.submission_id
   AND attempt.operation_id=recovery.operation_id
   AND attempt.audio_revision=recovery.audio_revision
   AND attempt.analysis_revision=recovery.analysis_revision
   AND attempt.input_revision=recovery.lyrics_revision
   AND attempt.input_hash=recovery.canonical_audio_sha256
 WHERE submission.status='published'
   AND attempt.stage='alignment_recovery'
   AND attempt.state='exhausted' AND attempt.attempt_number=3 AND attempt.retryable=FALSE
 ORDER BY attempt.updated_at,attempt.attempt_id LIMIT 50`;

const LOOKUP_SQL = `SELECT DISTINCT submission.operation_id,
       submission.workflow_revision::text AS workflow_revision,launch.workflow_instance_id
  FROM media_post_submissions submission
  JOIN media_submission_outbox launch
    ON launch.submission_id=submission.submission_id
   AND launch.operation_id=submission.operation_id
   AND launch.workflow_revision=submission.workflow_revision
   AND launch.event_type IN ('analysis_launch','workflow_replacement','alignment')
 WHERE submission.status='published'
   AND EXISTS (SELECT 1 FROM media_alignment_recovery_actions recovery
                WHERE recovery.submission_id=submission.submission_id
                  AND recovery.operation_id=submission.operation_id)
   AND launch.state IN ('delivered','exhausted')
 ORDER BY submission.operation_id LIMIT 50`;

const alert = (operationId: string, revision: number, reason: string, failureClass = reason) => ({
  key: `song-pipeline:${reason}`,
  severity: "high" as const,
  body: "Song alignment recovery ended and requires operator observation.",
  entity: `media:${operationId}:r${revision}:${reason}`,
  subsystem: "media" as const,
  operation: "media-analysis" as const,
  operation_id: operationId,
  workflow_revision: revision,
  failure_class: failureClass,
  outcome: "terminal" as const,
});

/** Read exhausted attempts even after recovery completion, and retained Workflow errors. */
export const collectSongAlignmentRecoveryAlerts = Effect.fn("collectSongAlignmentRecoveryAlerts")(
  function* (binding: CloudflareMediaWorkflowBinding | undefined) {
    const db = yield* ControlPlaneDb;
    const collector = yield* AlertCollector;
    const rows = (label: string, text: string) =>
      db
        .execute<Readonly<Record<string, unknown>>>({
          label,
          text,
          values: [],
          readonly: true,
        })
        .pipe(
          Effect.map((result) => result.rows),
          Effect.catchCause(() =>
            Effect.sync(() => {
              console.error("song_alignment_recovery_alert_query_unavailable", { query: label });
              return [];
            }),
          ),
        );
    let emitted = 0;
    for (const row of yield* rows(
      "song-pipeline.terminal.alignment-recovery-exhausted",
      EXHAUSTED_SQL,
    )) {
      const decoded = Schema.decodeUnknownOption(Candidate)(row);
      if (Option.isNone(decoded)) continue;
      yield* collector.emit(
        alert(
          decoded.value.operation_id,
          decoded.value.workflow_revision,
          "alignment_recovery_exhausted",
        ),
      );
      emitted += 1;
    }
    if (binding === undefined) return emitted;
    const launcher = makeCloudflareMediaProcessingWorkflowLauncher(
      binding,
      isWorkflowInstanceMissingError,
    );
    for (const row of yield* rows(
      "song-pipeline.terminal.alignment-recovery-lookups",
      LOOKUP_SQL,
    )) {
      const decoded = Schema.decodeUnknownOption(LookupCandidate)(row);
      if (Option.isNone(decoded)) continue;
      const failure = yield* Effect.tryPromise(() =>
        launcher.getRecoveryFailure(decoded.value.workflow_instance_id),
      ).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            console.error("song_alignment_recovery_workflow_observation_unavailable", {
              operationId: decoded.value.operation_id,
              workflowRevision: decoded.value.workflow_revision,
            });
            return null;
          }),
        ),
      );
      if (failure === null) continue;
      const reason =
        failure.outcome === "alignment_recovery_lookup_stale"
          ? `${failure.outcome}:${failure.reason}`
          : `${failure.outcome}:${failure.reason.errorClass}:${failure.reason.code ?? "unknown"}:${failure.reason.query}`;
      yield* collector.emit(
        alert(decoded.value.operation_id, decoded.value.workflow_revision, reason, failure.outcome),
      );
      emitted += 1;
    }
    return emitted;
  },
);
