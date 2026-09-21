import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Effect, type Layer } from "effect";
import { validateVideoStageFact } from "../../application/src/video/stage-facts.ts";
import type {
  VideoSafetyEvidence,
  VideoSafetyEvidenceStore,
  VideoSafetyFrameClaimInput,
  VideoSafetyInput,
} from "./video-safety-provider.ts";
import {
  VideoSafetyModerationUnresolvedError,
  validateVideoSafetyFrameProviderResult,
} from "./video-safety-provider.ts";

type Row = { input_sha256: string; evidence_snapshot: VideoSafetyEvidence };
type FrameClaimRow = {
  operation_id: string;
  submission_id: string;
  community_id: string;
  video_revision: string;
  creation_revision: string;
  frame_role: string;
  frame_artifact_ref: string;
  input_sha256: string;
  timestamp_ms: string;
  requested_timestamp_ms: string | null;
  request_id: string;
  claim_token: string;
  state: "sending" | "succeeded";
  provider_result: unknown;
};
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
  const frameIdentity = (input: VideoSafetyFrameClaimInput) => [
    input.operationId,
    input.videoRevision,
    input.creationRevision,
    input.frameRole,
  ];
  const assertFrameIdentity = (row: FrameClaimRow, input: VideoSafetyFrameClaimInput) => {
    if (
      row.operation_id !== input.operationId ||
      row.submission_id !== input.submissionId ||
      row.community_id !== input.communityId ||
      Number(row.video_revision) !== input.videoRevision ||
      Number(row.creation_revision) !== input.creationRevision ||
      row.frame_role !== input.frameRole ||
      row.frame_artifact_ref !== input.frameArtifactRef ||
      row.input_sha256 !== input.frameSha256 ||
      Number(row.timestamp_ms) !== input.timestampMs ||
      (row.requested_timestamp_ms === null ? null : Number(row.requested_timestamp_ms)) !==
        input.requestedTimestampMs ||
      row.request_id !== input.requestId
    )
      throw new Error("video safety provider-call identity mismatch");
  };
  const readFrameClaim = (tx: ControlPlaneTransaction, input: VideoSafetyFrameClaimInput) =>
    tx.execute<FrameClaimRow>({
      label: "video-safety-call.read",
      readonly: true,
      text: `SELECT operation_id,submission_id,community_id,video_revision,creation_revision,
          frame_role,frame_artifact_ref,input_sha256,timestamp_ms,requested_timestamp_ms,
          request_id,claim_token,state,provider_result
        FROM media_video_safety_provider_calls
        WHERE operation_id=$1 AND video_revision=$2 AND creation_revision=$3 AND frame_role=$4`,
      values: frameIdentity(input),
    });
  const lockAuthority = (tx: ControlPlaneTransaction, input: VideoSafetyFrameClaimInput) =>
    tx.execute({
      label: "video-safety-call.authority",
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
    save: (input, evidence, unavailableFrames = []) =>
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
              for (const unavailableFrame of unavailableFrames) {
                if (
                  unavailableFrame.operationId !== input.operationId ||
                  unavailableFrame.submissionId !== input.submissionId ||
                  unavailableFrame.communityId !== input.communityId ||
                  unavailableFrame.videoRevision !== input.videoRevision ||
                  unavailableFrame.creationRevision !== input.creationRevision
                )
                  throw new Error("video safety unavailable-frame identity mismatch");
                const claim = (yield* readFrameClaim(tx, unavailableFrame)).rows[0];
                if (claim === undefined) continue;
                assertFrameIdentity(claim, unavailableFrame);
                if (claim.state === "sending")
                  throw new VideoSafetyModerationUnresolvedError(claim.request_id);
                throw new Error("video safety succeeded frame result requires replay");
              }
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
    inspectFrame: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const existing = (yield* readFrameClaim(db, input)).rows[0];
          if (existing === undefined) return { status: "absent" } as const;
          assertFrameIdentity(existing, input);
          if (existing.state === "succeeded") {
            if (existing.provider_result === null)
              throw new Error("video safety provider-call result missing");
            return {
              status: "succeeded",
              result: validateVideoSafetyFrameProviderResult(
                existing.provider_result,
                input.frameSha256,
              ),
            } as const;
          }
          return { status: "unresolved" } as const;
        }),
      ),
    claimFrame: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const authority = yield* lockAuthority(tx, input);
              if (authority.rowCount !== 1)
                throw new Error("video safety provider-call authority superseded");
              const aggregate = yield* tx.execute({
                label: "video-safety-call.aggregate",
                readonly: true,
                text: `SELECT 1 FROM media_video_safety_evidence
                  WHERE submission_id=$1 AND video_revision=$2 AND creation_revision=$3`,
                values: [input.submissionId, input.videoRevision, input.creationRevision],
              });
              if (aggregate.rowCount !== 0)
                throw new Error("video safety aggregate evidence already exists");
              const claimToken = crypto.randomUUID();
              const inserted = yield* tx.execute<{ claim_token: string }>({
                label: "video-safety-call.claim",
                readonly: false,
                text: `INSERT INTO media_video_safety_provider_calls
                    (operation_id,submission_id,community_id,video_revision,creation_revision,
                     frame_role,frame_artifact_ref,input_sha256,timestamp_ms,
                     requested_timestamp_ms,request_id,claim_token,state)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sending')
                  ON CONFLICT (operation_id,video_revision,creation_revision,frame_role) DO NOTHING
                  RETURNING claim_token`,
                values: [
                  input.operationId,
                  input.submissionId,
                  input.communityId,
                  input.videoRevision,
                  input.creationRevision,
                  input.frameRole,
                  input.frameArtifactRef,
                  input.frameSha256,
                  input.timestampMs,
                  input.requestedTimestampMs,
                  input.requestId,
                  claimToken,
                ],
              });
              if (inserted.rowCount === 1) return { status: "dispatch", claimToken } as const;
              const existing = (yield* readFrameClaim(tx, input)).rows[0];
              if (existing === undefined)
                throw new Error("video safety provider-call claim missing");
              assertFrameIdentity(existing, input);
              if (existing.state === "succeeded") {
                if (existing.provider_result === null)
                  throw new Error("video safety provider-call result missing");
                return {
                  status: "succeeded",
                  result: validateVideoSafetyFrameProviderResult(
                    existing.provider_result,
                    input.frameSha256,
                  ),
                } as const;
              }
              return { status: "unresolved" } as const;
            }),
          );
        }),
      ),
    succeedFrame: (input, claimToken, result) =>
      run(
        Effect.gen(function* () {
          const validatedResult = validateVideoSafetyFrameProviderResult(result, input.frameSha256);
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const authority = yield* lockAuthority(tx, input);
              if (authority.rowCount !== 1)
                throw new Error("video safety provider-call authority superseded");
              const updated = yield* tx.execute<FrameClaimRow>({
                label: "video-safety-call.succeed",
                readonly: false,
                text: `UPDATE media_video_safety_provider_calls
                  SET state='succeeded',provider_result=$1::jsonb,resolved_at=clock_timestamp()
                  WHERE operation_id=$2 AND video_revision=$3 AND creation_revision=$4
                    AND frame_role=$5 AND submission_id=$6 AND community_id=$7
                    AND frame_artifact_ref=$8 AND input_sha256=$9 AND timestamp_ms=$10
                    AND requested_timestamp_ms IS NOT DISTINCT FROM $11::bigint
                    AND request_id=$12 AND claim_token=$13 AND state='sending'
                  RETURNING operation_id,submission_id,community_id,video_revision,creation_revision,
                    frame_role,frame_artifact_ref,input_sha256,timestamp_ms,requested_timestamp_ms,
                    request_id,claim_token,state,provider_result`,
                values: [
                  JSON.stringify(validatedResult),
                  ...frameIdentity(input),
                  input.submissionId,
                  input.communityId,
                  input.frameArtifactRef,
                  input.frameSha256,
                  input.timestampMs,
                  input.requestedTimestampMs,
                  input.requestId,
                  claimToken,
                ],
              });
              const row =
                updated.rows[0] ??
                (yield* tx.execute<FrameClaimRow>({
                  label: "video-safety-call.succeed-replay",
                  readonly: true,
                  text: `SELECT operation_id,submission_id,community_id,video_revision,
                        creation_revision,frame_role,frame_artifact_ref,input_sha256,timestamp_ms,
                        requested_timestamp_ms,request_id,claim_token,state,provider_result
                      FROM media_video_safety_provider_calls
                      WHERE operation_id=$1 AND video_revision=$2 AND creation_revision=$3
                        AND frame_role=$4 AND claim_token=$5 AND state='succeeded'
                        AND provider_result=$6::jsonb`,
                  values: [...frameIdentity(input), claimToken, JSON.stringify(validatedResult)],
                })).rows[0];
              if (row === undefined)
                throw new Error("video safety provider-call completion mismatch");
              assertFrameIdentity(row, input);
              if (row.state !== "succeeded" || row.provider_result === null)
                throw new Error("video safety provider-call completion mismatch");
              return validateVideoSafetyFrameProviderResult(row.provider_result, input.frameSha256);
            }),
          );
        }),
      ),
  };
}
