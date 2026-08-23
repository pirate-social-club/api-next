import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Data, Effect } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Bytes = Uint8Array;
const HASH = /^[0-9a-f]{64}$/u;
const ID = /^\S+$/u;
const RESERVATION_ENDPOINT = "/communities/:communityId/media-upload-reservations";
const SUBMISSION_ENDPOINT = "/communities/:communityId/media-post-submissions";

export type MediaSubmissionRepositoryOperation =
  | "reserve"
  | "create"
  | "replay"
  | "get"
  | "transition"
  | "finalize"
  | "attempt";
export type MediaSubmissionRepositoryReason =
  | "invalid-input"
  | "not-found"
  | "membership-required"
  | "idempotency-conflict"
  | "stale-revision"
  | "reservation-conflict"
  | "immutable-object-conflict"
  | "constraint"
  | "invalid-row";

export class MediaSubmissionRepositoryError extends Data.TaggedError(
  "MediaSubmissionRepositoryError",
)<{
  readonly operation: MediaSubmissionRepositoryOperation;
  readonly reason: MediaSubmissionRepositoryReason;
  readonly submissionId?: string;
  readonly reservationId?: string;
}> {}

export type MediaSubmissionRepositoryFailure = MediaSubmissionRepositoryError | ControlPlaneError;

export type ReplayOutcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "replay";
      readonly submissionId: string;
      readonly operationId: string;
      readonly bytes: Uint8Array;
      readonly sha256: string;
    }
  | { readonly kind: "conflict"; readonly submissionId: string };

export type ReservationInput = Readonly<{
  readonly communityId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly expectedContentType: string;
  readonly expectedSizeBytes: number;
  readonly expectedSha256?: string;
  readonly uploadUrl: string;
  readonly uploadHeaders?: readonly { readonly name: string; readonly value: string }[];
  readonly expiresAt: string;
  readonly responseBytes: Bytes;
  readonly responseSha256: string;
  readonly reservationId?: string;
}>;

export type SongAuthorInput = Readonly<{
  readonly version?: "song-author-input-v1";
  readonly title: string;
  readonly lyrics: string | null;
  readonly audio_reservation_id: string;
  readonly rights_declaration:
    | Readonly<{ readonly kind: "original"; readonly upstream_asset_id?: never }>
    | Readonly<{ readonly kind: "derivative"; readonly upstream_asset_id: string }>;
  readonly license_preset: "non-commercial" | "commercial-use" | "commercial-remix";
  readonly commercial_rev_share_bps?: number;
  readonly royalty_allocations: readonly {
    readonly recipient_id: string;
    readonly share_bps: number;
  }[];
  readonly access_mode: "public";
}>;

export type SubmissionInput = Readonly<{
  readonly communityId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly submissionId?: string;
  readonly operationId?: string;
  readonly authorInput: SongAuthorInput;
  readonly responseBytes: Bytes;
  readonly responseSha256: string;
}>;

export type CommandReplayInput = Readonly<{
  readonly actorUserId: string;
  readonly endpointTemplate: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}>;

export type TransitionInput = Readonly<{
  readonly submissionId: string;
  readonly actorUserId: string;
  readonly endpointTemplate: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly expectedRevision: number;
  readonly nextCreationRevision?: number;
  readonly responseBytes: Bytes;
  readonly responseSha256: string;
  readonly status:
    | "processing"
    | "action_required"
    | "manual_review"
    | "published"
    | "blocked"
    | "processing_failed"
    | "abandoned";
  readonly phase:
    | "reserve"
    | "awaiting_upload"
    | "finalize"
    | "analysis"
    | "decision"
    | "publish"
    | null;
  readonly reservationId?: string;
  readonly immutableRef?: string;
  readonly reasonCode?: string;
  readonly retryable?: boolean | null;
  readonly retryCount?: number;
  readonly actionExpiresAt?: string | null;
  readonly referenceRequestRef?: string | null;
  readonly reviewRef?: string | null;
  readonly heldRevision?: number | null;
  readonly postId?: string | null;
  readonly lastSafePhase?: string | null;
  readonly outbox?: OutboxWrite;
}>;

export type ImmutableObjectInput = Readonly<{
  readonly immutableRef: string;
  readonly destinationRef: string;
  readonly etag: string;
  readonly objectVersion: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly canonicalSha256?: string;
}>;

export type OutboxWrite = Readonly<{
  readonly outboxEventId: string;
  readonly workflowRevision: number;
  readonly workflowInstanceId: string;
  readonly eventType: "analysis_launch" | "publication" | "reference_wakeup" | "retry_wakeup";
  readonly effectIdentity: string;
  readonly payload: Readonly<Record<string, unknown>>;
}>;

export type FinalizeInput = TransitionInput &
  Readonly<{
    readonly reservationId: string;
    readonly immutableObject: ImmutableObjectInput;
  }>;

export type ProcessingAttemptInput = Readonly<{
  readonly attemptId: string;
  readonly submissionId: string;
  readonly operationId: string;
  readonly creationRevision: number;
  readonly stage:
    | "probe"
    | "hash"
    | "transform"
    | "acr"
    | "lyrics_safety"
    | "media_safety"
    | "publication";
  readonly inputHash: string;
  readonly attemptNumber?: number;
  readonly policyRevision?: string;
  readonly adapterRevision?: string;
  readonly leaseOwner?: string;
  readonly fenceToken?: number;
  readonly providerIdempotencyKey?: string;
  readonly retryable?: boolean;
  readonly failureCode?: string;
  readonly nextEligibleAt?: string;
  readonly evidenceRef?: string;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly state?: "pending" | "running" | "retry_wait" | "succeeded" | "exhausted";
}>;

export type MediaSubmissionStore = {
  readonly reserve: (input: ReservationInput) => Effect.Effect<
    | ReplayOutcome
    | {
        readonly kind: "created";
        readonly reservationId: string;
        readonly bytes: Uint8Array;
        readonly sha256: string;
      },
    MediaSubmissionRepositoryFailure,
    ControlPlaneDb
  >;
  readonly createSubmission: (input: SubmissionInput) => Effect.Effect<
    | ReplayOutcome
    | {
        readonly kind: "created";
        readonly submissionId: string;
        readonly operationId: string;
        readonly bytes: Uint8Array;
        readonly sha256: string;
      },
    MediaSubmissionRepositoryFailure,
    ControlPlaneDb
  >;
  readonly replay: (
    input: CommandReplayInput,
  ) => Effect.Effect<ReplayOutcome, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  readonly getForAuthor: (
    input: Readonly<{ readonly submissionId: string; readonly actorUserId: string }>,
  ) => Effect.Effect<Row | null, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  readonly transition: (
    input: TransitionInput,
  ) => Effect.Effect<
    ReplayOutcome | { readonly kind: "committed"; readonly submissionId: string },
    MediaSubmissionRepositoryFailure,
    ControlPlaneDb
  >;
  readonly finalizeSealed: (input: FinalizeInput) => Effect.Effect<
    | ReplayOutcome
    | {
        readonly kind: "committed";
        readonly submissionId: string;
        readonly immutableRef: string;
        readonly outboxEventId: string;
      },
    MediaSubmissionRepositoryFailure,
    ControlPlaneDb
  >;
  readonly recordProcessingAttempt: (
    input: ProcessingAttemptInput,
  ) => Effect.Effect<void, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
};

const fail = (
  operation: MediaSubmissionRepositoryOperation,
  reason: MediaSubmissionRepositoryReason,
  extra: Partial<Pick<MediaSubmissionRepositoryError, "submissionId" | "reservationId">> = {},
) => new MediaSubmissionRepositoryError({ operation, reason, ...extra });
const validId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value) && !value.includes("\u0000") && value.length <= 512;
const validHash = (value: unknown): value is string =>
  typeof value === "string" && HASH.test(value);
const bytes = (value: unknown): Uint8Array | null =>
  value instanceof Uint8Array && value.byteLength > 0 ? new Uint8Array(value) : null;
const stringValue = (row: Row | undefined, key: string): string | null =>
  typeof row?.[key] === "string" ? (row[key] as string) : null;
const numberValue = (row: Row | undefined, key: string): number | null =>
  typeof row?.[key] === "number" && Number.isSafeInteger(row[key]) ? (row[key] as number) : null;
const replayFromRow = (
  row: Row,
  requestHash: string,
  operation: MediaSubmissionRepositoryOperation,
): ReplayOutcome => {
  const submissionId = stringValue(row, "submission_id") ?? stringValue(row, "reservation_id");
  const operationId = stringValue(row, "operation_id") ?? "";
  const storedHash = stringValue(row, "request_hash");
  const data = bytes(row.response_snapshot_bytes);
  const digest = stringValue(row, "response_snapshot_sha256");
  if (!validId(submissionId) || !validHash(storedHash) || data === null || !validHash(digest))
    throw fail(operation, "invalid-row");
  if (storedHash !== requestHash) return { kind: "conflict", submissionId };
  return { kind: "replay", submissionId, operationId, bytes: data, sha256: digest };
};
const replayCommand = (
  row: Row,
  requestHash: string,
  operation: MediaSubmissionRepositoryOperation,
): ReplayOutcome => {
  const submissionId = stringValue(row, "submission_id");
  const operationId = stringValue(row, "operation_id");
  const storedHash = stringValue(row, "request_hash");
  const data = bytes(row.response_snapshot_bytes);
  const digest = stringValue(row, "response_snapshot_sha256");
  if (
    !validId(submissionId) ||
    !validId(operationId) ||
    !validHash(storedHash) ||
    data === null ||
    !validHash(digest)
  )
    throw fail(operation, "invalid-row");
  if (storedHash !== requestHash) return { kind: "conflict", submissionId };
  return { kind: "replay", submissionId, operationId, bytes: data, sha256: digest };
};
const lockKey = (tx: ControlPlaneTransaction, key: string) =>
  tx.execute({
    label: "media-submission.lock-idempotency",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    values: [key],
    readonly: false,
  });
const idempotencyKey = (actor: string, endpoint: string, key: string): string =>
  JSON.stringify([actor, endpoint, key]);
const rowSnapshot = (input: {
  readonly bytes: Bytes;
  readonly sha256: string;
}): readonly unknown[] => [new Uint8Array(input.bytes), input.sha256];
const json = (value: unknown): string => JSON.stringify(value);
const asIso = (value: string): string => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid timestamp");
  return new Date(parsed).toISOString();
};

function validateReservation(input: ReservationInput): void {
  if (
    !validId(input.communityId) ||
    !validId(input.actorUserId) ||
    !validId(input.idempotencyKey) ||
    !validHash(input.requestHash) ||
    !validId(input.expectedContentType) ||
    !Number.isSafeInteger(input.expectedSizeBytes) ||
    input.expectedSizeBytes < 1 ||
    !validId(input.uploadUrl) ||
    !validHash(input.responseSha256) ||
    bytes(input.responseBytes) === null
  )
    throw fail("reserve", "invalid-input");
  if (input.expectedSha256 !== undefined && !validHash(input.expectedSha256))
    throw fail("reserve", "invalid-input");
}

function validateSubmission(input: SubmissionInput): void {
  const author = input.authorInput;
  if (
    !validId(input.communityId) ||
    !validId(input.actorUserId) ||
    !validId(input.idempotencyKey) ||
    !validHash(input.requestHash) ||
    !validId(author.title) ||
    !validId(author.audio_reservation_id) ||
    !validHash(input.responseSha256) ||
    bytes(input.responseBytes) === null
  )
    throw fail("create", "invalid-input");
  if (
    author.license_preset === "commercial-remix" &&
    (author.commercial_rev_share_bps === undefined ||
      !Number.isInteger(author.commercial_rev_share_bps) ||
      author.commercial_rev_share_bps < 0 ||
      author.commercial_rev_share_bps > 10000)
  )
    throw fail("create", "invalid-input");
  if (author.license_preset !== "commercial-remix" && author.commercial_rev_share_bps !== undefined)
    throw fail("create", "invalid-input");
  if (
    !Array.isArray(author.royalty_allocations) ||
    author.royalty_allocations.length === 0 ||
    new Set(author.royalty_allocations.map((entry) => entry.recipient_id)).size !==
      author.royalty_allocations.length ||
    author.royalty_allocations.some(
      (entry) =>
        !validId(entry.recipient_id) || !Number.isInteger(entry.share_bps) || entry.share_bps < 1,
    ) ||
    author.royalty_allocations.reduce((sum, entry) => sum + entry.share_bps, 0) !== 10000
  )
    throw fail("create", "invalid-input");
}

export function makeControlPlaneMediaSubmissionRepository(): MediaSubmissionStore {
  const replay: MediaSubmissionStore["replay"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.actorUserId) ||
        !validId(input.endpointTemplate) ||
        !validId(input.idempotencyKey) ||
        !validHash(input.requestHash)
      )
        return yield* Effect.fail(fail("replay", "invalid-input"));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-submission.replay",
        text: `SELECT submission_id, operation_id, request_hash, response_snapshot_bytes, response_snapshot_sha256 FROM media_submission_command_replays WHERE actor_user_id = $1 AND endpoint_template = $2 AND idempotency_key = $3`,
        values: [input.actorUserId, input.endpointTemplate, input.idempotencyKey],
        readonly: true,
      });
      if (result.rows.length === 0) return { kind: "none" as const };
      if (result.rows.length !== 1) return yield* Effect.fail(fail("replay", "invalid-row"));
      return replayCommand(result.rows[0] as Row, input.requestHash, "replay");
    });

  const reserve: MediaSubmissionStore["reserve"] = (input) =>
    Effect.gen(function* () {
      try {
        validateReservation(input);
        asIso(input.expiresAt);
      } catch (error) {
        return yield* Effect.fail(
          error instanceof MediaSubmissionRepositoryError
            ? error
            : fail("reserve", "invalid-input"),
        );
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* lockKey(
            tx,
            idempotencyKey(input.actorUserId, RESERVATION_ENDPOINT, input.idempotencyKey),
          );
          const prior = yield* tx.execute<Row>({
            label: "media-reservation.replay",
            text: `SELECT reservation_id, operation_id, request_hash, response_snapshot_bytes, response_snapshot_sha256 FROM media_upload_reservations WHERE actor_user_id = $1 AND endpoint_template = $2 AND idempotency_key = $3 FOR UPDATE`,
            values: [input.actorUserId, RESERVATION_ENDPOINT, input.idempotencyKey],
            readonly: false,
          });
          if (prior.rows.length > 1) return yield* Effect.fail(fail("reserve", "invalid-row"));
          if (prior.rows.length === 1) {
            const outcome = replayFromRow(prior.rows[0] as Row, input.requestHash, "reserve");
            if (outcome.kind !== "replay") return outcome;
            return {
              kind: "created" as const,
              reservationId: outcome.submissionId,
              bytes: outcome.bytes,
              sha256: outcome.sha256,
            };
          }
          const community = yield* tx.execute({
            label: "media-reservation.community",
            text: "SELECT community_id FROM communities WHERE community_id = $1 AND status = 'active' FOR UPDATE",
            values: [input.communityId],
            readonly: false,
          });
          const membership = yield* tx.execute<Row>({
            label: "media-reservation.membership",
            text: "SELECT status FROM community_memberships WHERE community_id = $1 AND user_id = $2 FOR UPDATE",
            values: [input.communityId, input.actorUserId],
            readonly: false,
          });
          if (community.rows.length !== 1) return yield* Effect.fail(fail("reserve", "not-found"));
          if (membership.rows.length !== 1 || membership.rows[0]?.status !== "member")
            return yield* Effect.fail(fail("reserve", "membership-required"));
          const reservationId = input.reservationId ?? `res_${crypto.randomUUID()}`;
          const inserted = yield* tx.execute({
            label: "media-reservation.insert",
            text: `INSERT INTO media_upload_reservations (reservation_id, community_id, actor_user_id, idempotency_key, request_hash, track, slot, expected_content_type, expected_size_bytes, expected_sha256, upload_url, upload_headers, expires_at, response_snapshot_bytes, response_snapshot_sha256) VALUES ($1, $2, $3, $4, $5, 'song', 'primary_audio', $6, $7, $8, $9, $10::jsonb, $11::timestamptz, $12, $13) RETURNING reservation_id`,
            values: [
              reservationId,
              input.communityId,
              input.actorUserId,
              input.idempotencyKey,
              input.requestHash,
              input.expectedContentType,
              input.expectedSizeBytes,
              input.expectedSha256 ?? null,
              input.uploadUrl,
              json(input.uploadHeaders ?? []),
              input.expiresAt,
              ...rowSnapshot({ bytes: input.responseBytes, sha256: input.responseSha256 }),
            ],
            readonly: false,
          });
          if (inserted.rowCount !== 1) return yield* Effect.fail(fail("reserve", "constraint"));
          const data = bytes(input.responseBytes) as Uint8Array;
          return {
            kind: "created" as const,
            reservationId,
            bytes: data,
            sha256: input.responseSha256,
          };
        }),
      );
    });

  const createSubmission: MediaSubmissionStore["createSubmission"] = (input) =>
    Effect.gen(function* () {
      try {
        validateSubmission(input);
      } catch (error) {
        return yield* Effect.fail(
          error instanceof MediaSubmissionRepositoryError ? error : fail("create", "invalid-input"),
        );
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* lockKey(
            tx,
            idempotencyKey(input.actorUserId, SUBMISSION_ENDPOINT, input.idempotencyKey),
          );
          const existing = yield* tx.execute<Row>({
            label: "media-submission.replay",
            text: `SELECT submission_id, operation_id, request_hash, response_snapshot_bytes, response_snapshot_sha256 FROM media_post_submissions WHERE actor_user_id = $1 AND endpoint_template = $2 AND idempotency_key = $3 FOR UPDATE`,
            values: [input.actorUserId, SUBMISSION_ENDPOINT, input.idempotencyKey],
            readonly: false,
          });
          if (existing.rows.length > 1) return yield* Effect.fail(fail("create", "invalid-row"));
          if (existing.rows.length === 1) {
            const outcome = replayFromRow(existing.rows[0] as Row, input.requestHash, "create");
            return outcome;
          }
          const reservation = yield* tx.execute<Row>({
            label: "media-submission.claim-reservation",
            text: `SELECT reservation_id, community_id, actor_user_id, state, expires_at FROM media_upload_reservations WHERE reservation_id = $1 AND community_id = $2 AND actor_user_id = $3 FOR UPDATE`,
            values: [input.authorInput.audio_reservation_id, input.communityId, input.actorUserId],
            readonly: false,
          });
          const reservationRow = reservation.rows[0] as Row | undefined;
          if (reservation.rows.length !== 1 || reservationRow?.state !== "issued")
            return yield* Effect.fail(
              fail("create", "reservation-conflict", {
                reservationId: input.authorInput.audio_reservation_id,
              }),
            );
          const expired = Date.parse(String(reservationRow.expires_at)) <= Date.now();
          if (expired)
            return yield* Effect.fail(
              fail("create", "reservation-conflict", {
                reservationId: input.authorInput.audio_reservation_id,
              }),
            );
          const submissionId = input.submissionId ?? `sub_${crypto.randomUUID()}`;
          const operationId = input.operationId ?? `op_${crypto.randomUUID()}`;
          const author = input.authorInput;
          const rightsKind = author.rights_declaration.kind;
          const updatedReservation = yield* tx.execute({
            label: "media-submission.claim-reservation-update",
            text: `UPDATE media_upload_reservations SET state = 'claimed', submission_id = $1, operation_id = $2, updated_at = clock_timestamp() WHERE reservation_id = $3 AND state = 'issued'`,
            values: [submissionId, operationId, author.audio_reservation_id],
            readonly: false,
          });
          if (updatedReservation.rowCount !== 1)
            return yield* Effect.fail(
              fail("create", "reservation-conflict", {
                reservationId: author.audio_reservation_id,
              }),
            );
          const inserted = yield* tx.execute({
            label: "media-submission.insert",
            text: `INSERT INTO media_post_submissions (submission_id, community_id, actor_user_id, operation_id, idempotency_key, request_hash, track, author_input, title, lyrics, rights_kind, upstream_asset_id, license_preset, commercial_rev_share_bps, royalty_allocations, access_mode, audio_reservation_id, response_snapshot_bytes, response_snapshot_sha256, phase, last_safe_phase) VALUES ($1, $2, $3, $4, $5, $6, 'song', $7::jsonb, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, 'awaiting_upload', 'awaiting_upload')`,
            values: [
              submissionId,
              input.communityId,
              input.actorUserId,
              operationId,
              input.idempotencyKey,
              input.requestHash,
              json(author),
              author.title,
              author.lyrics,
              rightsKind,
              rightsKind === "derivative" ? author.rights_declaration.upstream_asset_id : null,
              author.license_preset,
              author.license_preset === "commercial-remix"
                ? (author.commercial_rev_share_bps ?? 1000)
                : 0,
              json(author.royalty_allocations),
              author.access_mode,
              author.audio_reservation_id,
              ...rowSnapshot({ bytes: input.responseBytes, sha256: input.responseSha256 }),
            ],
            readonly: false,
          });
          if (inserted.rowCount !== 1) return yield* Effect.fail(fail("create", "constraint"));
          yield* tx.execute({
            label: "media-submission.revision",
            text: `INSERT INTO media_submission_revisions (submission_id, creation_revision, operation_id, actor_user_id, phase, status, event) VALUES ($1, 1, $2, $3, 'awaiting_upload', 'processing', 'submission_reserved')`,
            values: [submissionId, operationId, input.actorUserId],
            readonly: false,
          });
          yield* tx.execute({
            label: "media-submission.moderation-projection",
            text: `INSERT INTO media_moderation_projections (submission_id, operation_id, status) VALUES ($1, $2, 'none')`,
            values: [submissionId, operationId],
            readonly: false,
          });
          const replay = yield* tx.execute({
            label: "media-submission.command-replay",
            text: `INSERT INTO media_submission_command_replays (actor_user_id, endpoint_template, idempotency_key, request_hash, submission_id, operation_id, response_snapshot_bytes, response_snapshot_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            values: [
              input.actorUserId,
              SUBMISSION_ENDPOINT,
              input.idempotencyKey,
              input.requestHash,
              submissionId,
              operationId,
              ...rowSnapshot({ bytes: input.responseBytes, sha256: input.responseSha256 }),
            ],
            readonly: false,
          });
          if (replay.rowCount !== 1) return yield* Effect.fail(fail("create", "constraint"));
          return {
            kind: "created" as const,
            submissionId,
            operationId,
            bytes: bytes(input.responseBytes) as Uint8Array,
            sha256: input.responseSha256,
          };
        }),
      );
    });

  const getForAuthor: MediaSubmissionStore["getForAuthor"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.submissionId) || !validId(input.actorUserId))
        return yield* Effect.fail(fail("get", "invalid-input"));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-submission.get",
        text: `SELECT * FROM media_post_submissions WHERE submission_id = $1 AND actor_user_id = $2`,
        values: [input.submissionId, input.actorUserId],
        readonly: true,
      });
      if (result.rows.length > 1) return yield* Effect.fail(fail("get", "invalid-row"));
      return (result.rows[0] as Row | undefined) ?? null;
    });

  const transition: MediaSubmissionStore["transition"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.submissionId) ||
        !validId(input.actorUserId) ||
        !validId(input.endpointTemplate) ||
        !validId(input.idempotencyKey) ||
        !validHash(input.requestHash) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1 ||
        (input.nextCreationRevision !== undefined &&
          (!Number.isSafeInteger(input.nextCreationRevision) ||
            input.nextCreationRevision < input.expectedRevision ||
            input.nextCreationRevision > input.expectedRevision + 1)) ||
        !validHash(input.responseSha256) ||
        bytes(input.responseBytes) === null ||
        (input.outbox !== undefined &&
          (!validId(input.outbox.outboxEventId) || !validId(input.outbox.effectIdentity)))
      )
        return yield* Effect.fail(
          fail("transition", "invalid-input", { submissionId: input.submissionId }),
        );
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) => commitTransition(tx, input));
    });

  const finalizeSealed: MediaSubmissionStore["finalizeSealed"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.submissionId) ||
        !validId(input.actorUserId) ||
        !validId(input.idempotencyKey) ||
        !validHash(input.requestHash) ||
        input.endpointTemplate.length === 0 ||
        !validHash(input.responseSha256) ||
        bytes(input.responseBytes) === null ||
        !validId(input.reservationId) ||
        !validId(input.immutableObject.immutableRef) ||
        !validId(input.immutableObject.destinationRef) ||
        !validId(input.immutableObject.etag) ||
        !validId(input.immutableObject.objectVersion) ||
        !Number.isSafeInteger(input.immutableObject.sizeBytes) ||
        input.immutableObject.sizeBytes < 1
      )
        return yield* Effect.fail(
          fail("finalize", "invalid-input", {
            submissionId: input.submissionId,
            reservationId: input.reservationId,
          }),
        );
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* lockKey(
            tx,
            idempotencyKey(input.actorUserId, input.endpointTemplate, input.idempotencyKey),
          );
          const replayRows = yield* tx.execute<Row>({
            label: "media-finalize.replay",
            text: `SELECT submission_id, operation_id, request_hash, response_snapshot_bytes, response_snapshot_sha256 FROM media_submission_command_replays WHERE actor_user_id = $1 AND endpoint_template = $2 AND idempotency_key = $3 FOR UPDATE`,
            values: [input.actorUserId, input.endpointTemplate, input.idempotencyKey],
            readonly: false,
          });
          if (replayRows.rows.length > 1)
            return yield* Effect.fail(
              fail("finalize", "invalid-row", { submissionId: input.submissionId }),
            );
          if (replayRows.rows.length === 1)
            return replayCommand(replayRows.rows[0] as Row, input.requestHash, "finalize");
          const rowResult = yield* tx.execute<Row>({
            label: "media-finalize.submission",
            text: `SELECT submission_id, operation_id, actor_user_id, creation_revision, status, phase, audio_reservation_id, immutable_ref FROM media_post_submissions WHERE submission_id = $1 FOR UPDATE`,
            values: [input.submissionId],
            readonly: false,
          });
          const row = rowResult.rows[0] as Row | undefined;
          if (rowResult.rows.length !== 1 || row?.actor_user_id !== input.actorUserId)
            return yield* Effect.fail(
              fail("finalize", "not-found", { submissionId: input.submissionId }),
            );
          if (
            numberValue(row, "creation_revision") !== input.expectedRevision ||
            row.phase !== "finalize" ||
            row.status !== "processing" ||
            row.audio_reservation_id !== input.reservationId
          )
            return yield* Effect.fail(
              fail("finalize", "stale-revision", {
                submissionId: input.submissionId,
                reservationId: input.reservationId,
              }),
            );
          const reservation = yield* tx.execute<Row>({
            label: "media-finalize.reservation",
            text: `SELECT reservation_id, community_id, actor_user_id, operation_id, state FROM media_upload_reservations WHERE reservation_id = $1 FOR UPDATE`,
            values: [input.reservationId],
            readonly: false,
          });
          const reservationRow = reservation.rows[0] as Row | undefined;
          if (
            reservation.rows.length !== 1 ||
            reservationRow?.actor_user_id !== input.actorUserId ||
            reservationRow.operation_id !== row.operation_id ||
            reservationRow.state !== "claimed"
          )
            return yield* Effect.fail(
              fail("finalize", "reservation-conflict", {
                submissionId: input.submissionId,
                reservationId: input.reservationId,
              }),
            );
          yield* lockKey(tx, `media-immutable-ref:${input.immutableObject.immutableRef}`);
          yield* lockKey(tx, `media-destination:${input.immutableObject.destinationRef}`);
          const destination = yield* tx.execute<Row>({
            label: "media-finalize.destination",
            text: `SELECT immutable_ref, operation_id FROM media_immutable_objects WHERE destination_ref = $1 FOR UPDATE`,
            values: [input.immutableObject.destinationRef],
            readonly: false,
          });
          if (destination.rows.length !== 0)
            return yield* Effect.fail(
              fail("finalize", "immutable-object-conflict", { submissionId: input.submissionId }),
            );
          const objectInsert = yield* tx.execute({
            label: "media-finalize.immutable-object",
            text: `INSERT INTO media_immutable_objects (immutable_ref, reservation_id, community_id, actor_user_id, operation_id, destination_ref, etag, object_version, size_bytes, content_type, canonical_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (immutable_ref) DO NOTHING`,
            values: [
              input.immutableObject.immutableRef,
              input.reservationId,
              reservationRow.community_id,
              input.actorUserId,
              row.operation_id,
              input.immutableObject.destinationRef,
              input.immutableObject.etag,
              input.immutableObject.objectVersion,
              input.immutableObject.sizeBytes,
              input.immutableObject.contentType,
              input.immutableObject.canonicalSha256 ?? null,
            ],
            readonly: false,
          });
          if (objectInsert.rowCount !== 1)
            return yield* Effect.fail(
              fail("finalize", "immutable-object-conflict", { submissionId: input.submissionId }),
            );
          const now = yield* tx.execute<Row>({
            label: "media-finalize.clock",
            text: "SELECT clock_timestamp() AS now",
            values: [],
            readonly: true,
          });
          const updated = yield* tx.execute({
            label: "media-finalize.submission-update",
            text: `UPDATE media_post_submissions SET phase = 'analysis', immutable_ref = $1, last_safe_phase = 'analysis', updated_at = clock_timestamp() WHERE submission_id = $2 AND actor_user_id = $3 AND creation_revision = $4 AND status = 'processing' AND phase = 'finalize'`,
            values: [
              input.immutableObject.immutableRef,
              input.submissionId,
              input.actorUserId,
              input.expectedRevision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1 || now.rows.length !== 1)
            return yield* Effect.fail(
              fail("finalize", "stale-revision", { submissionId: input.submissionId }),
            );
          const reservationUpdate = yield* tx.execute({
            label: "media-finalize.reservation-update",
            text: `UPDATE media_upload_reservations SET state = 'sealed', updated_at = clock_timestamp() WHERE reservation_id = $1 AND actor_user_id = $2 AND state = 'claimed'`,
            values: [input.reservationId, input.actorUserId],
            readonly: false,
          });
          if (reservationUpdate.rowCount !== 1)
            return yield* Effect.fail(
              fail("finalize", "reservation-conflict", {
                submissionId: input.submissionId,
                reservationId: input.reservationId,
              }),
            );
          const outbox = input.outbox;
          if (outbox === undefined)
            return yield* Effect.fail(
              fail("finalize", "constraint", { submissionId: input.submissionId }),
            );
          const outboxInsert = yield* insertOutbox(
            tx,
            input.submissionId,
            String(row.operation_id),
            input.expectedRevision,
            outbox,
          );
          if (outboxInsert !== 1)
            return yield* Effect.fail(
              fail("finalize", "constraint", { submissionId: input.submissionId }),
            );
          yield* insertReplay(
            tx,
            input.actorUserId,
            input.endpointTemplate,
            input.idempotencyKey,
            input.requestHash,
            input.submissionId,
            String(row.operation_id),
            input.responseBytes,
            input.responseSha256,
          );
          yield* tx.execute({
            label: "media-finalize.revision",
            text: `INSERT INTO media_submission_revisions (submission_id, creation_revision, operation_id, actor_user_id, phase, status, event, evidence) VALUES ($1, $2, $3, $4, 'analysis', 'processing', 'upload_finalized', jsonb_build_object('immutable_ref', $5))`,
            values: [
              input.submissionId,
              input.expectedRevision,
              row.operation_id,
              input.actorUserId,
              input.immutableObject.immutableRef,
            ],
            readonly: false,
          });
          return {
            kind: "committed" as const,
            submissionId: input.submissionId,
            immutableRef: input.immutableObject.immutableRef,
            outboxEventId: outbox.outboxEventId,
          };
        }),
      );
    });

  const recordProcessingAttempt: MediaSubmissionStore["recordProcessingAttempt"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.attemptId) ||
        !validId(input.submissionId) ||
        !validId(input.operationId) ||
        !validHash(input.inputHash) ||
        !Number.isSafeInteger(input.creationRevision) ||
        input.creationRevision < 1
      )
        return yield* Effect.fail(fail("attempt", "invalid-input"));
      const db = yield* ControlPlaneDb;
      yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const result = yield* tx.execute({
            label: "media-attempt.insert",
            text: `INSERT INTO media_processing_attempts (
              attempt_id, submission_id, operation_id, creation_revision, stage, state,
              input_hash, policy_revision, adapter_revision, lease_owner, fence_token,
              provider_idempotency_key, attempt_number, retryable, failure_code,
              next_eligible_at, evidence_ref, result, started_at, completed_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
              $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20
            ) ON CONFLICT (attempt_id) DO NOTHING`,
            values: [
              input.attemptId,
              input.submissionId,
              input.operationId,
              input.creationRevision,
              input.stage,
              input.state ?? "pending",
              input.inputHash,
              input.policyRevision ?? null,
              input.adapterRevision ?? null,
              input.leaseOwner ?? null,
              input.fenceToken ?? null,
              input.providerIdempotencyKey ?? null,
              input.attemptNumber ?? 1,
              input.retryable ?? null,
              input.failureCode ?? null,
              input.nextEligibleAt ?? null,
              input.evidenceRef ?? null,
              input.result === undefined ? null : JSON.stringify(input.result),
              input.startedAt ?? null,
              input.completedAt ?? null,
            ],
            readonly: false,
          });
          if (result.rowCount !== 1) {
            const existing = yield* tx.execute<Row>({
              label: "media-attempt.existing",
              text: "SELECT submission_id, operation_id, creation_revision, stage, input_hash FROM media_processing_attempts WHERE attempt_id = $1",
              values: [input.attemptId],
              readonly: true,
            });
            const row = existing.rows[0] as Row | undefined;
            if (
              existing.rows.length !== 1 ||
              row?.submission_id !== input.submissionId ||
              row.operation_id !== input.operationId ||
              row.creation_revision !== input.creationRevision ||
              row.stage !== input.stage ||
              row.input_hash !== input.inputHash
            )
              return yield* Effect.fail(fail("attempt", "immutable-object-conflict"));
          }
        }),
      );
    });
  return {
    reserve,
    createSubmission,
    replay,
    getForAuthor,
    transition,
    finalizeSealed,
    recordProcessingAttempt,
  };
}

const insertReplay = (
  tx: ControlPlaneTransaction,
  actor: string,
  endpoint: string,
  key: string,
  hash: string,
  submission: string,
  operation: string,
  response: Bytes,
  digest: string,
) =>
  tx
    .execute({
      label: "media-command-replay.insert",
      text: `INSERT INTO media_submission_command_replays (actor_user_id, endpoint_template, idempotency_key, request_hash, submission_id, operation_id, response_snapshot_bytes, response_snapshot_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      values: [
        actor,
        endpoint,
        key,
        hash,
        submission,
        operation,
        ...rowSnapshot({ bytes: response, sha256: digest }),
      ],
      readonly: false,
    })
    .pipe(Effect.map((result) => result.rowCount));
const insertOutbox = (
  tx: ControlPlaneTransaction,
  submission: string,
  operation: string,
  revision: number,
  outbox: OutboxWrite,
) =>
  Effect.gen(function* () {
    yield* lockKey(tx, outbox.effectIdentity);
    return yield* tx
      .execute({
        label: "media-outbox.insert",
        text: `INSERT INTO media_submission_outbox (outbox_event_id, submission_id, operation_id, creation_revision, workflow_revision, workflow_instance_id, event_type, effect_identity, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) ON CONFLICT (effect_identity) DO NOTHING`,
        values: [
          outbox.outboxEventId,
          submission,
          operation,
          revision,
          outbox.workflowRevision,
          outbox.workflowInstanceId,
          outbox.eventType,
          outbox.effectIdentity,
          json(outbox.payload),
        ],
        readonly: false,
      })
      .pipe(Effect.map((result) => result.rowCount));
  });

function commitTransition(
  tx: ControlPlaneTransaction,
  input: TransitionInput,
): Effect.Effect<
  ReplayOutcome | { readonly kind: "committed"; readonly submissionId: string },
  MediaSubmissionRepositoryFailure
> {
  return Effect.gen(function* () {
    yield* lockKey(
      tx,
      idempotencyKey(input.actorUserId, input.endpointTemplate, input.idempotencyKey),
    );
    const prior = yield* tx.execute<Row>({
      label: "media-transition.replay",
      text: `SELECT submission_id, operation_id, request_hash, response_snapshot_bytes, response_snapshot_sha256 FROM media_submission_command_replays WHERE actor_user_id = $1 AND endpoint_template = $2 AND idempotency_key = $3 FOR UPDATE`,
      values: [input.actorUserId, input.endpointTemplate, input.idempotencyKey],
      readonly: false,
    });
    if (prior.rows.length > 1)
      return yield* Effect.fail(
        fail("transition", "invalid-row", { submissionId: input.submissionId }),
      );
    if (prior.rows.length === 1)
      return replayCommand(prior.rows[0] as Row, input.requestHash, "transition");
    const current = yield* tx.execute<Row>({
      label: "media-transition.current",
      text: `SELECT submission_id, operation_id, actor_user_id, creation_revision, status, phase, audio_reservation_id, immutable_ref FROM media_post_submissions WHERE submission_id = $1 FOR UPDATE`,
      values: [input.submissionId],
      readonly: false,
    });
    const row = current.rows[0] as Row | undefined;
    if (current.rows.length !== 1 || row?.actor_user_id !== input.actorUserId)
      return yield* Effect.fail(
        fail("transition", "not-found", { submissionId: input.submissionId }),
      );
    if (row.creation_revision !== input.expectedRevision)
      return yield* Effect.fail(
        fail("transition", "stale-revision", { submissionId: input.submissionId }),
      );
    if (input.reservationId !== undefined && row.audio_reservation_id !== input.reservationId)
      return yield* Effect.fail(
        fail("transition", "reservation-conflict", {
          submissionId: input.submissionId,
          reservationId: input.reservationId,
        }),
      );
    if (input.immutableRef !== undefined && row.immutable_ref !== input.immutableRef)
      return yield* Effect.fail(
        fail("transition", "immutable-object-conflict", { submissionId: input.submissionId }),
      );
    const nextCreationRevision = input.nextCreationRevision ?? input.expectedRevision;
    const updated = yield* tx.execute({
      label: "media-transition.update",
      text: `UPDATE media_post_submissions SET status = $1, phase = $2, immutable_ref = COALESCE($3, immutable_ref), reason_code = $4, retryable = $5, retry_count = COALESCE($6, retry_count), action_expires_at = $7, reference_request_ref = $8, review_ref = $9, held_revision = $10, post_id = $11, last_safe_phase = $12, creation_revision = $13, updated_at = clock_timestamp() WHERE submission_id = $14 AND actor_user_id = $15 AND creation_revision = $16`,
      values: [
        input.status,
        input.phase,
        input.immutableRef ?? null,
        input.reasonCode ?? null,
        input.retryable ?? null,
        input.retryCount ?? null,
        input.actionExpiresAt ?? null,
        input.referenceRequestRef ?? null,
        input.reviewRef ?? null,
        input.heldRevision ?? null,
        input.postId ?? null,
        input.lastSafePhase ?? null,
        nextCreationRevision,
        input.submissionId,
        input.actorUserId,
        input.expectedRevision,
      ],
      readonly: false,
    });
    if (updated.rowCount !== 1)
      return yield* Effect.fail(
        fail("transition", "stale-revision", { submissionId: input.submissionId }),
      );
    if (input.outbox !== undefined) {
      const count = yield* insertOutbox(
        tx,
        input.submissionId,
        String(row.operation_id),
        nextCreationRevision,
        input.outbox,
      );
      if (count !== 1)
        return yield* Effect.fail(
          fail("transition", "constraint", { submissionId: input.submissionId }),
        );
    }
    yield* insertReplay(
      tx,
      input.actorUserId,
      input.endpointTemplate,
      input.idempotencyKey,
      input.requestHash,
      input.submissionId,
      String(row.operation_id),
      input.responseBytes,
      input.responseSha256,
    );
    yield* tx.execute({
      label: "media-transition.revision",
      text: `INSERT INTO media_submission_revisions (submission_id, creation_revision, operation_id, actor_user_id, phase, status, event) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      values: [
        input.submissionId,
        nextCreationRevision,
        row.operation_id,
        input.actorUserId,
        input.phase ?? "analysis",
        input.status,
        input.endpointTemplate,
      ],
      readonly: false,
    });
    return { kind: "committed" as const, submissionId: input.submissionId };
  });
}

export { RESERVATION_ENDPOINT, SUBMISSION_ENDPOINT };
export const makeMediaSubmissionRepository = makeControlPlaneMediaSubmissionRepository;
export const makeControlPlaneMediaSubmissionStore = makeControlPlaneMediaSubmissionRepository;
