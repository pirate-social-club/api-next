import { createHash } from "node:crypto";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type M2Actor,
} from "@pirate/application";
import { Data, Effect } from "effect";
import {
  type BoundReference,
  deterministicMediaWorkflowInstanceId,
  type ImmutableAudio,
  type MediaSubmissionCommand,
  type MediaSubmissionState,
  type ModeratorApprovalEvidence,
  type ModeratorBlockEvidence,
  type ProcessingFailure,
  type PublicationDecision,
  type ReviewCase,
  type SongTerms,
  type SongType,
  type TrustedSongAnalysis,
  transitionMediaSubmission,
} from "../../domain/src/media-submission.ts";

type Row = Readonly<Record<string, unknown>>;
type Bytes = Uint8Array;
const ID = /^\S(?:.*\S)?$/u;
const HASH = /^[0-9a-f]{64}$/u;
const sha256Text = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(", ")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(
        (left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0),
      )
      .map(
        (key) =>
          `${JSON.stringify(key)}: ${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(", ")}}`;
  return JSON.stringify(value);
};
const trustedAnalysisSnapshot = (analysis: TrustedSongAnalysis): unknown => ({
  ...analysis,
  speechLyrics:
    analysis.speechLyrics.status === "ready"
      ? analysis.speechLyrics
      : {
          ...analysis.speechLyrics,
          transcriptArtifactRef: null,
          transcriptSha256: null,
          primaryLanguageBcp47: null,
          secondaryLanguageBcp47: null,
        },
  boundReference:
    analysis.boundReference === null
      ? null
      : {
          assetId: analysis.boundReference.assetId,
          evidenceAudioRevision: analysis.boundReference.evidenceAudioRevision,
          evidenceAnalysisRevision: analysis.boundReference.evidenceAnalysisRevision,
          evidenceAudioSha256: analysis.boundReference.evidenceAudioSha256,
          upstreamCommercialRevShareBps: analysis.boundReference.upstreamCommercialRevShareBps,
        },
});
export const RESERVATION_ENDPOINT = "/communities/:communityId/media-upload-reservations";
export const SUBMISSION_ENDPOINT = "/communities/:communityId/media-post-submissions";

export type MediaSubmissionRepositoryOperation =
  | "reserve"
  | "create"
  | "replay"
  | "get"
  | "terms"
  | "finalize"
  | "analysis"
  | "decision"
  | "reference"
  | "review"
  | "moderation"
  | "publish"
  | "retry"
  | "alignment"
  | "attempt"
  | "failure"
  | "abandon";
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
  | "invalid-row"
  | "stale-fence"
  | "post-ownership"
  | "closed-payload";
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
      readonly bytes: Bytes;
      readonly sha256: string;
    }
  | { readonly kind: "conflict"; readonly submissionId: string };
export type ReservationOutcome =
  | {
      readonly kind: "created" | "replay";
      readonly reservationId: string;
      readonly bytes: Bytes;
      readonly sha256: string;
    }
  | { readonly kind: "conflict"; readonly reservationId: string };
export type CreatedSubmission = {
  readonly kind: "created";
  readonly submissionId: string;
  readonly operationId: string;
  readonly bytes: Bytes;
  readonly sha256: string;
};
export type Committed = { readonly kind: "committed"; readonly submissionId: string };

export type ReservationInput = Readonly<{
  communityId: string;
  actorUserId: string;
  personaId: string;
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
  personaId: string;
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
  personaId: string;
  endpointTemplate: string;
  idempotencyKey: string;
  requestHash: string;
  responseBytes: Bytes;
  responseSha256: string;
}>;
export type CommandReplayInput = Omit<
  Pick<
    CommandInput,
    "communityId" | "actorUserId" | "endpointTemplate" | "idempotencyKey" | "requestHash"
  >,
  never
> & {
  readonly personaId: string | null;
};
type ReplayIdentityInput = CommandReplayInput;
export type TermsInput = CommandInput &
  Readonly<{ expectedCreationRevision: number; terms: SongTerms }>;
export type ImmutableObjectInput = Readonly<{
  immutableRef: string;
  destinationRef: string;
  etag: string;
  objectVersion: string;
  sizeBytes: number;
  contentType: string;
  canonicalSha256: string;
}>;
export type MediaOutboxPayload =
  | Readonly<{
      kind: "analysis_launch";
      submission_id: string;
      operation_id: string;
      audio_revision: number;
      analysis_revision: number;
      workflow_revision: number;
      workflow_instance_id: string;
    }>
  | Readonly<{
      kind: "publication";
      submission_id: string;
      operation_id: string;
      post_id: string;
      workflow_revision: number;
      workflow_instance_id: string;
    }>
  | Readonly<{
      kind: "alignment";
      submission_id: string;
      operation_id: string;
      post_id: string;
      workflow_revision: number;
      workflow_instance_id: string;
    }>;
export type OutboxWrite = Readonly<{
  outboxEventId: string;
  effectIdentity: string;
  payload: MediaOutboxPayload;
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
    transcriptArtifact?: Readonly<{
      transcript: string;
      segments: readonly Readonly<{ start_ms: number; end_ms: number; text: string }>[];
    }>;
  }>;
export type DecisionInput = CommandInput &
  Readonly<{
    expectedCreationRevision: number;
    expectedAudioRevision: number;
    expectedAnalysisRevision: number;
    decision: PublicationDecision;
  }>;
export type ReferenceInput = CommandInput &
  Readonly<{ expectedCreationRevision: number; reference: BoundReference }>;
export type ReviewInput = CommandInput &
  Readonly<{ expectedCreationRevision: number; review: ReviewCase }>;
export type ModeratorInput = Omit<CommandInput, "actorUserId" | "personaId"> &
  Readonly<{
    expectedCreationRevision: number;
    action: "approve" | "block";
    approval?: ModeratorApprovalEvidence;
    evidenceRef?: string;
    actor: M2Actor;
    decision?: PublicationDecision;
  }>;
export type RetryInput = CommandInput & Readonly<{ expectedCreationRevision: number }>;
export type FailureInput = CommandInput &
  Readonly<{ expectedCreationRevision: number; failure: ProcessingFailure }>;
export type AbandonInput = CommandInput &
  Readonly<{ expectedCreationRevision: number; nowEpochMs?: number; evidenceRef?: string }>;
export type PublishInput = CommandInput &
  Readonly<{
    expectedCreationRevision: number;
    expectedAudioRevision: number;
    expectedAnalysisRevision: number;
    expectedDecisionRevision: number;
    postId: string;
    outbox: OutboxWrite;
  }>;
export type AlignmentInput = Readonly<{
  communityId: string;
  submissionId: string;
  actorUserId: string;
  personaId: string;
  postId: string;
  audioRevision: number;
  analysisRevision: number;
  canonicalAudioSha256: string;
  outcome: "ready" | "unavailable";
  artifact?: Readonly<{
    artifactRef: string;
    artifactRevision?: number;
    artifactSha256: string;
    artifact: Readonly<Record<string, unknown>>;
  }>;
  failureCode?: MediaAlignmentFailureCode;
}>;
export type MediaAlignmentFailureCode =
  | "elevenlabs_key_missing"
  | "key_invalid"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "invalid_response"
  | "alignment_failed"
  | "lyrics_missing"
  | "audio_missing";
export type ProcessingAttemptStage =
  | "probe"
  | "embedded_metadata"
  | "cover"
  | "transcript"
  | "acr"
  | "lyrics_safety"
  | "media_safety"
  | "publication";
export type ProcessingAttemptInput = Readonly<{
  attemptId: string;
  communityId: string;
  submissionId: string;
  actorUserId: string;
  personaId: string;
  operationId: string;
  audioRevision: number;
  analysisRevision: number;
  stage: ProcessingAttemptStage;
  inputKind: "audio" | "analysis" | "transcript" | "reference" | "publication";
  inputRevision: number;
  policyRevision: string;
  adapterRevision: string;
  inputHash: string;
  providerIdempotencyKey?: string;
  attemptNumber?: number;
}>;
export type ProcessingAttemptClaimInput = Readonly<{
  attemptId: string;
  workerId: string;
  leaseSeconds: number;
}>;
export type ProcessingAttemptCompleteInput = Readonly<{
  attemptId: string;
  workerId: string;
  claimFence: number;
  evidenceRef: string;
  result: Readonly<Record<string, unknown>>;
}>;
export type ProcessingAttemptFailInput = Readonly<{
  attemptId: string;
  workerId: string;
  claimFence: number;
  failureCode: MediaProcessingAttemptFailureCode;
  retryable: boolean;
  nextEligibleAt?: string;
  evidenceRef?: string;
}>;
export type MediaProcessingAttemptFailureCode =
  | ProcessingFailure["code"]
  | MediaAlignmentFailureCode
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_invalid";

export type MediaSubmissionStore = {
  reserve(
    input: ReservationInput,
  ): Effect.Effect<ReservationOutcome, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  createSubmission(
    input: SubmissionInput,
  ): Effect.Effect<
    ReplayOutcome | CreatedSubmission,
    MediaSubmissionRepositoryFailure,
    ControlPlaneDb
  >;
  replay(
    input: CommandReplayInput,
  ): Effect.Effect<ReplayOutcome, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  getForAuthor(input: {
    communityId: string;
    submissionId: string;
    actorUserId: string;
    personaId: string;
  }): Effect.Effect<MediaSubmissionState | null, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  bindTerms(
    input: TermsInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  finalizeSealed(
    input: FinalizeInput,
  ): Effect.Effect<
    ReplayOutcome | (Committed & { immutableRef: string; outboxEventId: string }),
    MediaSubmissionRepositoryFailure,
    ControlPlaneDb
  >;
  acceptAnalysis(
    input: AnalysisInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  recordDecision(
    input: DecisionInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  requireReference(
    input: CommandInput &
      Readonly<{
        expectedCreationRevision: number;
        expectedAudioRevision: number;
        expectedAnalysisRevision: number;
        referenceRequestRef: string;
        actionExpiresAt: string;
      }>,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  bindReference(
    input: ReferenceInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  requireReview(
    input: ReviewInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  moderate(
    input: ModeratorInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  retry(
    input: RetryInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  recordMediaFailure(
    input: FailureInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  recordTechnicalExhaustion(
    input: FailureInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  recordSealConflict(
    input: FailureInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  actionDeadlineElapsed(
    input: AbandonInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  authorCancel(
    input: AbandonInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  reservationExpire(
    input: AbandonInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  uploadExpectationMismatch(
    input: AbandonInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  uploadSourcePreconditionFailed(
    input: AbandonInput,
  ): Effect.Effect<ReplayOutcome | Committed, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  publish(
    input: PublishInput,
  ): Effect.Effect<
    ReplayOutcome | (Committed & { postId: string; outboxEventId: string }),
    MediaSubmissionRepositoryFailure,
    ControlPlaneDb
  >;
  recordAlignment(
    input: AlignmentInput,
  ): Effect.Effect<void, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  recordProcessingAttempt(
    input: ProcessingAttemptInput,
  ): Effect.Effect<void, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  claimProcessingAttempt(
    input: ProcessingAttemptClaimInput,
  ): Effect.Effect<boolean, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  completeProcessingAttempt(
    input: ProcessingAttemptCompleteInput,
  ): Effect.Effect<boolean, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
  failProcessingAttempt(
    input: ProcessingAttemptFailInput,
  ): Effect.Effect<boolean, MediaSubmissionRepositoryFailure, ControlPlaneDb>;
};

const fail = (
  operation: MediaSubmissionRepositoryOperation,
  reason: MediaSubmissionRepositoryReason,
  extra: Partial<Pick<MediaSubmissionRepositoryError, "submissionId" | "reservationId">> = {},
) => new MediaSubmissionRepositoryError({ operation, reason, ...extra });
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.includes("\u0000") &&
  ID.test(value);
const validHash = (value: unknown): value is string =>
  typeof value === "string" && HASH.test(value);
const validRevision = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const bytes = (value: unknown): Bytes | null =>
  value instanceof Uint8Array && value.byteLength > 0 ? new Uint8Array(value) : null;
const integer = (value: unknown): number | null => {
  if (value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const object = (value: unknown): Readonly<Record<string, unknown>> | null => {
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
const snapshot = (input: { responseBytes: Bytes; responseSha256: string }): readonly unknown[] => [
  new Uint8Array(input.responseBytes),
  input.responseSha256,
];
const validSnapshot = (input: { responseBytes: Bytes; responseSha256: string }): boolean =>
  bytes(input.responseBytes) !== null && validHash(input.responseSha256);
const lock = (tx: ControlPlaneTransaction, key: string) =>
  tx.execute({
    label: "media-submission.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    values: [key],
    readonly: false,
  });
const resolvePersonaId = (
  tx: ControlPlaneTransaction,
  accountId: string,
  requestedPersonaId: string,
  operation: MediaSubmissionRepositoryOperation,
) =>
  Effect.gen(function* () {
    const result = yield* tx.execute<Row>({
      label: `media-${operation}.persona`,
      text: "SELECT persona_id FROM personas WHERE account_id=$1 AND persona_id=$2 AND status='active'",
      values: [accountId, requestedPersonaId],
      readonly: true,
    });
    const personaId = result.rows[0]?.persona_id;
    if (!validId(personaId)) return yield* Effect.fail(fail(operation, "invalid-input"));
    return personaId;
  });
const replayKey = (input: ReplayIdentityInput): string =>
  json([input.actorUserId, input.personaId, input.endpointTemplate, input.idempotencyKey]);

function replayFromRow(
  row: Row,
  requestHash: string,
  operation: MediaSubmissionRepositoryOperation,
  expectedCommunityId?: string,
): ReplayOutcome {
  const submissionId = row.submission_id;
  const operationId = row.operation_id;
  const storedHash = row.request_hash;
  const response = bytes(row.response_snapshot_bytes);
  const digest = row.response_snapshot_sha256;
  if (
    !validId(submissionId) ||
    !validId(operationId) ||
    !validHash(storedHash) ||
    response === null ||
    !validHash(digest)
  )
    throw fail(operation, "invalid-row");
  return storedHash === requestHash &&
    (expectedCommunityId === undefined || row.community_id === expectedCommunityId)
    ? { kind: "replay", submissionId, operationId, bytes: response, sha256: digest }
    : { kind: "conflict", submissionId };
}
function reservationReplay(
  row: Row,
  requestHash: string,
  expectedCommunityId?: string,
): ReservationOutcome {
  const reservationId = row.reservation_id;
  const response = bytes(row.response_snapshot_bytes);
  const digest = row.response_snapshot_sha256;
  const storedHash = row.request_hash;
  if (!validId(reservationId) || response === null || !validHash(digest) || !validHash(storedHash))
    throw fail("reserve", "invalid-row");
  return storedHash === requestHash &&
    (expectedCommunityId === undefined || row.community_id === expectedCommunityId)
    ? { kind: "replay", reservationId, bytes: response, sha256: digest }
    : { kind: "conflict", reservationId };
}

const stateSelect = `SELECT s.*, t.terms_snapshot, a.canonical_sha256 AS audio_sha256, a.content_type AS audio_content_type, a.size_bytes AS audio_size_bytes, ae.analysis_snapshot, d.decision_snapshot, r.evidence_ref AS bound_reference_db_evidence_ref, r.inherited_license_preset AS bound_reference_inherited_license_preset, r.inherited_commercial_rev_share_bps AS bound_reference_inherited_share_bps, ap.status AS alignment_status FROM media_post_submissions s LEFT JOIN media_submission_terms t ON t.community_id = s.community_id AND t.actor_user_id = s.actor_user_id AND t.submission_id = s.submission_id AND t.operation_id = s.operation_id AND t.creation_revision = s.current_terms_revision LEFT JOIN media_audio_revisions a ON a.community_id = s.community_id AND a.actor_user_id = s.actor_user_id AND a.submission_id = s.submission_id AND a.operation_id = s.operation_id AND a.audio_revision = s.audio_revision LEFT JOIN media_analysis_evidence ae ON ae.community_id = s.community_id AND ae.actor_user_id = s.actor_user_id AND ae.submission_id = s.submission_id AND ae.operation_id = s.operation_id AND ae.analysis_revision = s.current_analysis_revision LEFT JOIN media_publication_decisions d ON d.community_id = s.community_id AND d.actor_user_id = s.actor_user_id AND d.submission_id = s.submission_id AND d.operation_id = s.operation_id AND d.decision_revision = s.current_decision_revision LEFT JOIN media_reference_evidence r ON r.community_id = s.community_id AND r.actor_user_id = s.actor_user_id AND r.submission_id = s.submission_id AND r.operation_id = s.operation_id AND r.asset_id = s.bound_reference_asset_id AND r.evidence_audio_revision = s.bound_reference_audio_revision AND r.evidence_analysis_revision = s.bound_reference_analysis_revision AND r.evidence_audio_sha256 = s.bound_reference_audio_sha256 LEFT JOIN media_alignment_projections ap ON ap.community_id = s.community_id AND ap.actor_user_id = s.actor_user_id AND ap.submission_id = s.submission_id AND ap.operation_id = s.operation_id`;

function decodeState(
  row: Row,
  operation: MediaSubmissionRepositoryOperation,
): MediaSubmissionState {
  const creationRevision = integer(row.creation_revision);
  const audioRevision = integer(row.audio_revision);
  const analysisRevision = integer(row.analysis_revision);
  const decisionRevision = integer(row.decision_revision);
  const workflowRevision = integer(row.workflow_revision);
  const retryCount = integer(row.retry_count);
  const failureRetryCount =
    row.failure_retry_count === null ? null : integer(row.failure_retry_count);
  const terms = row.terms_snapshot === null ? null : object(row.terms_snapshot);
  const analysis = row.analysis_snapshot === null ? null : object(row.analysis_snapshot);
  const decision = row.decision_snapshot === null ? null : object(row.decision_snapshot);
  const audioSize = row.audio_size_bytes === null ? null : integer(row.audio_size_bytes);
  const personaId = validId(row.author_persona_id) ? row.author_persona_id : null;
  if (
    ![
      row.submission_id,
      row.operation_id,
      row.community_id,
      row.actor_user_id,
      row.title,
      row.audio_reservation_id,
    ].every(validId) ||
    creationRevision === null ||
    audioRevision === null ||
    analysisRevision === null ||
    decisionRevision === null ||
    workflowRevision === null ||
    retryCount === null ||
    (row.status === "processing_failed" && (failureRetryCount === null || failureRetryCount > 3)) ||
    !["original", "remix"].includes(String(row.song_type)) ||
    ![
      "processing",
      "action_required",
      "manual_review",
      "published",
      "blocked",
      "processing_failed",
      "abandoned",
    ].includes(String(row.status)) ||
    ![null, "reserve", "awaiting_upload", "finalize", "analysis", "decision", "publish"].includes(
      row.phase as string | null,
    ) ||
    (audioRevision === 0) !== (row.current_immutable_ref === null) ||
    (audioRevision > 0 &&
      (!validId(row.current_immutable_ref) ||
        !validHash(row.audio_sha256) ||
        !validId(row.audio_content_type) ||
        audioSize === null ||
        audioSize < 1)) ||
    (analysisRevision === 0) !== (analysis === null) ||
    (decisionRevision === 0) !== (decision === null)
  )
    throw fail(
      operation,
      "invalid-row",
      validId(row.submission_id) ? { submissionId: row.submission_id } : {},
    );
  const boundReference =
    row.bound_reference_asset_id === null
      ? null
      : {
          assetId: row.bound_reference_asset_id as string,
          evidenceRef: row.bound_reference_evidence_ref as string,
          evidenceAudioRevision: integer(row.bound_reference_audio_revision) ?? 0,
          evidenceAnalysisRevision: integer(row.bound_reference_analysis_revision) ?? 0,
          evidenceAudioSha256: row.bound_reference_audio_sha256 as string,
          upstreamCommercialRevShareBps:
            row.bound_reference_upstream_share_bps === null
              ? null
              : (integer(row.bound_reference_upstream_share_bps) ?? -1),
          ...(row.bound_reference_inherited_license_preset === null
            ? {}
            : {
                inheritedLicensePreset: row.bound_reference_inherited_license_preset as NonNullable<
                  BoundReference["inheritedLicensePreset"]
                >,
              }),
          ...(row.bound_reference_inherited_share_bps === null
            ? { inheritedCommercialRevShareBps: null }
            : { inheritedCommercialRevShareBps: integer(row.bound_reference_inherited_share_bps) }),
        };
  const storedAnalysis = analysis as TrustedSongAnalysis | null;
  const storedBoundReference = storedAnalysis?.boundReference ?? null;
  const boundReferenceCore =
    boundReference === null
      ? null
      : {
          assetId: boundReference.assetId,
          evidenceAudioRevision: boundReference.evidenceAudioRevision,
          evidenceAnalysisRevision: boundReference.evidenceAnalysisRevision,
          evidenceAudioSha256: boundReference.evidenceAudioSha256,
          upstreamCommercialRevShareBps: boundReference.upstreamCommercialRevShareBps,
        };
  if (
    storedAnalysis !== null &&
    storedBoundReference !== null &&
    canonicalJson(storedBoundReference) !== canonicalJson(boundReferenceCore)
  )
    throw fail(
      operation,
      "invalid-row",
      validId(row.submission_id) ? { submissionId: row.submission_id } : {},
    );
  const projectedAnalysis =
    storedAnalysis === null
      ? null
      : ({
          ...storedAnalysis,
          boundReference:
            boundReference === null
              ? null
              : storedBoundReference === null
                ? boundReference
                : {
                    ...storedBoundReference,
                    evidenceRef: boundReference.evidenceRef,
                    ...(boundReference.inheritedLicensePreset === undefined
                      ? {}
                      : { inheritedLicensePreset: boundReference.inheritedLicensePreset }),
                    ...(boundReference.inheritedCommercialRevShareBps === undefined
                      ? {}
                      : {
                          inheritedCommercialRevShareBps:
                            boundReference.inheritedCommercialRevShareBps,
                        }),
                  },
        } satisfies TrustedSongAnalysis);
  const action =
    row.action_kind === null
      ? null
      : {
          kind: "reference_required" as const,
          referenceRequestRef: row.action_reference_request_ref as string,
          expiresAt: String(row.action_expires_at),
          heldRevision: integer(row.held_revision) ?? creationRevision,
        };
  const review =
    row.review_ref === null
      ? null
      : {
          reviewRef: row.review_ref as string,
          heldRevision: integer(row.held_revision) ?? creationRevision,
          reasonCode: row.review_reason_code as "review_required" | "moderation_unavailable",
          ...(row.review_exhaustion_code === null
            ? {}
            : {
                exhaustionCode: row.review_exhaustion_code as "acr_exhausted",
                exhaustionAttemptId: row.review_exhaustion_attempt_id as string,
              }),
        };
  const failure =
    row.failure_code === null
      ? null
      : {
          code: row.failure_code as ProcessingFailure["code"],
          retryable: row.retryable === true,
          retryCount: Math.min(3, failureRetryCount ?? retryCount) as 0 | 1 | 2 | 3,
          lastSafePhase: row.last_safe_phase as Exclude<MediaSubmissionState["phase"], null>,
        };
  return {
    submissionId: row.submission_id as string,
    operationId: row.operation_id as string,
    communityId: row.community_id as string,
    actorId: row.actor_user_id as string,
    personaId: personaId as string,
    title: row.title as string,
    songType: row.song_type as SongType,
    reservationId: row.audio_reservation_id as string,
    creationRevision,
    audioRevision,
    analysisRevision,
    decisionRevision,
    workflowRevision,
    retryCount,
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
    analysis: projectedAnalysis,
    boundReference,
    decision: decision as PublicationDecision | null,
    action,
    review,
    moderatorApproval:
      row.moderator_action_id === null
        ? row.moderator_actor_id !== null ||
          row.moderator_evidence_ref !== null ||
          row.moderator_approval_kind !== null ||
          row.moderator_reason_code !== null
          ? (() => {
              throw fail(operation, "invalid-row");
            })()
          : null
        : row.moderator_reason_code === "policy_violation"
          ? row.moderator_approval_kind !== null ||
            !validId(row.moderator_actor_id) ||
            !validId(row.moderator_evidence_ref)
            ? (() => {
                throw fail(operation, "invalid-row");
              })()
            : ({
                actionId: row.moderator_action_id as string,
                moderatorActorId: row.moderator_actor_id as string,
                evidenceRef: row.moderator_evidence_ref as string,
                reasonCode: "policy_violation",
                heldRevision: integer(row.held_revision) ?? creationRevision,
              } satisfies ModeratorBlockEvidence)
          : row.moderator_approval_kind !== "standard" &&
              row.moderator_approval_kind !== "acr_override"
            ? (() => {
                throw fail(operation, "invalid-row");
              })()
            : !validId(row.moderator_action_id) ||
                !validId(row.moderator_actor_id) ||
                !validId(row.moderator_evidence_ref)
              ? (() => {
                  throw fail(operation, "invalid-row");
                })()
              : row.moderator_reason_code !== null &&
                  !["acr_inconclusive", "acr_exhausted", "acr_skipped"].includes(
                    String(row.moderator_reason_code),
                  )
                ? (() => {
                    throw fail(operation, "invalid-row");
                  })()
                : {
                    actionId: row.moderator_action_id as string,
                    moderatorActorId: row.moderator_actor_id as string,
                    evidenceRef: row.moderator_evidence_ref as string,
                    approvalKind: row.moderator_approval_kind as "standard" | "acr_override",
                    reasonCode:
                      row.moderator_reason_code as ModeratorApprovalEvidence["reasonCode"],
                    heldRevision: integer(row.held_revision) ?? creationRevision,
                  },
    failure,
    abandonment:
      row.abandonment_reason === null
        ? null
        : {
            reason: row.abandonment_reason as
              | "author_cancelled"
              | "reservation_expired"
              | "action_deadline_elapsed"
              | "upload_expectation_mismatch"
              | "upload_source_changed_before_finalize",
            retentionDisposition: row.retention_disposition as
              | "no_object"
              | "retain_for_reconciliation"
              | "retain_until_expiry",
          },
    postId: row.post_id === null ? null : (row.post_id as string),
  };
}

const loadState = (
  tx: ControlPlaneTransaction,
  input: {
    communityId: string;
    submissionId: string;
    actorUserId: string;
    personaId?: string;
  },
  operation: MediaSubmissionRepositoryOperation,
  forUpdate: boolean,
) =>
  Effect.gen(function* () {
    const result = yield* tx.execute<Row>({
      label: `media-submission.${operation}.load`,
      text: `${stateSelect} WHERE s.community_id=$1 AND s.submission_id=$2 AND s.actor_user_id=$3 AND ($4::text IS NULL OR s.author_persona_id=$4) ${forUpdate ? "FOR UPDATE OF s" : ""}`,
      values: [input.communityId, input.submissionId, input.actorUserId, input.personaId ?? null],
      readonly: !forUpdate,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return yield* Effect.fail(fail(operation, "invalid-row"));
    return yield* Effect.try({
      try: () => decodeState(result.rows[0] as Row, operation),
      catch: (error) =>
        error instanceof MediaSubmissionRepositoryError ? error : fail(operation, "invalid-row"),
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
            result.rejection._tag === "stale_revision" ? "stale-revision" : "transition-rejected",
            current === null ? {} : { submissionId: current.submissionId },
          ),
        );
  });
const replayInTx = (
  tx: ControlPlaneTransaction,
  input: ReplayIdentityInput,
  operation: MediaSubmissionRepositoryOperation,
) =>
  Effect.gen(function* () {
    yield* lock(tx, replayKey(input));
    const result = yield* tx.execute<Row>({
      label: `media-submission.${operation}.replay`,
      text: "SELECT community_id,submission_id,operation_id,request_hash,response_snapshot_bytes,response_snapshot_sha256,actor_persona_id FROM media_submission_command_replays WHERE actor_account_id=$1 AND actor_persona_id IS NOT DISTINCT FROM $2 AND endpoint_template=$3 AND idempotency_key=$4 FOR UPDATE",
      values: [input.actorUserId, input.personaId, input.endpointTemplate, input.idempotencyKey],
      readonly: false,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return yield* Effect.fail(fail(operation, "invalid-row"));
    return yield* Effect.try({
      try: () =>
        replayFromRow(result.rows[0] as Row, input.requestHash, operation, input.communityId),
      catch: (error) =>
        error instanceof MediaSubmissionRepositoryError ? error : fail(operation, "invalid-row"),
    });
  });
const insertReplay = (
  tx: ControlPlaneTransaction,
  input:
    | CommandInput
    | (SubmissionInput & { endpointTemplate: string })
    | (Omit<CommandInput, "personaId"> & { personaId: null }),
  operationId: string,
  submissionActorUserId = input.actorUserId,
) =>
  tx.execute({
    label: "media-submission.replay.insert",
    text: "INSERT INTO media_submission_command_replays (community_id,actor_user_id,actor_persona_id,submission_actor_user_id,submission_author_persona_id,endpoint_template,idempotency_key,request_hash,submission_id,operation_id,response_snapshot_bytes,response_snapshot_sha256) VALUES ($1,$2,$3,$4,(SELECT author_persona_id FROM media_post_submissions WHERE community_id=$1 AND actor_user_id=$4 AND operation_id=$9),$5,$6,$7,COALESCE($8,(SELECT submission_id FROM media_post_submissions WHERE community_id=$1 AND actor_user_id=$4 AND operation_id=$9)),$9,$10,$11)",
    values: [
      input.communityId,
      input.actorUserId,
      input.personaId,
      submissionActorUserId,
      input.endpointTemplate,
      input.idempotencyKey,
      input.requestHash,
      input.submissionId ?? null,
      operationId,
      ...snapshot(input),
    ],
    readonly: false,
  });
const insertEvent = (
  tx: ControlPlaneTransaction,
  state: MediaSubmissionState,
  sequence: number,
  eventKind: string,
  evidence: Readonly<Record<string, unknown>>,
) =>
  tx.execute({
    label: `media-submission.event.${eventKind}`,
    text: "INSERT INTO media_submission_events (submission_id,community_id,actor_user_id,author_persona_id,operation_id,event_sequence,event_id,event_kind,creation_revision,audio_revision,analysis_revision,decision_revision,workflow_revision,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)",
    values: [
      state.submissionId,
      state.communityId,
      state.actorId,
      state.personaId,
      state.operationId,
      sequence,
      `media-event-${crypto.randomUUID()}`,
      eventKind,
      state.creationRevision,
      state.audioRevision,
      state.analysisRevision,
      state.decisionRevision,
      state.workflowRevision,
      json({
        ...evidence,
        event_kind: eventKind,
        ...(state.review?.exhaustionAttemptId === undefined
          ? {}
          : { exhaustion_attempt_id: state.review.exhaustionAttemptId }),
      }),
    ],
    readonly: false,
  });
const insertOutbox = (
  tx: ControlPlaneTransaction,
  state: MediaSubmissionState,
  eventType: "analysis_launch" | "publication" | "alignment",
  outbox: OutboxWrite,
) =>
  tx.execute({
    label: `media-submission.outbox.${eventType}`,
    text: "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,author_persona_id,operation_id,creation_revision,audio_revision,analysis_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)",
    values: [
      outbox.outboxEventId,
      state.submissionId,
      state.communityId,
      state.actorId,
      state.personaId,
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
const validCommand = (input: CommandInput): boolean =>
  validId(input.communityId) &&
  validId(input.submissionId) &&
  validId(input.actorUserId) &&
  validId(input.personaId) &&
  validId(input.endpointTemplate) &&
  validId(input.idempotencyKey) &&
  validHash(input.requestHash) &&
  validSnapshot(input);
const validAccountCommand = (input: Omit<CommandInput, "personaId">): boolean =>
  validId(input.communityId) &&
  validId(input.submissionId) &&
  validId(input.actorUserId) &&
  validId(input.endpointTemplate) &&
  validId(input.idempotencyKey) &&
  validHash(input.requestHash) &&
  validSnapshot(input);

export function makeControlPlaneMediaSubmissionRepository(): MediaSubmissionStore {
  const replay: MediaSubmissionStore["replay"] = (input) =>
    Effect.gen(function* () {
      if (
        ![input.communityId, input.actorUserId, input.endpointTemplate, input.idempotencyKey].every(
          validId,
        ) ||
        (input.personaId !== null && !validId(input.personaId)) ||
        !validHash(input.requestHash)
      )
        return yield* Effect.fail(fail("replay", "invalid-input"));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-submission.replay",
        text: "SELECT community_id,submission_id,operation_id,request_hash,response_snapshot_bytes,response_snapshot_sha256 FROM media_submission_command_replays WHERE actor_account_id=$1 AND actor_persona_id IS NOT DISTINCT FROM $2 AND endpoint_template=$3 AND idempotency_key=$4",
        values: [input.actorUserId, input.personaId, input.endpointTemplate, input.idempotencyKey],
        readonly: true,
      });
      if (result.rows.length === 0) return { kind: "none" } as const;
      if (result.rows.length !== 1) return yield* Effect.fail(fail("replay", "invalid-row"));
      return yield* Effect.try({
        try: () =>
          replayFromRow(result.rows[0] as Row, input.requestHash, "replay", input.communityId),
        catch: (error) =>
          error instanceof MediaSubmissionRepositoryError ? error : fail("replay", "invalid-row"),
      });
    });

  const reserve: MediaSubmissionStore["reserve"] = (input) =>
    Effect.gen(function* () {
      if (
        ![
          input.communityId,
          input.actorUserId,
          input.personaId,
          input.idempotencyKey,
          input.expectedContentType,
          input.uploadUrl,
        ].every(validId) ||
        !validHash(input.requestHash) ||
        !validRevision(input.expectedSizeBytes, 1) ||
        (input.expectedSha256 !== undefined && !validHash(input.expectedSha256)) ||
        !Number.isFinite(Date.parse(input.expiresAt)) ||
        !validSnapshot(input)
      )
        return yield* Effect.fail(fail("reserve", "invalid-input"));
      const reservationId = input.reservationId ?? `media-reservation-${crypto.randomUUID()}`;
      if (!validId(reservationId))
        return yield* Effect.fail(fail("reserve", "invalid-input", { reservationId }));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const personaId = yield* resolvePersonaId(
            tx,
            input.actorUserId,
            input.personaId,
            "reserve",
          );
          yield* lock(
            tx,
            json([input.actorUserId, personaId, RESERVATION_ENDPOINT, input.idempotencyKey]),
          );
          const prior = yield* tx.execute<Row>({
            label: "media-reservation.replay",
            text: "SELECT community_id,reservation_id,request_hash,response_snapshot_bytes,response_snapshot_sha256,actor_persona_id FROM media_upload_reservations WHERE actor_account_id=$1 AND actor_persona_id=$2 AND endpoint_template=$3 AND idempotency_key=$4 FOR UPDATE",
            values: [input.actorUserId, personaId, RESERVATION_ENDPOINT, input.idempotencyKey],
            readonly: false,
          });
          if (prior.rows.length === 1)
            return reservationReplay(prior.rows[0] as Row, input.requestHash, input.communityId);
          if (prior.rows.length > 1) return yield* Effect.fail(fail("reserve", "invalid-row"));
          const authority = yield* tx.execute<Row>({
            label: "media-reservation.authority",
            text: "SELECT (c.status='active' AND m.status='member') AS allowed FROM communities c JOIN community_memberships m ON m.community_id=c.community_id AND m.user_id=$2 WHERE c.community_id=$1 FOR SHARE",
            values: [input.communityId, input.actorUserId],
            readonly: false,
          });
          if (authority.rows.length !== 1 || authority.rows[0]?.allowed !== true)
            return yield* Effect.fail(fail("reserve", "membership-required"));
          const inserted = yield* tx.execute({
            label: "media-reservation.insert",
            text: "INSERT INTO media_upload_reservations (reservation_id,community_id,actor_user_id,actor_persona_id,idempotency_key,request_hash,expected_content_type,expected_size_bytes,expected_sha256,upload_url,upload_headers,expires_at,response_snapshot_bytes,response_snapshot_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz,$13,$14)",
            values: [
              reservationId,
              input.communityId,
              input.actorUserId,
              personaId,
              input.idempotencyKey,
              input.requestHash,
              input.expectedContentType,
              input.expectedSizeBytes,
              input.expectedSha256 ?? null,
              input.uploadUrl,
              json(input.uploadHeaders ?? []),
              input.expiresAt,
              ...snapshot(input),
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
        ![
          input.communityId,
          input.actorUserId,
          input.personaId,
          input.idempotencyKey,
          input.title,
          input.reservationId,
        ].every(validId) ||
        !validHash(input.requestHash) ||
        input.title.length > 200 ||
        !["original", "remix"].includes(input.songType) ||
        !validSnapshot(input)
      )
        return yield* Effect.fail(fail("create", "invalid-input"));
      const submissionId = input.submissionId ?? `media-submission-${crypto.randomUUID()}`;
      const operationId = input.operationId ?? `media-operation-${crypto.randomUUID()}`;
      if (!validId(submissionId) || !validId(operationId))
        return yield* Effect.fail(fail("create", "invalid-input"));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const personaId = yield* resolvePersonaId(
            tx,
            input.actorUserId,
            input.personaId,
            "create",
          );
          const replayInput = {
            communityId: input.communityId,
            actorUserId: input.actorUserId,
            personaId,
            endpointTemplate: SUBMISSION_ENDPOINT,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
          };
          const prior = yield* replayInTx(tx, replayInput, "create");
          if (prior !== null) return prior;
          const next = {
            ...(yield* reduce("create", null, {
              event: "submission_reserved",
              actorId: input.actorUserId,
              expectedCreationRevision: 0,
              submissionId,
              operationId,
              communityId: input.communityId,
              personaId,
              title: input.title,
              songType: input.songType,
              reservationId: input.reservationId,
            })),
          } satisfies MediaSubmissionState;
          const inserted = yield* tx.execute({
            label: "media-submission.create",
            text: "INSERT INTO media_post_submissions (submission_id,community_id,actor_user_id,author_persona_id,operation_id,idempotency_key,request_hash,title,song_type,phase,start_input,audio_reservation_id,response_snapshot_bytes,response_snapshot_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserve',$10::jsonb,$11,$12,$13)",
            values: [
              submissionId,
              input.communityId,
              input.actorUserId,
              personaId,
              operationId,
              input.idempotencyKey,
              input.requestHash,
              input.title,
              input.songType,
              json({
                version: "song-start-input-v1",
                title: input.title,
                audio_reservation_id: input.reservationId,
                song_type: input.songType,
                persona_id: personaId,
              }),
              input.reservationId,
              ...snapshot(input),
            ],
            readonly: false,
          });
          if (inserted.rowCount !== 1)
            return yield* Effect.fail(fail("create", "constraint", { submissionId }));
          yield* insertEvent(tx, next, 1, "submission_reserved", {});
          const claimed = yield* tx.execute({
            label: "media-reservation.claim",
            text: "UPDATE media_upload_reservations SET state='claimed',submission_id=$1,operation_id=$2,claim_fence=claim_fence+1,updated_at=clock_timestamp() WHERE community_id=$3 AND actor_user_id=$4 AND reservation_id=$5 AND state='issued' AND expires_at>clock_timestamp()",
            values: [
              submissionId,
              operationId,
              input.communityId,
              input.actorUserId,
              input.reservationId,
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
          yield* tx.execute({
            label: "media-moderation.create",
            text: "INSERT INTO media_moderation_projections (submission_id,community_id,actor_user_id,operation_id,status,author_persona_id) VALUES ($1,$2,$3,$4,'none',$5)",
            values: [
              submissionId,
              input.communityId,
              input.actorUserId,
              operationId,
              next.personaId,
            ],
            readonly: false,
          });
          const issued = yield* reduce("create", next, {
            event: "media_reservation_issued",
            actorId: input.actorUserId,
            expectedCreationRevision: next.creationRevision,
          });
          const issuedRow = yield* tx.execute({
            label: "media-submission.reservation-issued",
            text: "UPDATE media_post_submissions SET phase='awaiting_upload',event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$1 AND actor_user_id=$2 AND submission_id=$3 AND operation_id=$4 AND status='processing' AND phase='reserve' AND event_sequence=1 RETURNING event_sequence",
            values: [input.communityId, input.actorUserId, submissionId, operationId],
            readonly: false,
          });
          if (issuedRow.rowCount !== 1)
            return yield* Effect.fail(fail("create", "constraint", { submissionId }));
          yield* insertEvent(tx, issued, 2, "media_reservation_issued", {});
          yield* insertReplay(tx, { ...input, endpointTemplate: SUBMISSION_ENDPOINT }, operationId);
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
        ![input.communityId, input.submissionId, input.actorUserId, input.personaId].every(validId)
      )
        return yield* Effect.fail(
          fail("get", "invalid-input", { submissionId: input.submissionId }),
        );
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-submission.get",
        text: `${stateSelect} WHERE s.community_id=$1 AND s.submission_id=$2 AND s.actor_user_id=$3 AND s.author_persona_id=$4`,
        values: [input.communityId, input.submissionId, input.actorUserId, input.personaId],
        readonly: true,
      });
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1)
        return yield* Effect.fail(fail("get", "invalid-row", { submissionId: input.submissionId }));
      return yield* Effect.try({
        try: () => decodeState(result.rows[0] as Row, "get"),
        catch: (error) =>
          error instanceof MediaSubmissionRepositoryError
            ? error
            : fail("get", "invalid-row", { submissionId: input.submissionId }),
      });
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
          yield* resolvePersonaId(tx, input.actorUserId, input.personaId, "terms");
          const prior = yield* replayInTx(tx, input, "terms");
          if (prior !== null) return prior;
          const current = yield* loadState(tx, input, "terms", true);
          if (current === null)
            return yield* Effect.fail(
              fail("terms", "not-found", { submissionId: input.submissionId }),
            );
          const next = yield* reduce("terms", current, {
            event: "song_terms_bound",
            actorId: input.actorUserId,
            expectedCreationRevision: input.expectedCreationRevision,
            terms: input.terms,
          });
          yield* tx.execute({
            label: "media-terms.insert",
            text: "INSERT INTO media_submission_terms (submission_id,community_id,actor_user_id,operation_id,creation_revision,license_preset,commercial_remix_share_bps,royalty_allocations,access_mode,terms_snapshot,author_persona_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11)",
            values: [
              current.submissionId,
              current.communityId,
              current.actorId,
              current.operationId,
              next.creationRevision,
              input.terms.licensePreset,
              input.terms.commercialRemixShareBps,
              json(input.terms.royaltyAllocations),
              input.terms.accessMode,
              json(input.terms),
              current.personaId,
            ],
            readonly: false,
          });
          const updated = yield* tx.execute<Row>({
            label: "media-terms.project",
            text: "UPDATE media_post_submissions SET creation_revision=$1,current_terms_revision=$1,decision_revision=0,current_decision_revision=NULL,status=$2,phase=$3,action_kind=NULL,action_reference_request_ref=NULL,action_expires_at=NULL,review_ref=NULL,review_reason_code=NULL,review_exhaustion_code=NULL,review_exhaustion_attempt_id=NULL,held_revision=NULL,moderator_action_id=NULL,moderator_actor_id=NULL,moderator_evidence_ref=NULL,moderator_approval_kind=NULL,moderator_reason_code=NULL,failure_code=NULL,failure_retry_count=NULL,retryable=NULL,last_safe_phase=NULL,abandonment_reason=NULL,retention_disposition=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$4 AND actor_user_id=$5 AND submission_id=$6 AND creation_revision=$7 RETURNING event_sequence",
            values: [
              next.creationRevision,
              next.status,
              next.phase,
              current.communityId,
              current.actorId,
              current.submissionId,
              current.creationRevision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail("terms", "stale-revision", { submissionId: current.submissionId }),
            );
          const sequence = integer(updated.rows[0]?.event_sequence);
          if (sequence === null) return yield* Effect.fail(fail("terms", "invalid-row"));
          if (current.status === "action_required" || current.status === "manual_review") {
            const projection = yield* tx.execute({
              label: "media-moderation.supersede",
              text: "UPDATE media_moderation_projections SET status='closed',decision_revision=NULL,review_ref=NULL,held_revision=NULL,review_exhaustion_code=NULL,review_exhaustion_attempt_id=NULL,action_kind=NULL,moderator_action_id=NULL,moderator_actor_id=NULL,action_evidence_ref=NULL,updated_at=clock_timestamp() WHERE community_id=$1 AND actor_user_id=$2 AND submission_id=$3 AND operation_id=$4",
              values: [
                current.communityId,
                current.actorId,
                current.submissionId,
                current.operationId,
              ],
              readonly: false,
            });
            if (projection.rowCount !== 1)
              return yield* Effect.fail(
                fail("terms", "constraint", { submissionId: current.submissionId }),
              );
          }
          yield* insertEvent(tx, next, sequence, "song_terms_bound", {});
          yield* insertReplay(tx, input, current.operationId);
          return { kind: "committed", submissionId: current.submissionId } as const;
        }),
      );
    });

  const finalizeSealed: MediaSubmissionStore["finalizeSealed"] = (input) =>
    Effect.gen(function* () {
      if (
        !validCommand(input) ||
        !validRevision(input.expectedCreationRevision, 1) ||
        !validRevision(input.expectedAudioRevision) ||
        !validId(input.reservationId) ||
        !validId(input.outbox.outboxEventId) ||
        !validId(input.outbox.effectIdentity)
      )
        return yield* Effect.fail(
          fail("finalize", "invalid-input", { submissionId: input.submissionId }),
        );
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* resolvePersonaId(tx, input.actorUserId, input.personaId, "finalize");
          const prior = yield* replayInTx(tx, input, "finalize");
          if (prior !== null) return prior;
          const current = yield* loadState(tx, input, "finalize", true);
          if (current === null)
            return yield* Effect.fail(
              fail("finalize", "not-found", { submissionId: input.submissionId }),
            );
          if (input.reservationId !== current.reservationId)
            return yield* Effect.fail(
              fail("finalize", "reservation-conflict", { submissionId: current.submissionId }),
            );
          const audio: ImmutableAudio = {
            audioRevision: 1,
            immutableRef: input.immutableObject.immutableRef,
            canonicalSha256: input.immutableObject.canonicalSha256,
            contentType: input.immutableObject.contentType,
            sizeBytes: input.immutableObject.sizeBytes,
          };
          const next = yield* reduce("finalize", current, {
            event: "upload_finalized",
            actorId: input.actorUserId,
            expectedCreationRevision: input.expectedCreationRevision,
            expectedAudioRevision: input.expectedAudioRevision,
            audio,
          });
          yield* tx.execute({
            label: "media-object.insert",
            text: "INSERT INTO media_immutable_objects (immutable_ref,community_id,actor_user_id,reservation_id,submission_id,operation_id,destination_ref,etag,object_version,size_bytes,content_type,canonical_sha256,author_persona_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
            values: [
              input.immutableObject.immutableRef,
              current.communityId,
              current.actorId,
              input.reservationId,
              current.submissionId,
              current.operationId,
              input.immutableObject.destinationRef,
              input.immutableObject.etag,
              input.immutableObject.objectVersion,
              input.immutableObject.sizeBytes,
              input.immutableObject.contentType,
              input.immutableObject.canonicalSha256,
              current.personaId,
            ],
            readonly: false,
          });
          yield* tx.execute({
            label: "media-audio.insert",
            text: "INSERT INTO media_audio_revisions (submission_id,community_id,actor_user_id,operation_id,audio_revision,immutable_ref,canonical_sha256,content_type,size_bytes,author_persona_id) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9)",
            values: [
              current.submissionId,
              current.communityId,
              current.actorId,
              current.operationId,
              audio.immutableRef,
              audio.canonicalSha256,
              audio.contentType,
              audio.sizeBytes,
              current.personaId,
            ],
            readonly: false,
          });
          const updated = yield* tx.execute<Row>({
            label: "media-finalize.project",
            text: "UPDATE media_post_submissions SET audio_revision=1,current_immutable_ref=$1,workflow_revision=$2,status='processing',phase='analysis',event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$3 AND actor_user_id=$4 AND submission_id=$5 AND creation_revision=$6 AND audio_revision=0 RETURNING event_sequence",
            values: [
              audio.immutableRef,
              next.workflowRevision,
              current.communityId,
              current.actorId,
              current.submissionId,
              current.creationRevision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail("finalize", "stale-revision", { submissionId: current.submissionId }),
            );
          const sequence = integer(updated.rows[0]?.event_sequence);
          if (sequence === null) return yield* Effect.fail(fail("finalize", "invalid-row"));
          yield* tx.execute({
            label: "media-reservation.seal",
            text: "UPDATE media_upload_reservations SET state='sealed',updated_at=clock_timestamp() WHERE community_id=$1 AND actor_user_id=$2 AND reservation_id=$3 AND submission_id=$4 AND operation_id=$5 AND state='claimed'",
            values: [
              current.communityId,
              current.actorId,
              input.reservationId,
              current.submissionId,
              current.operationId,
            ],
            readonly: false,
          });
          yield* insertOutbox(tx, next, "analysis_launch", input.outbox);
          yield* insertEvent(tx, next, sequence, "upload_finalized", {
            immutable_ref: audio.immutableRef,
            canonical_audio_sha256: audio.canonicalSha256,
          });
          yield* insertReplay(tx, input, current.operationId);
          return {
            kind: "committed",
            submissionId: current.submissionId,
            immutableRef: audio.immutableRef,
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
        !validHash(input.expectedCanonicalAudioSha256) ||
        (input.analysis.speechLyrics.status === "ready" &&
          (input.transcriptArtifact === undefined ||
            input.transcriptArtifact.transcript.length > 200_000 ||
            input.transcriptArtifact.segments.reduce(
              (total, segment) => total + segment.text.length,
              0,
            ) > 200_000 ||
            input.transcriptArtifact.segments.length > 10_000 ||
            !input.transcriptArtifact.segments.every(
              (segment, index, all) =>
                Number.isSafeInteger(segment.start_ms) &&
                Number.isSafeInteger(segment.end_ms) &&
                segment.start_ms >= 0 &&
                segment.end_ms >= segment.start_ms &&
                segment.end_ms <= 86_400_000 &&
                segment.text.length <= 4096 &&
                (index === 0 || segment.start_ms >= (all[index - 1]?.start_ms ?? -1)),
            ))) ||
        (input.analysis.speechLyrics.status === "ready" &&
          sha256Text(input.transcriptArtifact?.transcript ?? "") !==
            input.analysis.speechLyrics.transcriptSha256)
      )
        return yield* Effect.fail(
          fail("analysis", "invalid-input", { submissionId: input.submissionId }),
        );
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* resolvePersonaId(tx, input.actorUserId, input.personaId, "analysis");
          const prior = yield* replayInTx(tx, input, "analysis");
          if (prior !== null) return prior;
          const current = yield* loadState(tx, input, "analysis", true);
          if (current === null)
            return yield* Effect.fail(
              fail("analysis", "not-found", { submissionId: input.submissionId }),
            );
          const next = yield* reduce("analysis", current, {
            event: "blocking_analysis_completed",
            actorId: input.actorUserId,
            expectedAudioRevision: input.expectedAudioRevision,
            expectedCanonicalAudioSha256: input.expectedCanonicalAudioSha256,
            analysis: input.analysis,
          });
          const cover = input.analysis.embeddedMetadata.cover;
          const speech = input.analysis.speechLyrics;
          const bound = input.analysis.boundReference;
          if (bound !== null) {
            yield* tx.execute({
              label: "media-reference.evidence",
              text: "INSERT INTO media_reference_evidence (community_id,actor_user_id,submission_id,operation_id,asset_id,evidence_audio_revision,evidence_analysis_revision,evidence_audio_sha256,evidence_ref,upstream_commercial_rev_share_bps,inherited_license_preset,inherited_commercial_rev_share_bps,author_persona_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (community_id,actor_user_id,submission_id,operation_id,asset_id,evidence_audio_revision,evidence_analysis_revision,evidence_audio_sha256) DO NOTHING",
              values: [
                current.communityId,
                current.actorId,
                current.submissionId,
                current.operationId,
                bound.assetId,
                bound.evidenceAudioRevision,
                bound.evidenceAnalysisRevision,
                bound.evidenceAudioSha256,
                bound.evidenceRef ?? null,
                bound.upstreamCommercialRevShareBps,
                bound.inheritedLicensePreset ?? null,
                bound.inheritedCommercialRevShareBps ?? null,
                current.personaId,
              ],
              readonly: false,
            });
          }
          if (speech.status === "ready") {
            yield* tx.execute({
              label: "media-transcript.insert",
              text: "INSERT INTO media_transcript_artifacts (transcript_artifact_ref,community_id,actor_user_id,submission_id,operation_id,audio_revision,analysis_revision,canonical_audio_sha256,transcript_sha256,transcript_text,segments,author_persona_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)",
              values: [
                speech.transcriptArtifactRef,
                current.communityId,
                current.actorId,
                current.submissionId,
                current.operationId,
                current.audioRevision,
                next.analysisRevision,
                input.analysis.canonicalAudioSha256,
                speech.transcriptSha256,
                input.transcriptArtifact?.transcript ?? null,
                json(input.transcriptArtifact?.segments ?? []),
                current.personaId,
              ],
              readonly: false,
            });
          }
          yield* tx.execute({
            label: "media-analysis.insert",
            text: "INSERT INTO media_analysis_evidence (submission_id,community_id,actor_user_id,operation_id,analysis_version,audio_revision,analysis_revision,canonical_audio_sha256,finalized_audio_ref,probe_evidence_ref,embedded_metadata_evidence_ref,embedded_metadata_adapter_revision,embedded_title,embedded_title_provenance,cover_status,cover_artifact_ref,cover_artifact_sha256,cover_media_type,cover_width,cover_height,cover_normalization_revision,cover_safety_policy_revision,cover_facts,speech_status,transcript_artifact_ref,transcript_sha256,explicitness,primary_language_bcp47,secondary_language_bcp47,speech_evidence_ref,speech_policy_revision,speech_adapter_revision,acr_decision,acr_evidence_ref,acr_policy_revision,acr_adapter_revision,media_safety,lyrics_safety,bound_reference_asset_id,bound_reference_audio_revision,bound_reference_analysis_revision,bound_reference_audio_sha256,bound_reference_upstream_share_bps,analysis_snapshot,author_persona_id) VALUES ($1,$2,$3,$4,'song-trusted-analysis-v1',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43::jsonb,$44)",
            values: [
              current.submissionId,
              current.communityId,
              current.actorId,
              current.operationId,
              input.analysis.audioRevision,
              next.analysisRevision,
              input.analysis.canonicalAudioSha256,
              input.analysis.finalizedAudioRef,
              input.analysis.probeEvidenceRef,
              input.analysis.embeddedMetadata.evidenceRef,
              input.analysis.embeddedMetadata.adapterRevision,
              input.analysis.embeddedMetadata.trackTitle,
              input.analysis.embeddedMetadata.trackTitle === null ? "absent" : "embedded",
              cover.status,
              cover.status === "ready" ? cover.artifactRef : null,
              cover.status === "ready" ? cover.artifactSha256 : null,
              cover.status === "ready" ? cover.mediaType : null,
              cover.status === "ready" ? cover.width : null,
              cover.status === "ready" ? cover.height : null,
              cover.status === "ready" ? cover.normalizationRevision : null,
              cover.status === "ready" ? cover.safetyPolicyRevision : null,
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
              input.analysis.acr.decision,
              input.analysis.acr.evidenceRef,
              input.analysis.acr.policyRevision,
              input.analysis.acr.adapterRevision,
              input.analysis.mediaSafety,
              input.analysis.lyricsSafety,
              bound?.assetId ?? null,
              bound?.evidenceAudioRevision ?? null,
              bound?.evidenceAnalysisRevision ?? null,
              bound?.evidenceAudioSha256 ?? null,
              bound?.upstreamCommercialRevShareBps ?? null,
              json(trustedAnalysisSnapshot(input.analysis)),
              current.personaId,
            ],
            readonly: false,
          });
          const updated = yield* tx.execute<Row>({
            label: "media-analysis.project",
            text: "UPDATE media_post_submissions SET analysis_revision=$1,current_analysis_revision=$1,decision_revision=0,current_decision_revision=NULL,status='processing',phase=$2,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$3 AND actor_user_id=$4 AND submission_id=$5 AND audio_revision=$6 AND analysis_revision=$7 RETURNING event_sequence",
            values: [
              next.analysisRevision,
              next.phase,
              current.communityId,
              current.actorId,
              current.submissionId,
              current.audioRevision,
              current.analysisRevision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail("analysis", "stale-revision", { submissionId: current.submissionId }),
            );
          const sequence = integer(updated.rows[0]?.event_sequence);
          if (sequence === null) return yield* Effect.fail(fail("analysis", "invalid-row"));
          yield* insertEvent(tx, next, sequence, "blocking_analysis_completed", {
            analysis_revision: next.analysisRevision,
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
          yield* resolvePersonaId(tx, input.actorUserId, input.personaId, "decision");
          const prior = yield* replayInTx(tx, input, "decision");
          if (prior !== null) return prior;
          const current = yield* loadState(tx, input, "decision", true);
          if (current === null)
            return yield* Effect.fail(
              fail("decision", "not-found", { submissionId: input.submissionId }),
            );
          const decisionCommand: MediaSubmissionCommand =
            input.decision.outcome === "allow"
              ? {
                  event: "publication_allowed",
                  actorId: input.actorUserId,
                  expectedCreationRevision: input.expectedCreationRevision,
                  expectedAudioRevision: input.expectedAudioRevision,
                  expectedAnalysisRevision: input.expectedAnalysisRevision,
                  decision: input.decision,
                }
              : input.decision.outcome === "manual_review"
                ? {
                    event: "review_required",
                    actorId: input.actorUserId,
                    expectedCreationRevision: input.expectedCreationRevision,
                    expectedAudioRevision: input.expectedAudioRevision,
                    expectedAnalysisRevision: input.expectedAnalysisRevision,
                    review: {
                      reviewRef: `review-${input.decision.evidenceRef}`,
                      heldRevision: input.expectedCreationRevision,
                      reasonCode: "review_required",
                    },
                    decision: input.decision,
                  }
                : {
                    event: "policy_blocked",
                    actorId: input.actorUserId,
                    expectedCreationRevision: input.expectedCreationRevision,
                    evidenceRef: input.decision.evidenceRef,
                  };
          const next = yield* reduce("decision", current, decisionCommand);
          yield* tx.execute({
            label: "media-decision.insert",
            text: "INSERT INTO media_publication_decisions (submission_id,community_id,actor_user_id,operation_id,decision_revision,creation_revision,audio_revision,analysis_revision,canonical_audio_sha256,outcome,policy_revision,evidence_ref,decision_snapshot,author_persona_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)",
            values: [
              current.submissionId,
              current.communityId,
              current.actorId,
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
              current.personaId,
            ],
            readonly: false,
          });
          const reviewValues =
            input.decision.outcome === "manual_review"
              ? [
                  `review-${input.decision.evidenceRef}`,
                  input.expectedCreationRevision,
                  "review_required",
                ]
              : [null, null, null];
          const updated = yield* tx.execute<Row>({
            label: "media-decision.project",
            text: "UPDATE media_post_submissions SET decision_revision=$1,current_decision_revision=$1,status=$2,phase=$3,review_ref=$4,held_revision=$5,review_reason_code=$6,review_exhaustion_code=NULL,review_exhaustion_attempt_id=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$7 AND actor_user_id=$8 AND submission_id=$9 AND creation_revision=$10 AND audio_revision=$11 AND analysis_revision=$12 RETURNING event_sequence",
            values: [
              next.decisionRevision,
              next.status,
              next.phase,
              ...reviewValues,
              current.communityId,
              current.actorId,
              current.submissionId,
              current.creationRevision,
              current.audioRevision,
              current.analysisRevision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail("decision", "stale-revision", { submissionId: current.submissionId }),
            );
          const sequence = integer(updated.rows[0]?.event_sequence);
          if (sequence === null) return yield* Effect.fail(fail("decision", "invalid-row"));
          if (input.decision.outcome === "manual_review") {
            const projection = yield* tx.execute({
              label: "media-moderation.open-decision",
              text: "UPDATE media_moderation_projections SET status='open',decision_revision=$1,review_ref=$2,held_revision=$3,review_exhaustion_code=NULL,review_exhaustion_attempt_id=NULL,action_kind=NULL,updated_at=clock_timestamp() WHERE community_id=$4 AND actor_user_id=$5 AND submission_id=$6 AND operation_id=$7",
              values: [
                next.decisionRevision,
                `review-${input.decision.evidenceRef}`,
                current.creationRevision,
                current.communityId,
                current.actorId,
                current.submissionId,
                current.operationId,
              ],
              readonly: false,
            });
            if (projection.rowCount !== 1)
              return yield* Effect.fail(
                fail("decision", "constraint", { submissionId: current.submissionId }),
              );
          }
          yield* insertEvent(
            tx,
            next,
            sequence,
            input.decision.outcome === "allow"
              ? "publication_allowed"
              : input.decision.outcome === "manual_review"
                ? "review_required"
                : "policy_blocked",
            {
              outcome: input.decision.outcome,
            },
          );
          yield* insertReplay(tx, input, current.operationId);
          return { kind: "committed", submissionId: current.submissionId } as const;
        }),
      );
    });

  const transitionSimple = (
    operation: MediaSubmissionRepositoryOperation,
    input: CommandInput,
    command: (current: MediaSubmissionState) => MediaSubmissionCommand,
    update: (
      next: MediaSubmissionState,
      current: MediaSubmissionState,
    ) => {
      readonly text: string;
      readonly values: readonly unknown[];
      readonly event: string;
      readonly reservationRejection?: Readonly<{
        reason: "expectation_mismatch" | "source_precondition_failed" | "destination_conflict";
        evidenceRef: string;
      }>;
      readonly reservationExpiry?: boolean;
    },
  ) =>
    Effect.gen(function* () {
      if (!validCommand(input))
        return yield* Effect.fail(
          fail(operation, "invalid-input", { submissionId: input.submissionId }),
        );
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* resolvePersonaId(tx, input.actorUserId, input.personaId, operation);
          const prior = yield* replayInTx(tx, input, operation);
          if (prior !== null) return prior;
          const current = yield* loadState(tx, input, operation, true);
          if (current === null)
            return yield* Effect.fail(
              fail(operation, "not-found", { submissionId: input.submissionId }),
            );
          const next = yield* reduce(operation, current, command(current));
          if (operation === "review" && next.review?.exhaustionCode === "acr_exhausted") {
            const attempt = yield* tx.execute<Row>({
              label: "media-review.exhaustion-attempt",
              text: "SELECT a.attempt_id FROM media_processing_attempts a WHERE a.attempt_id=$1 AND a.community_id=$2 AND a.actor_user_id=$3 AND a.submission_id=$4 AND a.operation_id=$5 AND a.stage='acr' AND a.input_kind='audio' AND a.audio_revision=$6 AND a.analysis_revision=$7 AND a.input_revision=$6 AND a.input_hash=$8 AND a.state='exhausted' AND a.retryable=FALSE AND a.failure_code IS NOT NULL AND a.attempt_number=3 AND NOT EXISTS (SELECT 1 FROM media_processing_attempts later WHERE later.community_id=a.community_id AND later.actor_user_id=a.actor_user_id AND later.submission_id=a.submission_id AND later.operation_id=a.operation_id AND later.stage='acr' AND later.attempt_number>a.attempt_number)",
              values: [
                next.review.exhaustionAttemptId,
                current.communityId,
                current.actorId,
                current.submissionId,
                current.operationId,
                current.audioRevision,
                current.analysisRevision,
                current.audio?.canonicalSha256 ?? "",
              ],
              readonly: true,
            });
            if (attempt.rowCount !== 1)
              return yield* Effect.fail(
                fail(operation, "constraint", { submissionId: current.submissionId }),
              );
          }
          const projection = update(next, current);
          const updated = yield* tx.execute<Row>({
            label: `media-${operation}.project`,
            text: `${projection.text} RETURNING event_sequence`,
            values: projection.values,
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail(operation, "stale-revision", { submissionId: input.submissionId }),
            );
          const sequence = integer(updated.rows[0]?.event_sequence);
          if (sequence === null) return yield* Effect.fail(fail(operation, "invalid-row"));
          if (projection.reservationRejection !== undefined) {
            const rejected = yield* tx.execute({
              label: "media-upload-reservation.reject",
              text: "UPDATE media_upload_reservations SET state='rejected',terminal_reason=$1,terminal_evidence_ref=$2,terminal_evidence_digest=$3,terminal_at=clock_timestamp(),terminal_fence=$4,updated_at=clock_timestamp() WHERE community_id=$5 AND actor_user_id=$6 AND reservation_id=$7 AND submission_id=$8 AND operation_id=$9 AND state='claimed'",
              values: [
                projection.reservationRejection.reason,
                projection.reservationRejection.evidenceRef,
                sha256Text(projection.reservationRejection.evidenceRef),
                sequence,
                current.communityId,
                current.actorId,
                current.reservationId,
                current.submissionId,
                current.operationId,
              ],
              readonly: false,
            });
            if (rejected.rowCount !== 1)
              return yield* Effect.fail(
                fail(operation, "constraint", { submissionId: current.submissionId }),
              );
          }
          if (projection.reservationExpiry === true) {
            const expired = yield* tx.execute({
              label: "media-upload-reservation.expire",
              text: "UPDATE media_upload_reservations SET state='expired',updated_at=clock_timestamp() WHERE community_id=$1 AND actor_user_id=$2 AND reservation_id=$3 AND submission_id=$4 AND operation_id=$5 AND state='claimed' AND expires_at<=clock_timestamp()",
              values: [
                current.communityId,
                current.actorId,
                current.reservationId,
                current.submissionId,
                current.operationId,
              ],
              readonly: false,
            });
            if (expired.rowCount !== 1)
              return yield* Effect.fail(
                fail(operation, "constraint", { submissionId: current.submissionId }),
              );
          }
          if (operation === "review") {
            const projection = yield* tx.execute({
              label: "media-moderation.open",
              text: "UPDATE media_moderation_projections SET status='open',decision_revision=NULL,review_ref=$1,held_revision=$2,review_exhaustion_code=$3,review_exhaustion_attempt_id=$4,action_kind=NULL,moderator_action_id=NULL,moderator_actor_id=NULL,action_evidence_ref=NULL,updated_at=clock_timestamp() WHERE community_id=$5 AND actor_user_id=$6 AND submission_id=$7 AND operation_id=$8",
              values: [
                next.review?.reviewRef ?? null,
                next.review?.heldRevision ?? null,
                next.review?.exhaustionCode ?? null,
                next.review?.exhaustionAttemptId ?? null,
                current.communityId,
                current.actorId,
                current.submissionId,
                current.operationId,
              ],
              readonly: false,
            });
            if (projection.rowCount !== 1)
              return yield* Effect.fail(
                fail(operation, "constraint", { submissionId: current.submissionId }),
              );
          }
          yield* insertEvent(tx, next, sequence, projection.event, {});
          yield* insertReplay(tx, input, current.operationId);
          return { kind: "committed", submissionId: current.submissionId } as const;
        }),
      );
    });

  const requireReference: MediaSubmissionStore["requireReference"] = (input) =>
    transitionSimple(
      "reference",
      input,
      (_current) => ({
        event: "reference_required",
        actorId: input.actorUserId,
        expectedCreationRevision: input.expectedCreationRevision,
        expectedAudioRevision: input.expectedAudioRevision,
        expectedAnalysisRevision: input.expectedAnalysisRevision,
        referenceRequestRef: input.referenceRequestRef,
        actionExpiresAt: input.actionExpiresAt,
      }),
      (_next, current) => ({
        event: "reference_required",
        text: "UPDATE media_post_submissions SET status='action_required',phase=NULL,action_kind='reference_required',action_reference_request_ref=$1,action_expires_at=$2::timestamptz,held_revision=$3,decision_revision=0,current_decision_revision=NULL,review_ref=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$4 AND actor_user_id=$5 AND submission_id=$6 AND creation_revision=$7 AND audio_revision=$8 AND analysis_revision=$9",
        values: [
          input.referenceRequestRef,
          input.actionExpiresAt,
          current.creationRevision,
          current.communityId,
          current.actorId,
          current.submissionId,
          current.creationRevision,
          current.audioRevision,
          current.analysisRevision,
        ],
      }),
    );
  const bindReference: MediaSubmissionStore["bindReference"] = (input) =>
    transitionSimple(
      "reference",
      input,
      (_current) => ({
        event: "reference_bound",
        actorId: input.actorUserId,
        expectedCreationRevision: input.expectedCreationRevision,
        reference: input.reference,
        nowEpochMs: Date.now(),
      }),
      (next, current) => ({
        event: "reference_bound",
        text: "WITH reference_evidence AS (INSERT INTO media_reference_evidence (community_id,actor_user_id,submission_id,operation_id,asset_id,evidence_audio_revision,evidence_analysis_revision,evidence_audio_sha256,evidence_ref,upstream_commercial_rev_share_bps,inherited_license_preset,inherited_commercial_rev_share_bps) VALUES ($10,$11,$12,$13,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (community_id,actor_user_id,submission_id,operation_id,asset_id,evidence_audio_revision,evidence_analysis_revision,evidence_audio_sha256) DO NOTHING RETURNING 1) UPDATE media_post_submissions SET creation_revision=$1,bound_reference_asset_id=$2,bound_reference_evidence_ref=$6,bound_reference_audio_revision=$3,bound_reference_analysis_revision=$4,bound_reference_audio_sha256=$5,bound_reference_upstream_share_bps=$7,status='processing',phase='analysis',action_kind=NULL,action_reference_request_ref=NULL,action_expires_at=NULL,held_revision=NULL,review_ref=NULL,review_reason_code=NULL,review_exhaustion_code=NULL,review_exhaustion_attempt_id=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$10 AND actor_user_id=$11 AND submission_id=$12 AND creation_revision=$14 AND EXISTS (SELECT 1 FROM reference_evidence UNION ALL SELECT 1 FROM media_reference_evidence WHERE community_id=$10 AND actor_user_id=$11 AND submission_id=$12 AND operation_id=$13 AND asset_id=$2 AND evidence_ref=$6 AND evidence_audio_revision=$3 AND evidence_analysis_revision=$4 AND evidence_audio_sha256=$5 AND upstream_commercial_rev_share_bps IS NOT DISTINCT FROM $7)",
        values: [
          next.creationRevision,
          input.reference.assetId,
          input.reference.evidenceAudioRevision,
          input.reference.evidenceAnalysisRevision,
          input.reference.evidenceAudioSha256,
          input.reference.evidenceRef ?? null,
          input.reference.upstreamCommercialRevShareBps,
          input.reference.inheritedLicensePreset ?? null,
          input.reference.inheritedCommercialRevShareBps ?? null,
          current.communityId,
          current.actorId,
          current.submissionId,
          current.operationId,
          current.creationRevision,
        ],
      }),
    );
  const requireReview: MediaSubmissionStore["requireReview"] = (input) =>
    transitionSimple(
      "review",
      input,
      (_current) => ({
        event: "review_exhaustion_recorded",
        actorId: input.actorUserId,
        expectedCreationRevision: input.expectedCreationRevision,
        review: input.review,
      }),
      (_next, current) => ({
        event: "review_exhaustion_recorded",
        text: "UPDATE media_post_submissions SET status='manual_review',phase=NULL,review_ref=$1,review_reason_code=$2,review_exhaustion_code=$3,review_exhaustion_attempt_id=$4,held_revision=$5,decision_revision=0,current_decision_revision=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$6 AND actor_user_id=$7 AND submission_id=$8 AND creation_revision=$9",
        values: [
          input.review.reviewRef,
          input.review.reasonCode,
          input.review.exhaustionCode ?? null,
          input.review.exhaustionAttemptId ?? null,
          input.review.heldRevision,
          current.communityId,
          current.actorId,
          current.submissionId,
          current.creationRevision,
        ],
      }),
    );
  const moderate: MediaSubmissionStore["moderate"] = (input) => {
    const actorId = input.actor.userId;
    const moderatorScope =
      (input.actor.kind === "admin" && input.actor.scopes?.includes("moderation") === true) ||
      input.actor.scopes?.includes("moderator") === true;
    if (
      !validId(actorId) ||
      !moderatorScope ||
      (input.action === "approve" && (input.approval === undefined || input.decision === undefined))
    )
      return Effect.fail(fail("moderation", "invalid-input", { submissionId: input.submissionId }));
    const authorityInput = { ...input, actorUserId: actorId };
    return Effect.gen(function* () {
      if (!validAccountCommand(authorityInput))
        return yield* Effect.fail(
          fail("moderation", "invalid-input", { submissionId: input.submissionId }),
        );
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const owner = yield* tx.execute<Row>({
            label: "media-moderation.owner",
            text: "SELECT actor_user_id FROM media_post_submissions WHERE community_id=$1 AND submission_id=$2 FOR UPDATE",
            values: [input.communityId, input.submissionId],
            readonly: false,
          });
          const ownerId =
            owner.rows.length === 1 && validId(owner.rows[0]?.actor_user_id)
              ? (owner.rows[0]?.actor_user_id as string)
              : null;
          if (ownerId === null)
            return yield* Effect.fail(
              fail("moderation", "not-found", { submissionId: input.submissionId }),
            );
          const current = yield* loadState(
            tx,
            {
              communityId: authorityInput.communityId,
              submissionId: authorityInput.submissionId,
              actorUserId: ownerId,
            },
            "moderation",
            true,
          );
          if (current === null)
            return yield* Effect.fail(
              fail("moderation", "not-found", { submissionId: input.submissionId }),
            );
          const replayInput = { ...authorityInput, actorUserId: actorId, personaId: null };
          const prior = yield* replayInTx(tx, replayInput, "moderation");
          if (prior !== null) return prior;
          const authority = yield* tx.execute<Row>({
            label: "media-moderation.authority",
            text: "SELECT (c.status='active' AND m.status='member') AS allowed FROM communities c JOIN community_memberships m ON m.community_id=c.community_id AND m.user_id=$2 WHERE c.community_id=$1 FOR SHARE",
            values: [current.communityId, actorId],
            readonly: false,
          });
          const allowed = authority.rows.length === 1 && authority.rows[0]?.allowed === true;
          const moderatorActionId = input.approval?.actionId ?? `moderator-${crypto.randomUUID()}`;
          const moderatorEvidenceRef =
            input.approval?.evidenceRef ?? input.evidenceRef ?? "moderator-evidence";
          const approval =
            input.approval === undefined
              ? undefined
              : { ...input.approval, moderatorActorId: actorId };
          const command: MediaSubmissionCommand =
            input.action === "approve"
              ? {
                  event: "moderator_approved",
                  actorId: current.actorId,
                  expectedCreationRevision: input.expectedCreationRevision,
                  communityActive: allowed,
                  membershipActive: allowed,
                  approval: approval as ModeratorApprovalEvidence,
                  decision: input.decision as PublicationDecision,
                }
              : {
                  event: "moderator_blocked",
                  actorId: current.actorId,
                  expectedCreationRevision: input.expectedCreationRevision,
                  communityActive: allowed,
                  membershipActive: allowed,
                  actionId: moderatorActionId,
                  moderatorActorId: actorId,
                  evidenceRef: moderatorEvidenceRef,
                  reasonCode: "policy_violation",
                };
          const next = yield* reduce("moderation", current, command);
          if (input.action === "approve") {
            const approvedDecision = input.decision as PublicationDecision;
            yield* tx.execute({
              label: "media-moderation.decision",
              text: "INSERT INTO media_publication_decisions (submission_id,community_id,actor_user_id,operation_id,decision_revision,creation_revision,audio_revision,analysis_revision,canonical_audio_sha256,outcome,policy_revision,evidence_ref,decision_snapshot,author_persona_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'allow',$10,$11,$12::jsonb,$13)",
              values: [
                current.submissionId,
                current.communityId,
                current.actorId,
                current.operationId,
                approvedDecision.decisionRevision,
                approvedDecision.creationRevision,
                approvedDecision.audioRevision,
                approvedDecision.analysisRevision,
                approvedDecision.canonicalAudioSha256,
                approvedDecision.policyRevision,
                approvedDecision.evidenceRef,
                json(approvedDecision),
                current.personaId,
              ],
              readonly: false,
            });
          }
          yield* tx.execute({
            label: "media-moderation.action",
            text: "INSERT INTO media_moderation_actions (action_id,community_id,actor_user_id,submission_id,operation_id,authority_actor_user_id,action_kind,approval_kind,reason_code,held_revision,decision_revision,evidence_ref,decision_snapshot,author_persona_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)",
            values: [
              moderatorActionId,
              current.communityId,
              current.actorId,
              current.submissionId,
              current.operationId,
              actorId,
              input.action,
              approval?.approvalKind ?? null,
              input.action === "approve" ? (approval?.reasonCode ?? null) : "policy_violation",
              current.review?.heldRevision ?? current.creationRevision,
              input.action === "approve" ? next.decisionRevision : null,
              moderatorEvidenceRef,
              input.action === "approve"
                ? json(input.decision)
                : json({ reasonCode: "policy_violation" }),
              current.personaId,
            ],
            readonly: false,
          });
          const updated = yield* tx.execute<Row>({
            label: "media-moderation.project",
            text:
              input.action === "approve"
                ? "UPDATE media_post_submissions SET status='processing',phase='publish',review_ref=NULL,review_reason_code=NULL,review_exhaustion_code=NULL,review_exhaustion_attempt_id=NULL,held_revision=NULL,moderator_action_id=$1,moderator_actor_id=$2,moderator_evidence_ref=$3,moderator_approval_kind=$4,moderator_reason_code=$5,decision_revision=$6,current_decision_revision=$6,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$7 AND actor_user_id=$8 AND submission_id=$9 AND creation_revision=$10 RETURNING event_sequence"
                : "UPDATE media_post_submissions SET status='blocked',phase=NULL,review_ref=NULL,review_reason_code=NULL,review_exhaustion_code=NULL,review_exhaustion_attempt_id=NULL,held_revision=NULL,moderator_action_id=$1,moderator_actor_id=$2,moderator_evidence_ref=$3,moderator_reason_code=$4,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$5 AND actor_user_id=$6 AND submission_id=$7 AND creation_revision=$8 RETURNING event_sequence",
            values:
              input.action === "approve"
                ? [
                    moderatorActionId,
                    actorId,
                    moderatorEvidenceRef,
                    approval?.approvalKind,
                    approval?.reasonCode,
                    next.decisionRevision,
                    current.communityId,
                    current.actorId,
                    current.submissionId,
                    current.creationRevision,
                  ]
                : [
                    moderatorActionId,
                    actorId,
                    moderatorEvidenceRef,
                    "policy_violation",
                    current.communityId,
                    current.actorId,
                    current.submissionId,
                    current.creationRevision,
                  ],
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail("moderation", "stale-revision", { submissionId: current.submissionId }),
            );
          const sequence = integer(updated.rows[0]?.event_sequence);
          if (sequence === null) return yield* Effect.fail(fail("moderation", "invalid-row"));
          const moderationProjection = yield* tx.execute({
            label: "media-moderation.projection",
            text: "UPDATE media_moderation_projections SET status=$1,decision_revision=$2,review_ref=$3,held_revision=$4,review_exhaustion_code=NULL,review_exhaustion_attempt_id=NULL,action_kind=$5,moderator_action_id=$6,moderator_actor_id=$7,action_evidence_ref=$8,updated_at=clock_timestamp() WHERE community_id=$9 AND actor_user_id=$10 AND submission_id=$11 AND operation_id=$12",
            values: [
              input.action === "approve" ? "approved" : "blocked",
              next.decisionRevision || null,
              input.action === "approve" ? null : (current.review?.reviewRef ?? null),
              input.action === "approve" ? null : current.creationRevision,
              input.action,
              moderatorActionId,
              actorId,
              moderatorEvidenceRef,
              current.communityId,
              current.actorId,
              current.submissionId,
              current.operationId,
            ],
            readonly: false,
          });
          if (moderationProjection.rowCount !== 1)
            return yield* Effect.fail(
              fail("moderation", "constraint", { submissionId: current.submissionId }),
            );
          yield* insertEvent(
            tx,
            next,
            sequence,
            input.action === "approve" ? "moderator_approved" : "moderator_blocked",
            input.action === "approve" ? {} : { reason_code: "policy_violation" },
          );
          yield* insertReplay(tx, replayInput, current.operationId, current.actorId);
          return { kind: "committed", submissionId: current.submissionId } as const;
        }),
      );
    });
  };
  const retry: MediaSubmissionStore["retry"] = (input) =>
    transitionSimple(
      "retry",
      input,
      (_current) => ({
        event: "retry_authorized",
        actorId: input.actorUserId,
        expectedCreationRevision: input.expectedCreationRevision,
      }),
      (next, current) => ({
        event: "retry_authorized",
        text: "UPDATE media_post_submissions SET creation_revision=$1,retry_count=retry_count+1,status='processing',phase=$2,decision_revision=0,current_decision_revision=NULL,failure_code=NULL,failure_retry_count=NULL,retryable=NULL,last_safe_phase=NULL,review_exhaustion_code=NULL,review_exhaustion_attempt_id=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$3 AND actor_user_id=$4 AND submission_id=$5 AND creation_revision=$6 AND status='processing_failed'",
        values: [
          next.creationRevision,
          next.phase,
          current.communityId,
          current.actorId,
          current.submissionId,
          current.creationRevision,
        ],
      }),
    );

  const failureTransition = (
    input: FailureInput,
    event: "media_failure_recorded" | "technical_exhaustion_recorded" | "seal_conflict_recorded",
  ) =>
    transitionSimple(
      "failure",
      input,
      (_current) => ({
        event,
        actorId: input.actorUserId,
        expectedCreationRevision: input.expectedCreationRevision,
        failure: input.failure,
      }),
      (_next, current) => ({
        event,
        text: "UPDATE media_post_submissions SET status='processing_failed',phase=NULL,failure_code=$1,failure_retry_count=$2,retryable=$3,last_safe_phase=$4,decision_revision=0,current_decision_revision=NULL,review_ref=NULL,review_reason_code=NULL,review_exhaustion_code=NULL,review_exhaustion_attempt_id=NULL,held_revision=NULL,action_kind=NULL,action_reference_request_ref=NULL,action_expires_at=NULL,moderator_action_id=NULL,moderator_actor_id=NULL,moderator_evidence_ref=NULL,moderator_approval_kind=NULL,moderator_reason_code=NULL,abandonment_reason=NULL,retention_disposition=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$5 AND actor_user_id=$6 AND submission_id=$7 AND creation_revision=$8",
        values: [
          input.failure.code,
          input.failure.retryCount,
          input.failure.retryable,
          input.failure.lastSafePhase,
          current.communityId,
          current.actorId,
          current.submissionId,
          current.creationRevision,
        ],
        ...(event === "seal_conflict_recorded"
          ? {
              reservationRejection: {
                reason: "destination_conflict" as const,
                evidenceRef: input.failure.evidenceRef ?? "",
              },
            }
          : {}),
      }),
    );
  const recordMediaFailure: MediaSubmissionStore["recordMediaFailure"] = (input) =>
    failureTransition(input, "media_failure_recorded");
  const recordTechnicalExhaustion: MediaSubmissionStore["recordTechnicalExhaustion"] = (input) =>
    failureTransition(input, "technical_exhaustion_recorded");
  const recordSealConflict: MediaSubmissionStore["recordSealConflict"] = (input) =>
    failureTransition(input, "seal_conflict_recorded");

  const abandonmentTransition = (
    input: AbandonInput,
    event:
      | "author_cancelled"
      | "reservation_expired"
      | "action_deadline_elapsed"
      | "upload_expectation_mismatch_recorded"
      | "upload_source_precondition_failed",
  ) =>
    transitionSimple(
      "abandon",
      input,
      (_current) => {
        if (event === "action_deadline_elapsed")
          return {
            event,
            actorId: input.actorUserId,
            expectedCreationRevision: input.expectedCreationRevision,
            nowEpochMs: input.nowEpochMs ?? Date.now(),
          };
        if (event === "upload_expectation_mismatch_recorded")
          return {
            event,
            actorId: input.actorUserId,
            expectedCreationRevision: input.expectedCreationRevision,
            abandonment: {
              reason: "upload_expectation_mismatch" as const,
              retentionDisposition: "retain_for_reconciliation" as const,
            },
            evidenceRef: input.evidenceRef ?? "",
          };
        if (event === "upload_source_precondition_failed")
          return {
            event,
            actorId: input.actorUserId,
            expectedCreationRevision: input.expectedCreationRevision,
            abandonment: {
              reason: "upload_source_changed_before_finalize" as const,
              retentionDisposition: "retain_for_reconciliation" as const,
            },
            evidenceRef: input.evidenceRef ?? "",
          };
        return {
          event,
          actorId: input.actorUserId,
          expectedCreationRevision: input.expectedCreationRevision,
        };
      },
      (_next, current) => ({
        event,
        text: "UPDATE media_post_submissions SET status='abandoned',phase=NULL,action_kind=NULL,action_reference_request_ref=NULL,action_expires_at=NULL,review_ref=NULL,review_reason_code=NULL,review_exhaustion_code=NULL,review_exhaustion_attempt_id=NULL,held_revision=NULL,abandonment_reason=$1,retention_disposition=$2,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$3 AND actor_user_id=$4 AND submission_id=$5 AND creation_revision=$6",
        values: [
          event === "action_deadline_elapsed"
            ? "action_deadline_elapsed"
            : event === "author_cancelled"
              ? "author_cancelled"
              : event === "reservation_expired"
                ? "reservation_expired"
                : event === "upload_expectation_mismatch_recorded"
                  ? "upload_expectation_mismatch"
                  : "upload_source_changed_before_finalize",
          event === "action_deadline_elapsed" && current.audioRevision > 0
            ? "retain_until_expiry"
            : event === "upload_expectation_mismatch_recorded" ||
                event === "upload_source_precondition_failed"
              ? "retain_for_reconciliation"
              : "no_object",
          current.communityId,
          current.actorId,
          current.submissionId,
          current.creationRevision,
        ],
        ...(event === "upload_expectation_mismatch_recorded" ||
        event === "upload_source_precondition_failed"
          ? {
              reservationRejection: {
                reason:
                  event === "upload_expectation_mismatch_recorded"
                    ? ("expectation_mismatch" as const)
                    : ("source_precondition_failed" as const),
                evidenceRef: input.evidenceRef ?? "",
              },
            }
          : event === "reservation_expired"
            ? { reservationExpiry: true }
            : {}),
      }),
    );
  const actionDeadlineElapsed: MediaSubmissionStore["actionDeadlineElapsed"] = (input) =>
    abandonmentTransition(input, "action_deadline_elapsed");
  const authorCancel: MediaSubmissionStore["authorCancel"] = (input) =>
    abandonmentTransition(input, "author_cancelled");
  const reservationExpire: MediaSubmissionStore["reservationExpire"] = (input) =>
    abandonmentTransition(input, "reservation_expired");
  const uploadExpectationMismatch: MediaSubmissionStore["uploadExpectationMismatch"] = (input) =>
    abandonmentTransition(input, "upload_expectation_mismatch_recorded");
  const uploadSourcePreconditionFailed: MediaSubmissionStore["uploadSourcePreconditionFailed"] = (
    input,
  ) => abandonmentTransition(input, "upload_source_precondition_failed");

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
          yield* resolvePersonaId(tx, input.actorUserId, input.personaId, "publish");
          const prior = yield* replayInTx(tx, input, "publish");
          if (prior !== null) return prior;
          const current = yield* loadState(tx, input, "publish", true);
          if (current === null)
            return yield* Effect.fail(
              fail("publish", "not-found", { submissionId: input.submissionId }),
            );
          const ownedPostId = `media-post-${current.operationId}`;
          if (input.postId !== ownedPostId)
            return yield* Effect.fail(
              fail("publish", "post-ownership", { submissionId: current.submissionId }),
            );
          const authority = yield* tx.execute<Row>({
            label: "media-publish.authority",
            text: "SELECT (c.status='active' AND m.status='member') AS allowed FROM communities c JOIN community_memberships m ON m.community_id=c.community_id AND m.user_id=$2 WHERE c.community_id=$1 FOR SHARE",
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
            communityActive: authority.rows.length === 1 && authority.rows[0]?.allowed === true,
            membershipActive: authority.rows.length === 1 && authority.rows[0]?.allowed === true,
            postId: ownedPostId,
          });
          const existing = yield* tx.execute<Row>({
            label: "media-publish.post.lookup",
            text: "SELECT author_user_id,post_type,status,visibility,title FROM posts WHERE community_id=$1 AND post_id=$2 FOR UPDATE",
            values: [current.communityId, ownedPostId],
            readonly: false,
          });
          if (existing.rows.length === 0) {
            yield* tx.execute({
              label: "media-publish.post.insert",
              text: "INSERT INTO posts (community_id,post_id,author_user_id,post_type,status,visibility,title,created_at,updated_at,idempotency_key,idempotency_body_hash,author_persona_id) VALUES ($1,$2,$3,'song','published','public',$4,clock_timestamp(),clock_timestamp(),$5,$6,$7)",
              values: [
                current.communityId,
                ownedPostId,
                current.actorId,
                current.title,
                input.idempotencyKey,
                input.requestHash,
                current.personaId,
              ],
              readonly: false,
            });
          } else if (
            existing.rows.length !== 1 ||
            existing.rows[0]?.author_user_id !== current.actorId ||
            existing.rows[0]?.post_type !== "song" ||
            existing.rows[0]?.status !== "published" ||
            existing.rows[0]?.visibility !== "public" ||
            existing.rows[0]?.title !== current.title
          )
            return yield* Effect.fail(
              fail("publish", "post-ownership", { submissionId: current.submissionId }),
            );
          const updated = yield* tx.execute<Row>({
            label: "media-publish.project-state",
            text: "UPDATE media_post_submissions SET status='published',phase=NULL,post_id=$1,workflow_revision=$2,event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE community_id=$3 AND actor_user_id=$4 AND submission_id=$5 AND creation_revision=$6 AND audio_revision=$7 AND analysis_revision=$8 AND decision_revision=$9 RETURNING event_sequence",
            values: [
              ownedPostId,
              next.workflowRevision,
              current.communityId,
              current.actorId,
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
              fail("publish", "stale-revision", { submissionId: current.submissionId }),
            );
          const sequence = integer(updated.rows[0]?.event_sequence);
          if (sequence === null || current.audio === null || current.analysis === null)
            return yield* Effect.fail(fail("publish", "invalid-row"));
          const speech = current.analysis.speechLyrics;
          const cover = current.analysis.embeddedMetadata.cover;
          yield* tx.execute({
            label: "media-publish.projection",
            text: "INSERT INTO media_publication_projections (submission_id,community_id,actor_user_id,operation_id,post_id,creation_revision,audio_revision,analysis_revision,decision_revision,canonical_audio_sha256,title,audio_asset_ref,cover_artifact_ref,language_status,primary_language_bcp47,secondary_language_bcp47,lyrics_explicitness,analysis_badges,author_persona_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)",
            values: [
              current.submissionId,
              current.communityId,
              current.actorId,
              current.operationId,
              ownedPostId,
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
              json(current.boundReference === null ? [] : ["reference_bound"]),
              current.personaId,
            ],
            readonly: false,
          });
          yield* tx.execute({
            label: "media-alignment.pending",
            text: "INSERT INTO media_alignment_projections (submission_id,community_id,actor_user_id,operation_id,post_id,audio_revision,analysis_revision,canonical_audio_sha256,status,author_persona_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)",
            values: [
              current.submissionId,
              current.communityId,
              current.actorId,
              current.operationId,
              ownedPostId,
              current.audioRevision,
              current.analysisRevision,
              current.audio.canonicalSha256,
              current.personaId,
            ],
            readonly: false,
          });
          yield* insertOutbox(tx, next, "publication", input.outbox);
          yield* insertEvent(tx, next, sequence, "publication_committed", { post_id: ownedPostId });
          yield* insertReplay(tx, input, current.operationId);
          return {
            kind: "committed",
            submissionId: current.submissionId,
            postId: ownedPostId,
            outboxEventId: input.outbox.outboxEventId,
          } as const;
        }),
      );
    });

  const recordAlignment: MediaSubmissionStore["recordAlignment"] = (input) =>
    Effect.gen(function* () {
      if (
        ![input.communityId, input.submissionId, input.actorUserId, input.postId].every(validId) ||
        !validId(input.personaId) ||
        !validRevision(input.audioRevision, 1) ||
        !validRevision(input.analysisRevision, 1) ||
        !validHash(input.canonicalAudioSha256) ||
        (input.outcome === "ready" &&
          (input.failureCode !== undefined ||
            input.artifact === undefined ||
            !validId(input.artifact.artifactRef) ||
            !validHash(input.artifact.artifactSha256) ||
            sha256Text(canonicalJson(input.artifact.artifact)) !==
              input.artifact.artifactSha256)) ||
        (input.outcome === "unavailable" &&
          (input.failureCode === undefined || input.artifact !== undefined))
      )
        return yield* Effect.fail(
          fail("alignment", "invalid-input", { submissionId: input.submissionId }),
        );
      const artifactRevision = input.artifact?.artifactRevision ?? 1;
      const db = yield* ControlPlaneDb;
      yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          if (input.outcome === "ready") {
            if (input.artifact === undefined)
              return yield* Effect.fail(
                fail("alignment", "invalid-input", { submissionId: input.submissionId }),
              );
            if (!validRevision(artifactRevision, 1))
              return yield* Effect.fail(
                fail("alignment", "invalid-input", { submissionId: input.submissionId }),
              );
            const insertedArtifact = yield* tx.execute({
              label: "media-alignment.artifact",
              text: "INSERT INTO media_timed_lyrics_artifacts (artifact_ref,community_id,actor_user_id,submission_id,operation_id,post_id,audio_revision,analysis_revision,artifact_revision,canonical_audio_sha256,artifact_sha256,artifact,author_persona_id) SELECT $1,p.community_id,p.actor_user_id,p.submission_id,p.operation_id,p.post_id,p.audio_revision,p.analysis_revision,$2,p.canonical_audio_sha256,$3,$4::jsonb,p.author_persona_id FROM media_publication_projections p WHERE p.community_id=$5 AND p.actor_user_id=$6 AND p.submission_id=$7 AND p.post_id=$8 AND p.audio_revision=$9 AND p.analysis_revision=$10 AND p.canonical_audio_sha256=$11",
              values: [
                input.artifact.artifactRef,
                artifactRevision,
                input.artifact.artifactSha256,
                json(input.artifact.artifact),
                input.communityId,
                input.actorUserId,
                input.submissionId,
                input.postId,
                input.audioRevision,
                input.analysisRevision,
                input.canonicalAudioSha256,
              ],
              readonly: false,
            });
            if (insertedArtifact.rowCount !== 1)
              return yield* Effect.fail(
                fail("alignment", "constraint", { submissionId: input.submissionId }),
              );
          }
          const updated = yield* tx.execute({
            label: "media-alignment.project",
            text: "UPDATE media_alignment_projections SET status=$1,current_artifact_ref=$2,current_artifact_revision=$3,alignment_revision=alignment_revision+1,failure_code=$4,updated_at=clock_timestamp() WHERE community_id=$5 AND actor_user_id=$6 AND submission_id=$7 AND post_id=$8 AND audio_revision=$9 AND analysis_revision=$10 AND canonical_audio_sha256=$11",
            values: [
              input.outcome,
              input.artifact?.artifactRef ?? null,
              input.outcome === "ready" ? artifactRevision : null,
              input.failureCode ?? null,
              input.communityId,
              input.actorUserId,
              input.submissionId,
              input.postId,
              input.audioRevision,
              input.analysisRevision,
              input.canonicalAudioSha256,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1)
            return yield* Effect.fail(
              fail("alignment", "stale-revision", { submissionId: input.submissionId }),
            );
          const publication = yield* tx.execute({
            label: "media-alignment.publication-project",
            text: "UPDATE media_publication_projections SET alignment=$1 WHERE community_id=$2 AND actor_user_id=$3 AND submission_id=$4 AND post_id=$5 AND audio_revision=$6 AND analysis_revision=$7 AND canonical_audio_sha256=$8",
            values: [
              input.outcome,
              input.communityId,
              input.actorUserId,
              input.submissionId,
              input.postId,
              input.audioRevision,
              input.analysisRevision,
              input.canonicalAudioSha256,
            ],
            readonly: false,
          });
          if (publication.rowCount !== 1)
            return yield* Effect.fail(
              fail("alignment", "stale-revision", { submissionId: input.submissionId }),
            );
        }),
      );
    });

  const recordProcessingAttempt: MediaSubmissionStore["recordProcessingAttempt"] = (input) =>
    Effect.gen(function* () {
      const providerIdempotencyKey =
        input.providerIdempotencyKey ?? `media-attempt-${input.attemptId}`;
      if (
        ![
          input.attemptId,
          input.communityId,
          input.submissionId,
          input.actorUserId,
          input.operationId,
          input.inputHash,
        ].every(validId) ||
        !validId(input.personaId) ||
        !validHash(input.inputHash) ||
        !validRevision(input.audioRevision, 1) ||
        !validRevision(input.analysisRevision, 1) ||
        !validRevision(input.inputRevision, 1) ||
        !validId(input.policyRevision) ||
        !validId(input.adapterRevision) ||
        !validId(providerIdempotencyKey) ||
        !validRevision(input.attemptNumber ?? 1, 1) ||
        (input.attemptNumber ?? 1) > 3
      )
        return yield* Effect.fail(fail("attempt", "invalid-input"));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute({
        label: "media-attempt.insert",
        text: "INSERT INTO media_processing_attempts (attempt_id,submission_id,community_id,actor_user_id,operation_id,audio_revision,analysis_revision,stage,attempt_number,input_hash,provider_idempotency_key,input_kind,input_revision,policy_revision,adapter_revision,state,author_persona_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (attempt_id) DO NOTHING",
        values: [
          input.attemptId,
          input.submissionId,
          input.communityId,
          input.actorUserId,
          input.operationId,
          input.audioRevision,
          input.analysisRevision,
          input.stage,
          input.attemptNumber ?? 1,
          input.inputHash,
          providerIdempotencyKey,
          input.inputKind,
          input.inputRevision,
          input.policyRevision,
          input.adapterRevision,
          "pending",
          input.personaId,
        ],
        readonly: false,
      });
      if (result.rowCount === 1) return;
      const existing = yield* db.execute<Row>({
        label: "media-attempt.replay",
        text: "SELECT * FROM media_processing_attempts WHERE attempt_id=$1",
        values: [input.attemptId],
        readonly: true,
      });
      const row = existing.rows[0];
      if (
        existing.rows.length !== 1 ||
        row?.submission_id !== input.submissionId ||
        row?.community_id !== input.communityId ||
        row?.actor_user_id !== input.actorUserId ||
        row?.operation_id !== input.operationId ||
        integer(row.audio_revision) !== input.audioRevision ||
        integer(row.analysis_revision) !== input.analysisRevision ||
        row.stage !== input.stage ||
        integer(row.attempt_number) !== (input.attemptNumber ?? 1) ||
        row.input_hash !== input.inputHash ||
        row.provider_idempotency_key !== providerIdempotencyKey ||
        row.input_kind !== input.inputKind ||
        integer(row.input_revision) !== input.inputRevision ||
        row.policy_revision !== input.policyRevision ||
        row.adapter_revision !== input.adapterRevision
      )
        return yield* Effect.fail(fail("attempt", "immutable-object-conflict"));
    });
  const claimProcessingAttempt: MediaSubmissionStore["claimProcessingAttempt"] = (input) =>
    Effect.gen(function* () {
      if (
        ![input.attemptId, input.workerId].every(validId) ||
        !validRevision(input.leaseSeconds, 1) ||
        input.leaseSeconds > 3600
      )
        return yield* Effect.fail(fail("attempt", "invalid-input"));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute({
        label: "media-attempt.claim",
        text: "UPDATE media_processing_attempts SET state='running',claim_owner=$1,claim_fence=claim_fence+1,lease_expires_at=clock_timestamp()+make_interval(secs=>$2),next_eligible_at=NULL,updated_at=clock_timestamp() WHERE attempt_id=$3 AND (state='pending' OR (state='retry_wait' AND next_eligible_at<=clock_timestamp()) OR (state='running' AND lease_expires_at<=clock_timestamp()))",
        values: [input.workerId, input.leaseSeconds, input.attemptId],
        readonly: false,
      });
      return result.rowCount === 1;
    });
  const completeProcessingAttempt: MediaSubmissionStore["completeProcessingAttempt"] = (input) =>
    Effect.gen(function* () {
      if (
        ![input.attemptId, input.workerId, input.evidenceRef].every(validId) ||
        !validRevision(input.claimFence, 1)
      )
        return yield* Effect.fail(fail("attempt", "invalid-input"));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute({
        label: "media-attempt.complete",
        text: "UPDATE media_processing_attempts SET state='succeeded',claim_owner=NULL,lease_expires_at=NULL,evidence_ref=$1,result=$2::jsonb,updated_at=clock_timestamp() WHERE attempt_id=$3 AND state='running' AND claim_owner=$4 AND claim_fence=$5 AND lease_expires_at>clock_timestamp()",
        values: [
          input.evidenceRef,
          json(input.result),
          input.attemptId,
          input.workerId,
          input.claimFence,
        ],
        readonly: false,
      });
      return result.rowCount === 1;
    });
  const failProcessingAttempt: MediaSubmissionStore["failProcessingAttempt"] = (input) =>
    Effect.gen(function* () {
      if (
        ![input.attemptId, input.workerId, input.failureCode].every(validId) ||
        (input.evidenceRef !== undefined && !validId(input.evidenceRef)) ||
        !validRevision(input.claimFence, 1) ||
        (input.retryable &&
          (input.nextEligibleAt === undefined ||
            !Number.isFinite(Date.parse(input.nextEligibleAt)))) ||
        (!input.retryable &&
          input.nextEligibleAt !== undefined &&
          !Number.isFinite(Date.parse(input.nextEligibleAt)))
      )
        return yield* Effect.fail(fail("attempt", "invalid-input"));
      const db = yield* ControlPlaneDb;
      const state = input.retryable ? "retry_wait" : "exhausted";
      const result = yield* db.execute({
        label: "media-attempt.fail",
        text: "UPDATE media_processing_attempts SET state=CASE WHEN attempt_number >= 3 THEN 'exhausted' ELSE $1 END,claim_owner=NULL,lease_expires_at=NULL,failure_code=$2,evidence_ref=COALESCE($3,evidence_ref),retryable=CASE WHEN attempt_number >= 3 THEN FALSE ELSE $4 END,next_eligible_at=CASE WHEN attempt_number >= 3 THEN NULL ELSE $5::timestamptz END,updated_at=clock_timestamp() WHERE attempt_id=$6 AND state='running' AND claim_owner=$7 AND claim_fence=$8 AND lease_expires_at>clock_timestamp()",
        values: [
          state,
          input.failureCode,
          input.evidenceRef ?? null,
          input.retryable,
          input.retryable ? input.nextEligibleAt : null,
          input.attemptId,
          input.workerId,
          input.claimFence,
        ],
        readonly: false,
      });
      return result.rowCount === 1;
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
    requireReference,
    bindReference,
    requireReview,
    moderate,
    retry,
    recordMediaFailure,
    recordTechnicalExhaustion,
    recordSealConflict,
    actionDeadlineElapsed,
    authorCancel,
    reservationExpire,
    uploadExpectationMismatch,
    uploadSourcePreconditionFailed,
    publish,
    recordAlignment,
    recordProcessingAttempt,
    claimProcessingAttempt,
    completeProcessingAttempt,
    failProcessingAttempt,
  };
}
export const makeMediaSubmissionRepository = makeControlPlaneMediaSubmissionRepository;
export const makeControlPlaneMediaSubmissionStore = makeControlPlaneMediaSubmissionRepository;
