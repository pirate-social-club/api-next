import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  type VideoStageFact,
  type VideoStageFactStore,
  validateVideoStageFact,
} from "@pirate/application/video/stage-facts";
import { Effect, type Layer } from "effect";
import type { VideoSubmissionState } from "../../domain/src/video-submission.ts";

export function insertVideoStageFact(
  tx: Pick<ControlPlaneTransaction, "execute">,
  submission: VideoSubmissionState,
  input: VideoStageFact,
) {
  return Effect.gen(function* () {
    const fact = validateVideoStageFact(input);
    if (
      submission.video === null ||
      ((fact.stage === "audio" || fact.stage === "frames") &&
        (fact.snapshot.videoRevision !== submission.videoRevision ||
          fact.snapshot.sourceSha256 !== submission.video.canonicalSha256))
    )
      throw new Error("video stage fact source binding rejected");
    const values = [
      submission.submissionId,
      submission.videoRevision,
      submission.creationRevision,
      fact.stage,
      submission.analysisRevision + 1,
      fact.adapterRevision,
      JSON.stringify(fact),
    ];
    yield* tx.execute({
      label: "video-stage-fact.insert",
      readonly: false,
      values,
      text: `INSERT INTO media_video_stage_facts
        (submission_id,video_revision,creation_revision,stage,analysis_revision,adapter_revision,fact_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
    });
    const winner = yield* tx.execute({
      label: "video-stage-fact.winner",
      readonly: true,
      values,
      text: `SELECT 1 FROM media_video_stage_facts WHERE submission_id=$1 AND video_revision=$2
        AND creation_revision=$3 AND stage=$4 AND analysis_revision=$5 AND adapter_revision=$6
        AND sha256(convert_to(fact_snapshot::text,'UTF8'))=sha256(convert_to(($7::jsonb)::text,'UTF8'))`,
    });
    if (winner.rows.length !== 1) throw new Error("video stage fact invariant rejected");
    return fact;
  });
}

export function makeControlPlaneVideoStageFactStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VideoStageFactStore {
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.runPromise(Effect.provide(runtime)(effect));
  return {
    read: (identity) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Record<string, unknown>>({
            label: "video-stage-fact.read",
            readonly: true,
            text: `SELECT stage,adapter_revision,fact_snapshot FROM media_video_stage_facts
          WHERE submission_id=$1 AND video_revision=$2 AND creation_revision=$3 ORDER BY stage`,
            values: [identity.submissionId, identity.videoRevision, identity.creationRevision],
          });
          return result.rows.map((row) => {
            const fact = validateVideoStageFact(row.fact_snapshot);
            if (fact.stage !== row.stage || fact.adapterRevision !== row.adapter_revision)
              throw new Error("video stage fact row binding rejected");
            return fact;
          });
        }),
      ),
    write: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const authority = yield* tx.execute<{ video_state_snapshot: VideoSubmissionState }>({
                label: "video-stage-fact.authority",
                readonly: true,
                text: `SELECT video_state_snapshot FROM media_post_submissions WHERE submission_id=$1 AND operation_id=$2
            AND media_kind='video' AND video_revision=$3 AND creation_revision=$4 AND analysis_revision=$5
            AND event_sequence=$6 AND status='processing' AND phase='analysis' FOR UPDATE`,
                values: [
                  input.submission.submissionId,
                  input.submission.operationId,
                  input.submission.videoRevision,
                  input.submission.creationRevision,
                  input.submission.analysisRevision,
                  input.observedEventSequence,
                ],
              });
              if (authority.rows.length !== 1)
                throw new Error("video stage fact authority rejected");
              const current = authority.rows[0]?.video_state_snapshot;
              if (current === undefined) throw new Error("video stage fact authority rejected");
              return yield* insertVideoStageFact(tx, current, input.fact);
            }),
          );
        }),
      ),
  };
}
