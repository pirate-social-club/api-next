import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  type DataRegistrationArtifact,
  type DataRegistrationAttemptFailureCode,
  type DataRegistrationAttemptState,
  type DataRegistrationFailureCode,
  type DataRegistrationOperation,
  type DataRegistrationOperationState,
  type DataRegistrationOutbox,
  type DataRegistrationPinVerification,
  type DataRegistrationReceiptInput,
  type DataRegistrationReceiptObservation,
  type DataRegistrationSigningAttempt,
  type DataRegistrationStore,
  deterministicDataRegistrationOperationId,
  deterministicDataRegistrationOutboxId,
  deterministicDataRegistrationReceiptId,
  deterministicDataRegistrationTransitionId,
  deterministicDataRegistrationWorkflowId,
  type ReserveDataRegistrationAttemptInput,
} from "@pirate/application/data/registration-persistence";
import { Data, Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const OPERATION_STATES = new Set<DataRegistrationOperationState>([
  "pending",
  "signing",
  "broadcast",
  "confirming",
  "registered",
  "failed",
  "reconciliation_required",
]);
const ATTEMPT_STATES = new Set<DataRegistrationAttemptState>([
  "signing_intent",
  "nonce_reserved",
  "prepared",
  "broadcast",
  "mined",
  "confirmed",
  "replaced",
  "reverted",
  "failed",
  "reconciliation_required",
]);
const OPERATION_FAILURE_CODES = new Set<DataRegistrationFailureCode>([
  "pin_verification_failed",
  "signing_failed",
  "broadcast_failed",
  "receipt_reverted",
  "confirmation_timeout",
  "chain_reorganization",
  "invalid_receipt",
  "configuration_invalid",
]);
const ATTEMPT_FAILURE_CODES = new Set<DataRegistrationAttemptFailureCode>([
  "signing_failed",
  "broadcast_failed",
  "receipt_reverted",
  "confirmation_timeout",
  "chain_reorganization",
  "invalid_receipt",
]);
const HASH = /^[0-9a-f]{64}$/u;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

export class DataRegistrationRepositoryError extends Data.TaggedError(
  "DataRegistrationRepositoryError",
)<{
  readonly operation:
    | "create"
    | "read"
    | "artifact"
    | "pin"
    | "attempt"
    | "receipt"
    | "confirm"
    | "failure"
    | "outbox";
  readonly reason:
    | "invalid-input"
    | "invalid-row"
    | "not-found"
    | "identity-conflict"
    | "stale-state"
    | "pins-not-ready"
    | "metadata-mismatch";
  readonly registrationOperationId?: string;
}> {}

const fail = (
  operation: DataRegistrationRepositoryError["operation"],
  reason: DataRegistrationRepositoryError["reason"],
  registrationOperationId?: string,
) =>
  new DataRegistrationRepositoryError({
    operation,
    reason,
    ...(registrationOperationId === undefined ? {} : { registrationOperationId }),
  });

const validId = (value: unknown, maximum = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value === value.trim() &&
  !value.includes("\u0000");
const validHash = (value: unknown): value is string =>
  typeof value === "string" && HASH.test(value);
const validTransactionHash = (value: unknown): value is string =>
  typeof value === "string" && TRANSACTION_HASH.test(value);
const validAddress = (value: unknown): value is string =>
  typeof value === "string" && ADDRESS.test(value);
const positive = (value: bigint): boolean => value > 0n;
const validInstant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const text = (row: Row, field: string): string => {
  const value = row[field];
  if (!validId(value, 16_384)) throw new Error(`invalid ${field}`);
  return value;
};
const nullableText = (row: Row, field: string): string | null => {
  const value = row[field];
  if (value === null || value === undefined) return null;
  return text(row, field);
};
const bigint = (row: Row, field: string): bigint => {
  const value = row[field];
  if (!/^[0-9]+$/u.test(String(value))) throw new Error(`invalid ${field}`);
  return BigInt(String(value));
};
const nullableBigint = (row: Row, field: string): bigint | null => {
  const value = row[field];
  if (value === null || value === undefined) return null;
  return bigint(row, field);
};
const integer = (row: Row, field: string): number => {
  const value = Number(row[field]);
  if (!Number.isSafeInteger(value)) throw new Error(`invalid ${field}`);
  return value;
};
const nullableInteger = (row: Row, field: string): number | null => {
  const value = row[field];
  if (value === null || value === undefined) return null;
  return integer(row, field);
};
const instant = (row: Row, field: string): string => {
  const value = row[field];
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) throw new Error(`invalid ${field}`);
  return new Date(milliseconds).toISOString();
};
const nullableInstant = (row: Row, field: string): string | null => {
  const value = row[field];
  if (value === null || value === undefined) return null;
  return instant(row, field);
};
const bytes = (row: Row, field: string): Uint8Array | null => {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new Error(`invalid ${field}`);
};
const sameBytes = (left: Uint8Array | null, right: Uint8Array): boolean =>
  left !== null &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);
const operationFromRow = (row: Row): DataRegistrationOperation => {
  const state = text(row, "state") as DataRegistrationOperationState;
  const failureCode = nullableText(row, "failure_code") as DataRegistrationFailureCode | null;
  if (
    !OPERATION_STATES.has(state) ||
    (failureCode !== null && !OPERATION_FAILURE_CODES.has(failureCode))
  ) {
    throw new Error("invalid operation state");
  }
  return {
    registrationOperationId: text(row, "registration_operation_id"),
    communityId: text(row, "community_id"),
    actorUserId: text(row, "actor_user_id"),
    submissionId: text(row, "submission_id"),
    mediaOperationId: text(row, "media_operation_id"),
    postId: text(row, "post_id"),
    assetId: text(row, "asset_id"),
    chainId: bigint(row, "chain_id"),
    registrationRevision: bigint(row, "registration_revision"),
    publicationCreationRevision: bigint(row, "publication_creation_revision"),
    publicationAudioRevision: bigint(row, "publication_audio_revision"),
    publicationAnalysisRevision: bigint(row, "publication_analysis_revision"),
    publicationDecisionRevision: bigint(row, "publication_decision_revision"),
    canonicalAudioSha256: text(row, "canonical_audio_sha256"),
    state,
    workflowRevision: bigint(row, "workflow_revision"),
    workflowInstanceId: text(row, "workflow_instance_id"),
    currentAttemptId: nullableText(row, "current_attempt_id"),
    registeredIpId: nullableText(row, "registered_ip_id"),
    confirmedTransactionHash: nullableText(row, "confirmed_transaction_hash"),
    confirmedBlockNumber: nullableBigint(row, "confirmed_block_number"),
    confirmedBlockHash: nullableText(row, "confirmed_block_hash"),
    confirmedLogIndex: nullableInteger(row, "confirmed_log_index"),
    confirmedAt: nullableInstant(row, "confirmed_at"),
    failureCode,
    failureEvidenceRef: nullableText(row, "failure_evidence_ref"),
  };
};

const artifactFromRow = (row: Row): DataRegistrationArtifact => ({
  artifactId: text(row, "artifact_id"),
  registrationOperationId: text(row, "registration_operation_id"),
  artifactKind: text(row, "artifact_kind") as DataRegistrationArtifact["artifactKind"],
  sourceRef: text(row, "source_ref"),
  mediaType: text(row, "media_type"),
  byteLength: bigint(row, "byte_length"),
  canonicalSha256: text(row, "canonical_sha256"),
  canonicalizationRevision: nullableText(
    row,
    "canonicalization_revision",
  ) as DataRegistrationArtifact["canonicalizationRevision"],
});

const pinFromRow = (row: Row): DataRegistrationPinVerification => ({
  pinVerificationId: text(row, "pin_verification_id"),
  registrationOperationId: text(row, "registration_operation_id"),
  artifactId: text(row, "artifact_id"),
  artifactKind: text(row, "artifact_kind") as DataRegistrationPinVerification["artifactKind"],
  role: text(row, "role") as DataRegistrationPinVerification["role"],
  providerId: text(row, "provider_id"),
  attemptNumber: integer(row, "attempt_number"),
  outcome: text(row, "outcome") as DataRegistrationPinVerification["outcome"],
  cid: nullableText(row, "cid"),
  canonicalSha256: nullableText(row, "canonical_sha256"),
  byteLength: nullableBigint(row, "byte_length"),
  evidenceRef: text(row, "evidence_ref"),
  verifiedAt: nullableInstant(row, "verified_at"),
});

const attemptFromRow = (row: Row): DataRegistrationSigningAttempt => {
  const state = text(row, "state") as DataRegistrationAttemptState;
  const failureCode = nullableText(
    row,
    "failure_code",
  ) as DataRegistrationAttemptFailureCode | null;
  if (
    !ATTEMPT_STATES.has(state) ||
    (failureCode !== null && !ATTEMPT_FAILURE_CODES.has(failureCode))
  ) {
    throw new Error("invalid attempt state");
  }
  return {
    submissionAttemptId: text(row, "submission_attempt_id"),
    registrationOperationId: text(row, "registration_operation_id"),
    chainId: bigint(row, "chain_id"),
    attemptNumber: integer(row, "attempt_number"),
    signerNamespace: text(row, "signer_namespace"),
    signerAddress: text(row, "signer_address"),
    signingIntentId: text(row, "signing_intent_id"),
    calldataHash: text(row, "calldata_hash"),
    nonce: nullableBigint(row, "nonce"),
    signedTransaction: bytes(row, "signed_transaction"),
    signedTransactionHash: nullableText(row, "signed_transaction_hash"),
    transactionHash: nullableText(row, "transaction_hash"),
    supersedesSubmissionAttemptId: nullableText(row, "supersedes_submission_attempt_id"),
    state,
    failureCode,
    failureEvidenceRef: nullableText(row, "failure_evidence_ref"),
  };
};

const receiptFromRow = (row: Row): DataRegistrationReceiptObservation => ({
  receiptObservationId: text(row, "receipt_observation_id"),
  registrationOperationId: text(row, "registration_operation_id"),
  submissionAttemptId: text(row, "submission_attempt_id"),
  observationSequence: bigint(row, "observation_sequence"),
  transactionHash: text(row, "transaction_hash"),
  outcome: text(row, "outcome") as DataRegistrationReceiptObservation["outcome"],
  blockNumber: nullableBigint(row, "block_number"),
  blockHash: nullableText(row, "block_hash"),
  logIndex: nullableInteger(row, "log_index"),
  confirmations: integer(row, "confirmations"),
  registeredIpId: nullableText(row, "registered_ip_id"),
  ipMetadataUri: nullableText(row, "ip_metadata_uri"),
  ipMetadataHash: nullableText(row, "ip_metadata_hash"),
  nftMetadataUri: nullableText(row, "nft_metadata_uri"),
  nftMetadataHash: nullableText(row, "nft_metadata_hash"),
  evidenceRef: text(row, "evidence_ref"),
  observedAt: instant(row, "observed_at"),
});

const outboxFromRow = (row: Row): DataRegistrationOutbox => ({
  outboxId: text(row, "outbox_id"),
  registrationOperationId: text(row, "registration_operation_id"),
  workflowRevision: bigint(row, "workflow_revision"),
  workflowInstanceId: text(row, "workflow_instance_id"),
  eventType: text(row, "event_type") as DataRegistrationOutbox["eventType"],
  effectIdentity: text(row, "effect_identity"),
  state: text(row, "state") as DataRegistrationOutbox["state"],
  deliveryAttempts: integer(row, "delivery_attempts"),
  claimOwner: nullableText(row, "claim_owner"),
  claimFence: bigint(row, "claim_fence"),
  leaseExpiresAt: nullableInstant(row, "lease_expires_at"),
  nextEligibleAt: nullableInstant(row, "next_eligible_at"),
  failureCode: nullableText(row, "failure_code") as DataRegistrationOutbox["failureCode"],
});

const OPERATION_SELECT = `
  SELECT registration_operation_id,community_id,actor_user_id,submission_id,
         media_operation_id,post_id,asset_id,chain_id,registration_revision,
         publication_creation_revision,publication_audio_revision,
         publication_analysis_revision,publication_decision_revision,
         canonical_audio_sha256,state,workflow_revision,workflow_instance_id,
         current_attempt_id,registered_ip_id,confirmed_transaction_hash,
         confirmed_block_number,confirmed_block_hash,confirmed_log_index,
         confirmed_at,failure_code,failure_evidence_ref
    FROM data_registration_operations`;
const ARTIFACT_SELECT = `
  SELECT artifact_id,registration_operation_id,artifact_kind,source_ref,
         media_type,byte_length,canonical_sha256,canonicalization_revision
    FROM data_registration_artifacts`;
const PIN_SELECT = `
  SELECT pin_verification_id,registration_operation_id,artifact_id,artifact_kind,
         role,provider_id,attempt_number,outcome,cid,canonical_sha256,byte_length,
         evidence_ref,verified_at
    FROM data_registration_pin_verifications`;
const ATTEMPT_SELECT = `
  SELECT submission_attempt_id,registration_operation_id,chain_id,attempt_number,
         signer_namespace,signer_address,signing_intent_id,calldata_hash,nonce,
         signed_transaction,signed_transaction_hash,transaction_hash,
         supersedes_submission_attempt_id,state,failure_code,failure_evidence_ref
    FROM data_registration_signing_attempts`;
const RECEIPT_SELECT = `
  SELECT receipt_observation_id,registration_operation_id,submission_attempt_id,
         observation_sequence,transaction_hash,outcome,block_number,block_hash,
         log_index,confirmations,registered_ip_id,ip_metadata_uri,ip_metadata_hash,
         nft_metadata_uri,nft_metadata_hash,evidence_ref,observed_at
    FROM data_registration_receipt_observations`;
const OUTBOX_SELECT = `
  SELECT outbox_id,registration_operation_id,workflow_revision,workflow_instance_id,
         event_type,effect_identity,state,delivery_attempts,claim_owner,claim_fence,
         lease_expires_at,next_eligible_at,failure_code
    FROM data_registration_outbox`;

const decode = <A>(
  operation: DataRegistrationRepositoryError["operation"],
  row: Row,
  parser: (value: Row) => A,
  registrationOperationId?: string,
): Effect.Effect<A, DataRegistrationRepositoryError> =>
  Effect.try({
    try: () => parser(row),
    catch: () => fail(operation, "invalid-row", registrationOperationId),
  });

const readOperation = (
  db: ControlPlaneTransaction,
  registrationOperationId: string,
  lock = false,
) =>
  Effect.gen(function* () {
    const result = yield* db.execute<Row>({
      label: "data-registration.operation.read",
      text: `${OPERATION_SELECT} WHERE registration_operation_id=$1 ${lock ? "FOR UPDATE" : ""}`,
      values: [registrationOperationId],
      readonly: !lock,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1 || result.rows[0] === undefined) {
      return yield* Effect.fail(fail("read", "invalid-row", registrationOperationId));
    }
    return yield* decode("read", result.rows[0], operationFromRow, registrationOperationId);
  });

const readAttempt = (db: ControlPlaneTransaction, submissionAttemptId: string, lock = false) =>
  Effect.gen(function* () {
    const result = yield* db.execute<Row>({
      label: "data-registration.attempt.read",
      text: `${ATTEMPT_SELECT} WHERE submission_attempt_id=$1 ${lock ? "FOR UPDATE" : ""}`,
      values: [submissionAttemptId],
      readonly: !lock,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1 || result.rows[0] === undefined) {
      return yield* Effect.fail(fail("attempt", "invalid-row"));
    }
    return yield* decode("attempt", result.rows[0], attemptFromRow);
  });

const appendTransition = (
  db: ControlPlaneTransaction,
  attempt: DataRegistrationSigningAttempt,
  fromState: DataRegistrationAttemptState | null,
  toState: DataRegistrationAttemptState,
  evidenceRef: string,
) =>
  Effect.gen(function* () {
    const sequenceResult = yield* db.execute<Row>({
      label: "data-registration.transition.sequence",
      text: "SELECT COALESCE(MAX(transition_sequence),0)+1 AS next_sequence FROM data_registration_attempt_transitions WHERE submission_attempt_id=$1",
      values: [attempt.submissionAttemptId],
      readonly: false,
    });
    const sequence = bigint(sequenceResult.rows[0] ?? {}, "next_sequence");
    yield* db.execute({
      label: "data-registration.transition.append",
      text: "INSERT INTO data_registration_attempt_transitions (transition_id,registration_operation_id,submission_attempt_id,transition_sequence,from_state,to_state,evidence_ref) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      values: [
        deterministicDataRegistrationTransitionId(attempt.submissionAttemptId, sequence),
        attempt.registrationOperationId,
        attempt.submissionAttemptId,
        sequence.toString(),
        fromState,
        toState,
        evidenceRef,
      ],
      readonly: false,
    });
  });

const artifactMatches = (left: DataRegistrationArtifact, right: DataRegistrationArtifact) =>
  left.artifactId === right.artifactId &&
  left.registrationOperationId === right.registrationOperationId &&
  left.artifactKind === right.artifactKind &&
  left.sourceRef === right.sourceRef &&
  left.mediaType === right.mediaType &&
  left.byteLength === right.byteLength &&
  left.canonicalSha256 === right.canonicalSha256 &&
  left.canonicalizationRevision === right.canonicalizationRevision;

const pinMatches = (
  left: DataRegistrationPinVerification,
  right: DataRegistrationPinVerification,
) =>
  left.pinVerificationId === right.pinVerificationId &&
  left.registrationOperationId === right.registrationOperationId &&
  left.artifactId === right.artifactId &&
  left.artifactKind === right.artifactKind &&
  left.role === right.role &&
  left.providerId === right.providerId &&
  left.attemptNumber === right.attemptNumber &&
  left.outcome === right.outcome &&
  left.cid === right.cid &&
  left.canonicalSha256 === right.canonicalSha256 &&
  left.byteLength === right.byteLength &&
  left.evidenceRef === right.evidenceRef &&
  left.verifiedAt === right.verifiedAt;

const attemptIdentityMatches = (
  left: DataRegistrationSigningAttempt,
  right: ReserveDataRegistrationAttemptInput,
) =>
  left.submissionAttemptId === right.submissionAttemptId &&
  left.registrationOperationId === right.registrationOperationId &&
  left.chainId === right.chainId &&
  left.attemptNumber === right.attemptNumber &&
  left.signerNamespace === right.signerNamespace &&
  left.signerAddress.toLowerCase() === right.signerAddress.toLowerCase() &&
  left.signingIntentId === right.signingIntentId &&
  left.calldataHash === right.calldataHash &&
  left.supersedesSubmissionAttemptId === right.supersedesSubmissionAttemptId;

const receiptMatches = (
  left: DataRegistrationReceiptObservation,
  right: DataRegistrationReceiptInput,
) =>
  left.receiptObservationId === right.receiptObservationId &&
  left.registrationOperationId === right.registrationOperationId &&
  left.submissionAttemptId === right.submissionAttemptId &&
  left.observationSequence === right.observationSequence &&
  left.transactionHash === right.transactionHash &&
  left.outcome === right.outcome &&
  left.blockNumber === right.blockNumber &&
  left.blockHash === right.blockHash &&
  left.logIndex === right.logIndex &&
  left.confirmations === right.confirmations &&
  left.registeredIpId === right.registeredIpId &&
  left.ipMetadataUri === right.ipMetadataUri &&
  left.ipMetadataHash === right.ipMetadataHash &&
  left.nftMetadataUri === right.nftMetadataUri &&
  left.nftMetadataHash === right.nftMetadataHash &&
  left.evidenceRef === right.evidenceRef &&
  Date.parse(left.observedAt) === Date.parse(right.observedAt);

const recordReceiptIn = (db: ControlPlaneTransaction, input: DataRegistrationReceiptInput) =>
  Effect.gen(function* () {
    const existing = yield* db.execute<Row>({
      label: "data-registration.receipt.replay",
      text: `${RECEIPT_SELECT} WHERE receipt_observation_id=$1`,
      values: [input.receiptObservationId],
      readonly: false,
    });
    if (existing.rows.length === 1 && existing.rows[0] !== undefined) {
      const decoded = yield* decode("receipt", existing.rows[0], receiptFromRow);
      if (!receiptMatches(decoded, input))
        return yield* Effect.fail(fail("receipt", "identity-conflict"));
      return "replay" as const;
    }
    if (existing.rows.length !== 0) return yield* Effect.fail(fail("receipt", "invalid-row"));
    yield* db.execute({
      label: "data-registration.receipt.insert",
      text: "INSERT INTO data_registration_receipt_observations (receipt_observation_id,registration_operation_id,submission_attempt_id,observation_sequence,transaction_hash,outcome,block_number,block_hash,log_index,confirmations,registered_ip_id,ip_metadata_uri,ip_metadata_hash,nft_metadata_uri,nft_metadata_hash,evidence_ref,observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
      values: [
        input.receiptObservationId,
        input.registrationOperationId,
        input.submissionAttemptId,
        input.observationSequence.toString(),
        input.transactionHash,
        input.outcome,
        input.blockNumber?.toString() ?? null,
        input.blockHash,
        input.logIndex,
        input.confirmations,
        input.registeredIpId,
        input.ipMetadataUri,
        input.ipMetadataHash,
        input.nftMetadataUri,
        input.nftMetadataHash,
        input.evidenceRef,
        input.observedAt,
      ],
      readonly: false,
    });
    return "created" as const;
  });

const sha256Hex = async (value: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export function makeDataRegistrationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): DataRegistrationStore {
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>): Promise<A> =>
    Effect.runPromise(Effect.provide(runtime)(effect));

  const getOperation: DataRegistrationStore["getOperation"] = (registrationOperationId) => {
    if (!validId(registrationOperationId)) return Promise.reject(fail("read", "invalid-input"));
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* readOperation(db, registrationOperationId);
      }),
    );
  };

  const createOperation: DataRegistrationStore["createOperation"] = async (input) => {
    if (
      ![
        input.registrationOperationId,
        input.communityId,
        input.actorUserId,
        input.submissionId,
        input.mediaOperationId,
        input.postId,
        input.assetId,
        input.workflowInstanceId,
        input.outboxId,
        input.outboxEffectIdentity,
        input.endpointTemplate,
        input.idempotencyKey,
      ].every((value) => validId(value)) ||
      !validHash(input.canonicalAudioSha256) ||
      !validHash(input.requestHash) ||
      !validHash(input.responseSnapshotSha256) ||
      input.responseSnapshotBytes.length === 0 ||
      ![
        input.chainId,
        input.registrationRevision,
        input.publicationCreationRevision,
        input.publicationAudioRevision,
        input.publicationAnalysisRevision,
        input.publicationDecisionRevision,
        input.workflowRevision,
      ].every(positive) ||
      input.assetId !== input.postId ||
      input.registrationOperationId !==
        deterministicDataRegistrationOperationId(
          input.chainId,
          input.assetId,
          input.registrationRevision,
        ) ||
      input.workflowInstanceId !==
        deterministicDataRegistrationWorkflowId(
          input.registrationOperationId,
          input.workflowRevision,
        ) ||
      input.outboxId !==
        deterministicDataRegistrationOutboxId(
          input.registrationOperationId,
          input.workflowRevision,
        ) ||
      (await sha256Hex(input.responseSnapshotBytes)) !== input.responseSnapshotSha256
    ) {
      throw fail("create", "invalid-input", input.registrationOperationId);
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute({
              label: "data-registration.create.lock",
              text: "SELECT pg_advisory_xact_lock(hashtextextended($1,57000001))",
              values: [JSON.stringify([input.endpointTemplate, input.idempotencyKey])],
              readonly: false,
            });
            const replay = yield* transaction.execute<Row>({
              label: "data-registration.create.replay",
              text: "SELECT request_hash,registration_operation_id FROM data_registration_command_replays WHERE endpoint_template=$1 AND idempotency_key=$2",
              values: [input.endpointTemplate, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length === 1 && replay.rows[0] !== undefined) {
              if (
                replay.rows[0].request_hash !== input.requestHash ||
                replay.rows[0].registration_operation_id !== input.registrationOperationId
              ) {
                return yield* Effect.fail(
                  fail("create", "identity-conflict", input.registrationOperationId),
                );
              }
              const operation = yield* readOperation(
                transaction,
                input.registrationOperationId,
                true,
              );
              if (operation === null) {
                return yield* Effect.fail(
                  fail("create", "invalid-row", input.registrationOperationId),
                );
              }
              return { kind: "replay", operation } as const;
            }
            if (replay.rows.length !== 0) {
              return yield* Effect.fail(
                fail("create", "invalid-row", input.registrationOperationId),
              );
            }
            yield* transaction.execute({
              label: "data-registration.create.operation",
              text: "INSERT INTO data_registration_operations (registration_operation_id,community_id,actor_user_id,submission_id,media_operation_id,post_id,asset_id,chain_id,registration_revision,publication_creation_revision,publication_audio_revision,publication_analysis_revision,publication_decision_revision,canonical_audio_sha256,workflow_revision,workflow_instance_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
              values: [
                input.registrationOperationId,
                input.communityId,
                input.actorUserId,
                input.submissionId,
                input.mediaOperationId,
                input.postId,
                input.assetId,
                input.chainId.toString(),
                input.registrationRevision.toString(),
                input.publicationCreationRevision.toString(),
                input.publicationAudioRevision.toString(),
                input.publicationAnalysisRevision.toString(),
                input.publicationDecisionRevision.toString(),
                input.canonicalAudioSha256,
                input.workflowRevision.toString(),
                input.workflowInstanceId,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "data-registration.create.outbox",
              text: "INSERT INTO data_registration_outbox (outbox_id,registration_operation_id,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ($1,$2,$3,$4,'registration_launch',$5,$6::jsonb)",
              values: [
                input.outboxId,
                input.registrationOperationId,
                input.workflowRevision.toString(),
                input.workflowInstanceId,
                input.outboxEffectIdentity,
                JSON.stringify({
                  operation_id: input.registrationOperationId,
                  outbox_id: input.outboxId,
                }),
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "data-registration.create.replay-insert",
              text: "INSERT INTO data_registration_command_replays (endpoint_template,idempotency_key,request_hash,registration_operation_id,response_snapshot_bytes,response_snapshot_sha256) VALUES ($1,$2,$3,$4,$5,$6)",
              values: [
                input.endpointTemplate,
                input.idempotencyKey,
                input.requestHash,
                input.registrationOperationId,
                input.responseSnapshotBytes,
                input.responseSnapshotSha256,
              ],
              readonly: false,
            });
            const operation = yield* readOperation(transaction, input.registrationOperationId);
            if (operation === null) {
              return yield* Effect.fail(
                fail("create", "invalid-row", input.registrationOperationId),
              );
            }
            return { kind: "created", operation } as const;
          }),
        );
      }),
    );
  };

  const recordArtifact: DataRegistrationStore["recordArtifact"] = (artifact) => {
    if (
      !validId(artifact.artifactId) ||
      !validId(artifact.registrationOperationId) ||
      !validId(artifact.sourceRef, 16_384) ||
      !validId(artifact.mediaType, 128) ||
      !positive(artifact.byteLength) ||
      !validHash(artifact.canonicalSha256) ||
      (artifact.artifactKind.endsWith("metadata")
        ? artifact.canonicalizationRevision !== "rfc8785-jcs-v1" ||
          artifact.mediaType !== "application/json"
        : artifact.canonicalizationRevision !== null)
    ) {
      return Promise.reject(fail("artifact", "invalid-input", artifact.registrationOperationId));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "data-registration.artifact.insert",
              text: "INSERT INTO data_registration_artifacts (artifact_id,registration_operation_id,artifact_kind,source_ref,media_type,byte_length,canonical_sha256,canonicalization_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (artifact_id) DO NOTHING RETURNING artifact_id",
              values: [
                artifact.artifactId,
                artifact.registrationOperationId,
                artifact.artifactKind,
                artifact.sourceRef,
                artifact.mediaType,
                artifact.byteLength.toString(),
                artifact.canonicalSha256,
                artifact.canonicalizationRevision,
              ],
              readonly: false,
            });
            if (result.rowCount === 1) return "created" as const;
            const existing = yield* transaction.execute<Row>({
              label: "data-registration.artifact.replay",
              text: `${ARTIFACT_SELECT} WHERE artifact_id=$1`,
              values: [artifact.artifactId],
              readonly: false,
            });
            if (existing.rows.length !== 1 || existing.rows[0] === undefined) {
              return yield* Effect.fail(
                fail("artifact", "identity-conflict", artifact.registrationOperationId),
              );
            }
            const decoded = yield* decode(
              "artifact",
              existing.rows[0],
              artifactFromRow,
              artifact.registrationOperationId,
            );
            if (!artifactMatches(decoded, artifact)) {
              return yield* Effect.fail(
                fail("artifact", "identity-conflict", artifact.registrationOperationId),
              );
            }
            return "replay" as const;
          }),
        );
      }),
    );
  };

  const recordPinVerification: DataRegistrationStore["recordPinVerification"] = (verification) => {
    if (
      ![
        verification.pinVerificationId,
        verification.registrationOperationId,
        verification.artifactId,
        verification.providerId,
        verification.evidenceRef,
      ].every((value) => validId(value)) ||
      verification.attemptNumber < 1 ||
      verification.attemptNumber > 10 ||
      (verification.outcome === "verified"
        ? !validId(verification.cid) ||
          !validHash(verification.canonicalSha256) ||
          verification.byteLength === null ||
          !positive(verification.byteLength) ||
          verification.verifiedAt === null ||
          !validInstant(verification.verifiedAt)
        : verification.cid !== null ||
          verification.canonicalSha256 !== null ||
          verification.byteLength !== null ||
          verification.verifiedAt !== null)
    ) {
      return Promise.reject(fail("pin", "invalid-input", verification.registrationOperationId));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const inserted = yield* transaction.execute<Row>({
              label: "data-registration.pin.insert",
              text: "INSERT INTO data_registration_pin_verifications (pin_verification_id,registration_operation_id,artifact_id,artifact_kind,role,provider_id,attempt_number,outcome,cid,canonical_sha256,byte_length,evidence_ref,verified_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (pin_verification_id) DO NOTHING RETURNING pin_verification_id",
              values: [
                verification.pinVerificationId,
                verification.registrationOperationId,
                verification.artifactId,
                verification.artifactKind,
                verification.role,
                verification.providerId,
                verification.attemptNumber,
                verification.outcome,
                verification.cid,
                verification.canonicalSha256,
                verification.byteLength?.toString() ?? null,
                verification.evidenceRef,
                verification.verifiedAt,
              ],
              readonly: false,
            });
            if (inserted.rowCount === 1) return "created" as const;
            const existing = yield* transaction.execute<Row>({
              label: "data-registration.pin.replay",
              text: `${PIN_SELECT} WHERE pin_verification_id=$1`,
              values: [verification.pinVerificationId],
              readonly: false,
            });
            if (existing.rows.length !== 1 || existing.rows[0] === undefined) {
              return yield* Effect.fail(
                fail("pin", "identity-conflict", verification.registrationOperationId),
              );
            }
            const decoded = yield* decode(
              "pin",
              existing.rows[0],
              pinFromRow,
              verification.registrationOperationId,
            );
            if (!pinMatches(decoded, verification)) {
              return yield* Effect.fail(
                fail("pin", "identity-conflict", verification.registrationOperationId),
              );
            }
            return "replay" as const;
          }),
        );
      }),
    );
  };

  const pinsReady: DataRegistrationStore["pinsReady"] = (registrationOperationId) => {
    if (!validId(registrationOperationId)) return Promise.reject(fail("pin", "invalid-input"));
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "data-registration.pin.ready",
          text: "SELECT data_registration_pins_are_ready($1) AS ready",
          values: [registrationOperationId],
          readonly: true,
        });
        return result.rows[0]?.ready === true;
      }),
    );
  };

  const reserveSigningAttempt: DataRegistrationStore["reserveSigningAttempt"] = (input) => {
    if (
      ![
        input.registrationOperationId,
        input.submissionAttemptId,
        input.signerNamespace,
        input.signingIntentId,
        input.evidenceRef,
      ].every((value) => validId(value)) ||
      !validAddress(input.signerAddress) ||
      !validHash(input.calldataHash) ||
      !positive(input.chainId) ||
      input.attemptNumber < 1 ||
      input.attemptNumber > 20
    ) {
      return Promise.reject(fail("attempt", "invalid-input", input.registrationOperationId));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const existing = yield* readAttempt(transaction, input.submissionAttemptId, true);
            if (existing !== null) {
              if (!attemptIdentityMatches(existing, input)) {
                return yield* Effect.fail(
                  fail("attempt", "identity-conflict", input.registrationOperationId),
                );
              }
              return { kind: "replay", attempt: existing } as const;
            }
            const ready = yield* transaction.execute<Row>({
              label: "data-registration.attempt.pin-fence",
              text: "SELECT data_registration_pins_are_ready($1) AS ready",
              values: [input.registrationOperationId],
              readonly: false,
            });
            if (ready.rows[0]?.ready !== true) {
              return yield* Effect.fail(
                fail("attempt", "pins-not-ready", input.registrationOperationId),
              );
            }
            yield* transaction.execute({
              label: "data-registration.attempt.insert",
              text: "INSERT INTO data_registration_signing_attempts (submission_attempt_id,registration_operation_id,chain_id,attempt_number,signer_namespace,signer_address,signing_intent_id,calldata_hash,supersedes_submission_attempt_id,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'signing_intent')",
              values: [
                input.submissionAttemptId,
                input.registrationOperationId,
                input.chainId.toString(),
                input.attemptNumber,
                input.signerNamespace,
                input.signerAddress,
                input.signingIntentId,
                input.calldataHash,
                input.supersedesSubmissionAttemptId,
              ],
              readonly: false,
            });
            const attempt = yield* readAttempt(transaction, input.submissionAttemptId, true);
            if (attempt === null) {
              return yield* Effect.fail(
                fail("attempt", "invalid-row", input.registrationOperationId),
              );
            }
            yield* appendTransition(
              transaction,
              attempt,
              null,
              "signing_intent",
              input.evidenceRef,
            );
            const operation = yield* transaction.execute({
              label: "data-registration.attempt.operation",
              text: "UPDATE data_registration_operations SET state='signing',current_attempt_id=$1,updated_at=clock_timestamp() WHERE registration_operation_id=$2 AND state IN ('pending','broadcast','confirming','reconciliation_required')",
              values: [input.submissionAttemptId, input.registrationOperationId],
              readonly: false,
            });
            if (operation.rowCount !== 1) {
              return yield* Effect.fail(
                fail("attempt", "stale-state", input.registrationOperationId),
              );
            }
            return { kind: "created", attempt } as const;
          }),
        );
      }),
    );
  };

  const transitionAttempt = (
    submissionAttemptId: string,
    expectedState: DataRegistrationAttemptState,
    nextState: DataRegistrationAttemptState,
    evidenceRef: string,
    fields: Readonly<Record<string, unknown>>,
    replayMatches: (attempt: DataRegistrationSigningAttempt) => boolean,
  ): Promise<DataRegistrationSigningAttempt> => {
    if (!validId(submissionAttemptId) || !validId(evidenceRef)) {
      return Promise.reject(fail("attempt", "invalid-input"));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const current = yield* readAttempt(transaction, submissionAttemptId, true);
            if (current === null) return yield* Effect.fail(fail("attempt", "not-found"));
            if (current.state === nextState) {
              if (!replayMatches(current)) {
                return yield* Effect.fail(
                  fail("attempt", "identity-conflict", current.registrationOperationId),
                );
              }
              return current;
            }
            if (current.state !== expectedState) {
              return yield* Effect.fail(
                fail("attempt", "stale-state", current.registrationOperationId),
              );
            }
            const assignments: string[] = ["state=$2", "updated_at=clock_timestamp()"];
            const values: unknown[] = [submissionAttemptId, nextState];
            for (const [column, value] of Object.entries(fields)) {
              assignments.push(`${column}=$${values.length + 1}`);
              values.push(value);
            }
            const updated = yield* transaction.execute({
              label: "data-registration.attempt.transition",
              text: `UPDATE data_registration_signing_attempts SET ${assignments.join(",")} WHERE submission_attempt_id=$1 AND state='${expectedState}'`,
              values,
              readonly: false,
            });
            if (updated.rowCount !== 1) {
              return yield* Effect.fail(
                fail("attempt", "stale-state", current.registrationOperationId),
              );
            }
            yield* appendTransition(transaction, current, current.state, nextState, evidenceRef);
            const result = yield* readAttempt(transaction, submissionAttemptId);
            if (result === null) return yield* Effect.fail(fail("attempt", "invalid-row"));
            return result;
          }),
        );
      }),
    );
  };

  const reserveNonce: DataRegistrationStore["reserveNonce"] = (
    submissionAttemptId,
    nonce,
    evidenceRef,
  ) => {
    if (nonce < 0n) return Promise.reject(fail("attempt", "invalid-input"));
    return transitionAttempt(
      submissionAttemptId,
      "signing_intent",
      "nonce_reserved",
      evidenceRef,
      { nonce: nonce.toString() },
      (attempt) => attempt.nonce === nonce,
    );
  };

  const persistPreparedTransaction: DataRegistrationStore["persistPreparedTransaction"] = (
    submissionAttemptId,
    signedTransaction,
    signedTransactionHash,
    evidenceRef,
  ) => {
    if (signedTransaction.length === 0 || !validTransactionHash(signedTransactionHash)) {
      return Promise.reject(fail("attempt", "invalid-input"));
    }
    return transitionAttempt(
      submissionAttemptId,
      "nonce_reserved",
      "prepared",
      evidenceRef,
      {
        signed_transaction: signedTransaction,
        signed_transaction_hash: signedTransactionHash,
        prepared_at: new Date().toISOString(),
      },
      (attempt) =>
        attempt.signedTransactionHash === signedTransactionHash &&
        sameBytes(attempt.signedTransaction, signedTransaction),
    );
  };

  const markBroadcast: DataRegistrationStore["markBroadcast"] = (
    submissionAttemptId,
    transactionHash,
    evidenceRef,
  ) => {
    if (!validTransactionHash(transactionHash)) {
      return Promise.reject(fail("attempt", "invalid-input"));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const current = yield* readAttempt(transaction, submissionAttemptId, true);
            if (current === null) return yield* Effect.fail(fail("attempt", "not-found"));
            if (current.state === "broadcast" && current.transactionHash === transactionHash) {
              return current;
            }
            if (current.state !== "prepared") {
              return yield* Effect.fail(
                fail("attempt", "stale-state", current.registrationOperationId),
              );
            }
            if (current.signedTransactionHash !== transactionHash) {
              return yield* Effect.fail(
                fail("attempt", "identity-conflict", current.registrationOperationId),
              );
            }
            yield* transaction.execute({
              label: "data-registration.attempt.broadcast",
              text: "UPDATE data_registration_signing_attempts SET state='broadcast',transaction_hash=$2,broadcast_at=clock_timestamp(),updated_at=clock_timestamp() WHERE submission_attempt_id=$1 AND state='prepared'",
              values: [submissionAttemptId, transactionHash],
              readonly: false,
            });
            yield* appendTransition(transaction, current, "prepared", "broadcast", evidenceRef);
            const operation = yield* transaction.execute({
              label: "data-registration.operation.broadcast",
              text: "UPDATE data_registration_operations SET state='broadcast',updated_at=clock_timestamp() WHERE registration_operation_id=$1 AND current_attempt_id=$2 AND state='signing'",
              values: [current.registrationOperationId, submissionAttemptId],
              readonly: false,
            });
            if (operation.rowCount !== 1) {
              return yield* Effect.fail(
                fail("attempt", "stale-state", current.registrationOperationId),
              );
            }
            const result = yield* readAttempt(transaction, submissionAttemptId);
            if (result === null) return yield* Effect.fail(fail("attempt", "invalid-row"));
            return result;
          }),
        );
      }),
    );
  };

  const recordReceipt: DataRegistrationStore["recordReceipt"] = (observation) => {
    if (
      observation.receiptObservationId !==
        deterministicDataRegistrationReceiptId(
          observation.submissionAttemptId,
          observation.observationSequence,
        ) ||
      !validTransactionHash(observation.transactionHash) ||
      !validId(observation.evidenceRef) ||
      !validInstant(observation.observedAt) ||
      !positive(observation.observationSequence)
    ) {
      return Promise.reject(fail("receipt", "invalid-input", observation.registrationOperationId));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          recordReceiptIn(transaction, observation),
        );
      }),
    );
  };

  const markReplaced: DataRegistrationStore["markReplaced"] = (
    supersededSubmissionAttemptId,
    replacementSubmissionAttemptId,
    evidenceRef,
  ) => {
    if (
      !validId(supersededSubmissionAttemptId) ||
      !validId(replacementSubmissionAttemptId) ||
      !validId(evidenceRef) ||
      supersededSubmissionAttemptId === replacementSubmissionAttemptId
    ) {
      return Promise.reject(fail("attempt", "invalid-input"));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const superseded = yield* readAttempt(transaction, supersededSubmissionAttemptId, true);
            const replacement = yield* readAttempt(
              transaction,
              replacementSubmissionAttemptId,
              true,
            );
            if (superseded === null || replacement === null) {
              return yield* Effect.fail(fail("attempt", "not-found"));
            }
            if (
              replacement.registrationOperationId !== superseded.registrationOperationId ||
              replacement.supersedesSubmissionAttemptId !== superseded.submissionAttemptId ||
              replacement.attemptNumber <= superseded.attemptNumber
            ) {
              return yield* Effect.fail(
                fail("attempt", "identity-conflict", superseded.registrationOperationId),
              );
            }
            if (superseded.state === "replaced") return superseded;
            if (superseded.state !== "broadcast" && superseded.state !== "mined") {
              return yield* Effect.fail(
                fail("attempt", "stale-state", superseded.registrationOperationId),
              );
            }
            const updated = yield* transaction.execute({
              label: "data-registration.attempt.replaced",
              text: "UPDATE data_registration_signing_attempts SET state='replaced',terminal_at=clock_timestamp(),updated_at=clock_timestamp() WHERE submission_attempt_id=$1 AND state IN ('broadcast','mined')",
              values: [supersededSubmissionAttemptId],
              readonly: false,
            });
            if (updated.rowCount !== 1) {
              return yield* Effect.fail(
                fail("attempt", "stale-state", superseded.registrationOperationId),
              );
            }
            yield* appendTransition(
              transaction,
              superseded,
              superseded.state,
              "replaced",
              evidenceRef,
            );
            const result = yield* readAttempt(transaction, supersededSubmissionAttemptId);
            if (result === null) return yield* Effect.fail(fail("attempt", "invalid-row"));
            return result;
          }),
        );
      }),
    );
  };

  const markMined: DataRegistrationStore["markMined"] = (submissionAttemptId, evidenceRef) =>
    run(
      Effect.gen(function* () {
        if (!validId(submissionAttemptId) || !validId(evidenceRef)) {
          return yield* Effect.fail(fail("attempt", "invalid-input"));
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const current = yield* readAttempt(transaction, submissionAttemptId, true);
            if (current === null) return yield* Effect.fail(fail("attempt", "not-found"));
            if (current.state === "mined") return current;
            if (current.state !== "broadcast") {
              return yield* Effect.fail(
                fail("attempt", "stale-state", current.registrationOperationId),
              );
            }
            yield* transaction.execute({
              label: "data-registration.attempt.mined",
              text: "UPDATE data_registration_signing_attempts SET state='mined',updated_at=clock_timestamp() WHERE submission_attempt_id=$1 AND state='broadcast'",
              values: [submissionAttemptId],
              readonly: false,
            });
            yield* appendTransition(transaction, current, "broadcast", "mined", evidenceRef);
            const operation = yield* transaction.execute({
              label: "data-registration.operation.confirming",
              text: "UPDATE data_registration_operations SET state='confirming',updated_at=clock_timestamp() WHERE registration_operation_id=$1 AND current_attempt_id=$2 AND state='broadcast'",
              values: [current.registrationOperationId, submissionAttemptId],
              readonly: false,
            });
            if (operation.rowCount !== 1) {
              return yield* Effect.fail(
                fail("attempt", "stale-state", current.registrationOperationId),
              );
            }
            const result = yield* readAttempt(transaction, submissionAttemptId);
            if (result === null) return yield* Effect.fail(fail("attempt", "invalid-row"));
            return result;
          }),
        );
      }),
    );

  const confirmRegistration: DataRegistrationStore["confirmRegistration"] = (observation) => {
    if (
      observation.outcome !== "confirmed" ||
      observation.receiptObservationId !==
        deterministicDataRegistrationReceiptId(
          observation.submissionAttemptId,
          observation.observationSequence,
        ) ||
      !positive(observation.observationSequence) ||
      !validTransactionHash(observation.transactionHash) ||
      observation.blockNumber < 0n ||
      !validTransactionHash(observation.blockHash) ||
      observation.logIndex < 0 ||
      observation.confirmations < 1 ||
      ![
        observation.registeredIpId,
        observation.ipMetadataUri,
        observation.nftMetadataUri,
        observation.evidenceRef,
      ].every((value) => validId(value)) ||
      !validTransactionHash(observation.ipMetadataHash) ||
      !validTransactionHash(observation.nftMetadataHash) ||
      !validInstant(observation.observedAt)
    ) {
      return Promise.reject(fail("confirm", "invalid-input", observation.registrationOperationId));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const attempt = yield* readAttempt(transaction, observation.submissionAttemptId, true);
            const operation = yield* readOperation(
              transaction,
              observation.registrationOperationId,
              true,
            );
            if (attempt === null || operation === null) {
              return yield* Effect.fail(
                fail("confirm", "not-found", observation.registrationOperationId),
              );
            }
            if (
              attempt.registrationOperationId !== observation.registrationOperationId ||
              attempt.transactionHash !== observation.transactionHash
            ) {
              return yield* Effect.fail(
                fail("confirm", "identity-conflict", observation.registrationOperationId),
              );
            }
            if (operation.state === "registered") {
              if (
                operation.currentAttemptId !== observation.submissionAttemptId ||
                operation.registeredIpId !== observation.registeredIpId ||
                operation.confirmedTransactionHash !== observation.transactionHash ||
                operation.confirmedBlockNumber !== observation.blockNumber ||
                operation.confirmedBlockHash !== observation.blockHash ||
                operation.confirmedLogIndex !== observation.logIndex
              ) {
                return yield* Effect.fail(
                  fail("confirm", "identity-conflict", observation.registrationOperationId),
                );
              }
              yield* recordReceiptIn(transaction, observation);
              return operation;
            }
            if (!dataConfirmationStates(attempt.state, operation.state)) {
              return yield* Effect.fail(
                fail("confirm", "stale-state", observation.registrationOperationId),
              );
            }
            const metadata = yield* transaction.execute<Row>({
              label: "data-registration.confirm.metadata",
              text: `SELECT data_registration_pins_are_ready($1) AND
                       EXISTS (
                         SELECT 1 FROM data_registration_artifacts artifact
                         JOIN data_registration_pin_verifications primary_pin
                           ON primary_pin.registration_operation_id=artifact.registration_operation_id
                          AND primary_pin.artifact_id=artifact.artifact_id
                          AND primary_pin.role='primary' AND primary_pin.outcome='verified'
                          AND primary_pin.canonical_sha256=artifact.canonical_sha256
                          AND primary_pin.byte_length=artifact.byte_length
                         JOIN data_registration_pin_verifications redundant_pin
                           ON redundant_pin.registration_operation_id=primary_pin.registration_operation_id
                          AND redundant_pin.artifact_id=primary_pin.artifact_id
                          AND redundant_pin.role='redundant' AND redundant_pin.outcome='verified'
                          AND redundant_pin.cid=primary_pin.cid
                          AND redundant_pin.canonical_sha256=primary_pin.canonical_sha256
                          AND redundant_pin.byte_length=primary_pin.byte_length
                          AND redundant_pin.provider_id<>primary_pin.provider_id
                         JOIN data_registration_pin_verifications gateway
                           ON gateway.registration_operation_id=primary_pin.registration_operation_id
                          AND gateway.artifact_id=primary_pin.artifact_id
                          AND gateway.role='independent_gateway' AND gateway.outcome='verified'
                          AND gateway.cid=primary_pin.cid
                          AND gateway.canonical_sha256=primary_pin.canonical_sha256
                          AND gateway.byte_length=primary_pin.byte_length
                          AND gateway.provider_id NOT IN (
                            primary_pin.provider_id,redundant_pin.provider_id
                          )
                         WHERE artifact.registration_operation_id=$1
                           AND artifact.artifact_kind='ip_metadata'
                           AND 'ipfs://'||primary_pin.cid=$2
                           AND '0x'||artifact.canonical_sha256=$3
                       ) AND EXISTS (
                         SELECT 1 FROM data_registration_artifacts artifact
                         JOIN data_registration_pin_verifications primary_pin
                           ON primary_pin.registration_operation_id=artifact.registration_operation_id
                          AND primary_pin.artifact_id=artifact.artifact_id
                          AND primary_pin.role='primary' AND primary_pin.outcome='verified'
                          AND primary_pin.canonical_sha256=artifact.canonical_sha256
                          AND primary_pin.byte_length=artifact.byte_length
                         JOIN data_registration_pin_verifications redundant_pin
                           ON redundant_pin.registration_operation_id=primary_pin.registration_operation_id
                          AND redundant_pin.artifact_id=primary_pin.artifact_id
                          AND redundant_pin.role='redundant' AND redundant_pin.outcome='verified'
                          AND redundant_pin.cid=primary_pin.cid
                          AND redundant_pin.canonical_sha256=primary_pin.canonical_sha256
                          AND redundant_pin.byte_length=primary_pin.byte_length
                          AND redundant_pin.provider_id<>primary_pin.provider_id
                         JOIN data_registration_pin_verifications gateway
                           ON gateway.registration_operation_id=primary_pin.registration_operation_id
                          AND gateway.artifact_id=primary_pin.artifact_id
                          AND gateway.role='independent_gateway' AND gateway.outcome='verified'
                          AND gateway.cid=primary_pin.cid
                          AND gateway.canonical_sha256=primary_pin.canonical_sha256
                          AND gateway.byte_length=primary_pin.byte_length
                          AND gateway.provider_id NOT IN (
                            primary_pin.provider_id,redundant_pin.provider_id
                          )
                         WHERE artifact.registration_operation_id=$1
                           AND artifact.artifact_kind='nft_metadata'
                           AND 'ipfs://'||primary_pin.cid=$4
                           AND '0x'||artifact.canonical_sha256=$5
                       ) AS matches`,
              values: [
                observation.registrationOperationId,
                observation.ipMetadataUri,
                observation.ipMetadataHash,
                observation.nftMetadataUri,
                observation.nftMetadataHash,
              ],
              readonly: false,
            });
            if (metadata.rows[0]?.matches !== true) {
              return yield* Effect.fail(
                fail("confirm", "metadata-mismatch", observation.registrationOperationId),
              );
            }
            yield* recordReceiptIn(transaction, observation);
            yield* transaction.execute({
              label: "data-registration.attempt.confirm",
              text: "UPDATE data_registration_signing_attempts SET state='confirmed',failure_code=NULL,failure_evidence_ref=NULL,terminal_at=clock_timestamp(),updated_at=clock_timestamp() WHERE submission_attempt_id=$1 AND state IN ('mined','reconciliation_required')",
              values: [observation.submissionAttemptId],
              readonly: false,
            });
            yield* appendTransition(
              transaction,
              attempt,
              attempt.state,
              "confirmed",
              observation.evidenceRef,
            );
            const operationUpdate = yield* transaction.execute({
              label: "data-registration.operation.confirm",
              text: "UPDATE data_registration_operations SET state='registered',current_attempt_id=$2,registered_ip_id=$3,confirmed_transaction_hash=$4,confirmed_block_number=$5,confirmed_block_hash=$6,confirmed_log_index=$7,confirmed_at=$8,failure_code=NULL,failure_evidence_ref=NULL,updated_at=clock_timestamp() WHERE registration_operation_id=$1 AND state IN ('confirming','reconciliation_required','failed')",
              values: [
                observation.registrationOperationId,
                observation.submissionAttemptId,
                observation.registeredIpId,
                observation.transactionHash,
                observation.blockNumber.toString(),
                observation.blockHash,
                observation.logIndex,
                observation.observedAt,
              ],
              readonly: false,
            });
            if (operationUpdate.rowCount !== 1) {
              return yield* Effect.fail(
                fail("confirm", "stale-state", observation.registrationOperationId),
              );
            }
            const projection = yield* transaction.execute({
              label: "data-registration.projection.registered",
              text: "UPDATE media_publication_projections SET data_registration='registered' WHERE community_id=$1 AND actor_user_id=$2 AND submission_id=$3 AND operation_id=$4 AND post_id=$5 AND creation_revision=$6 AND audio_revision=$7 AND analysis_revision=$8 AND decision_revision=$9 AND canonical_audio_sha256=$10",
              values: [
                operation.communityId,
                operation.actorUserId,
                operation.submissionId,
                operation.mediaOperationId,
                operation.postId,
                operation.publicationCreationRevision.toString(),
                operation.publicationAudioRevision.toString(),
                operation.publicationAnalysisRevision.toString(),
                operation.publicationDecisionRevision.toString(),
                operation.canonicalAudioSha256,
              ],
              readonly: false,
            });
            if (projection.rowCount !== 1) {
              return yield* Effect.fail(
                fail("confirm", "stale-state", observation.registrationOperationId),
              );
            }
            const result = yield* readOperation(transaction, observation.registrationOperationId);
            if (result === null) {
              return yield* Effect.fail(
                fail("confirm", "invalid-row", observation.registrationOperationId),
              );
            }
            return result;
          }),
        );
      }),
    );
  };

  const failRegistration: DataRegistrationStore["failRegistration"] = (input) => {
    if (
      !validId(input.registrationOperationId) ||
      !validId(input.evidenceRef) ||
      !OPERATION_FAILURE_CODES.has(input.operationFailureCode) ||
      (input.attemptFailureCode !== null && !ATTEMPT_FAILURE_CODES.has(input.attemptFailureCode)) ||
      (input.submissionAttemptId === null) !== (input.attemptFailureCode === null) ||
      (input.operationState === "reconciliation_required" && input.submissionAttemptId === null)
    ) {
      return Promise.reject(fail("failure", "invalid-input", input.registrationOperationId));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const operation = yield* readOperation(
              transaction,
              input.registrationOperationId,
              true,
            );
            if (operation === null) {
              return yield* Effect.fail(
                fail("failure", "not-found", input.registrationOperationId),
              );
            }
            let attempt: DataRegistrationSigningAttempt | null = null;
            if (input.submissionAttemptId !== null && input.attemptFailureCode !== null) {
              attempt = yield* readAttempt(transaction, input.submissionAttemptId, true);
              if (
                attempt === null ||
                attempt.registrationOperationId !== input.registrationOperationId
              ) {
                return yield* Effect.fail(
                  fail("failure", "identity-conflict", input.registrationOperationId),
                );
              }
            }
            if (operation.state === input.operationState) {
              const sameOperationFailure =
                input.operationState === "reconciliation_required" ||
                (operation.failureCode === input.operationFailureCode &&
                  operation.failureEvidenceRef === input.evidenceRef);
              const expectedAttemptStates: readonly DataRegistrationAttemptState[] =
                input.operationState === "reconciliation_required"
                  ? ["reconciliation_required"]
                  : ["failed", "reconciliation_required"];
              const sameAttemptFailure =
                attempt === null ||
                (expectedAttemptStates.includes(attempt.state) &&
                  attempt.failureCode === input.attemptFailureCode &&
                  attempt.failureEvidenceRef === input.evidenceRef);
              if (!sameOperationFailure || !sameAttemptFailure) {
                return yield* Effect.fail(
                  fail("failure", "identity-conflict", input.registrationOperationId),
                );
              }
              return operation;
            }
            if (attempt !== null && input.attemptFailureCode !== null) {
              if (["failed", "reconciliation_required"].includes(attempt.state)) {
                if (
                  attempt.failureCode !== input.attemptFailureCode ||
                  attempt.failureEvidenceRef !== input.evidenceRef
                ) {
                  return yield* Effect.fail(
                    fail("failure", "identity-conflict", input.registrationOperationId),
                  );
                }
              } else {
                const nextAttemptState: DataRegistrationAttemptState =
                  input.operationState === "reconciliation_required" ||
                  ["prepared", "broadcast", "mined", "confirmed"].includes(attempt.state)
                    ? "reconciliation_required"
                    : "failed";
                yield* transaction.execute({
                  label: "data-registration.attempt.fail",
                  text: "UPDATE data_registration_signing_attempts SET state=$2,failure_code=$3,failure_evidence_ref=$4,terminal_at=clock_timestamp(),updated_at=clock_timestamp() WHERE submission_attempt_id=$1",
                  values: [
                    attempt.submissionAttemptId,
                    nextAttemptState,
                    input.attemptFailureCode,
                    input.evidenceRef,
                  ],
                  readonly: false,
                });
                yield* appendTransition(
                  transaction,
                  attempt,
                  attempt.state,
                  nextAttemptState,
                  input.evidenceRef,
                );
              }
            }
            const targetFailed = input.operationState === "failed";
            const updated = yield* transaction.execute({
              label: "data-registration.operation.fail",
              text: "UPDATE data_registration_operations SET state=$2,registered_ip_id=NULL,confirmed_transaction_hash=NULL,confirmed_block_number=NULL,confirmed_block_hash=NULL,confirmed_log_index=NULL,confirmed_at=NULL,failure_code=$3,failure_evidence_ref=$4,updated_at=clock_timestamp() WHERE registration_operation_id=$1",
              values: [
                input.registrationOperationId,
                input.operationState,
                targetFailed ? input.operationFailureCode : null,
                targetFailed ? input.evidenceRef : null,
              ],
              readonly: false,
            });
            if (updated.rowCount !== 1) {
              return yield* Effect.fail(
                fail("failure", "stale-state", input.registrationOperationId),
              );
            }
            const projectedState = targetFailed ? "failed" : "pending";
            const projection = yield* transaction.execute({
              label: "data-registration.projection.failure",
              text: "UPDATE media_publication_projections SET data_registration=$2 WHERE community_id=$1 AND actor_user_id=$3 AND submission_id=$4 AND operation_id=$5 AND post_id=$6",
              values: [
                operation.communityId,
                projectedState,
                operation.actorUserId,
                operation.submissionId,
                operation.mediaOperationId,
                operation.postId,
              ],
              readonly: false,
            });
            if (projection.rowCount !== 1) {
              return yield* Effect.fail(
                fail("failure", "stale-state", input.registrationOperationId),
              );
            }
            const result = yield* readOperation(transaction, input.registrationOperationId);
            if (result === null) {
              return yield* Effect.fail(
                fail("failure", "invalid-row", input.registrationOperationId),
              );
            }
            return result;
          }),
        );
      }),
    );
  };

  const getOutbox: DataRegistrationStore["getOutbox"] = (outboxId) => {
    if (!validId(outboxId)) return Promise.reject(fail("outbox", "invalid-input"));
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "data-registration.outbox.read",
          text: `${OUTBOX_SELECT} WHERE outbox_id=$1`,
          values: [outboxId],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1 || result.rows[0] === undefined) {
          return yield* Effect.fail(fail("outbox", "invalid-row"));
        }
        return yield* decode("outbox", result.rows[0], outboxFromRow);
      }),
    );
  };

  const replaceMissingWorkflow: DataRegistrationStore["replaceMissingWorkflow"] = (
    registrationOperationId,
    expectedWorkflowRevision,
  ) => {
    if (!validId(registrationOperationId) || expectedWorkflowRevision < 1n) {
      return Promise.reject(fail("outbox", "invalid-input", registrationOperationId));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const operation = yield* readOperation(transaction, registrationOperationId, true);
            if (operation === null) {
              return yield* Effect.fail(fail("outbox", "not-found", registrationOperationId));
            }
            if (operation.workflowRevision === expectedWorkflowRevision + 1n) {
              const replayOutboxId = deterministicDataRegistrationOutboxId(
                registrationOperationId,
                operation.workflowRevision,
              );
              const replayResult = yield* transaction.execute<Row>({
                label: "data-registration.workflow.outbox-replay",
                text: `${OUTBOX_SELECT} WHERE outbox_id=$1 AND event_type='workflow_replacement'`,
                values: [replayOutboxId],
                readonly: false,
              });
              if (replayResult.rows.length !== 1 || replayResult.rows[0] === undefined) {
                return yield* Effect.fail(fail("outbox", "invalid-row", registrationOperationId));
              }
              const replayOutbox = yield* decode(
                "outbox",
                replayResult.rows[0],
                outboxFromRow,
                registrationOperationId,
              );
              return { operation, outbox: replayOutbox };
            }
            if (operation.state === "registered") {
              return yield* Effect.fail(fail("outbox", "stale-state", registrationOperationId));
            }
            if (operation.workflowRevision !== expectedWorkflowRevision) {
              return yield* Effect.fail(fail("outbox", "stale-state", registrationOperationId));
            }
            const workflowRevision = operation.workflowRevision + 1n;
            const workflowInstanceId = deterministicDataRegistrationWorkflowId(
              registrationOperationId,
              workflowRevision,
            );
            const outboxId = deterministicDataRegistrationOutboxId(
              registrationOperationId,
              workflowRevision,
            );
            const updated = yield* transaction.execute({
              label: "data-registration.workflow.replace",
              text: "UPDATE data_registration_operations SET workflow_revision=$2,workflow_instance_id=$3,updated_at=clock_timestamp() WHERE registration_operation_id=$1 AND workflow_revision=$4 AND state<>'registered'",
              values: [
                registrationOperationId,
                workflowRevision.toString(),
                workflowInstanceId,
                expectedWorkflowRevision.toString(),
              ],
              readonly: false,
            });
            if (updated.rowCount !== 1) {
              return yield* Effect.fail(fail("outbox", "stale-state", registrationOperationId));
            }
            yield* transaction.execute({
              label: "data-registration.workflow.outbox",
              text: "INSERT INTO data_registration_outbox (outbox_id,registration_operation_id,workflow_revision,workflow_instance_id,event_type,effect_identity,payload) VALUES ($1,$2,$3,$4,'workflow_replacement',$5,$6::jsonb)",
              values: [
                outboxId,
                registrationOperationId,
                workflowRevision.toString(),
                workflowInstanceId,
                `data-registration-workflow-replacement:${registrationOperationId}:r${workflowRevision}`,
                JSON.stringify({ operation_id: registrationOperationId, outbox_id: outboxId }),
              ],
              readonly: false,
            });
            const nextOperation = yield* readOperation(transaction, registrationOperationId);
            const outboxResult = yield* transaction.execute<Row>({
              label: "data-registration.workflow.outbox-read",
              text: `${OUTBOX_SELECT} WHERE outbox_id=$1`,
              values: [outboxId],
              readonly: false,
            });
            if (
              nextOperation === null ||
              outboxResult.rows.length !== 1 ||
              outboxResult.rows[0] === undefined
            ) {
              return yield* Effect.fail(fail("outbox", "invalid-row", registrationOperationId));
            }
            const outbox = yield* decode(
              "outbox",
              outboxResult.rows[0],
              outboxFromRow,
              registrationOperationId,
            );
            return { operation: nextOperation, outbox };
          }),
        );
      }),
    );
  };

  const listEligibleOutbox: DataRegistrationStore["listEligibleOutbox"] = (limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Promise.reject(fail("outbox", "invalid-input"));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "data-registration.outbox.list",
          text: `${OUTBOX_SELECT} WHERE (state='pending' OR (state='failed' AND next_eligible_at<=clock_timestamp()) OR (state='running' AND lease_expires_at<=clock_timestamp())) ORDER BY created_at,outbox_id LIMIT $1`,
          values: [limit],
          readonly: true,
        });
        const records: DataRegistrationOutbox[] = [];
        for (const row of result.rows) records.push(yield* decode("outbox", row, outboxFromRow));
        return records;
      }),
    );
  };

  const claimOutbox: DataRegistrationStore["claimOutbox"] = (outboxId, workerId, leaseSeconds) => {
    if (
      !validId(outboxId) ||
      !validId(workerId) ||
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 1 ||
      leaseSeconds > 600
    ) {
      return Promise.reject(fail("outbox", "invalid-input"));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "data-registration.outbox.claim",
          text: `UPDATE data_registration_outbox
                    SET state='running',delivery_attempts=delivery_attempts+1,
                        claim_owner=$2,claim_fence=claim_fence+1,
                        lease_expires_at=clock_timestamp()+($3::text||' seconds')::interval,
                        next_eligible_at=NULL,failure_code=NULL,updated_at=clock_timestamp()
                  WHERE outbox_id=$1 AND delivery_attempts<5 AND
                    (state='pending' OR (state='failed' AND next_eligible_at<=clock_timestamp())
                     OR (state='running' AND lease_expires_at<=clock_timestamp()))
                  RETURNING outbox_id,registration_operation_id,workflow_revision,
                    workflow_instance_id,event_type,effect_identity,state,delivery_attempts,
                    claim_owner,claim_fence,lease_expires_at,next_eligible_at,failure_code`,
          values: [outboxId, workerId, leaseSeconds],
          readonly: false,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1 || result.rows[0] === undefined) {
          return yield* Effect.fail(fail("outbox", "invalid-row"));
        }
        return yield* decode("outbox", result.rows[0], outboxFromRow);
      }),
    );
  };

  const completeOutbox: DataRegistrationStore["completeOutbox"] = (
    outboxId,
    workerId,
    claimFence,
  ) => {
    if (!validId(outboxId) || !validId(workerId) || !positive(claimFence)) {
      return Promise.reject(fail("outbox", "invalid-input"));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "data-registration.outbox.complete",
          text: "UPDATE data_registration_outbox SET state='delivered',claim_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE outbox_id=$1 AND state='running' AND claim_owner=$2 AND claim_fence=$3 AND lease_expires_at>clock_timestamp()",
          values: [outboxId, workerId, claimFence.toString()],
          readonly: false,
        });
        return result.rowCount === 1;
      }),
    );
  };

  const failOutbox: DataRegistrationStore["failOutbox"] = (input) => {
    if (
      !validId(input.outboxId) ||
      !validId(input.workerId) ||
      !positive(input.claimFence) ||
      (input.nextEligibleAt !== null && !validInstant(input.nextEligibleAt))
    ) {
      return Promise.reject(fail("outbox", "invalid-input"));
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "data-registration.outbox.fail",
          text: `UPDATE data_registration_outbox
                    SET state=CASE WHEN delivery_attempts=5 THEN 'exhausted' ELSE 'failed' END,
                        claim_owner=NULL,lease_expires_at=NULL,
                        next_eligible_at=CASE WHEN delivery_attempts=5 THEN NULL ELSE $5 END,
                        failure_code=$4,updated_at=clock_timestamp()
                  WHERE outbox_id=$1 AND state='running' AND claim_owner=$2
                    AND claim_fence=$3 AND lease_expires_at>clock_timestamp()
                    AND ((delivery_attempts<5 AND $5 IS NOT NULL) OR delivery_attempts=5)`,
          values: [
            input.outboxId,
            input.workerId,
            input.claimFence.toString(),
            input.failureCode,
            input.nextEligibleAt,
          ],
          readonly: false,
        });
        return result.rowCount === 1;
      }),
    );
  };

  return {
    createOperation,
    getOperation,
    recordArtifact,
    recordPinVerification,
    pinsReady,
    reserveSigningAttempt,
    reserveNonce,
    persistPreparedTransaction,
    markBroadcast,
    markReplaced,
    recordReceipt,
    markMined,
    confirmRegistration,
    failRegistration,
    replaceMissingWorkflow,
    getOutbox,
    listEligibleOutbox,
    claimOutbox,
    completeOutbox,
    failOutbox,
  };
}

function dataConfirmationStates(
  attemptState: DataRegistrationAttemptState,
  operationState: DataRegistrationOperationState,
): boolean {
  return (
    (attemptState === "mined" || attemptState === "reconciliation_required") &&
    (operationState === "confirming" ||
      operationState === "reconciliation_required" ||
      operationState === "failed")
  );
}
