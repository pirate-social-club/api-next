import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import type {
  VideoAttemptReconciliationStore,
  VideoPublicationStore,
  VideoPublishBundle,
  VideoReservationRecord,
  VideoSubmissionRecord,
} from "@pirate/application/video/publication";
import { Effect, type Layer } from "effect";
import {
  attachImmutableVideo,
  VIDEO_DERIVED_ARTIFACT_RETENTION_POLICY_V1,
  type VideoSubmissionState,
} from "../../domain/src/video-submission.ts";
import { insertVideoStageFact } from "./video-stage-fact-repository.ts";

type Row = Readonly<Record<string, unknown>>;
type Executor = Pick<ControlPlaneTransaction, "execute">;

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array && value.byteLength > 0) return value;
  throw new Error("invalid video snapshot bytes");
};

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0 || value !== value.trim())
    throw new Error("invalid video persistence row");
  return value;
};

const nullableText = (row: Row, key: string): string | null => {
  const value = row[key];
  return value === null || value === undefined ? null : text(row, key);
};

const integer = (row: Row, key: string, minimum = 0): number => {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error("invalid video persistence row");
  return value;
};

const instant = (row: Row, key: string): string => {
  const value = row[key];
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("invalid video persistence row");
  return date.toISOString();
};

const json = <T>(value: unknown): T => {
  if (typeof value === "string") return JSON.parse(value) as T;
  if (value !== null && typeof value === "object") return value as T;
  throw new Error("invalid video persistence row");
};

function reservationFromRow(row: Row): VideoReservationRecord {
  const contentType = text(row, "expected_content_type");
  if (contentType !== "video/mp4" && contentType !== "video/quicktime")
    throw new Error("invalid video reservation content type");
  const state = text(row, "state");
  if (!["issued", "claimed", "sealed", "rejected", "expired"].includes(state))
    throw new Error("invalid video reservation state");
  const manifest =
    row.multipart_manifest === null || row.multipart_manifest === undefined
      ? null
      : json<readonly { partNumber: number; etag: string }[]>(row.multipart_manifest);
  return {
    reservationId: text(row, "reservation_id"),
    communityId: text(row, "community_id"),
    actorAccountId: text(row, "actor_user_id"),
    authorPersonaId: text(row, "actor_persona_id"),
    requestHash: text(row, "request_hash"),
    expectedContentType: contentType,
    expectedSizeBytes: integer(row, "expected_size_bytes", 1),
    expectedSha256: nullableText(row, "expected_sha256"),
    ingestPolicyRevision: integer(row, "ingest_policy_revision", 1),
    uploadId: text(row, "multipart_upload_id"),
    partSizeBytes: integer(row, "multipart_part_size_bytes", 1),
    partCount: integer(row, "multipart_part_count", 1),
    expiresAt: instant(row, "expires_at"),
    state: state as VideoReservationRecord["state"],
    submissionId: nullableText(row, "submission_id"),
    operationId: nullableText(row, "operation_id"),
    manifest,
    responseBytes: bytes(row.response_snapshot_bytes),
    updatedAt: instant(row, "updated_at"),
  };
}

function submissionFromRow(row: Row): VideoSubmissionRecord {
  const snapshot = json<VideoSubmissionState>(row.video_state_snapshot);
  // Pre-0120 snapshots have no attempt reconciliation; its migration refuses
  // historical attempts. Only absence defaults false; malformed facts fail closed.
  if (
    snapshot.reconciliationRequired !== undefined &&
    typeof snapshot.reconciliationRequired !== "boolean"
  )
    throw new Error("invalid video reconciliation fact");
  const state = { ...snapshot, reconciliationRequired: snapshot.reconciliationRequired ?? false };
  if (
    state.submissionId !== text(row, "submission_id") ||
    state.operationId !== text(row, "operation_id") ||
    state.authorPersonaId !== text(row, "author_persona_id") ||
    state.intent !== "original_audio"
  )
    throw new Error("invalid video submission snapshot");
  const persona = json<VideoSubmissionRecord["authorPersona"]>(row.author_persona);
  if (persona.persona_id !== state.authorPersonaId || persona.object !== "persona")
    throw new Error("invalid video persona snapshot");
  return {
    state,
    eventSequence: integer(row, "event_sequence"),
    authorPersona: persona,
    updatedAt: instant(row, "updated_at"),
  };
}

const RESERVATION_COLUMNS = `reservation_id,community_id,actor_user_id,actor_persona_id,
  request_hash,expected_content_type,expected_size_bytes,expected_sha256,
  ingest_policy_revision,multipart_upload_id,multipart_part_size_bytes,
  multipart_part_count,multipart_manifest,expires_at,state,submission_id,
  operation_id,response_snapshot_bytes,updated_at`;

const SUBMISSION_SELECT = `SELECT s.submission_id,s.operation_id,s.author_persona_id,
  s.video_state_snapshot,s.event_sequence,s.updated_at,public_persona_projection(s.author_persona_id) AS author_persona
  FROM media_post_submissions s`;

function replayFromRow(row: Row | undefined, requestHash: string, entityKey: string) {
  if (row === undefined) return { kind: "none" as const };
  const entityId = text(row, entityKey);
  return text(row, "request_hash") === requestHash
    ? { kind: "replay" as const, bytes: bytes(row.response_snapshot_bytes), entityId }
    : { kind: "conflict" as const, entityId };
}

function lock(tx: Executor, value: string) {
  return tx.execute({
    label: "video-publication.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    values: [value],
    readonly: false,
  });
}

function commandReplay(
  executor: Executor,
  input: {
    actorAccountId: string;
    endpointTemplate: string;
    idempotencyKey: string;
    requestHash: string;
  },
) {
  return Effect.gen(function* () {
    const result = yield* executor.execute<Row>({
      label: "video-publication.command-replay",
      text: `SELECT submission_id,request_hash,response_snapshot_bytes
               FROM media_submission_command_replays
              WHERE actor_user_id=$1 AND endpoint_template=$2 AND idempotency_key=$3`,
      values: [input.actorAccountId, input.endpointTemplate, input.idempotencyKey],
      readonly: true,
    });
    if (result.rows.length > 1) throw new Error("invalid video command replay");
    return replayFromRow(result.rows[0], input.requestHash, "submission_id");
  });
}

function storeCommand(
  tx: Executor,
  input: {
    state: VideoSubmissionState;
    actorAccountId: string;
    endpointTemplate: string;
    idempotencyKey: string;
    requestHash: string;
    responseBytes: Uint8Array;
    responseSha256: string;
  },
) {
  return tx.execute({
    label: "video-publication.command-store",
    text: `INSERT INTO media_submission_command_replays
      (community_id,actor_user_id,submission_actor_user_id,endpoint_template,idempotency_key,
       request_hash,submission_id,operation_id,response_snapshot_bytes,response_snapshot_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    values: [
      input.state.communityId,
      input.actorAccountId,
      input.state.actorAccountId,
      input.endpointTemplate,
      input.idempotencyKey,
      input.requestHash,
      input.state.submissionId,
      input.state.operationId,
      input.responseBytes,
      input.responseSha256,
    ],
    readonly: false,
  });
}

function findSubmission(executor: Executor, input: { clause: string; values: readonly unknown[] }) {
  return Effect.gen(function* () {
    const result = yield* executor.execute<Row>({
      label: "video-publication.submission-read",
      text: `${SUBMISSION_SELECT} WHERE s.media_kind='video' AND ${input.clause}`,
      values: input.values,
      readonly: true,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1 || result.rows[0] === undefined)
      throw new Error("invalid video submission cardinality");
    return submissionFromRow(result.rows[0]);
  });
}

function updateSubmissionSnapshot(
  tx: Executor,
  input: {
    prior: VideoSubmissionState;
    next: VideoSubmissionState;
    extraSql?: string;
    extraValues?: readonly unknown[];
    observedEventSequence?: number;
  },
) {
  const extraValues = input.extraValues ?? [];
  return tx.execute({
    label: "video-publication.submission-update",
    text: `UPDATE media_post_submissions SET
      video_state_snapshot=$1::jsonb,status=$2,phase=$3,creation_revision=$4,
      video_revision=$5,analysis_revision=$6,post_id=$7,failure_code=$8,
      retry_count=$9,event_sequence=event_sequence+1,updated_at=clock_timestamp()
      ${input.extraSql ?? ""}
      WHERE submission_id=$${10 + extraValues.length} AND operation_id=$${11 + extraValues.length}
        AND creation_revision=$${12 + extraValues.length} AND media_kind='video'
        ${input.observedEventSequence === undefined ? "" : `AND event_sequence=$${13 + extraValues.length}`} RETURNING event_sequence`,
    values: [
      JSON.stringify(input.next),
      input.next.status,
      input.next.phase,
      input.next.creationRevision,
      input.next.videoRevision,
      input.next.analysisRevision,
      input.next.postId,
      input.next.failureCode,
      input.next.retryCount,
      ...extraValues,
      input.prior.submissionId,
      input.prior.operationId,
      input.prior.creationRevision,
      ...(input.observedEventSequence === undefined ? [] : [input.observedEventSequence]),
    ],
    readonly: false,
  });
}

export function makeControlPlaneVideoPublicationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VideoPublicationStore & VideoAttemptReconciliationStore {
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>): Promise<A> =>
    Effect.runPromise(Effect.provide(runtime)(effect));

  return {
    replayReservation: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          if (input.endpointTemplate !== undefined) {
            const result = yield* db.execute<Row>({
              label: "video-publication.reservation-command-replay",
              text: `SELECT reservation_id,request_hash,response_snapshot_bytes
                       FROM media_video_reservation_command_replays
                      WHERE actor_account_id=$1 AND actor_persona_id=$2
                        AND endpoint_template=$3 AND idempotency_key=$4`,
              values: [
                input.actorAccountId,
                input.authorPersonaId,
                input.endpointTemplate,
                input.idempotencyKey,
              ],
              readonly: true,
            });
            return replayFromRow(result.rows[0], input.requestHash, "reservation_id");
          }
          const result = yield* db.execute<Row>({
            label: "video-publication.reservation-replay",
            text: `SELECT reservation_id,request_hash,response_snapshot_bytes
                     FROM media_upload_reservations
                    WHERE community_id=$1 AND actor_user_id=$2 AND actor_persona_id=$3
                      AND endpoint_template='/communities/:communityId/media-upload-reservations'
                      AND idempotency_key=$4`,
            values: [
              input.communityId,
              input.actorAccountId,
              input.authorPersonaId,
              input.idempotencyKey,
            ],
            readonly: true,
          });
          return replayFromRow(result.rows[0], input.requestHash, "reservation_id");
        }),
      ),

    createReservation: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const scope = `${input.record.actorAccountId}:${input.record.authorPersonaId}:${input.idempotencyKey}`;
              yield* lock(tx, `video-reservation:${scope}`);
              const prior = yield* tx.execute<Row>({
                label: "video-publication.reservation-existing",
                text: `SELECT reservation_id,request_hash,response_snapshot_bytes
                         FROM media_upload_reservations
                        WHERE community_id=$1 AND actor_user_id=$2 AND actor_persona_id=$3
                          AND endpoint_template='/communities/:communityId/media-upload-reservations'
                          AND idempotency_key=$4`,
                values: [
                  input.record.communityId,
                  input.record.actorAccountId,
                  input.record.authorPersonaId,
                  input.idempotencyKey,
                ],
                readonly: true,
              });
              if (prior.rows[0] !== undefined)
                return replayFromRow(prior.rows[0], input.record.requestHash, "reservation_id");
              yield* tx.execute({
                label: "video-publication.reservation-insert",
                text: `INSERT INTO media_upload_reservations
                  (reservation_id,community_id,actor_user_id,actor_persona_id,idempotency_key,
                   request_hash,expected_content_type,expected_size_bytes,expected_sha256,
                   upload_url,upload_headers,expires_at,response_snapshot_bytes,response_snapshot_sha256,
                   media_kind,video_intent,ingest_policy_revision,multipart_upload_id,
                   multipart_part_size_bytes,multipart_part_count)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,'[]'::jsonb,$10,$11,$12,
                          'video','original_audio',$13,$14,$15,$16)`,
                values: [
                  input.record.reservationId,
                  input.record.communityId,
                  input.record.actorAccountId,
                  input.record.authorPersonaId,
                  input.idempotencyKey,
                  input.record.requestHash,
                  input.record.expectedContentType,
                  input.record.expectedSizeBytes,
                  input.record.expectedSha256,
                  input.record.expiresAt,
                  input.record.responseBytes,
                  input.responseSha256,
                  input.record.ingestPolicyRevision,
                  input.record.uploadId,
                  input.record.partSizeBytes,
                  input.record.partCount,
                ],
                readonly: false,
              });
              for (const part of input.parts) {
                yield* tx.execute({
                  label: "video-publication.part-insert",
                  text: `INSERT INTO media_video_upload_parts
                    (reservation_id,part_number,presigned_url,expires_at) VALUES ($1,$2,$3,$4)`,
                  values: [input.record.reservationId, part.partNumber, part.url, part.expiresAt],
                  readonly: false,
                });
              }
              return { kind: "none" as const };
            }),
          );
        }),
      ),

    getReservationForAuthor: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "video-publication.reservation-read",
            text: `SELECT ${RESERVATION_COLUMNS} FROM media_upload_reservations
                    WHERE reservation_id=$1 AND actor_user_id=$2 AND actor_persona_id=$3
                      AND media_kind='video'`,
            values: [input.reservationId, input.actorAccountId, input.authorPersonaId],
            readonly: true,
          });
          return result.rows[0] === undefined ? null : reservationFromRow(result.rows[0]);
        }),
      ),

    getReservationForAccount: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "video-publication.reservation-account-read",
            text: `SELECT ${RESERVATION_COLUMNS} FROM media_upload_reservations
                    WHERE reservation_id=$1 AND actor_user_id=$2 AND media_kind='video'`,
            values: [input.reservationId, input.actorAccountId],
            readonly: true,
          });
          return result.rows[0] === undefined ? null : reservationFromRow(result.rows[0]);
        }),
      ),

    renewParts: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              yield* lock(
                tx,
                `video-renew:${input.reservation.actorAccountId}:${input.reservation.authorPersonaId}:${input.idempotencyKey}`,
              );
              const prior = yield* tx.execute<Row>({
                label: "video-publication.renew-replay",
                text: `SELECT reservation_id,request_hash,response_snapshot_bytes
                         FROM media_video_reservation_command_replays
                        WHERE actor_account_id=$1 AND actor_persona_id=$2
                          AND endpoint_template=$3 AND idempotency_key=$4`,
                values: [
                  input.reservation.actorAccountId,
                  input.reservation.authorPersonaId,
                  input.endpointTemplate,
                  input.idempotencyKey,
                ],
                readonly: true,
              });
              if (prior.rows[0] !== undefined)
                return replayFromRow(prior.rows[0], input.requestHash, "reservation_id");
              const guarded = yield* tx.execute({
                label: "video-publication.renew-guard",
                text: `SELECT reservation_id FROM media_upload_reservations
                        WHERE reservation_id=$1 AND actor_user_id=$2 AND actor_persona_id=$3
                          AND media_kind='video' AND state IN ('issued','claimed')
                          AND multipart_manifest IS NULL
                          AND expires_at>clock_timestamp() FOR UPDATE`,
                values: [
                  input.reservation.reservationId,
                  input.reservation.actorAccountId,
                  input.reservation.authorPersonaId,
                ],
                readonly: false,
              });
              if (guarded.rowCount !== 1) throw new Error("video reservation action expired");
              for (const part of input.parts) {
                yield* tx.execute({
                  label: "video-publication.part-renew",
                  text: `UPDATE media_video_upload_parts SET presigned_url=$1,expires_at=$2,
                          renewed_at=clock_timestamp() WHERE reservation_id=$3 AND part_number=$4`,
                  values: [
                    part.url,
                    part.expiresAt,
                    input.reservation.reservationId,
                    part.partNumber,
                  ],
                  readonly: false,
                });
              }
              yield* tx.execute({
                label: "video-publication.renew-replay-insert",
                text: `INSERT INTO media_video_reservation_command_replays
                  (actor_account_id,actor_persona_id,endpoint_template,idempotency_key,request_hash,
                   reservation_id,response_snapshot_bytes,response_snapshot_sha256)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                values: [
                  input.reservation.actorAccountId,
                  input.reservation.authorPersonaId,
                  input.endpointTemplate,
                  input.idempotencyKey,
                  input.requestHash,
                  input.reservation.reservationId,
                  input.responseBytes,
                  input.responseSha256,
                ],
                readonly: false,
              });
              return { kind: "none" as const };
            }),
          );
        }),
      ),

    createSubmission: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const state = input.state;
              yield* lock(tx, `video-create:${state.actorAccountId}:${input.idempotencyKey}`);
              const prior = yield* tx.execute<Row>({
                label: "video-publication.create-replay",
                text: `SELECT submission_id,request_hash,response_snapshot_bytes
                         FROM media_post_submissions WHERE community_id=$1 AND actor_user_id=$2
                          AND endpoint_template='/communities/:communityId/media-post-submissions'
                          AND idempotency_key=$3`,
                values: [state.communityId, state.actorAccountId, input.idempotencyKey],
                readonly: true,
              });
              if (prior.rows[0] !== undefined)
                return replayFromRow(prior.rows[0], input.requestHash, "submission_id");
              const reservation = yield* tx.execute({
                label: "video-publication.claim-reservation",
                text: `SELECT reservation_id FROM media_upload_reservations
                        WHERE reservation_id=$1 AND community_id=$2 AND actor_user_id=$3
                          AND actor_persona_id=$4 AND media_kind='video' AND state='issued'
                          AND expires_at>clock_timestamp() FOR UPDATE`,
                values: [
                  state.reservationId,
                  state.communityId,
                  state.actorAccountId,
                  state.authorPersonaId,
                ],
                readonly: false,
              });
              if (reservation.rowCount !== 1)
                throw new Error("video reservation cannot be claimed");
              yield* tx.execute({
                label: "video-publication.submission-insert",
                text: `INSERT INTO media_post_submissions
                  (submission_id,community_id,actor_user_id,author_persona_id,operation_id,
                   idempotency_key,request_hash,title,song_type,start_input,audio_reservation_id,
                   creation_revision,audio_revision,analysis_revision,event_sequence,status,phase,
                   response_snapshot_bytes,response_snapshot_sha256,media_kind,video_intent,caption,
                   video_revision,video_state_snapshot,author_declared_rating)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,$8::jsonb,$9,1,0,0,1,'processing',
                          'awaiting_upload',$10,$11,'video','original_audio',$12,0,$13::jsonb,$14)`,
                values: [
                  state.submissionId,
                  state.communityId,
                  state.actorAccountId,
                  state.authorPersonaId,
                  state.operationId,
                  input.idempotencyKey,
                  input.requestHash,
                  JSON.stringify(input.startInput),
                  state.reservationId,
                  input.responseBytes,
                  input.responseSha256,
                  state.caption,
                  JSON.stringify(state),
                  state.authorDeclaredRating,
                ],
                readonly: false,
              });
              yield* tx.execute({
                label: "video-publication.claim-reservation-update",
                text: `UPDATE media_upload_reservations SET state='claimed',submission_id=$1,
                        operation_id=$2,claim_fence=claim_fence+1,updated_at=clock_timestamp()
                        WHERE reservation_id=$3 AND state='issued'`,
                values: [state.submissionId, state.operationId, state.reservationId],
                readonly: false,
              });
              return { kind: "none" as const };
            }),
          );
        }),
      ),

    getSubmissionForAccount: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* findSubmission(db, {
            clause: "s.submission_id=$1 AND s.actor_user_id=$2",
            values: [input.submissionId, input.actorAccountId],
          });
        }),
      ),
    getSubmissionByOperation: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* findSubmission(db, {
            clause: "s.submission_id=$1 AND s.operation_id=$2",
            values: [input.submissionId, input.operationId],
          });
        }),
      ),
    getSubmissionForModerator: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* findSubmission(db, {
            clause: `s.submission_id=$1 AND has_community_moderation_capability_v1(
              $2,s.community_id,'moderation.act')`,
            values: [input.submissionId, input.actor.userId],
          });
        }),
      ),

    replayCommand: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* commandReplay(db, {
            actorAccountId: input.actorAccountId,
            endpointTemplate: input.endpointTemplate,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
          });
        }),
      ),

    beginFinalize: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const current = yield* findSubmission(tx, {
                clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
                values: [input.submission.submissionId, input.submission.operationId],
              });
              if (
                current === null ||
                current.state.creationRevision !== input.expectedCreationRevision ||
                current.state.authorPersonaId !== input.submission.authorPersonaId ||
                current.state.status !== "processing" ||
                !["awaiting_upload", "finalize"].includes(current.state.phase ?? "")
              )
                throw new Error("video finalize fence rejected");
              const reservationResult = yield* tx.execute<Row>({
                label: "video-publication.finalize-reservation",
                text: `SELECT ${RESERVATION_COLUMNS} FROM media_upload_reservations
                        WHERE reservation_id=$1 AND submission_id=$2 AND operation_id=$3
                          AND state='claimed' FOR UPDATE`,
                values: [
                  current.state.reservationId,
                  current.state.submissionId,
                  current.state.operationId,
                ],
                readonly: false,
              });
              const row = reservationResult.rows[0];
              if (row === undefined) throw new Error("video finalize reservation missing");
              const reservation = reservationFromRow(row);
              const priorManifest = reservation.manifest;
              if (
                priorManifest !== null &&
                JSON.stringify(priorManifest) !== JSON.stringify(input.manifest)
              )
                throw new Error("video finalize manifest conflict");
              if (priorManifest === null) {
                yield* tx.execute({
                  label: "video-publication.finalize-manifest",
                  text: `UPDATE media_upload_reservations SET multipart_manifest=$1::jsonb,
                          updated_at=clock_timestamp() WHERE reservation_id=$2`,
                  values: [JSON.stringify(input.manifest), reservation.reservationId],
                  readonly: false,
                });
              }
              if (current.state.phase === "awaiting_upload") {
                const next = {
                  ...current.state,
                  phase: "finalize" as const,
                  posterTimestampMs: input.posterTimestampMs,
                };
                yield* updateSubmissionSnapshot(tx, {
                  prior: current.state,
                  next,
                  extraSql: ",poster_timestamp_ms=$10",
                  extraValues: [input.posterTimestampMs],
                });
              }
              return {
                reservation: { ...reservation, manifest: input.manifest },
                alreadyCompleted: row.multipart_completed_at !== null,
              };
            }),
          );
        }),
      ),

    recordMultipartCompleted: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.execute({
            label: "video-publication.multipart-completed",
            text: `UPDATE media_upload_reservations SET multipart_completed_at=COALESCE(
                    multipart_completed_at,clock_timestamp()),updated_at=clock_timestamp()
                    WHERE reservation_id=$1 AND submission_id=$2 AND operation_id=$3
                      AND multipart_manifest=$4::jsonb AND multipart_aborted_at IS NULL`,
            values: [
              input.submission.reservationId,
              input.submission.submissionId,
              input.submission.operationId,
              JSON.stringify(input.manifest),
            ],
            readonly: false,
          });
        }),
      ),

    abandonInvalidManifest: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const next: VideoSubmissionState = {
                ...input.submission,
                status: "abandoned",
                phase: null,
              };
              yield* tx.execute({
                label: "video-publication.manifest-abort",
                text: `UPDATE media_upload_reservations SET state='rejected',
                        terminal_reason='expectation_mismatch',terminal_evidence_ref=$1,
                        terminal_evidence_digest=encode(sha256(convert_to($1,'UTF8')),'hex'),
                        terminal_at=clock_timestamp(),terminal_fence=claim_fence,
                        multipart_aborted_at=clock_timestamp(),updated_at=clock_timestamp()
                        WHERE reservation_id=$2 AND state='claimed'`,
                values: [input.evidenceRef, input.reservation.reservationId],
                readonly: false,
              });
              yield* updateSubmissionSnapshot(tx, { prior: input.submission, next });
            }),
          );
        }),
      ),

    finalizeSealed: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              yield* lock(
                tx,
                `video-finalize:${input.submission.operationId}:${input.idempotencyKey}`,
              );
              const prior = yield* commandReplay(tx, {
                actorAccountId: input.submission.actorAccountId,
                endpointTemplate: input.endpointTemplate,
                idempotencyKey: input.idempotencyKey,
                requestHash: input.requestHash,
              });
              if (prior.kind !== "none") return prior;
              const current = yield* findSubmission(tx, {
                clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
                values: [input.submission.submissionId, input.submission.operationId],
              });
              if (
                current === null ||
                current.state.phase !== "finalize" ||
                current.state.creationRevision !== input.expectedCreationRevision
              )
                throw new Error("video finalization rejected");
              const next = attachImmutableVideo(current.state, {
                videoRevision: 1,
                immutableRef: input.immutable.immutableRef,
                canonicalSha256: input.immutable.canonicalSha256,
                contentType: input.immutable.contentType,
                sizeBytes: input.immutable.sizeBytes,
              });
              yield* tx.execute({
                label: "video-publication.immutable-insert",
                text: `INSERT INTO media_immutable_objects
                  (immutable_ref,community_id,actor_user_id,reservation_id,submission_id,
                   operation_id,destination_ref,etag,object_version,size_bytes,content_type,canonical_sha256)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                  ON CONFLICT (immutable_ref) DO NOTHING`,
                values: [
                  input.immutable.immutableRef,
                  current.state.communityId,
                  current.state.actorAccountId,
                  current.state.reservationId,
                  current.state.submissionId,
                  current.state.operationId,
                  input.immutable.destinationRef,
                  input.immutable.etag,
                  input.immutable.objectVersion,
                  input.immutable.sizeBytes,
                  input.immutable.contentType,
                  input.immutable.canonicalSha256,
                ],
                readonly: false,
              });
              yield* tx.execute({
                label: "video-publication.revision-insert",
                text: `INSERT INTO media_video_revisions
                  (submission_id,community_id,actor_user_id,operation_id,video_revision,
                   immutable_ref,canonical_sha256,content_type,size_bytes)
                  VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
                values: [
                  current.state.submissionId,
                  current.state.communityId,
                  current.state.actorAccountId,
                  current.state.operationId,
                  input.immutable.immutableRef,
                  input.immutable.canonicalSha256,
                  input.immutable.contentType,
                  input.immutable.sizeBytes,
                ],
                readonly: false,
              });
              yield* tx.execute({
                label: "video-publication.analysis-outbox",
                text: `INSERT INTO media_video_analysis_outbox
                  (effect_identity,submission_id,operation_id,video_revision,creation_revision,
                   canonical_video_sha256)
                  VALUES ($1,$2,$3,1,1,$4) ON CONFLICT DO NOTHING`,
                values: [
                  `video-analysis:${current.state.operationId}:v1:c1`,
                  current.state.submissionId,
                  current.state.operationId,
                  input.immutable.canonicalSha256,
                ],
                readonly: false,
              });
              yield* updateSubmissionSnapshot(tx, {
                prior: current.state,
                next,
                extraSql:
                  ",current_immutable_ref=$10,response_snapshot_bytes=$11,response_snapshot_sha256=$12",
                extraValues: [
                  input.immutable.immutableRef,
                  input.responseBytes,
                  input.responseSha256,
                ],
              });
              yield* tx.execute({
                label: "video-publication.reservation-sealed",
                text: `UPDATE media_upload_reservations SET state='sealed',updated_at=clock_timestamp()
                        WHERE reservation_id=$1 AND state='claimed' AND multipart_completed_at IS NOT NULL`,
                values: [current.state.reservationId],
                readonly: false,
              });
              yield* storeCommand(tx, {
                state: current.state,
                actorAccountId: current.state.actorAccountId,
                endpointTemplate: input.endpointTemplate,
                idempotencyKey: input.idempotencyKey,
                requestHash: input.requestHash,
                responseBytes: input.responseBytes,
                responseSha256: input.responseSha256,
              });
              return { kind: "none" as const };
            }),
          );
        }),
      ),

    abandonExpectationMismatch: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const next: VideoSubmissionState = {
                ...input.submission,
                status: "abandoned",
                phase: null,
              };
              yield* tx.execute({
                label: "video-publication.expectation-mismatch",
                text: `UPDATE media_upload_reservations SET state='rejected',
                        terminal_reason='expectation_mismatch',terminal_evidence_ref=$1,
                        terminal_evidence_digest=encode(sha256(convert_to($1,'UTF8')),'hex'),
                        terminal_at=clock_timestamp(),terminal_fence=claim_fence,
                        updated_at=clock_timestamp() WHERE reservation_id=$2 AND state='claimed'`,
                values: [input.evidenceRef, input.submission.reservationId],
                readonly: false,
              });
              yield* updateSubmissionSnapshot(tx, {
                prior: input.submission,
                next,
                extraSql: ",response_snapshot_bytes=$10,response_snapshot_sha256=$11",
                extraValues: [input.responseBytes, input.responseSha256],
              });
              yield* storeCommand(tx, {
                state: input.submission,
                actorAccountId: input.submission.actorAccountId,
                endpointTemplate: input.endpointTemplate,
                idempotencyKey: input.idempotencyKey,
                requestHash: input.requestHash,
                responseBytes: input.responseBytes,
                responseSha256: input.responseSha256,
              });
              return { kind: "none" as const };
            }),
          );
        }),
      ),

    commitAnalysisDecision: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const current = yield* findSubmission(tx, {
                clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
                values: [input.submission.submissionId, input.submission.operationId],
              });
              if (
                current?.state.phase === "publish" &&
                current.state.analysis?.analysisRevision === input.analysis.analysisRevision &&
                current.state.decision?.acceptedAnalysisRevision ===
                  input.decision.acceptedAnalysisRevision
              )
                return current;
              if (
                current === null ||
                current.state.phase !== "analysis" ||
                current.state.video?.canonicalSha256 !== input.analysis.canonicalVideoSha256
              )
                throw new Error("video analysis fence rejected");
              yield* tx.execute({
                label: "video-publication.analysis-insert",
                text: `INSERT INTO media_video_analyses
                  (submission_id,community_id,actor_user_id,operation_id,video_revision,
                   analysis_revision,canonical_video_sha256,analysis_snapshot)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
                values: [
                  current.state.submissionId,
                  current.state.communityId,
                  current.state.actorAccountId,
                  current.state.operationId,
                  input.analysis.videoRevision,
                  input.analysis.analysisRevision,
                  input.analysis.canonicalVideoSha256,
                  JSON.stringify(input.analysis),
                ],
                readonly: false,
              });
              yield* tx.execute({
                label: "video-publication.decision-insert",
                text: `INSERT INTO media_video_publication_decisions
                  (submission_id,community_id,actor_user_id,operation_id,creation_revision,
                   video_revision,analysis_revision,outcome,effective_content_rating,
                   decision_snapshot,decided_at)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
                values: [
                  current.state.submissionId,
                  current.state.communityId,
                  current.state.actorAccountId,
                  current.state.operationId,
                  input.decision.creationRevision,
                  input.decision.videoRevision,
                  input.decision.acceptedAnalysisRevision,
                  input.decision.outcome.kind,
                  input.decision.effectiveContentRating,
                  JSON.stringify(input.decision),
                  input.decision.decidedAt,
                ],
                readonly: false,
              });
              const soundtrack = input.analysis.audio.soundtrack;
              for (const artifact of [
                {
                  artifactRef: soundtrack.extractedAudioRef,
                  artifactKind: "extracted_audio" as const,
                  canonicalSha256: soundtrack.extractedAudioSha256,
                },
                ...input.analysis.frames.extracted.map((frame) => ({
                  artifactRef: frame.artifactRef,
                  artifactKind: frame.role,
                  canonicalSha256: frame.sha256,
                })),
              ]) {
                yield* tx.execute({
                  label: "video-publication.analysis-derived-insert",
                  text: `INSERT INTO media_video_derived_artifacts
                    (artifact_ref,submission_id,video_revision,analysis_revision,artifact_kind,
                     canonical_sha256,retention_policy_revision)
                    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
                  values: [
                    artifact.artifactRef,
                    current.state.submissionId,
                    input.analysis.videoRevision,
                    input.analysis.analysisRevision,
                    artifact.artifactKind,
                    artifact.canonicalSha256,
                    VIDEO_DERIVED_ARTIFACT_RETENTION_POLICY_V1.policyRevision,
                  ],
                  readonly: false,
                });
              }
              if (input.decision.outcome.kind === "review") {
                const safety = input.decision.outcome.reasonCodes.filter((reason) =>
                  [
                    "media_review_required",
                    "caption_review_required",
                    "safety_adapter_unavailable",
                  ].includes(reason),
                );
                const soundtrack = input.decision.outcome.reasonCodes.filter(
                  (reason) => !safety.includes(reason),
                );
                for (const [kind, reasons] of [
                  ["safety", safety],
                  ["soundtrack", soundtrack],
                ] as const) {
                  if (reasons.length === 0) continue;
                  yield* tx.execute({
                    label: "video-publication.hold-insert",
                    text: `INSERT INTO media_video_review_holds
                      (submission_id,creation_revision,hold_kind,reason_codes)
                      VALUES ($1,$2,$3,$4::jsonb)`,
                    values: [
                      current.state.submissionId,
                      current.state.creationRevision,
                      kind,
                      JSON.stringify(reasons),
                    ],
                    readonly: false,
                  });
                }
              }
              yield* updateSubmissionSnapshot(tx, {
                prior: current.state,
                next: input.nextState,
                extraSql:
                  ",decision_revision=decision_revision+1,current_analysis_revision=$10,current_decision_revision=decision_revision+1,review_ref=$11,review_reason_code=$12,held_revision=$13",
                extraValues: [
                  input.analysis.analysisRevision,
                  input.nextState.status === "manual_review"
                    ? `video-review-${current.state.operationId}-r${current.state.creationRevision}`
                    : null,
                  input.nextState.status === "manual_review" ? "video_review" : null,
                  input.nextState.status === "manual_review"
                    ? current.state.creationRevision
                    : null,
                ],
              });
              return {
                ...current,
                eventSequence: current.eventSequence + 1,
                state: input.nextState,
                updatedAt: new Date().toISOString(),
              };
            }),
          );
        }),
      ),

    enterAttemptReconciliation: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const current = yield* findSubmission(tx, {
                clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
                values: [input.submission.submissionId, input.submission.operationId],
              });
              if (
                current === null ||
                current.state.video === null ||
                current.eventSequence !== input.observedEventSequence ||
                current.state.creationRevision !== input.submission.creationRevision ||
                current.state.videoRevision !== input.submission.videoRevision ||
                current.state.analysisRevision !== input.submission.analysisRevision ||
                !(
                  (current.state.status === "processing" && current.state.phase === "analysis") ||
                  (current.state.status === "processing_failed" &&
                    current.state.reconciliationRequired)
                )
              )
                throw new Error("video reconciliation fence rejected");
              const attempt = yield* tx.execute<Row>({
                label: "video-publication.reconciliation-attempt",
                text: `UPDATE media_video_transform_attempts AS attempt SET
                  reconciliation_state=CASE WHEN reconciliation_state='required' THEN 'required' ELSE $1 END,
                  first_uncertainty_at=COALESCE(first_uncertainty_at,clock_timestamp()),
                  last_observation=$2::jsonb,reconciliation_evidence_ref=$3,updated_at=clock_timestamp()
                  WHERE request_id=$4 AND submission_id=$5 AND operation_id=$6
                    AND video_revision=$7 AND creation_revision=$8 AND analysis_revision=$9
                    AND provider_job_phase IN ('submitting','started')
                    AND reconciliation_state <> 'resolved' AND canonical_video_sha256=$10
                    AND NOT EXISTS (SELECT 1 FROM media_video_stage_facts fact
                      WHERE fact.submission_id=attempt.submission_id
                        AND fact.video_revision=attempt.video_revision
                        AND fact.creation_revision=attempt.creation_revision
                        AND fact.stage=attempt.capability)
                  RETURNING capability`,
                values: [
                  input.state,
                  JSON.stringify(input.observation),
                  `video-submission-unconfirmed:${input.requestId}`,
                  input.requestId,
                  current.state.submissionId,
                  current.state.operationId,
                  current.state.videoRevision,
                  current.state.creationRevision,
                  current.state.analysisRevision + 1,
                  current.state.video.canonicalSha256,
                ],
                readonly: false,
              });
              if (attempt.rows.length !== 1)
                throw new Error("video reconciliation attempt rejected");
              // Polling uncertainty is attempt-local. Never downgrade an existing
              // required reconciliation or rewrite its submission failure.
              if (input.state === "pending") return current;
              const next: VideoSubmissionState = {
                ...current.state,
                status: "processing_failed",
                phase: null,
                reconciliationRequired: true,
                failureCode:
                  attempt.rows[0]?.capability === "probe" ? "probe_failed" : "transform_failed",
              };
              const result = yield* updateSubmissionSnapshot(tx, {
                prior: current.state,
                next,
                observedEventSequence: input.observedEventSequence,
                extraSql:
                  ",failure_evidence_ref=$10,failure_retry_count=$11,retryable=false,last_safe_phase='analysis'",
                extraValues: [
                  `video-submission-unconfirmed:${input.requestId}`,
                  current.state.retryCount,
                ],
              });
              if (result.rows.length !== 1) throw new Error("video reconciliation fence rejected");
              return {
                ...current,
                state: next,
                eventSequence: current.eventSequence + 1,
                updatedAt: new Date().toISOString(),
              };
            }),
          );
        }),
      ),

    reconcileTerminalWorkflow: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const current = yield* findSubmission(tx, {
                clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
                values: [input.submission.submissionId, input.submission.operationId],
              });
              if (
                current === null ||
                current.eventSequence !== input.observedEventSequence ||
                current.state.creationRevision !== input.submission.creationRevision ||
                current.state.videoRevision !== input.submission.videoRevision ||
                current.state.analysisRevision !== input.submission.analysisRevision ||
                current.state.status !== "processing" ||
                current.state.phase !== "analysis" ||
                current.state.decision !== null
              )
                throw new Error("video terminal reconciliation fence rejected");
              const attempts = yield* tx.execute<Row>({
                label: "video-publication.terminal-attempts",
                readonly: true,
                text: `SELECT attempt.request_id,attempt.capability,attempt.provider_job_phase,
            attempt.reconciliation_state,fact.stage AS accepted_stage
            FROM media_video_transform_attempts attempt LEFT JOIN media_video_stage_facts fact
              ON fact.submission_id=attempt.submission_id AND fact.video_revision=attempt.video_revision
                AND fact.creation_revision=attempt.creation_revision AND fact.stage=attempt.capability
            WHERE attempt.submission_id=$1 AND attempt.video_revision=$2 AND attempt.creation_revision=$3`,
                values: [
                  current.state.submissionId,
                  current.state.videoRevision,
                  current.state.creationRevision,
                ],
              });
              const uncertain = attempts.rows.filter(
                (row) =>
                  row.accepted_stage === null &&
                  row.reconciliation_state !== "resolved" &&
                  ["submitting", "started"].includes(String(row.provider_job_phase)),
              );
              if (attempts.rows.length > 0 && uncertain.length === 0) {
                const facts = yield* tx.execute({
                  label: "video-publication.terminal-facts",
                  readonly: true,
                  text: "SELECT stage FROM media_video_stage_facts WHERE submission_id=$1 AND video_revision=$2 AND creation_revision=$3",
                  values: [
                    current.state.submissionId,
                    current.state.videoRevision,
                    current.state.creationRevision,
                  ],
                });
                return facts.rows.length === 5 ? ("accepted" as const) : ("allocated" as const);
              }
              for (const attempt of uncertain) {
                yield* tx.execute({
                  label: "video-publication.terminal-reconciliation",
                  readonly: false,
                  text: `UPDATE media_video_transform_attempts SET reconciliation_state='required',
              first_uncertainty_at=COALESCE(first_uncertainty_at,clock_timestamp()),
              last_observation=jsonb_build_object('status','workflow_terminal','observedAt',clock_timestamp()),
              reconciliation_evidence_ref=$2,updated_at=clock_timestamp() WHERE request_id=$1`,
                  values: [attempt.request_id, input.evidenceRef],
                });
              }
              const next: VideoSubmissionState = {
                ...current.state,
                status: "processing_failed",
                phase: null,
                reconciliationRequired: uncertain.length > 0,
                failureCode:
                  uncertain.length === 1 && uncertain[0]?.capability === "probe"
                    ? "probe_failed"
                    : "transform_failed",
              };
              const updated = yield* updateSubmissionSnapshot(tx, {
                prior: current.state,
                next,
                observedEventSequence: input.observedEventSequence,
                extraSql:
                  ",failure_evidence_ref=$10,failure_retry_count=$11,retryable=$12,last_safe_phase='analysis'",
                extraValues: [
                  input.evidenceRef,
                  current.state.retryCount,
                  !next.reconciliationRequired && current.state.retryCount < 3,
                ],
              });
              if (updated.rows.length !== 1)
                throw new Error("video terminal reconciliation fence rejected");
              return uncertain.length > 0
                ? ("reconciliation_required" as const)
                : ("failed" as const);
            }),
          );
        }),
      ),

    resolveAttemptReconciliation: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const current = yield* findSubmission(tx, {
                clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
                values: [input.submission.submissionId, input.submission.operationId],
              });
              if (
                current === null ||
                current.state.video === null ||
                current.eventSequence !== input.observedEventSequence ||
                current.state.creationRevision !== input.submission.creationRevision ||
                current.state.videoRevision !== input.submission.videoRevision ||
                current.state.analysisRevision !== input.submission.analysisRevision ||
                !(
                  (current.state.status === "processing" && current.state.phase === "analysis") ||
                  (current.state.status === "processing_failed" &&
                    current.state.reconciliationRequired)
                )
              )
                throw new Error("video reconciliation resolution fence rejected");
              const observation = input.observation;
              const evidenceRef =
                observation.status === "completed"
                  ? `video-submission-confirmed:${input.requestId}`
                  : observation.evidenceRef;
              if (evidenceRef.trim() === "" || !Number.isFinite(Date.parse(observation.observedAt)))
                throw new Error("invalid video reconciliation observation");
              const attempt = yield* tx.execute<Row>({
                label: "video-publication.reconciliation-resolve",
                text: `UPDATE media_video_transform_attempts SET
                  reconciliation_state=$1,last_observation=$2::jsonb,
                  reconciliation_evidence_ref=$3,updated_at=clock_timestamp()
                  WHERE request_id=$4 AND submission_id=$5 AND operation_id=$6
                    AND video_revision=$7 AND creation_revision=$8 AND analysis_revision=$9
                    AND canonical_video_sha256=$10
                    AND reconciliation_state IN ('pending','required')
                    AND provider_job_phase IN ('submitting','started') RETURNING capability`,
                values: [
                  observation.status === "workflow_terminal" ? "required" : "resolved",
                  JSON.stringify({
                    status: observation.status,
                    observedAt: observation.observedAt,
                  }),
                  evidenceRef,
                  input.requestId,
                  current.state.submissionId,
                  current.state.operationId,
                  current.state.videoRevision,
                  current.state.creationRevision,
                  current.state.analysisRevision + 1,
                  current.state.video.canonicalSha256,
                ],
                readonly: false,
              });
              if (attempt.rows.length !== 1)
                throw new Error("video reconciliation resolution attempt rejected");
              if (observation.status === "completed") {
                const fact = observation.fact;
                if (
                  fact.stage !== attempt.rows[0]?.capability ||
                  fact.adapterRevision.trim() === ""
                )
                  throw new Error("video reconciliation fact binding rejected");
                yield* insertVideoStageFact(tx, current.state, fact);
              }
              // Submission lock serializes reconciliation across capabilities. A later
              // successful resolution must not erase a previously confirmed failure.
              const remaining = yield* tx.execute<Row>({
                label: "video-publication.reconciliation-remaining",
                text: `SELECT EXISTS (SELECT 1 FROM media_video_transform_attempts
                    WHERE submission_id=$1 AND video_revision=$2 AND creation_revision=$3
                      AND reconciliation_state IN ('pending','required')) AS unresolved,
                  (SELECT capability FROM media_video_transform_attempts
                    WHERE submission_id=$1 AND video_revision=$2 AND creation_revision=$3
                      AND reconciliation_state='resolved' AND last_observation->>'status'='failed'
                    ORDER BY capability LIMIT 1) AS failed_capability,
                  (SELECT reconciliation_evidence_ref FROM media_video_transform_attempts
                    WHERE submission_id=$1 AND video_revision=$2 AND creation_revision=$3
                      AND reconciliation_state='resolved' AND last_observation->>'status'='failed'
                    ORDER BY capability LIMIT 1) AS failed_evidence`,
                values: [
                  current.state.submissionId,
                  current.state.videoRevision,
                  current.state.creationRevision,
                ],
                readonly: true,
              });
              const unresolved = remaining.rows[0]?.unresolved === true;
              const failedCapability = remaining.rows[0]?.failed_capability;
              const failed = failedCapability !== null && failedCapability !== undefined;
              const next: VideoSubmissionState = {
                ...current.state,
                status: unresolved || failed ? "processing_failed" : "processing",
                phase: unresolved || failed ? null : "analysis",
                reconciliationRequired: unresolved,
                failureCode: unresolved
                  ? (current.state.failureCode ?? "transform_failed")
                  : failed
                    ? failedCapability === "probe"
                      ? "probe_failed"
                      : "transform_failed"
                    : null,
              };
              const result = yield* updateSubmissionSnapshot(tx, {
                prior: current.state,
                next,
                observedEventSequence: input.observedEventSequence,
                extraSql:
                  ",failure_evidence_ref=$10,failure_retry_count=$11,retryable=$12,last_safe_phase='analysis'",
                extraValues: [
                  unresolved ? evidenceRef : failed ? remaining.rows[0]?.failed_evidence : null,
                  current.state.retryCount,
                  !unresolved && current.state.retryCount < 3,
                ],
              });
              if (result.rows.length !== 1)
                throw new Error("video reconciliation resolution fence rejected");
              return {
                ...current,
                state: next,
                eventSequence: current.eventSequence + 1,
                updatedAt: new Date().toISOString(),
              };
            }),
          );
        }),
      ),

    recordProcessingFailure: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const current = yield* findSubmission(tx, {
                clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
                values: [input.submission.submissionId, input.submission.operationId],
              });
              if (
                current === null ||
                current.state.status !== "processing" ||
                current.eventSequence !== input.observedEventSequence ||
                current.state.creationRevision !== input.submission.creationRevision ||
                current.state.videoRevision !== input.submission.videoRevision ||
                current.state.analysisRevision !== input.submission.analysisRevision ||
                !["analysis", "publish"].includes(current.state.phase ?? "")
              ) {
                throw new Error("video processing failure fence rejected");
              }
              const next: VideoSubmissionState = {
                ...current.state,
                status: "processing_failed",
                phase: null,
                failureCode: input.failureCode,
              };
              const updated = yield* updateSubmissionSnapshot(tx, {
                prior: current.state,
                next,
                observedEventSequence: input.observedEventSequence,
                extraSql:
                  ",failure_evidence_ref=$10,failure_retry_count=$11,retryable=$12,last_safe_phase=$13",
                extraValues: [
                  input.evidenceRef,
                  current.state.retryCount,
                  current.state.retryCount < 3,
                  current.state.phase,
                ],
              });
              if (updated.rows.length !== 1)
                throw new Error("video processing failure fence rejected");
              return {
                ...current,
                eventSequence: current.eventSequence + 1,
                state: next,
                updatedAt: new Date().toISOString(),
              };
            }),
          );
        }),
      ),

    publish: (input) => run(publishTransaction(input)),

    retryPoster: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              yield* lock(
                tx,
                `video-poster-retry:${input.submission.operationId}:${input.idempotencyKey}`,
              );
              const prior = yield* commandReplay(tx, {
                actorAccountId: input.submission.actorAccountId,
                endpointTemplate: input.endpointTemplate,
                idempotencyKey: input.idempotencyKey,
                requestHash: input.requestHash,
              });
              if (prior.kind !== "none") return prior;
              const current = yield* findSubmission(tx, {
                clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
                values: [input.submission.submissionId, input.submission.operationId],
              });
              if (
                current === null ||
                current.state.status !== "processing_failed" ||
                current.state.video === null ||
                current.state.reconciliationRequired ||
                current.state.retryCount >= 3 ||
                !["poster_undecodable", "poster_timestamp_out_of_range"].includes(
                  current.state.failureCode ?? "",
                )
              )
                throw new Error("poster retry rejected");
              const next: VideoSubmissionState = {
                ...current.state,
                creationRevision: current.state.creationRevision + 1,
                retryCount: current.state.retryCount + 1,
                status: "processing",
                phase: "analysis",
                failureCode: null,
                posterTimestampMs: input.posterTimestampMs,
                decision: null,
                reviewReasons: [],
                approvedHolds: [],
              };
              yield* updateSubmissionSnapshot(tx, {
                prior: current.state,
                next,
                extraSql:
                  ",poster_timestamp_ms=$10,decision_revision=0,current_decision_revision=NULL",
                extraValues: [input.posterTimestampMs],
              });
              yield* tx.execute({
                label: "video-publication.poster-retry-outbox",
                text: `INSERT INTO media_video_analysis_outbox
                  (effect_identity,submission_id,operation_id,video_revision,creation_revision,
                   canonical_video_sha256)
                  VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
                values: [
                  `video-analysis:${current.state.operationId}:v${current.state.videoRevision}:c${next.creationRevision}`,
                  current.state.submissionId,
                  current.state.operationId,
                  current.state.videoRevision,
                  next.creationRevision,
                  current.state.video.canonicalSha256,
                ],
                readonly: false,
              });
              yield* storeCommand(tx, {
                state: current.state,
                actorAccountId: current.state.actorAccountId,
                endpointTemplate: input.endpointTemplate,
                idempotencyKey: input.idempotencyKey,
                requestHash: input.requestHash,
                responseBytes: input.responseBytes,
                responseSha256: input.responseSha256,
              });
              return { kind: "none" as const };
            }),
          );
        }),
      ),

    retryTechnical: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              yield* lock(
                tx,
                `video-technical-retry:${input.submission.operationId}:${input.idempotencyKey}`,
              );
              const prior = yield* commandReplay(tx, {
                actorAccountId: input.submission.actorAccountId,
                endpointTemplate: input.endpointTemplate,
                idempotencyKey: input.idempotencyKey,
                requestHash: input.requestHash,
              });
              if (prior.kind !== "none") return prior;
              const current = yield* findSubmission(tx, {
                clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
                values: [input.submission.submissionId, input.submission.operationId],
              });
              if (
                current === null ||
                current.state.status !== "processing_failed" ||
                current.state.reconciliationRequired ||
                current.state.retryCount >= 3 ||
                current.state.video === null ||
                current.state.failureCode === null ||
                [
                  "poster_undecodable",
                  "poster_timestamp_out_of_range",
                  "upload_seal_conflict",
                ].includes(current.state.failureCode)
              ) {
                throw new Error("video technical retry rejected");
              }
              const publicationOnly = current.state.failureCode === "publication_failed";
              const next: VideoSubmissionState = {
                ...current.state,
                creationRevision: current.state.creationRevision + 1,
                retryCount: current.state.retryCount + 1,
                status: "processing",
                phase: publicationOnly ? "publish" : "analysis",
                failureCode: null,
                ...(publicationOnly
                  ? {}
                  : { decision: null, reviewReasons: [], approvedHolds: [] }),
              };
              yield* updateSubmissionSnapshot(tx, {
                prior: current.state,
                next,
                extraSql:
                  ",failure_evidence_ref=NULL,failure_retry_count=NULL,retryable=NULL,last_safe_phase=NULL",
              });
              if (!publicationOnly) {
                yield* tx.execute({
                  label: "video-publication.technical-retry-outbox",
                  text: `INSERT INTO media_video_analysis_outbox
                    (effect_identity,submission_id,operation_id,video_revision,creation_revision,
                     canonical_video_sha256)
                    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
                  values: [
                    `video-analysis:${current.state.operationId}:v${current.state.videoRevision}:c${next.creationRevision}`,
                    current.state.submissionId,
                    current.state.operationId,
                    current.state.videoRevision,
                    next.creationRevision,
                    current.state.video.canonicalSha256,
                  ],
                  readonly: false,
                });
              }
              yield* storeCommand(tx, {
                state: current.state,
                actorAccountId: current.state.actorAccountId,
                endpointTemplate: input.endpointTemplate,
                idempotencyKey: input.idempotencyKey,
                requestHash: input.requestHash,
                responseBytes: input.responseBytes,
                responseSha256: input.responseSha256,
              });
              return { kind: "none" as const };
            }),
          );
        }),
      ),

    cancel: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const current = yield* findSubmission(tx, {
                clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
                values: [input.submission.submissionId, input.submission.operationId],
              });
              if (
                current === null ||
                current.state.video !== null ||
                current.state.status !== "processing"
              )
                throw new Error("video cancel rejected");
              const next: VideoSubmissionState = {
                ...current.state,
                status: "abandoned",
                phase: null,
              };
              yield* tx.execute({
                label: "video-publication.cancel-reservation",
                text: `UPDATE media_upload_reservations SET state='rejected',
                        terminal_reason='source_precondition_failed',terminal_evidence_ref=$1,
                        terminal_evidence_digest=encode(sha256(convert_to($1,'UTF8')),'hex'),
                        terminal_at=clock_timestamp(),terminal_fence=claim_fence,
                        multipart_aborted_at=clock_timestamp(),updated_at=clock_timestamp()
                        WHERE reservation_id=$2 AND state='claimed'`,
                values: [
                  `video-author-cancel:${current.state.operationId}`,
                  current.state.reservationId,
                ],
                readonly: false,
              });
              yield* updateSubmissionSnapshot(tx, { prior: current.state, next });
              return {
                ...current,
                eventSequence: current.eventSequence + 1,
                state: next,
                updatedAt: new Date().toISOString(),
              };
            }),
          );
        }),
      ),

    moderate: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              yield* lock(tx, `video-moderation:${input.actor.userId}:${input.idempotencyKey}`);
              const prior = yield* commandReplay(tx, {
                actorAccountId: input.actor.userId,
                endpointTemplate: input.endpointTemplate,
                idempotencyKey: input.idempotencyKey,
                requestHash: input.requestHash,
              });
              if (prior.kind !== "none") return prior;
              const current = yield* findSubmission(tx, {
                clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
                values: [input.submission.submissionId, input.submission.operationId],
              });
              if (
                current === null ||
                current.state.status !== "manual_review" ||
                current.state.creationRevision !== input.expectedCreationRevision
              )
                throw new Error("video moderation fence rejected");
              const authorized = yield* tx.execute({
                label: "video-publication.moderator-recheck",
                text: "SELECT 1 WHERE has_community_moderation_capability_v1($1,$2,'moderation.act')",
                values: [input.actor.userId, current.state.communityId],
                readonly: true,
              });
              if (authorized.rowCount !== 1) throw new Error("video moderator authority rejected");
              const actionId = `video-moderation:${input.actor.userId}:${input.idempotencyKey}`;
              if (input.action.kind === "block") {
                yield* tx.execute({
                  label: "video-publication.holds-block",
                  text: `UPDATE media_video_review_holds SET status='blocked',action_id=$1,
                          evidence_ref=$2,updated_at=clock_timestamp()
                          WHERE submission_id=$3 AND creation_revision=$4 AND status='open'`,
                  values: [
                    actionId,
                    input.action.evidenceRef,
                    current.state.submissionId,
                    current.state.creationRevision,
                  ],
                  readonly: false,
                });
                const next: VideoSubmissionState = {
                  ...current.state,
                  status: "blocked",
                  reviewReasons: [],
                  decision:
                    current.state.decision === null
                      ? null
                      : {
                          ...current.state.decision,
                          outcome: {
                            kind: "block",
                            reasonCode: input.action.reasonCode,
                            publicReason: input.action.reasonCode,
                          },
                        },
                };
                yield* updateSubmissionSnapshot(tx, { prior: current.state, next });
                yield* storeCommand(tx, {
                  state: current.state,
                  actorAccountId: input.actor.userId,
                  endpointTemplate: input.endpointTemplate,
                  idempotencyKey: input.idempotencyKey,
                  requestHash: input.requestHash,
                  responseBytes: input.responseBytes,
                  responseSha256: input.responseSha256,
                });
                return { kind: "none" as const };
              }
              const updated = yield* tx.execute({
                label: "video-publication.hold-approve",
                text: `UPDATE media_video_review_holds SET status='approved',action_id=$1,
                        evidence_ref=$2,updated_at=clock_timestamp()
                        WHERE submission_id=$3 AND creation_revision=$4 AND hold_kind=$5
                          AND status='open'`,
                values: [
                  actionId,
                  input.action.evidenceRef,
                  current.state.submissionId,
                  current.state.creationRevision,
                  input.action.hold,
                ],
                readonly: false,
              });
              if (updated.rowCount !== 1) throw new Error("video moderation hold rejected");
              const open = yield* tx.execute<Row>({
                label: "video-publication.holds-open",
                text: `SELECT count(*)::int AS count FROM media_video_review_holds
                        WHERE submission_id=$1 AND creation_revision=$2 AND status='open'`,
                values: [current.state.submissionId, current.state.creationRevision],
                readonly: true,
              });
              const allApproved = integer(open.rows[0] ?? {}, "count") === 0;
              const next: VideoSubmissionState = {
                ...current.state,
                approvedHolds: [...current.state.approvedHolds, input.action.hold],
                ...(allApproved
                  ? {
                      status: "processing" as const,
                      phase: "publish" as const,
                      reviewReasons: [],
                      decision:
                        current.state.decision === null
                          ? null
                          : { ...current.state.decision, outcome: { kind: "publish" as const } },
                    }
                  : {}),
              };
              yield* updateSubmissionSnapshot(tx, {
                prior: current.state,
                next,
                extraSql: allApproved
                  ? ",review_ref=NULL,review_reason_code=NULL,held_revision=NULL"
                  : "",
              });
              yield* storeCommand(tx, {
                state: current.state,
                actorAccountId: input.actor.userId,
                endpointTemplate: input.endpointTemplate,
                idempotencyKey: input.idempotencyKey,
                requestHash: input.requestHash,
                responseBytes: input.responseBytes,
                responseSha256: input.responseSha256,
              });
              return { kind: "none" as const };
            }),
          );
        }),
      ),
  };
}

function publishTransaction(input: VideoPublishBundle) {
  return Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((tx) =>
      Effect.gen(function* () {
        const current = yield* findSubmission(tx, {
          clause: "s.submission_id=$1 AND s.operation_id=$2 FOR UPDATE",
          values: [input.state.submissionId, input.state.operationId],
        });
        if (current?.state.status === "published" && current.state.postId === input.state.postId)
          return current;
        if (
          current === null ||
          current.state.phase !== "publish" ||
          current.state.video === null ||
          current.state.analysis === null ||
          current.state.decision?.outcome.kind !== "publish"
        )
          throw new Error("video publication fence rejected");
        const active = yield* tx.execute({
          label: "video-publication.membership-recheck",
          text: "SELECT 1 WHERE active_community_effect($1,$2)",
          values: [current.state.communityId, current.state.actorAccountId],
          readonly: true,
        });
        if (active.rowCount !== 1) throw new Error("video publication membership rejected");
        const postId = input.state.postId;
        if (postId === null) throw new Error("video publication post missing");
        yield* tx.execute({
          label: "video-publication.post-insert",
          text: `INSERT INTO posts
            (community_id,post_id,author_user_id,author_persona_id,post_type,status,
             visibility,title,body,created_at,updated_at,idempotency_key,
             author_declared_rating,content_rating)
            VALUES ($1,$2,$3,$4,'video','published','public',NULL,$5,
                    clock_timestamp(),clock_timestamp(),$6,$7,$8)
            ON CONFLICT (community_id,post_id) DO NOTHING`,
          values: [
            current.state.communityId,
            postId,
            current.state.actorAccountId,
            current.state.authorPersonaId,
            current.state.caption,
            `video-publication:${current.state.operationId}`,
            current.state.authorDeclaredRating,
            input.decision.effectiveContentRating,
          ],
          readonly: false,
        });
        yield* tx.execute({
          label: "video-publication.rights-insert",
          text: `INSERT INTO media_video_rights
            (submission_id,rights_basis,access_mode,royalty_allocations,offered_license)
            VALUES ($1,'original','public',$2::jsonb,NULL) ON CONFLICT DO NOTHING`,
          values: [
            current.state.submissionId,
            JSON.stringify([{ recipient_id: current.state.authorPersonaId, share_bps: 10_000 }]),
          ],
          readonly: false,
        });
        for (const artifact of input.derivedArtifacts) {
          yield* tx.execute({
            label: "video-publication.derived-insert",
            text: `INSERT INTO media_video_derived_artifacts
              (artifact_ref,submission_id,video_revision,analysis_revision,artifact_kind,
               canonical_sha256,retention_policy_revision)
              VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            values: [
              artifact.artifactRef,
              current.state.submissionId,
              current.state.videoRevision,
              current.state.analysisRevision,
              artifact.artifactKind,
              artifact.canonicalSha256,
              input.originalSound.retentionPolicyRevision,
            ],
            readonly: false,
          });
        }
        yield* tx.execute({
          label: "video-publication.original-sound-insert",
          text: `INSERT INTO media_video_original_sounds
            (original_sound_id,submission_id,origin_video_post_id,origin_video_revision,
             extracted_audio_ref,extracted_audio_sha256,extraction_policy_revision,
             retention_policy_revision)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          values: [
            input.originalSound.originalSoundId,
            current.state.submissionId,
            postId,
            input.originalSound.originVideoRevision,
            input.originalSound.extractedAudioRef,
            input.originalSound.extractedAudioSha256,
            input.originalSound.extractionPolicyRevision,
            input.originalSound.retentionPolicyRevision,
          ],
          readonly: false,
        });
        yield* tx.execute({
          label: "video-publication.projection-insert",
          text: `INSERT INTO media_publication_projections
            (submission_id,community_id,actor_user_id,operation_id,post_id,
             creation_revision,audio_revision,analysis_revision,decision_revision,
             canonical_audio_sha256,title,audio_asset_ref,language_status,
             lyrics_explicitness,media_kind,video_revision,caption,video_asset_ref,
             poster_artifact_ref,original_sound_id,canonical_video_sha256)
            VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,NULL,NULL,NULL,'unavailable','not_applicable',
                    'video',$9,$10,$11,$12,$13,$14)
            ON CONFLICT (submission_id) DO NOTHING`,
          values: [
            current.state.submissionId,
            current.state.communityId,
            current.state.actorAccountId,
            current.state.operationId,
            postId,
            current.state.creationRevision,
            current.state.analysisRevision,
            current.state.creationRevision,
            current.state.videoRevision,
            current.state.caption,
            current.state.video.immutableRef,
            input.poster.artifactRef,
            input.originalSound.originalSoundId,
            current.state.video.canonicalSha256,
          ],
          readonly: false,
        });
        const registrationOperationId = `data-registration:1315:${postId}:1`;
        const workflowInstanceId = `data-registration-workflow:${registrationOperationId}:r1`;
        yield* tx.execute({
          label: "video-publication.data-operation-insert",
          text: `INSERT INTO data_registration_operations
            (registration_operation_id,community_id,actor_user_id,submission_id,
             media_operation_id,post_id,asset_id,chain_id,registration_revision,
             publication_creation_revision,publication_audio_revision,
             publication_analysis_revision,publication_decision_revision,
             canonical_audio_sha256,workflow_revision,workflow_instance_id,
             media_kind,rights_basis)
            VALUES ($1,$2,$3,$4,$5,$6,$6,1315,1,$7,$8,$9,$10,$11,1,$12,
                    'video','original') ON CONFLICT DO NOTHING`,
          values: [
            registrationOperationId,
            current.state.communityId,
            current.state.actorAccountId,
            current.state.submissionId,
            current.state.operationId,
            postId,
            current.state.creationRevision,
            current.state.videoRevision,
            current.state.analysisRevision,
            current.state.creationRevision,
            current.state.video.canonicalSha256,
            workflowInstanceId,
          ],
          readonly: false,
        });
        yield* tx.execute({
          label: "video-publication.data-outbox-insert",
          text: `INSERT INTO data_registration_outbox
            (outbox_id,registration_operation_id,workflow_revision,workflow_instance_id,
             event_type,effect_identity,payload)
            VALUES ($1,$2,1,$3,'registration_launch',$4,$5::jsonb)
            ON CONFLICT DO NOTHING`,
          values: [
            `${registrationOperationId}:outbox:r1`,
            registrationOperationId,
            workflowInstanceId,
            `data-registration:${registrationOperationId}:r1:launch`,
            JSON.stringify({
              operation_id: registrationOperationId,
              outbox_id: `${registrationOperationId}:outbox:r1`,
            }),
          ],
          readonly: false,
        });
        for (const kind of ["stream", "thumbnail"] as const) {
          yield* tx.execute({
            label: "video-publication.enrichment-outbox-insert",
            text: `INSERT INTO media_video_enrichment_outbox
              (effect_identity,submission_id,operation_id,post_id,enrichment_kind,payload)
              VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
            values: [
              `video-enrichment:${current.state.operationId}:${kind}`,
              current.state.submissionId,
              current.state.operationId,
              postId,
              kind,
              JSON.stringify({
                operation_id: current.state.operationId,
                submission_id: current.state.submissionId,
                post_id: postId,
                video_revision: current.state.videoRevision,
                canonical_video_sha256: current.state.video.canonicalSha256,
                source_ref: current.state.video.immutableRef,
                ...(kind === "thumbnail" ? { poster_ref: input.poster.artifactRef } : {}),
              }),
            ],
            readonly: false,
          });
        }
        yield* tx.execute({
          label: "video-publication.stream-ledger-insert",
          text: `INSERT INTO media_video_stream_ingests (operation_id)
                 VALUES ($1) ON CONFLICT DO NOTHING`,
          values: [current.state.operationId],
          readonly: false,
        });
        yield* updateSubmissionSnapshot(tx, { prior: current.state, next: input.state });
        return {
          ...current,
          eventSequence: current.eventSequence + 1,
          state: input.state,
          updatedAt: new Date().toISOString(),
        };
      }),
    );
  });
}
