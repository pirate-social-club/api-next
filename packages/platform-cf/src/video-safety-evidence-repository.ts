import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
import { validateVideoStageFact } from "../../application/src/video/stage-facts.ts";
import type {
  VideoSafetyEvidence,
  VideoSafetyEvidenceStore,
  VideoSafetyInput,
} from "./video-safety-provider.ts";

type Row = { input_sha256: string; evidence_snapshot: VideoSafetyEvidence };
export function makeVideoSafetyEvidenceStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VideoSafetyEvidenceStore {
  const run = <A, E>(program: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.runPromise(program.pipe(Effect.provide(runtime)));
  const decode = (row: Row, digest: string) => {
    if (row.input_sha256 !== digest) throw new Error("video safety replay identity mismatch");
    const fact = validateVideoStageFact({
      stage: "safety",
      adapterRevision: row.evidence_snapshot.fact.adapterRevision,
      snapshot: row.evidence_snapshot.fact,
      artifacts: [],
    });
    if (fact.stage !== "safety") throw new Error("video safety fact mismatch");
    return fact.snapshot;
  };
  const identity = (input: VideoSafetyInput) => [
    input.submissionId,
    input.videoRevision,
    input.creationRevision,
  ];
  return {
    load: (input, digest) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "video-safety.load",
            readonly: true,
            text: "SELECT input_sha256,evidence_snapshot FROM media_video_safety_evidence WHERE submission_id=$1 AND video_revision=$2 AND creation_revision=$3",
            values: identity(input),
          });
          return result.rows[0] === undefined ? null : decode(result.rows[0], digest);
        }),
      ),
    save: (input, evidence) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const authority = yield* tx.execute({
                label: "video-safety.authority",
                readonly: true,
                text: `SELECT submission_id FROM media_post_submissions WHERE submission_id=$1 AND operation_id=$2
            AND community_id=$3 AND video_revision=$4 AND creation_revision=$5
            AND status='processing' AND phase='analysis' AND media_kind='video' FOR UPDATE`,
                values: [
                  input.submissionId,
                  input.operationId,
                  input.communityId,
                  input.videoRevision,
                  input.creationRevision,
                ],
              });
              if (authority.rowCount !== 1) throw new Error("video safety authority superseded");
              yield* tx.execute({
                label: "video-safety.insert",
                readonly: false,
                text: `INSERT INTO media_video_safety_evidence (submission_id,video_revision,creation_revision,request_id,input_sha256,evidence_ref,evidence_snapshot,platform_held)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (submission_id,video_revision,creation_revision) DO NOTHING`,
                values: [
                  ...identity(input),
                  evidence.requestId,
                  evidence.inputDigest,
                  evidence.fact.evidenceRef,
                  JSON.stringify(evidence),
                  evidence.platformHeld,
                ],
              });
              const stored = yield* tx.execute<Row>({
                label: "video-safety.winner",
                readonly: true,
                text: "SELECT input_sha256,evidence_snapshot FROM media_video_safety_evidence WHERE submission_id=$1 AND video_revision=$2 AND creation_revision=$3 AND evidence_snapshot=$4::jsonb",
                values: [...identity(input), JSON.stringify(evidence)],
              });
              const row = stored.rows[0];
              if (row === undefined) throw new Error("video safety persistence missing");
              return decode(row, evidence.inputDigest);
            }),
          );
        }),
      ),
  };
}
