import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  deterministicMediaWorkflowInstanceId,
  type ImmutableAudio,
  type MediaSubmissionCommand,
  type MediaSubmissionState,
  type PublicationDecision,
  type SongTerms,
  type SongType,
  type TrustedSongAnalysis,
  transitionMediaSubmission,
} from "@pirate/domain";
import { Data, Effect } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Bytes = Uint8Array;
const HASH = /^[0-9a-f]{64}$/u;
const ID = /^\S(?:.*\S)?$/u;
const RESERVATION_ENDPOINT = "/communities/:communityId/media-upload-reservations";
const SUBMISSION_ENDPOINT = "/communities/:communityId/media-post-submissions";

export type MediaSubmissionRepositoryOperation =
  | "reserve"
  | "create"
  | "replay"
  | "get"
  | "terms"
  | "finalize"
  | "analysis"
  | "decision"
  | "publish"
  | "attempt";
export type MediaSubmissionRepositoryReason =
  | "invalid-input"
  | "not-found"
  | "membership-required"
  | "idempotency-conflict"
  | "stale-revision"
  | "reservation-conflict"
  | "immutable-object-conflict"
  | "transition-rejected"
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
  communityId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestHash: string;
  expectedContentType: string;
  expectedSizeBytes: number;
  expectedSha256?: string;
  uploadUrl: string;
  uploadHeaders?: readonly Readonly<{ name: string; value: string }>[];
  expiresAt: string;
  responseBytes: Bytes;
  responseSha256: string;
  reservationId?: string;
}>;

export type SubmissionInput = Readonly<{
  communityId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestHash: string;
  title: string;
  songType: SongType;
  reservationId: string;
  submissionId?: string;
  operationId?: string;
  responseBytes: Bytes;
  responseSha256: string;
}>;

export type CommandInput = Readonly<{
  communityId: string;
  submissionId: string;
  actorUserId: string;
  endpointTemplate: string;
  idempotencyKey: string;
  requestHash: string;
  responseBytes: Bytes;
  responseSha256: string;
}>;

export type CommandReplayInput = Pick<
  CommandInput,
  "communityId" | "actorUserId" | "endpointTemplate" | "idempotencyKey" | "requestHash"
>;

export type TermsInput = CommandInput &
  Readonly<{
    expectedCreationRevision: number;
    terms: SongTerms;
  }>;

export type ImmutableObjectInput = Readonly<{
  immutableRef: string;
  destinationRef: string;
  etag: string;
  objectVersion: string;
  sizeBytes: number;
  contentType: string;
  canonicalSha256: string;
}>;

export type OutboxWrite = Readonly<{
  outboxEventId: string;
  effectIdentity: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type FinalizeInput = CommandInput &
  Readonly<{
    expectedCreationRevision: number;
    expectedAudioRevision: number;
    reservationId: string;
    immutableObject: ImmutableObjectInput;
    outbox: OutboxWrite;
  }>;

export type AnalysisInput = CommandInput &
  Readonly<{
    expectedAudioRevision: number;
    expectedCanonicalAudioSha256: string;
    analysis: TrustedSongAnalysis;
  }>;

export type DecisionInput = CommandInput &
  Readonly<{
    expectedCreationRevision: number;
    expectedAudioRevision: number;
    expectedAnalysisRevision: number;
    decision: PublicationDecision;
  }>;

export type PublishInput = CommandInput &
  Readonly<{
    expectedCreationRevision: number;
    expectedAudioRevision: number;
    expectedAnalysisRevision: number;
    expectedDecisionRevision: number;
    postId: string;
    outbox: OutboxWrite;
  }>;

export type ProcessingAttemptInput = Readonly<{
  attemptId: string;
  communityId: string;
  submissionId: string;
  operationId: string;
  audioRevision: number;
  analysisRevision: number;
  stage:
    | "probe"
    | "embedded_metadata"
    | "cover"
    | "transcript"
    | "acr"
    | "lyrics_safety"
    | "media_safety"
    | "publication";
  inputHash: string;
  attemptNumber?: number;
}>;

type ReservationOutcome =
  | {
      readonly kind: "created" | "replay";
      readonly reservationId: string;
      readonly bytes: Uint8Array;
      readonly sha256: string;
    }
  | { readonly kind: "conflict"; readonly reservationId: string };
type CreatedSubmission = Readonly<{
  kind: "created";
  submissionId: string;
  operationId: string;
  bytes: Uint8Array;
  sha256: string;
}>;
type Committed = Readonly<{ kind: "committed"; submissionId: string }>;

export type MediaSubmissionStore = {
  reserve: (
    input: ReservationInput,
  ) => Effect.Effect<ReservationOutcome, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  createSubmission: (
    input: SubmissionInput,
  ) => Effect.Effect<
    ReplayOutcome | CreatedSubmission,
    MediaSubmissionRepositoryFailure,
    ControlPlaneDb
  >;
  replay: (
    input: CommandReplayInput,
  ) => Effect.Effect<ReplayOutcome, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  getForAuthor: (input: {
    communityId: string;
    submissionId: string;
    actorUserId: string;
  }) => Effect.Effect<
    MediaSubmissionState | null,
    MediaSubmissionRepositoryFailure,
    ControlPlaneDb
  >;
  bindTerms: (
    input: TermsInput,
  ) => Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  finalizeSealed: (
    input: FinalizeInput,
  ) => Effect.Effect<
    ReplayOutcome | (Committed & Readonly<{ immutableRef: string; outboxEventId: string }>),
    MediaSubmissionRepositoryFailure,
    ControlPlaneDb
  >;
  acceptAnalysis: (
    input: AnalysisInput,
  ) => Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  recordDecision: (
    input: DecisionInput,
  ) => Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  publish: (
    input: PublishInput,
  ) => Effect.Effect<
    ReplayOutcome | (Committed & Readonly<{ postId: string; outboxEventId: string }>),
    MediaSubmissionRepositoryFailure,
    ControlPlaneDb
  >;
  recordProcessingAttempt: (
    input: ProcessingAttemptInput,
  ) => Effect.Effect<void, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
};

const fail = (
  operation: MediaSubmissionRepositoryOperation,
  reason: MediaSubmissionRepositoryReason,
  extra: Partial<Pick<MediaSubmissionRepositoryError, "submissionId" | "reservationId">> = {},
) => new MediaSubmissionRepositoryError({ operation, reason, ...extra });
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 512 && !value.includes("\u0000") && ID.test(value);
const validHash = (value: unknown): value is string =>
  typeof value === "string" && HASH.test(value);
const validRevision = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const byteValue = (value: unknown): Uint8Array | null =>
  value instanceof Uint8Array && value.byteLength > 0 ? new Uint8Array(value) : null;
const numberValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^-?[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const objectValue = (value: unknown): Readonly<Record<string, unknown>> | null => {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Readonly<Record<string, unknown>>;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
};
const json = (value: unknown): string => JSON.stringify(value);
const snapshotValues = (input: { responseBytes: Bytes; responseSha256: string }) =>
  [new Uint8Array(input.responseBytes), input.responseSha256] as const;
const validSnapshot = (input: { responseBytes: Bytes; responseSha256: string }): boolean =>
  byteValue(input.responseBytes) !== null && validHash(input.responseSha256);
const lockKey = (tx: ControlPlaneTransaction, key: string) =>
  tx.execute({
    label: "media-submission.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    values: [key],
    readonly: false,
  });
const replayLockKey = (input: CommandReplayInput): string =>
  json([input.communityId, input.actorUserId, input.endpointTemplate, input.idempotencyKey]);

function replayFromRow(
  row: Row,
  requestHash: string,
  operation: MediaSubmissionRepositoryOperation,
): ReplayOutcome {
  const submissionId = row.submission_id;
  const operationId = row.operation_id;
  const storedHash = row.request_hash;
  const response = byteValue(row.response_snapshot_bytes);
  const digest = row.response_snapshot_sha256;
  if (
    !validId(submissionId) ||
    !validId(operationId) ||
    !validHash(storedHash) ||
    response === null ||
    !validHash(digest)
  )
    throw fail(operation, "invalid-row");
  if (storedHash !== requestHash) return { kind: "conflict", submissionId };
  return { kind: "replay", submissionId, operationId, bytes: response, sha256: digest };
}

function reservationReplayFromRow(row: Row, requestHash: string): ReservationOutcome {
  const reservationId = row.reservation_id;
  const storedHash = row.request_hash;
  const response = byteValue(row.response_snapshot_bytes);
  const digest = row.response_snapshot_sha256;
  if (!validId(reservationId) || !validHash(storedHash) || response === null || !validHash(digest))
    throw fail("reserve", "invalid-row");
  if (storedHash !== requestHash) return { kind: "conflict", reservationId };
  return { kind: "replay", reservationId, bytes: response, sha256: digest };
}

const stateSelect = `
  SELECT s.*, t.terms_snapshot, a.canonical_sha256 AS audio_sha256,
         a.content_type AS audio_content_type, a.size_bytes AS audio_size_bytes,
         ae.analysis_snapshot, d.decision_snapshot
    FROM media_post_submissions s
    LEFT JOIN media_submission_terms t
      ON t.submission_id = s.submission_id
     AND t.creation_revision = s.current_terms_revision
    LEFT JOIN media_audio_revisions a
      ON a.submission_id = s.submission_id
     AND a.audio_revision = s.audio_revision
    LEFT JOIN media_analysis_evidence ae
      ON ae.submission_id = s.submission_id
     AND ae.analysis_revision = s.current_analysis_revision
    LEFT JOIN media_publication_decisions d
      ON d.submission_id = s.submission_id
     AND d.decision_revision = s.current_decision_revision`;

function decodeState(
  row: Row,
  operation: MediaSubmissionRepositoryOperation,
): MediaSubmissionState {
  const creationRevision = numberValue(row.creation_revision);
  const audioRevision = numberValue(row.audio_revision);
  const analysisRevision = numberValue(row.analysis_revision);
  const decisionRevision = numberValue(row.decision_revision);
  const workflowRevision = numberValue(row.workflow_revision);
  const terms = row.terms_snapshot === null ? null : objectValue(row.terms_snapshot);
  const analysis = row.analysis_snapshot === null ? null : objectValue(row.analysis_snapshot);
  const decision = row.decision_snapshot === null ? null : objectValue(row.decision_snapshot);
  const audioSize = row.audio_size_bytes === null ? null : numberValue(row.audio_size_bytes);
  const identity = [
    row.submission_id,
    row.operation_id,
    row.community_id,
    row.actor_user_id,
    row.title,
    row.audio_reservation_id,
  ];
  if (
    identity.some((value) => !validId(value)) ||
    !validRevision(creationRevision, 1) ||
    !validRevision(audioRevision) ||
    !validRevision(analysisRevision) ||
    !validRevision(decisionRevision) ||
    !validRevision(workflowRevision) ||
    !["original", "remix"].includes(String(row.song_type)) ||
    ![
      "awaiting_upload",
      "analyzing",
      "decision_pending",
      "ready_to_publish",
      "manual_review",
      "published",
      "blocked",
      "failed",
      "abandoned",
    ].includes(String(row.status)) ||
    ![null, "upload", "analysis", "decision", "publication"].includes(row.phase as string | null) ||
    (audioRevision === 0) !== (row.current_immutable_ref === null) ||
    (audioRevision > 0 &&
      (!validId(row.current_immutable_ref) ||
        !validHash(row.audio_sha256) ||
        !validId(row.audio_content_type) ||
        !validRevision(audioSize, 1))) ||
    (analysisRevision === 0) !== (analysis === null) ||
    (decisionRevision === 0) !== (decision === null) ||
    (creationRevision > 1 && terms === null)
  )
    throw fail(operation, "invalid-row", {
      ...(validId(row.submission_id) ? { submissionId: row.submission_id } : {}),
    });
  return {
    submissionId: row.submission_id as string,
    operationId: row.operation_id as string,
    communityId: row.community_id as string,
    actorId: row.actor_user_id as string,
    title: row.title as string,
    songType: row.song_type as SongType,
    reservationId: row.audio_reservation_id as string,
    creationRevision,
    audioRevision,
    analysisRevision,
    decisionRevision,
    workflowRevision,
    status: row.status as MediaSubmissionState["status"],
    phase: row.phase as MediaSubmissionState["phase"],
    terms: terms as SongTerms | null,
    audio:
      audioRevision === 0
        ? null
        : {
            audioRevision,
            immutableRef: row.current_immutable_ref as string,
            canonicalSha256: row.audio_sha256 as string,
            contentType: row.audio_content_type as string,
            sizeBytes: audioSize as number,
          },
    analysis: analysis as TrustedSongAnalysis | null,
    decision: decision as PublicationDecision | null,
    postId: row.post_id === null ? null : (row.post_id as string),
    failureCode: row.failure_code === null ? null : (row.failure_code as string),
  };
}

const loadState = (
  tx: ControlPlaneTransaction,
  input: { communityId: string; submissionId: string; actorUserId: string },
  operation: MediaSubmissionRepositoryOperation,
  lock: boolean,
) =>
  Effect.gen(function* () {
    const result = yield* tx.execute<Row>({
      label: `media-submission.${operation}.load`,
      text: `${stateSelect}
       WHERE s.community_id = $1 AND s.submission_id = $2 AND s.actor_user_id = $3
       ${lock ? "FOR UPDATE OF s" : ""}`,
      values: [input.communityId, input.submissionId, input.actorUserId],
      readonly: !lock,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1)
      return yield* Effect.fail(
        fail(operation, "invalid-row", { submissionId: input.submissionId }),
      );
    return yield* Effect.try({
      try: () => decodeState(result.rows[0] as Row, operation),
      catch: (error) =>
        error instanceof MediaSubmissionRepositoryError
          ? error
          : fail(operation, "invalid-row", { submissionId: input.submissionId }),
    });
  });

const reduce = (
  operation: MediaSubmissionRepositoryOperation,
  current: MediaSubmissionState | null,
  command: MediaSubmissionCommand,
) =>
  Effect.suspend(() => {
    const result = transitionMediaSubmission(current, command);
    return result.ok
      ? Effect.succeed(result.state)
      : Effect.fail(
          fail(
            operation,
            result.rejection.tag === "stale_revision" ? "stale-revision" : "transition-rejected",
            current === null ? {} : { submissionId: current.submissionId },
          ),
        );
  });

const replayInTransaction = (
  tx: ControlPlaneTransaction,
  input: CommandReplayInput,
  operation: MediaSubmissionRepositoryOperation,
) =>
  Effect.gen(function* () {
    yield* lockKey(tx, replayLockKey(input));
    const prior = yield* tx.execute<Row>({
      label: `media-submission.${operation}.replay`,
      text: `SELECT submission_id, operation_id, request_hash,
                    response_snapshot_bytes, response_snapshot_sha256
               FROM media_submission_command_replays
              WHERE community_id = $1 AND actor_user_id = $2
                AND endpoint_template = $3 AND idempotency_key = $4
              FOR UPDATE`,
      values: [input.communityId, input.actorUserId, input.endpointTemplate, input.idempotencyKey],
      readonly: false,
    });
    if (prior.rows.length > 1) return yield* Effect.fail(fail(operation, "invalid-row"));
    if (prior.rows.length === 0) return null;
    return yield* Effect.try({
      try: () => replayFromRow(prior.rows[0] as Row, input.requestHash, operation),
      catch: (error) =>
        error instanceof MediaSubmissionRepositoryError ? error : fail(operation, "invalid-row"),
    });
  });

const insertReplay = (tx: ControlPlaneTransaction, input: CommandInput, operationId: string) =>
  tx.execute({
    label: "media-submission.replay.insert",
    text: `INSERT INTO media_submission_command_replays (
             community_id, actor_user_id, endpoint_template, idempotency_key,
             request_hash, submission_id, operation_id,
             response_snapshot_bytes, response_snapshot_sha256
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    values: [
      input.communityId,
      input.actorUserId,
      input.endpointTemplate,
      input.idempotencyKey,
      input.requestHash,
      input.submissionId,
      operationId,
      ...snapshotValues(input),
    ],
    readonly: false,
  });

const insertEvent = (
  tx: ControlPlaneTransaction,
  state: MediaSubmissionState,
  eventSequence: number,
  eventKind: string,
  evidence: Readonly<Record<string, unknown>>,
) =>
  tx.execute({
    label: `media-submission.event.${eventKind}`,
    text: `INSERT INTO media_submission_events (
             submission_id, community_id, operation_id, event_sequence, event_id,
             event_kind, creation_revision, audio_revision, analysis_revision,
             decision_revision, workflow_revision, evidence
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    values: [
      state.submissionId,
      state.communityId,
      state.operationId,
      eventSequence,
      `media_event_${crypto.randomUUID()}`,
      eventKind,
      state.creationRevision,
      state.audioRevision,
      state.analysisRevision,
      state.decisionRevision,
      state.workflowRevision,
      json(evidence),
    ],
    readonly: false,
  });

const insertOutbox = (
  tx: ControlPlaneTransaction,
  state: MediaSubmissionState,
  eventType: "analysis_launch" | "publication",
  outbox: OutboxWrite,
) =>
  tx.execute({
    label: `media-submission.outbox.${eventType}`,
    text: `INSERT INTO media_submission_outbox (
             outbox_event_id, submission_id, community_id, operation_id,
             creation_revision, audio_revision, analysis_revision, workflow_revision,
             workflow_instance_id, event_type, effect_identity, payload
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    values: [
      outbox.outboxEventId,
      state.submissionId,
      state.communityId,
      state.operationId,
      state.creationRevision,
      state.audioRevision,
      state.analysisRevision,
      state.workflowRevision,
      deterministicMediaWorkflowInstanceId(state.operationId, state.workflowRevision),
      eventType,
      outbox.effectIdentity,
      json(outbox.payload),
    ],
    readonly: false,
  });

function validCommand(input: CommandInput): boolean {
  return (
    validId(input.communityId) &&
    validId(input.submissionId) &&
    validId(input.actorUserId) &&
    validId(input.endpointTemplate) &&
    validId(input.idempotencyKey) &&
    validHash(input.requestHash) &&
    validSnapshot(input)
  );
}

export function makeControlPlaneMediaSubmissionRepository(): MediaSubmissionStore {
  const replay: MediaSubmissionStore["replay"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.communityId) ||
        !validId(input.actorUserId) ||
        !validId(input.endpointTemplate) ||
        !validId(input.idempotencyKey) ||
        !validHash(input.requestHash)
      )
        return yield* Effect.fail(fail("replay", "invalid-input"));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-submission.replay",
        text: `SELECT submission_id, operation_id, request_hash,
                      response_snapshot_bytes, response_snapshot_sha256
                 FROM media_submission_command_replays
                WHERE community_id = $1 AND actor_user_id = $2
                  AND endpoint_template = $3 AND idempotency_key = $4`,
        values: [
          input.communityId,
          input.actorUserId,
          input.endpointTemplate,
          input.idempotencyKey,
        ],
        readonly: true,
      });
      if (result.rows.length === 0) return { kind: "none" } as const;
      if (result.rows.length !== 1) return yield* Effect.fail(fail("replay", "invalid-row"));
      return yield* Effect.try({
        try: () => replayFromRow(result.rows[0] as Row, input.requestHash, "replay"),
        catch: (error) =>
          error instanceof MediaSubmissionRepositoryError ? error : fail("replay", "invalid-row"),
      });
    });

  const reserve: MediaSubmissionStore["reserve"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.communityId) ||
        !validId(input.actorUserId) ||
        !validId(input.idempotencyKey) ||
        !validHash(input.requestHash) ||
        !validId(input.expectedContentType) ||
        !validRevision(input.expectedSizeBytes, 1) ||
        (input.expectedSha256 !== undefined && !validHash(input.expectedSha256)) ||
        !validId(input.uploadUrl) ||
        !Number.isFinite(Date.parse(input.expiresAt)) ||
        !validSnapshot(input)
      )
        return yield* Effect.fail(fail("reserve", "invalid-input"));
      const reservationId = input.reservationId ?? `media_reservation_${crypto.randomUUID()}`;
      if (!validId(reservationId))
        return yield* Effect.fail(fail("reserve", "invalid-input", { reservationId }));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const key = json([
            input.communityId,
            input.actorUserId,
            RESERVATION_ENDPOINT,
            input.idempotencyKey,
          ]);
          yield* lockKey(tx, key);
          const prior = yield* tx.execute<Row>({
            label: "media-reservation.replay",
            text: `SELECT reservation_id, request_hash,
                          response_snapshot_bytes, response_snapshot_sha256
                     FROM media_upload_reservations
                    WHERE community_id = $1 AND actor_user_id = $2
                      AND endpoint_template = $3 AND idempotency_key = $4
                    FOR UPDATE`,
            values: [
              input.communityId,
              input.actorUserId,
              RESERVATION_ENDPOINT,
              input.idempotencyKey,
            ],
            readonly: false,
          });
          if (prior.rows.length > 1) return yield* Effect.fail(fail("reserve", "invalid-row"));
          if (prior.rows.length === 1)
            return yield* Effect.try({
              try: () => reservationReplayFromRow(prior.rows[0] as Row, input.requestHash),
              catch: (error) =>
                error instanceof MediaSubmissionRepositoryError
                  ? error
                  : fail("reserve", "invalid-row"),
            });
          const community = yield* tx.execute<Row>({
            label: "media-reservation.community-authority",
            text: "SELECT status FROM communities WHERE community_id = $1 FOR SHARE",
            values: [input.communityId],
            readonly: false,
          });
          const membership = yield* tx.execute<Row>({
            label: "media-reservation.membership-authority",
            text: `SELECT status FROM community_memberships
                    WHERE community_id = $1 AND user_id = $2 FOR SHARE`,
            values: [input.communityId, input.actorUserId],
            readonly: false,
          });
          if (community.rows.length !== 1 || community.rows[0]?.status !== "active")
            return yield* Effect.fail(fail("reserve", "not-found"));
          if (membership.rows.length !== 1 || membership.rows[0]?.status !== "member")
            return yield* Effect.fail(fail("reserve", "membership-required"));
          const inserted = yield* tx.execute({
            label: "media-reservation.insert",
            text: `INSERT INTO media_upload_reservations (
                     reservation_id, community_id, actor_user_id, idempotency_key,
                     request_hash, expected_content_type, expected_size_bytes,
                     expected_sha256, upload_url, upload_headers, expires_at,
                     response_snapshot_bytes, response_snapshot_sha256
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
                             $11::timestamptz, $12, $13)`,
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
              ...snapshotValues(input),
            ],
            readonly: false,
          });
          if (inserted.rowCount !== 1)
            return yield* Effect.fail(fail("reserve", "constraint", { reservationId }));
          return {
            kind: "created",
            reservationId,
            bytes: new Uint8Array(input.responseBytes),
            sha256: input.responseSha256,
          } as const;
        }),
      );
    });

  const createSubmission: MediaSubmissionStore["createSubmission"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.communityId) ||
        !validId(input.actorUserId) ||
        !validId(input.idempotencyKey) ||
        !validHash(input.requestHash) ||
        !validId(input.title) ||
        input.title.length > 200 ||
        !["original", "remix"].includes(input.songType) ||
        !validId(input.reservationId) ||
        !validSnapshot(input)
      )
        return yield* Effect.fail(fail("create", "invalid-input"));
      const submissionId = input.submissionId ?? `media_submission_${crypto.randomUUID()}`;
      const operationId = input.operationId ?? `media_operation_${crypto.randomUUID()}`;
      if (!validId(submissionId) || !validId(operationId))
        return yield* Effect.fail(fail("create", "invalid-input"));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const replayInput = {
            communityId: input.communityId,
            actorUserId: input.actorUserId,
            endpointTemplate: SUBMISSION_ENDPOINT,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
          };
          const prior = yield* replayInTransaction(tx, replayInput, "create");
          if (prior !== null) return prior;
          const next = yield* reduce("create", null, {
            event: "submission_created",
            actorId: input.actorUserId,
            expectedCreationRevision: 0,
            submissionId,
            operationId,
            communityId: input.communityId,
            title: input.title,
            songType: input.songType,
            reservationId: input.reservationId,
          });
          const inserted = yield* tx.execute({
            label: "media-submission.create",
            text: `INSERT INTO media_post_submissions (
                     submission_id, community_id, actor_user_id, operation_id,
                     idempotency_key, request_hash, title, song_type, start_input,
                     audio_reservation_id, status, phase,
                     response_snapshot_bytes, response_snapshot_sha256
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
                             $10, 'awaiting_upload', 'upload', $11, $12)`,
            values: [
              submissionId,
              input.communityId,
              input.actorUserId,
              operationId,
              input.idempotencyKey,
              input.requestHash,
              input.title,
              input.songType,
              json({
                title: input.title,
                song_type: input.songType,
                audio_reservation_id: input.reservationId,
              }),
              input.reservationId,
              ...snapshotValues(input),
            ],
            readonly: false,
          });
          if (inserted.rowCount !== 1)
            return yield* Effect.fail(fail("create", "constraint", { submissionId }));
          const claimed = yield* tx.execute({
            label: "media-reservation.claim",
            text: `UPDATE media_upload_reservations
                      SET state = 'claimed', submission_id = $1, operation_id = $2,
                          updated_at = clock_timestamp()
                    WHERE reservation_id = $3 AND community_id = $4 AND actor_user_id = $5
                      AND state = 'issued' AND expires_at > clock_timestamp()`,
            values: [
              submissionId,
              operationId,
              input.reservationId,
              input.communityId,
              input.actorUserId,
            ],
            readonly: false,
          });
          if (claimed.rowCount !== 1)
            return yield* Effect.fail(
              fail("create", "reservation-conflict", {
                submissionId,
                reservationId: input.reservationId,
              }),
            );
          yield* insertEvent(tx, next, 1, "submission_created", {
            reservation_id: input.reservationId,
          });
          yield* tx.execute({
            label: "media-moderation.create",
            text: `INSERT INTO media_moderation_projections (
                     submission_id, community_id, operation_id, status
                   ) VALUES ($1, $2, $3, 'none')`,
            values: [submissionId, input.communityId, operationId],
            readonly: false,
          });
          yield* insertReplay(
            tx,
            { ...input, submissionId, endpointTemplate: SUBMISSION_ENDPOINT },
            operationId,
          );
          return {
            kind: "created",
            submissionId,
            operationId,
            bytes: new Uint8Array(input.responseBytes),
            sha256: input.responseSha256,
          } as const;
        }),
      );
    });

  const getForAuthor: MediaSubmissionStore["getForAuthor"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.communityId) ||
        !validId(input.submissionId) ||
        !validId(input.actorUserId)
      )
        return yield* Effect.fail(fail("get", "invalid-input"));
      const db = yield* ControlPlaneDb;
      return yield* loadState(db, input, "get", false);
    });

  const bindTerms: MediaSubmissionStore["bindTerms"] = (input) =>
    Effect.gen(function* () {
      if (!validCommand(input) || !validRevision(input.expectedCreationRevision, 1))
        return yield* Effect.fail(
          fail("terms", "invalid-input", { submissionId: input.submissionId }),
        );
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const prior = yield* replayInTransaction(tx, input, "terms");
          if (prior !== null) return prior;
          const current = yield* loadState(tx, input, "terms", true);
          if (current === null)
            return yield* Effect.fail(
              fail("terms", "not-found", { submissionId: input.submissionId }),
            );
          const next = yield* reduce("terms", current, {
            event: "terms_bound",
            actorId: input.actorUserId,
            expectedCreationRevision: input.expectedCreationRevision,
            terms: input.terms,
          });
          yield* tx.execute({
            label: "media-terms.insert",
            text: `INSERT INTO media_submission_terms (
                     submission_id, community_id, actor_user_id, operation_id,
                     creation_revision, license_preset, commercial_remix_share_bps,
                     royalty_allocations, access_mode, terms_snapshot
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'public', $9::jsonb)`,
            values: [
              current.submissionId,
              current.communityId,
              current.actorId,
              current.operationId,
              next.creationRevision,
              input.terms.licensePreset,
              input.terms.commercialRemixShareBps,
              json(input.terms.royaltyAllocations),
              json(input.terms),
            ],
            readonly: false,
          });
          const updated = yield* tx.execute<Row>({
            label: "media-terms.project",
            text: `UPDATE media_post_submissions
                      SET creation_revision = $1, current_terms_revision = $1,
                          decision_revision = 0, current_decision_revision = NULL,
                          status = $2, phase = $3, event_sequence = event_sequence + 1,
                          updated_at = clock_timestamp()
                    WHERE submission_id = $4 AND creation_revision = $5
                    RETURNING event_sequence`,
            values: [
              next.creationRevision,
              next.status,
              next.phase,
              current.submissionId,
              current.creationRevision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail("terms", "stale-revision", { submissionId: input.submissionId }),
            );
          const eventSequence = numberValue(updated.rows[0]?.event_sequence);
          if (eventSequence === null)
            return yield* Effect.fail(
              fail("terms", "invalid-row", { submissionId: input.submissionId }),
            );
          yield* insertEvent(tx, next, eventSequence, "terms_bound", {});
          yield* insertReplay(tx, input, current.operationId);
          return { kind: "committed", submissionId: current.submissionId } as const;
        }),
      );
    });

  const finalizeSealed: MediaSubmissionStore["finalizeSealed"] = (input) =>
    Effect.gen(function* () {
      const object = input.immutableObject;
      if (
        !validCommand(input) ||
        !validRevision(input.expectedCreationRevision, 1) ||
        !validRevision(input.expectedAudioRevision) ||
        !validId(input.reservationId) ||
        !validId(object.immutableRef) ||
        !validId(object.destinationRef) ||
        !validId(object.etag) ||
        !validId(object.objectVersion) ||
        !validRevision(object.sizeBytes, 1) ||
        !validId(object.contentType) ||
        !validHash(object.canonicalSha256) ||
        !validId(input.outbox.outboxEventId) ||
        !validId(input.outbox.effectIdentity)
      )
        return yield* Effect.fail(
          fail("finalize", "invalid-input", { submissionId: input.submissionId }),
        );
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const prior = yield* replayInTransaction(tx, input, "finalize");
          if (prior !== null) return prior;
          const current = yield* loadState(tx, input, "finalize", true);
          if (current === null)
            return yield* Effect.fail(
              fail("finalize", "not-found", { submissionId: input.submissionId }),
            );
          const audio: ImmutableAudio = {
            audioRevision: current.audioRevision + 1,
            immutableRef: object.immutableRef,
            canonicalSha256: object.canonicalSha256,
            contentType: object.contentType,
            sizeBytes: object.sizeBytes,
          };
          const next = yield* reduce("finalize", current, {
            event: "audio_finalized",
            actorId: input.actorUserId,
            expectedCreationRevision: input.expectedCreationRevision,
            expectedAudioRevision: input.expectedAudioRevision,
            audio,
          });
          if (current.reservationId !== input.reservationId)
            return yield* Effect.fail(
              fail("finalize", "reservation-conflict", {
                submissionId: input.submissionId,
                reservationId: input.reservationId,
              }),
            );
          yield* tx.execute({
            label: "media-finalize.object",
            text: `INSERT INTO media_immutable_objects (
                     immutable_ref, community_id, actor_user_id, reservation_id,
                     submission_id, operation_id, destination_ref, etag,
                     object_version, size_bytes, content_type, canonical_sha256
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            values: [
              object.immutableRef,
              current.communityId,
              current.actorId,
              current.reservationId,
              current.submissionId,
              current.operationId,
              object.destinationRef,
              object.etag,
              object.objectVersion,
              object.sizeBytes,
              object.contentType,
              object.canonicalSha256,
            ],
            readonly: false,
          });
          yield* tx.execute({
            label: "media-finalize.audio-revision",
            text: `INSERT INTO media_audio_revisions (
                     submission_id, community_id, actor_user_id, operation_id,
                     audio_revision, immutable_ref, canonical_sha256, content_type, size_bytes
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            values: [
              current.submissionId,
              current.communityId,
              current.actorId,
              current.operationId,
              next.audioRevision,
              object.immutableRef,
              object.canonicalSha256,
              object.contentType,
              object.sizeBytes,
            ],
            readonly: false,
          });
          const updated = yield* tx.execute<Row>({
            label: "media-finalize.project",
            text: `UPDATE media_post_submissions
                      SET audio_revision = $1, current_immutable_ref = $2,
                          workflow_revision = $3, status = 'analyzing', phase = 'analysis',
                          event_sequence = event_sequence + 1, updated_at = clock_timestamp()
                    WHERE submission_id = $4 AND creation_revision = $5 AND audio_revision = $6
                    RETURNING event_sequence`,
            values: [
              next.audioRevision,
              object.immutableRef,
              next.workflowRevision,
              current.submissionId,
              current.creationRevision,
              current.audioRevision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail("finalize", "stale-revision", { submissionId: input.submissionId }),
            );
          const eventSequence = numberValue(updated.rows[0]?.event_sequence);
          if (eventSequence === null)
            return yield* Effect.fail(
              fail("finalize", "invalid-row", { submissionId: input.submissionId }),
            );
          const sealed = yield* tx.execute({
            label: "media-finalize.reservation",
            text: `UPDATE media_upload_reservations
                      SET state = 'sealed', updated_at = clock_timestamp()
                    WHERE reservation_id = $1 AND community_id = $2 AND actor_user_id = $3
                      AND submission_id = $4 AND operation_id = $5 AND state = 'claimed'`,
            values: [
              current.reservationId,
              current.communityId,
              current.actorId,
              current.submissionId,
              current.operationId,
            ],
            readonly: false,
          });
          if (sealed.rowCount !== 1)
            return yield* Effect.fail(
              fail("finalize", "reservation-conflict", {
                submissionId: input.submissionId,
                reservationId: input.reservationId,
              }),
            );
          yield* insertOutbox(tx, next, "analysis_launch", input.outbox);
          yield* insertEvent(tx, next, eventSequence, "audio_finalized", {
            immutable_ref: object.immutableRef,
            canonical_sha256: object.canonicalSha256,
          });
          yield* insertReplay(tx, input, current.operationId);
          return {
            kind: "committed",
            submissionId: current.submissionId,
            immutableRef: object.immutableRef,
            outboxEventId: input.outbox.outboxEventId,
          } as const;
        }),
      );
    });

  const acceptAnalysis: MediaSubmissionStore["acceptAnalysis"] = (input) =>
    Effect.gen(function* () {
      if (
        !validCommand(input) ||
        !validRevision(input.expectedAudioRevision, 1) ||
        !validHash(input.expectedCanonicalAudioSha256)
      )
        return yield* Effect.fail(
          fail("analysis", "invalid-input", { submissionId: input.submissionId }),
        );
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const prior = yield* replayInTransaction(tx, input, "analysis");
          if (prior !== null) return prior;
          const current = yield* loadState(tx, input, "analysis", true);
          if (current === null)
            return yield* Effect.fail(
              fail("analysis", "not-found", { submissionId: input.submissionId }),
            );
          const next = yield* reduce("analysis", current, {
            event: "analysis_accepted",
            actorId: input.actorUserId,
            expectedAudioRevision: input.expectedAudioRevision,
            expectedCanonicalAudioSha256: input.expectedCanonicalAudioSha256,
            analysis: input.analysis,
          });
          const cover = input.analysis.cover;
          const speech = input.analysis.speech;
          yield* tx.execute({
            label: "media-analysis.insert",
            text: `INSERT INTO media_analysis_evidence (
                     submission_id, community_id, operation_id, audio_revision,
                     analysis_revision, canonical_audio_sha256, finalized_audio_ref,
                     probe_evidence_ref, embedded_metadata_evidence_ref,
                     embedded_title, embedded_title_provenance,
                     cover_status, cover_artifact_ref, cover_artifact_sha256, cover_facts,
                     speech_status, transcript_artifact_ref, transcript_sha256,
                     explicitness, primary_language_bcp47, secondary_language_bcp47,
                     speech_evidence_ref, speech_policy_revision, speech_adapter_revision,
                     acr_decision, acr_evidence_ref, acr_policy_revision, acr_adapter_revision,
                     media_safety, lyrics_safety, analysis_snapshot
                   ) VALUES (
                     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                     $12, $13, $14, $15::jsonb, $16, $17, $18, $19, $20, $21,
                     $22, $23, $24, $25, $26, $27, $28, $29, $30, $31::jsonb
                   )`,
            values: [
              current.submissionId,
              current.communityId,
              current.operationId,
              input.analysis.audioRevision,
              input.analysis.analysisRevision,
              input.analysis.canonicalAudioSha256,
              input.analysis.finalizedAudioRef,
              input.analysis.probeEvidenceRef,
              input.analysis.embeddedMetadataEvidenceRef,
              input.analysis.embeddedTitle,
              input.analysis.embeddedTitle === null ? "absent" : "embedded",
              cover.status,
              cover.status === "ready" ? cover.artifactRef : null,
              cover.status === "ready" ? cover.artifactSha256 : null,
              json(cover),
              speech.status,
              speech.status === "ready" ? speech.transcriptArtifactRef : null,
              speech.status === "ready" ? speech.transcriptSha256 : null,
              speech.explicitness,
              speech.status === "ready" ? speech.primaryLanguageBcp47 : null,
              speech.status === "ready" ? speech.secondaryLanguageBcp47 : null,
              speech.evidenceRef,
              speech.policyRevision,
              speech.adapterRevision,
              input.analysis.acrDecision,
              input.analysis.acrEvidenceRef,
              input.analysis.acrPolicyRevision,
              input.analysis.acrAdapterRevision,
              input.analysis.mediaSafety,
              input.analysis.lyricsSafety,
              json(input.analysis),
            ],
            readonly: false,
          });
          const updated = yield* tx.execute<Row>({
            label: "media-analysis.project",
            text: `UPDATE media_post_submissions
                      SET analysis_revision = $1, current_analysis_revision = $1,
                          decision_revision = 0, current_decision_revision = NULL,
                          status = 'decision_pending', phase = 'decision',
                          event_sequence = event_sequence + 1, updated_at = clock_timestamp()
                    WHERE submission_id = $2 AND audio_revision = $3
                    RETURNING event_sequence`,
            values: [next.analysisRevision, current.submissionId, current.audioRevision],
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail("analysis", "stale-revision", { submissionId: input.submissionId }),
            );
          const eventSequence = numberValue(updated.rows[0]?.event_sequence);
          if (eventSequence === null)
            return yield* Effect.fail(
              fail("analysis", "invalid-row", { submissionId: input.submissionId }),
            );
          yield* insertEvent(tx, next, eventSequence, "analysis_accepted", {
            canonical_audio_sha256: input.analysis.canonicalAudioSha256,
          });
          yield* insertReplay(tx, input, current.operationId);
          return { kind: "committed", submissionId: current.submissionId } as const;
        }),
      );
    });

  const recordDecision: MediaSubmissionStore["recordDecision"] = (input) =>
    Effect.gen(function* () {
      if (
        !validCommand(input) ||
        !validRevision(input.expectedCreationRevision, 2) ||
        !validRevision(input.expectedAudioRevision, 1) ||
        !validRevision(input.expectedAnalysisRevision, 1)
      )
        return yield* Effect.fail(
          fail("decision", "invalid-input", { submissionId: input.submissionId }),
        );
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const prior = yield* replayInTransaction(tx, input, "decision");
          if (prior !== null) return prior;
          const current = yield* loadState(tx, input, "decision", true);
          if (current === null)
            return yield* Effect.fail(
              fail("decision", "not-found", { submissionId: input.submissionId }),
            );
          const next = yield* reduce("decision", current, {
            event: "decision_recorded",
            actorId: input.actorUserId,
            expectedCreationRevision: input.expectedCreationRevision,
            expectedAudioRevision: input.expectedAudioRevision,
            expectedAnalysisRevision: input.expectedAnalysisRevision,
            decision: input.decision,
          });
          yield* tx.execute({
            label: "media-decision.insert",
            text: `INSERT INTO media_publication_decisions (
                     submission_id, community_id, operation_id, decision_revision,
                     creation_revision, audio_revision, analysis_revision,
                     canonical_audio_sha256, outcome, policy_revision, evidence_ref,
                     decision_snapshot
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
            values: [
              current.submissionId,
              current.communityId,
              current.operationId,
              input.decision.decisionRevision,
              input.decision.creationRevision,
              input.decision.audioRevision,
              input.decision.analysisRevision,
              input.decision.canonicalAudioSha256,
              input.decision.outcome,
              input.decision.policyRevision,
              input.decision.evidenceRef,
              json(input.decision),
            ],
            readonly: false,
          });
          const updated = yield* tx.execute<Row>({
            label: "media-decision.project",
            text: `UPDATE media_post_submissions
                      SET decision_revision = $1, current_decision_revision = $1,
                          status = $2, phase = $3, event_sequence = event_sequence + 1,
                          updated_at = clock_timestamp()
                    WHERE submission_id = $4 AND creation_revision = $5
                      AND audio_revision = $6 AND analysis_revision = $7
                    RETURNING event_sequence`,
            values: [
              next.decisionRevision,
              next.status,
              next.phase,
              current.submissionId,
              current.creationRevision,
              current.audioRevision,
              current.analysisRevision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail("decision", "stale-revision", { submissionId: input.submissionId }),
            );
          const eventSequence = numberValue(updated.rows[0]?.event_sequence);
          if (eventSequence === null)
            return yield* Effect.fail(
              fail("decision", "invalid-row", { submissionId: input.submissionId }),
            );
          yield* insertEvent(tx, next, eventSequence, "decision_recorded", {
            outcome: input.decision.outcome,
          });
          yield* insertReplay(tx, input, current.operationId);
          return { kind: "committed", submissionId: current.submissionId } as const;
        }),
      );
    });

  const publish: MediaSubmissionStore["publish"] = (input) =>
    Effect.gen(function* () {
      if (
        !validCommand(input) ||
        !validRevision(input.expectedCreationRevision, 2) ||
        !validRevision(input.expectedAudioRevision, 1) ||
        !validRevision(input.expectedAnalysisRevision, 1) ||
        !validRevision(input.expectedDecisionRevision, 1) ||
        !validId(input.postId) ||
        !validId(input.outbox.outboxEventId) ||
        !validId(input.outbox.effectIdentity)
      )
        return yield* Effect.fail(
          fail("publish", "invalid-input", { submissionId: input.submissionId }),
        );
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const prior = yield* replayInTransaction(tx, input, "publish");
          if (prior !== null) return prior;
          const current = yield* loadState(tx, input, "publish", true);
          if (current === null)
            return yield* Effect.fail(
              fail("publish", "not-found", { submissionId: input.submissionId }),
            );
          const community = yield* tx.execute<Row>({
            label: "media-publish.community-authority",
            text: "SELECT status FROM communities WHERE community_id = $1 FOR SHARE",
            values: [current.communityId],
            readonly: false,
          });
          const membership = yield* tx.execute<Row>({
            label: "media-publish.membership-authority",
            text: `SELECT status FROM community_memberships
                    WHERE community_id = $1 AND user_id = $2 FOR SHARE`,
            values: [current.communityId, current.actorId],
            readonly: false,
          });
          const next = yield* reduce("publish", current, {
            event: "publication_committed",
            actorId: input.actorUserId,
            expectedCreationRevision: input.expectedCreationRevision,
            expectedAudioRevision: input.expectedAudioRevision,
            expectedAnalysisRevision: input.expectedAnalysisRevision,
            expectedDecisionRevision: input.expectedDecisionRevision,
            communityActive: community.rows.length === 1 && community.rows[0]?.status === "active",
            membershipActive:
              membership.rows.length === 1 && membership.rows[0]?.status === "member",
            postId: input.postId,
          });
          const updated = yield* tx.execute<Row>({
            label: "media-publish.project-state",
            text: `UPDATE media_post_submissions
                      SET status = 'published', phase = NULL, post_id = $1,
                          workflow_revision = $2, event_sequence = event_sequence + 1,
                          updated_at = clock_timestamp()
                    WHERE submission_id = $3 AND creation_revision = $4
                      AND audio_revision = $5 AND analysis_revision = $6
                      AND decision_revision = $7
                    RETURNING event_sequence`,
            values: [
              input.postId,
              next.workflowRevision,
              current.submissionId,
              current.creationRevision,
              current.audioRevision,
              current.analysisRevision,
              current.decisionRevision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail("publish", "stale-revision", { submissionId: input.submissionId }),
            );
          const eventSequence = numberValue(updated.rows[0]?.event_sequence);
          if (eventSequence === null)
            return yield* Effect.fail(
              fail("publish", "invalid-row", { submissionId: input.submissionId }),
            );
          if (current.audio === null || current.analysis === null || current.decision === null)
            return yield* Effect.fail(
              fail("publish", "invalid-row", { submissionId: input.submissionId }),
            );
          const speech = current.analysis.speech;
          const cover = current.analysis.cover;
          yield* tx.execute({
            label: "media-publish.projection",
            text: `INSERT INTO media_publication_projections (
                     submission_id, community_id, operation_id, post_id,
                     creation_revision, audio_revision, analysis_revision,
                     decision_revision, canonical_audio_sha256, title, audio_asset_ref,
                     cover_artifact_ref, language_status, primary_language_bcp47,
                     secondary_language_bcp47, lyrics_explicitness, outcome,
                     alignment, data_registration, locked_delivery
                   ) VALUES (
                     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                     $13, $14, $15, $16, 'allow', 'pending', 'pending', 'not_required'
                   )`,
            values: [
              current.submissionId,
              current.communityId,
              current.operationId,
              input.postId,
              current.creationRevision,
              current.audioRevision,
              current.analysisRevision,
              current.decisionRevision,
              current.audio.canonicalSha256,
              current.title,
              current.audio.immutableRef,
              cover.status === "ready" ? cover.artifactRef : null,
              speech.status,
              speech.status === "ready" ? speech.primaryLanguageBcp47 : null,
              speech.status === "ready" ? speech.secondaryLanguageBcp47 : null,
              speech.explicitness,
            ],
            readonly: false,
          });
          yield* insertOutbox(tx, next, "publication", input.outbox);
          yield* insertEvent(tx, next, eventSequence, "publication_committed", {
            post_id: input.postId,
          });
          yield* insertReplay(tx, input, current.operationId);
          return {
            kind: "committed",
            submissionId: current.submissionId,
            postId: input.postId,
            outboxEventId: input.outbox.outboxEventId,
          } as const;
        }),
      );
    });

  const recordProcessingAttempt: MediaSubmissionStore["recordProcessingAttempt"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.attemptId) ||
        !validId(input.communityId) ||
        !validId(input.submissionId) ||
        !validId(input.operationId) ||
        !validRevision(input.audioRevision, 1) ||
        !validRevision(input.analysisRevision, 1) ||
        !validHash(input.inputHash) ||
        !validRevision(input.attemptNumber ?? 1, 1) ||
        (input.attemptNumber ?? 1) > 3
      )
        return yield* Effect.fail(fail("attempt", "invalid-input"));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute({
        label: "media-attempt.insert",
        text: `INSERT INTO media_processing_attempts (
                 attempt_id, submission_id, community_id, operation_id,
                 audio_revision, analysis_revision, stage, attempt_number,
                 input_hash, state
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
               ON CONFLICT (attempt_id) DO NOTHING`,
        values: [
          input.attemptId,
          input.submissionId,
          input.communityId,
          input.operationId,
          input.audioRevision,
          input.analysisRevision,
          input.stage,
          input.attemptNumber ?? 1,
          input.inputHash,
        ],
        readonly: false,
      });
      if (result.rowCount === 1) return;
      const existing = yield* db.execute<Row>({
        label: "media-attempt.replay",
        text: `SELECT submission_id, community_id, operation_id, audio_revision,
                      analysis_revision, stage, attempt_number, input_hash
                 FROM media_processing_attempts WHERE attempt_id = $1`,
        values: [input.attemptId],
        readonly: true,
      });
      const row = existing.rows[0];
      if (
        existing.rows.length !== 1 ||
        row?.submission_id !== input.submissionId ||
        row.community_id !== input.communityId ||
        row.operation_id !== input.operationId ||
        numberValue(row.audio_revision) !== input.audioRevision ||
        numberValue(row.analysis_revision) !== input.analysisRevision ||
        row.stage !== input.stage ||
        numberValue(row.attempt_number) !== (input.attemptNumber ?? 1) ||
        row.input_hash !== input.inputHash
      )
        return yield* Effect.fail(fail("attempt", "immutable-object-conflict"));
    });

  return {
    reserve,
    createSubmission,
    replay,
    getForAuthor,
    bindTerms,
    finalizeSealed,
    acceptAnalysis,
    recordDecision,
    publish,
    recordProcessingAttempt,
  };
}

export { RESERVATION_ENDPOINT, SUBMISSION_ENDPOINT };
export const makeMediaSubmissionRepository = makeControlPlaneMediaSubmissionRepository;
export const makeControlPlaneMediaSubmissionStore = makeControlPlaneMediaSubmissionRepository;
