import {
  type CommunityCreationIntentDocument,
  CommunityCreationRepositoryError,
  type CommunityCreationRepositoryFailure,
  type CommunityCreationStore,
  type CommunityCreationStoreService,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { VerificationCompletionStorageFailed } from "@pirate/application/verification";
import {
  CommitCommunityCreationIntent,
  CommunityCreationIntent as CommunityCreationIntentContract,
  CreateCommunityCreationIntent,
  UpdateCommunityCreationIntent,
} from "@pirate/contracts";
import {
  type CommunityCreationIntentState,
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  compileCommunityGatePolicy,
  creationNextAction,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  transitionCommunityCreationIntent,
  VERY_OAUTH_CONFIGURATION_REFERENCE,
  VERY_OAUTH_CONFIGURATION_VERSION,
  VERY_OAUTH_ISSUER,
  VERY_OAUTH_METHOD,
  VERY_OAUTH_PROTOCOL_VERSION,
  VERY_OAUTH_PROVIDER_ID,
  VERY_OAUTH_RP_SCOPE,
} from "@pirate/domain";
import { Effect, type Layer, Option, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;

export const COMMUNITY_CREATION_INTENT_TTL_SECONDS = 24 * 60 * 60;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const UNRESOLVED_PROVIDER_ID = "unresolved";
const UNRESOLVED_PROVIDER_CONFIGURATION = "unresolved";
const VERY_OAUTH_EVIDENCE_KIND = "very.oauth.id-token-userinfo.v1";
const TERMINAL_STATUSES = new Set([
  "committed",
  "quota_exceeded",
  "gate_unsupported",
  "expired",
  "cancelled",
]);

const HUMAN_MEMBERSHIP_REQUIREMENTS = [
  { claim_id: "credential.subject_unique" },
  { claim_id: "human.personhood" },
] as const;
const HUMAN_MEMBERSHIP_CLAIM_IDS = ["credential.subject_unique", "human.personhood"] as const;

export type CommunityCreationVerificationAdvanceOutcome =
  | Readonly<{ readonly kind: "advanced"; readonly intent_id: string; readonly revision: number }>
  | Readonly<{
      readonly kind: "already_ready";
      readonly intent_id: string;
      readonly revision: number;
    }>
  | Readonly<{ readonly kind: "not_applicable" }>
  | Readonly<{
      readonly kind: "stale";
      readonly reason:
        | "intent_expired"
        | "intent_terminal"
        | "intent_not_verification_required"
        | "session_binding_drift"
        | "evidence_invalid";
    }>;

export type CommunityCreationRepositoryOptions = Readonly<{
  readonly intent_ttl_seconds?: number;
  readonly next_intent_id?: () => string;
  readonly next_community_id?: () => string;
  readonly next_subject_claim_id?: () => string;
}>;

type IntentBinding = Readonly<{
  readonly providerId: string;
  readonly configurationKind: "dynamic";
  readonly configurationReference: string;
  readonly configurationVersion: string;
}>;

type CompiledDraft = Readonly<{
  readonly status: "verification_required" | "gate_unsupported";
  readonly canonicalPolicyHash: string;
  readonly verificationRequirementHash: string;
  readonly binding: IntentBinding;
}>;

function failure(
  operation: "create" | "get" | "update" | "commit",
  reason: "not-found" | "idempotency-conflict" | "revision-conflict" | "constraint" | "invalid-row",
): CommunityCreationRepositoryError {
  return new CommunityCreationRepositoryError({ operation, reason });
}

function validId(value: string): boolean {
  return value.length > 0 && value.trim() === value && !value.includes("\u0000");
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asPositiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function asTimestamp(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function oneRow(rows: readonly Row[]): Row | null | undefined {
  if (rows.length > 1) return undefined;
  return rows[0] ?? null;
}

function compileDraft(policy: unknown): CompiledDraft {
  const compilation = compileCommunityGatePolicy(policy);
  if (compilation.kind === "supported") {
    return {
      status: "verification_required",
      canonicalPolicyHash: compilation.canonical_policy_hash,
      verificationRequirementHash: compilation.verification_requirement_hash,
      binding: {
        providerId: compilation.provider_binding.provider_id,
        configurationKind: compilation.provider_binding.provider_configuration.kind,
        configurationReference: compilation.provider_binding.provider_configuration.reference,
        configurationVersion: compilation.provider_binding.provider_configuration.version,
      },
    };
  }
  return {
    status: "gate_unsupported",
    canonicalPolicyHash: compilation.canonical_policy_hash,
    verificationRequirementHash: compilation.verification_requirement_hash,
    binding: {
      providerId: UNRESOLVED_PROVIDER_ID,
      configurationKind: "dynamic",
      configurationReference: UNRESOLVED_PROVIDER_CONFIGURATION,
      configurationVersion: "1",
    },
  };
}

function documentFromRow(row: Row): CommunityCreationIntentDocument | null {
  const intentId = asString(row.intent_id);
  const revision = asPositiveInteger(row.revision);
  const status = asString(row.status);
  const canonicalPolicyRevision = asPositiveInteger(row.canonical_policy_revision);
  const canonicalPolicyHash = asString(row.canonical_policy_hash);
  const requirementHash = asString(row.verification_requirement_hash);
  const providerId = asString(row.verification_provider_id);
  const expiresAt = asTimestamp(row.expires_at);
  if (
    intentId === null ||
    revision === null ||
    status === null ||
    canonicalPolicyRevision === null ||
    canonicalPolicyHash === null ||
    requirementHash === null ||
    providerId === null ||
    expiresAt === null
  ) {
    return null;
  }
  const state: CommunityCreationIntentState = {
    intent_id: intentId,
    revision,
    status: status as CommunityCreationIntentState["status"],
    canonical_policy_revision: canonicalPolicyRevision,
    canonical_policy_hash: canonicalPolicyHash,
    verification_requirement_hash: requirementHash,
    verification_provider_id: providerId,
    expires_at: expiresAt,
    committed_resource:
      row.committed_community_id === null && row.committed_resource_href === null
        ? null
        : {
            community_id: asString(row.committed_community_id) ?? "",
            href: asString(row.committed_resource_href) ?? "",
          },
  };
  const decoded = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
    intent_id: state.intent_id,
    revision: state.revision,
    status: state.status,
    draft: jsonValue(row.draft),
    canonical_policy_revision: state.canonical_policy_revision,
    canonical_policy_hash: state.canonical_policy_hash,
    verification_requirement_hash: state.verification_requirement_hash,
    next_action: creationNextAction(state),
    expires_at: state.expires_at,
    committed_resource: state.committed_resource,
  });
  return Option.isSome(decoded) ? decoded.value : null;
}

function stateFromDocument(
  document: CommunityCreationIntentDocument,
  providerId: string,
): CommunityCreationIntentState {
  return {
    intent_id: document.intent_id,
    revision: document.revision,
    status: document.status,
    canonical_policy_revision: document.canonical_policy_revision,
    canonical_policy_hash: document.canonical_policy_hash,
    verification_requirement_hash: document.verification_requirement_hash,
    verification_provider_id: providerId,
    expires_at: document.expires_at,
    committed_resource: document.committed_resource,
  };
}

function decodeSnapshot(value: unknown): CommunityCreationIntentDocument | null {
  const decoded = Schema.decodeUnknownOption(CommunityCreationIntentContract)(jsonValue(value));
  return Option.isSome(decoded) ? decoded.value : null;
}

function rowColumns(): string {
  return `intent_id, actor_id, create_idempotency_key, create_request_hash,
          revision, status, draft, canonical_policy_revision,
          canonical_policy_hash, verification_requirement_hash,
          verification_provider_id, provider_configuration_kind,
          provider_configuration_ref, provider_configuration_version,
          expires_at, committed_community_id, committed_resource_href`;
}

function lockActor(
  transaction: ControlPlaneTransaction,
  actorId: string,
  operation: "create" | "update" | "commit",
): Effect.Effect<void, CommunityCreationRepositoryFailure> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: `community.creation.${operation}.lock-actor`,
      text: "SELECT user_id FROM users WHERE user_id = $1 AND status = 'active' FOR UPDATE",
      values: [actorId],
      readonly: false,
    });
    const row = oneRow(result.rows);
    if (row === undefined) return yield* Effect.fail(failure(operation, "invalid-row"));
    if (row === null || row.user_id !== actorId) {
      return yield* Effect.fail(failure(operation, "constraint"));
    }
  });
}

function loadLockedIntent(
  transaction: ControlPlaneTransaction,
  actorId: string,
  intentId: string,
  operation: "get" | "update" | "commit",
) {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: `community.creation.${operation}.lock-intent`,
      text: `SELECT ${rowColumns()}, expires_at <= clock_timestamp() AS expired
               FROM community_creation_intents
              WHERE intent_id = $1 AND actor_id = $2
              FOR UPDATE`,
      values: [intentId, actorId],
      readonly: false,
    });
    const row = oneRow(result.rows);
    if (row === undefined) return yield* Effect.fail(failure(operation, "invalid-row"));
    return row;
  });
}

function replayByKey(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly operation: "create" | "update" | "commit";
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly intentId?: string;
  }>,
) {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: `community.creation.${input.operation}.load-replay`,
      text: `SELECT intent_id, request_hash, state_snapshot
               FROM community_creation_intent_revisions
              WHERE actor_id = $1
                AND operation_kind = $2
                AND idempotency_key = $3
              FOR UPDATE`,
      values: [input.actorId, input.operation, input.idempotencyKey],
      readonly: false,
    });
    const row = oneRow(result.rows);
    if (row === undefined) {
      return yield* Effect.fail(failure(input.operation, "invalid-row"));
    }
    if (row === null) return null;
    if (
      row.request_hash !== input.requestHash ||
      (input.intentId !== undefined && row.intent_id !== input.intentId)
    ) {
      return yield* Effect.fail(failure(input.operation, "idempotency-conflict"));
    }
    const snapshot = decodeSnapshot(row.state_snapshot);
    return snapshot === null
      ? yield* Effect.fail(failure(input.operation, "invalid-row"))
      : snapshot;
  });
}

function insertRevision(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly intent: CommunityCreationIntentDocument;
    readonly actorId: string;
    readonly operation: "create" | "update" | "verification" | "commit" | "expire";
    readonly idempotencyKey?: string;
    readonly requestHash: string;
  }>,
) {
  return transaction.execute({
    label: `community.creation.${input.operation}.insert-revision`,
    text: `INSERT INTO community_creation_intent_revisions (
             intent_id, revision, actor_id, operation_kind, idempotency_key,
             request_hash, status, state_snapshot
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    values: [
      input.intent.intent_id,
      input.intent.revision,
      input.actorId,
      input.operation,
      input.idempotencyKey ?? null,
      input.requestHash,
      input.intent.status,
      JSON.stringify(input.intent),
    ],
    readonly: false,
  });
}

function verificationStorageFailure(): VerificationCompletionStorageFailed {
  return new VerificationCompletionStorageFailed();
}

function exactCanonicalJson(value: unknown, expected: unknown): boolean {
  return JSON.stringify(jsonValue(value)) === JSON.stringify(expected);
}

type CommitEvidence = Readonly<{
  readonly proofSessionId: string;
  readonly evidenceReceiptId: string;
  readonly subjectKeyId: string;
}>;

function loadCommitEvidence(
  transaction: ControlPlaneTransaction,
  input: Readonly<{ readonly actorId: string; readonly proofSessionId: string }>,
): Effect.Effect<CommitEvidence | null, ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "community.creation.commit.validate-evidence",
      text: `SELECT
               MIN(receipt.evidence_receipt_id) AS evidence_receipt_id,
               MIN(receipt.subject_key_id) AS subject_key_id,
               (
                 COUNT(DISTINCT receipt.evidence_receipt_id) = 1
                 AND COUNT(DISTINCT receipt.subject_key_id) = 1
                 AND COUNT(assertion.assertion_id) = 2
                 AND COUNT(DISTINCT assertion.binding_group_id) = 1
                 AND COUNT(*) FILTER (
                   WHERE assertion.claim_id = 'human.personhood'
                     AND assertion.assertion_value = '{"personhood": true}'::jsonb
                     AND assertion.assurance = 'provider_attested'
                 ) = 1
                 AND COUNT(*) FILTER (
                   WHERE assertion.claim_id = 'credential.subject_unique'
                     AND assertion.assertion_value = '{"subject_unique": true}'::jsonb
                     AND assertion.assurance = 'provider_attested'
                 ) = 1
                 AND BOOL_AND(
                   receipt.user_id = session.actor_id
                   AND receipt.provider_id = session.provider_id
                   AND receipt.provider_configuration_kind = session.provider_configuration_kind
                   AND receipt.provider_configuration_ref = session.provider_configuration_ref
                   AND receipt.provider_configuration_version = session.provider_configuration_version
                   AND receipt.issuer = session.issuer
                   AND receipt.method = session.method
                   AND receipt.scope_kind = session.scope_kind
                   AND receipt.issuer_rp_scope IS NOT DISTINCT FROM session.issuer_rp_scope
                   AND receipt.issuer_rp_action_scope IS NOT DISTINCT FROM session.issuer_rp_action_scope
                   AND receipt.protocol_version = session.protocol_version
                   AND receipt.environment = session.environment
                   AND receipt.provenance_kind = 'proof_session'
                   AND receipt.evidence_kind = $2
                   AND receipt.subject_key_id IS NOT NULL
                   AND receipt.subject_binding_event_id IS NOT NULL
                   AND receipt.subject_binding_epoch IS NOT NULL
                   AND receipt.observed_at <= session.terminal_at
                   AND (receipt.expires_at IS NULL OR receipt.expires_at > clock_timestamp())
                   AND active_binding.subject_key_id = receipt.subject_key_id
                   AND active_binding.binding_event_id = receipt.subject_binding_event_id
                   AND active_binding.binding_epoch = receipt.subject_binding_epoch
                   AND active_binding.user_id = session.actor_id
                   AND assertion.user_id = session.actor_id
                   AND assertion.evidence_receipt_id = receipt.evidence_receipt_id
                   AND assertion.subject_key_id = receipt.subject_key_id
                   AND assertion.observed_at <= session.terminal_at
                   AND (assertion.expires_at IS NULL OR assertion.expires_at > clock_timestamp())
                   AND assertion_binding.user_id = session.actor_id
                   AND assertion_binding.binding_mode = 'same_subject'
                   AND assertion_binding.subject_key_id = receipt.subject_key_id
                   AND assertion_binding.evidence_receipt_id IS NULL
                   AND assertion_binding.subject_binding_event_id = receipt.subject_binding_event_id
                   AND assertion_binding.subject_binding_epoch = receipt.subject_binding_epoch
                 )
               ) AS evidence_valid
          FROM proof_sessions AS session
          LEFT JOIN evidence_receipts AS receipt
            ON receipt.proof_session_id = session.proof_session_id
          LEFT JOIN assertions AS assertion
            ON assertion.evidence_receipt_id = receipt.evidence_receipt_id
          LEFT JOIN assertion_bindings AS assertion_binding
            ON assertion_binding.binding_group_id = assertion.binding_group_id
          LEFT JOIN active_subject_key_bindings AS active_binding
            ON active_binding.subject_key_id = receipt.subject_key_id
         WHERE session.proof_session_id = $1
           AND session.actor_id = $3`,
      values: [input.proofSessionId, VERY_OAUTH_EVIDENCE_KIND, input.actorId],
      readonly: false,
    });
    const row = oneRow(result.rows);
    if (row === undefined || row === null || row.evidence_valid !== true) return null;
    const evidenceReceiptId = asString(row.evidence_receipt_id);
    const subjectKeyId = asString(row.subject_key_id);
    if (evidenceReceiptId === null || subjectKeyId === null) return null;
    return { proofSessionId: input.proofSessionId, evidenceReceiptId, subjectKeyId };
  });
}

/**
 * Settle a completed canonical Very ceremony against its creation intent.
 *
 * The helper deliberately preserves valid generic/stale evidence: only a
 * storage or constraint failure aborts the surrounding completion transaction.
 * Replays may call it again to repair a completion produced before the intent
 * revision was appended.
 */
export function advanceCommunityCreationVerificationInTransaction(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly actor_id: string;
    readonly proof_session_id: string;
    readonly result_hash: string;
  }>,
): Effect.Effect<
  CommunityCreationVerificationAdvanceOutcome,
  VerificationCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    if (
      !validId(input.actor_id) ||
      !validId(input.proof_session_id) ||
      !SHA256_HEX.test(input.result_hash)
    ) {
      return yield* Effect.fail(verificationStorageFailure());
    }

    const sessionResult = yield* transaction.execute<Row>({
      label: "community.creation.verification.lock-session",
      text: `SELECT proof_session_id, actor_id, intent_id, provider_id,
                    provider_configuration_kind, provider_configuration_ref,
                    provider_configuration_version, method, issuer, scope_kind,
                    issuer_rp_scope, issuer_rp_action_scope, request_mode,
                    requested_requirements, requested_claim_ids,
                    subject_binding_intent, protocol_version, environment,
                    status, expires_at, completed_at, terminal_at,
                    completion_idempotency_key, completion_result_hash
               FROM proof_sessions
              WHERE proof_session_id = $1 AND actor_id = $2
              FOR UPDATE`,
      values: [input.proof_session_id, input.actor_id],
      readonly: false,
    });
    const session = oneRow(sessionResult.rows);
    if (session === undefined) return yield* Effect.fail(verificationStorageFailure());
    if (session === null) return { kind: "not_applicable" } as const;

    const intentId = asString(session.intent_id);
    const completedAt = asTimestamp(session.completed_at);
    const terminalAt = asTimestamp(session.terminal_at);
    const sessionExpiresAt = asTimestamp(session.expires_at);
    if (
      intentId === null ||
      session.proof_session_id !== input.proof_session_id ||
      session.actor_id !== input.actor_id ||
      session.status !== "completed" ||
      session.completion_result_hash !== input.result_hash ||
      asString(session.completion_idempotency_key) === null ||
      completedAt === null ||
      terminalAt === null ||
      sessionExpiresAt === null ||
      completedAt !== terminalAt ||
      Date.parse(completedAt) >= Date.parse(sessionExpiresAt)
    ) {
      return { kind: "stale", reason: "session_binding_drift" } as const;
    }

    const intentResult = yield* transaction.execute<Row>({
      label: "community.creation.verification.lock-intent",
      text: `SELECT ${rowColumns()}, expires_at > clock_timestamp() AS active
               FROM community_creation_intents
              WHERE intent_id = $1 AND actor_id = $2
              FOR UPDATE`,
      values: [intentId, input.actor_id],
      readonly: false,
    });
    const intentRow = oneRow(intentResult.rows);
    if (intentRow === undefined) return yield* Effect.fail(verificationStorageFailure());
    if (intentRow === null) return { kind: "not_applicable" } as const;
    const document = documentFromRow(intentRow);
    const providerId = asString(intentRow.verification_provider_id);
    if (document === null || providerId === null) {
      return yield* Effect.fail(verificationStorageFailure());
    }
    if (document.status === "commit_ready") {
      return {
        kind: "already_ready",
        intent_id: document.intent_id,
        revision: document.revision,
      } as const;
    }
    if (TERMINAL_STATUSES.has(document.status)) {
      return { kind: "stale", reason: "intent_terminal" } as const;
    }
    if (document.status !== "verification_required") {
      return { kind: "stale", reason: "intent_not_verification_required" } as const;
    }
    if (intentRow.active !== true) {
      return { kind: "stale", reason: "intent_expired" } as const;
    }

    const exactBinding =
      document.verification_requirement_hash === HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH &&
      providerId === VERY_OAUTH_PROVIDER_ID &&
      session.provider_id === providerId &&
      intentRow.provider_configuration_kind === "dynamic" &&
      intentRow.provider_configuration_ref === VERY_OAUTH_CONFIGURATION_REFERENCE &&
      intentRow.provider_configuration_version === VERY_OAUTH_CONFIGURATION_VERSION &&
      session.provider_configuration_kind === intentRow.provider_configuration_kind &&
      session.provider_configuration_ref === intentRow.provider_configuration_ref &&
      session.provider_configuration_version === intentRow.provider_configuration_version &&
      session.method === VERY_OAUTH_METHOD &&
      session.issuer === VERY_OAUTH_ISSUER &&
      session.scope_kind === "issuer_rp_scope" &&
      session.issuer_rp_scope === VERY_OAUTH_RP_SCOPE &&
      session.issuer_rp_action_scope === null &&
      session.request_mode === "dynamic" &&
      exactCanonicalJson(session.requested_requirements, HUMAN_MEMBERSHIP_REQUIREMENTS) &&
      exactCanonicalJson(session.requested_claim_ids, HUMAN_MEMBERSHIP_CLAIM_IDS) &&
      session.subject_binding_intent === "establish" &&
      session.protocol_version === VERY_OAUTH_PROTOCOL_VERSION &&
      asString(session.environment) !== null;
    if (!exactBinding) {
      return { kind: "stale", reason: "session_binding_drift" } as const;
    }

    const evidenceResult = yield* transaction.execute<Row>({
      label: "community.creation.verification.validate-evidence",
      text: `SELECT (
               COUNT(DISTINCT receipt.evidence_receipt_id) = 1
               AND COUNT(assertion.assertion_id) = 2
               AND COUNT(DISTINCT assertion.binding_group_id) = 1
               AND COUNT(*) FILTER (
                 WHERE assertion.claim_id = 'human.personhood'
                   AND assertion.assertion_value = '{"personhood": true}'::jsonb
                   AND assertion.assurance = 'provider_attested'
               ) = 1
               AND COUNT(*) FILTER (
                 WHERE assertion.claim_id = 'credential.subject_unique'
                   AND assertion.assertion_value = '{"subject_unique": true}'::jsonb
                   AND assertion.assurance = 'provider_attested'
               ) = 1
               AND BOOL_AND(
                 receipt.user_id = session.actor_id
                 AND receipt.provider_id = session.provider_id
                 AND receipt.provider_configuration_kind = session.provider_configuration_kind
                 AND receipt.provider_configuration_ref = session.provider_configuration_ref
                 AND receipt.provider_configuration_version = session.provider_configuration_version
                 AND receipt.issuer = session.issuer
                 AND receipt.method = session.method
                 AND receipt.scope_kind = session.scope_kind
                 AND receipt.issuer_rp_scope IS NOT DISTINCT FROM session.issuer_rp_scope
                 AND receipt.issuer_rp_action_scope IS NOT DISTINCT FROM session.issuer_rp_action_scope
                 AND receipt.protocol_version = session.protocol_version
                 AND receipt.environment = session.environment
                 AND receipt.provenance_kind = 'proof_session'
                 AND receipt.evidence_kind = $2
                 AND receipt.subject_key_id IS NOT NULL
                 AND receipt.subject_binding_event_id IS NOT NULL
                 AND receipt.subject_binding_epoch IS NOT NULL
                 AND receipt.observed_at <= session.terminal_at
                 AND (receipt.expires_at IS NULL OR receipt.expires_at > clock_timestamp())
                 AND active_binding.subject_key_id = receipt.subject_key_id
                 AND active_binding.binding_event_id = receipt.subject_binding_event_id
                 AND active_binding.binding_epoch = receipt.subject_binding_epoch
                 AND active_binding.user_id = session.actor_id
                 AND assertion.user_id = session.actor_id
                 AND assertion.evidence_receipt_id = receipt.evidence_receipt_id
                 AND assertion.subject_key_id = receipt.subject_key_id
                 AND assertion.observed_at <= session.terminal_at
                 AND (assertion.expires_at IS NULL OR assertion.expires_at > clock_timestamp())
                 AND assertion_binding.user_id = session.actor_id
                 AND assertion_binding.binding_mode = 'same_subject'
                 AND assertion_binding.subject_key_id = receipt.subject_key_id
                 AND assertion_binding.evidence_receipt_id IS NULL
                 AND assertion_binding.subject_binding_event_id = receipt.subject_binding_event_id
                 AND assertion_binding.subject_binding_epoch = receipt.subject_binding_epoch
               )
             ) AS evidence_valid
        FROM proof_sessions AS session
        LEFT JOIN evidence_receipts AS receipt
          ON receipt.proof_session_id = session.proof_session_id
        LEFT JOIN assertions AS assertion
          ON assertion.evidence_receipt_id = receipt.evidence_receipt_id
        LEFT JOIN assertion_bindings AS assertion_binding
          ON assertion_binding.binding_group_id = assertion.binding_group_id
        LEFT JOIN active_subject_key_bindings AS active_binding
          ON active_binding.subject_key_id = receipt.subject_key_id
       WHERE session.proof_session_id = $1
         AND session.actor_id = $3`,
      values: [input.proof_session_id, VERY_OAUTH_EVIDENCE_KIND, input.actor_id],
      readonly: false,
    });
    const evidenceRow = oneRow(evidenceResult.rows);
    if (evidenceRow === undefined || evidenceRow === null) {
      return yield* Effect.fail(verificationStorageFailure());
    }
    if (evidenceRow.evidence_valid !== true) {
      return { kind: "stale", reason: "evidence_invalid" } as const;
    }

    const transitioned = transitionCommunityCreationIntent(
      stateFromDocument(document, providerId),
      { type: "verification_completed", expected_revision: document.revision },
    );
    if (transitioned.kind === "rejected") {
      return yield* Effect.fail(verificationStorageFailure());
    }
    const next = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
      ...document,
      revision: transitioned.state.revision,
      status: transitioned.state.status,
      next_action: creationNextAction(transitioned.state),
    });
    if (Option.isNone(next)) return yield* Effect.fail(verificationStorageFailure());
    const updated = yield* transaction.execute({
      label: "community.creation.verification.persist-intent",
      text: `UPDATE community_creation_intents
                SET revision = $1, status = 'commit_ready', updated_at = clock_timestamp()
              WHERE intent_id = $2 AND actor_id = $3 AND revision = $4
                AND status = 'verification_required'
                AND expires_at > clock_timestamp()`,
      values: [next.value.revision, intentId, input.actor_id, document.revision],
      readonly: false,
    });
    if (updated.rowCount === 0) {
      return { kind: "stale", reason: "intent_expired" } as const;
    }
    if (updated.rowCount !== 1) return yield* Effect.fail(verificationStorageFailure());
    yield* insertRevision(transaction, {
      intent: next.value,
      actorId: input.actor_id,
      operation: "verification",
      requestHash: input.result_hash,
    });
    return { kind: "advanced", intent_id: intentId, revision: next.value.revision } as const;
  });
}

function exactCreateBody(value: unknown) {
  return Schema.decodeUnknownOption(CreateCommunityCreationIntent.request.body, {
    onExcessProperty: "error",
  })(value);
}

function exactUpdateBody(value: unknown) {
  return Schema.decodeUnknownOption(UpdateCommunityCreationIntent.request.body, {
    onExcessProperty: "error",
  })(value);
}

function exactCommitBody(value: unknown) {
  return Schema.decodeUnknownOption(CommitCommunityCreationIntent.request.body, {
    onExcessProperty: "error",
  })(value);
}

interface CommunityCreationRepository {
  readonly create: (
    input: Parameters<CommunityCreationStoreService["create"]>[0],
  ) => Effect.Effect<
    CommunityCreationIntentDocument,
    CommunityCreationRepositoryFailure,
    ControlPlaneDb
  >;
  readonly get: (
    input: Parameters<CommunityCreationStoreService["get"]>[0],
  ) => Effect.Effect<
    CommunityCreationIntentDocument | null,
    CommunityCreationRepositoryFailure,
    ControlPlaneDb
  >;
  readonly update: (
    input: Parameters<CommunityCreationStoreService["update"]>[0],
  ) => Effect.Effect<
    CommunityCreationIntentDocument,
    CommunityCreationRepositoryFailure,
    ControlPlaneDb
  >;
  readonly commit: (
    input: Parameters<CommunityCreationStoreService["commit"]>[0],
  ) => Effect.Effect<
    CommunityCreationIntentDocument,
    CommunityCreationRepositoryFailure,
    ControlPlaneDb
  >;
}

export function makeControlPlaneCommunityCreationRepository(
  options: CommunityCreationRepositoryOptions = {},
): CommunityCreationRepository {
  const intentTtlSeconds = options.intent_ttl_seconds ?? COMMUNITY_CREATION_INTENT_TTL_SECONDS;
  const nextIntentId = options.next_intent_id ?? (() => `community-intent-${crypto.randomUUID()}`);
  const nextCommunityId = options.next_community_id ?? (() => `community-${crypto.randomUUID()}`);
  const nextSubjectClaimId =
    options.next_subject_claim_id ?? (() => `community-creation-claim-${crypto.randomUUID()}`);
  const configured = Number.isSafeInteger(intentTtlSeconds) && intentTtlSeconds > 0;

  const create: CommunityCreationRepository["create"] = (input) =>
    Effect.gen(function* () {
      const decodedBody = exactCreateBody(input.body);
      if (
        !configured ||
        !validId(input.actor.userId) ||
        !SHA256_HEX.test(input.requestHash) ||
        Option.isNone(decodedBody)
      ) {
        return yield* Effect.fail(failure("create", "constraint"));
      }
      const body = decodedBody.value;
      const intentId = nextIntentId();
      if (!validId(intentId)) return yield* Effect.fail(failure("create", "constraint"));
      const compiled = compileDraft(body.draft.policy);
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* lockActor(transaction, input.actor.userId, "create");
          const replay = yield* replayByKey(transaction, {
            operation: "create",
            actorId: input.actor.userId,
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          if (replay !== null) return replay;

          const inserted = yield* transaction.execute<Row>({
            label: "community.creation.create.insert-intent",
            text: `INSERT INTO community_creation_intents (
                     intent_id, actor_id, create_idempotency_key, create_request_hash,
                     revision, status, draft, canonical_policy_revision,
                     canonical_policy_hash, verification_requirement_hash,
                     verification_provider_id, provider_configuration_kind,
                     provider_configuration_ref, provider_configuration_version,
                     expires_at
                   ) VALUES (
                     $1, $2, $3, $4, 1, $5, $6::jsonb, 1, $7, $8,
                     $9, $10, $11, $12,
                     clock_timestamp() + ($13::integer * interval '1 second')
                   )
                   RETURNING ${rowColumns()}`,
            values: [
              intentId,
              input.actor.userId,
              body.idempotency_key,
              input.requestHash,
              compiled.status,
              JSON.stringify(body.draft),
              compiled.canonicalPolicyHash,
              compiled.verificationRequirementHash,
              compiled.binding.providerId,
              compiled.binding.configurationKind,
              compiled.binding.configurationReference,
              compiled.binding.configurationVersion,
              intentTtlSeconds,
            ],
            readonly: false,
          });
          const row = oneRow(inserted.rows);
          if (row === undefined || row === null) {
            return yield* Effect.fail(failure("create", "invalid-row"));
          }
          const document = documentFromRow(row);
          if (document === null) return yield* Effect.fail(failure("create", "invalid-row"));
          yield* insertRevision(transaction, {
            intent: document,
            actorId: input.actor.userId,
            operation: "create",
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          return document;
        }),
      );
    });

  const get: CommunityCreationRepository["get"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.actor.userId) || !validId(input.intentId)) {
        return yield* Effect.fail(failure("get", "not-found"));
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const row = yield* loadLockedIntent(
            transaction,
            input.actor.userId,
            input.intentId,
            "get",
          );
          if (row === null) return null;
          const document = documentFromRow(row);
          const providerId = asString(row.verification_provider_id);
          if (document === null || providerId === null) {
            return yield* Effect.fail(failure("get", "invalid-row"));
          }
          if (row.expired !== true || TERMINAL_STATUSES.has(document.status)) return document;
          const transitioned = transitionCommunityCreationIntent(
            stateFromDocument(document, providerId),
            { type: "expired", expected_revision: document.revision },
          );
          if (transitioned.kind === "rejected") {
            return yield* Effect.fail(failure("get", "invalid-row"));
          }
          const expired = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
            ...document,
            revision: transitioned.state.revision,
            status: transitioned.state.status,
            next_action: creationNextAction(transitioned.state),
          });
          if (Option.isNone(expired)) return yield* Effect.fail(failure("get", "invalid-row"));
          const updated = yield* transaction.execute({
            label: "community.creation.get.expire-intent",
            text: `UPDATE community_creation_intents
                      SET revision = $1, status = 'expired', updated_at = clock_timestamp()
                    WHERE intent_id = $2 AND actor_id = $3 AND revision = $4`,
            values: [expired.value.revision, input.intentId, input.actor.userId, document.revision],
            readonly: false,
          });
          if (updated.rowCount !== 1) return yield* Effect.fail(failure("get", "invalid-row"));
          const requestHash = asString(row.create_request_hash);
          if (requestHash === null) return yield* Effect.fail(failure("get", "invalid-row"));
          yield* insertRevision(transaction, {
            intent: expired.value,
            actorId: input.actor.userId,
            operation: "expire",
            requestHash,
          });
          return expired.value;
        }),
      );
    });

  const update: CommunityCreationRepository["update"] = (input) =>
    Effect.gen(function* () {
      const decodedBody = exactUpdateBody(input.body);
      if (
        !validId(input.actor.userId) ||
        !validId(input.intentId) ||
        !SHA256_HEX.test(input.requestHash) ||
        Option.isNone(decodedBody)
      ) {
        return yield* Effect.fail(failure("update", "constraint"));
      }
      const body = decodedBody.value;
      const compiled = compileDraft(body.draft.policy);
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* lockActor(transaction, input.actor.userId, "update");
          const replay = yield* replayByKey(transaction, {
            operation: "update",
            actorId: input.actor.userId,
            intentId: input.intentId,
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          if (replay !== null) return replay;
          const row = yield* loadLockedIntent(
            transaction,
            input.actor.userId,
            input.intentId,
            "update",
          );
          if (row === null) return yield* Effect.fail(failure("update", "not-found"));
          const document = documentFromRow(row);
          const providerId = asString(row.verification_provider_id);
          if (document === null || providerId === null) {
            return yield* Effect.fail(failure("update", "invalid-row"));
          }
          if (row.expired === true || TERMINAL_STATUSES.has(document.status)) {
            return yield* Effect.fail(failure("update", "constraint"));
          }
          if (body.expected_revision !== document.revision) {
            return yield* Effect.fail(failure("update", "revision-conflict"));
          }
          const requirementUnchanged =
            document.verification_requirement_hash === compiled.verificationRequirementHash;
          const outcome =
            compiled.status === "gate_unsupported"
              ? "gate_unsupported"
              : document.status === "commit_ready" && requirementUnchanged
                ? "evidence_satisfied"
                : "verification_required";
          const transitioned = transitionCommunityCreationIntent(
            stateFromDocument(document, providerId),
            {
              type: "draft_preflight_completed",
              expected_revision: document.revision,
              canonical_policy_revision: document.canonical_policy_revision + 1,
              canonical_policy_hash: compiled.canonicalPolicyHash,
              verification_requirement_hash: compiled.verificationRequirementHash,
              outcome,
            },
          );
          if (transitioned.kind === "rejected") {
            return yield* Effect.fail(failure("update", "constraint"));
          }
          const next = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
            ...document,
            revision: transitioned.state.revision,
            status: transitioned.state.status,
            draft: body.draft,
            canonical_policy_revision: transitioned.state.canonical_policy_revision,
            canonical_policy_hash: transitioned.state.canonical_policy_hash,
            verification_requirement_hash: transitioned.state.verification_requirement_hash,
            next_action: creationNextAction(transitioned.state),
          });
          if (Option.isNone(next)) return yield* Effect.fail(failure("update", "invalid-row"));
          const updated = yield* transaction.execute({
            label: "community.creation.update.persist-intent",
            text: `UPDATE community_creation_intents
                      SET revision = $1, status = $2, draft = $3::jsonb,
                          canonical_policy_revision = $4, canonical_policy_hash = $5,
                          verification_requirement_hash = $6,
                          verification_provider_id = $7,
                          provider_configuration_kind = $8,
                          provider_configuration_ref = $9,
                          provider_configuration_version = $10,
                          updated_at = clock_timestamp()
                    WHERE intent_id = $11 AND actor_id = $12 AND revision = $13`,
            values: [
              next.value.revision,
              next.value.status,
              JSON.stringify(body.draft),
              next.value.canonical_policy_revision,
              next.value.canonical_policy_hash,
              next.value.verification_requirement_hash,
              compiled.binding.providerId,
              compiled.binding.configurationKind,
              compiled.binding.configurationReference,
              compiled.binding.configurationVersion,
              input.intentId,
              input.actor.userId,
              document.revision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1) return yield* Effect.fail(failure("update", "invalid-row"));
          yield* insertRevision(transaction, {
            intent: next.value,
            actorId: input.actor.userId,
            operation: "update",
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          return next.value;
        }),
      );
    });

  const commit: CommunityCreationRepository["commit"] = (input) =>
    Effect.gen(function* () {
      const decodedBody = exactCommitBody(input.body);
      if (
        !validId(input.actor.userId) ||
        !validId(input.intentId) ||
        !SHA256_HEX.test(input.requestHash) ||
        Option.isNone(decodedBody)
      ) {
        return yield* Effect.fail(failure("commit", "constraint"));
      }
      const body = decodedBody.value;
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* lockActor(transaction, input.actor.userId, "commit");
          const replay = yield* replayByKey(transaction, {
            operation: "commit",
            actorId: input.actor.userId,
            intentId: input.intentId,
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          if (replay !== null) return replay;
          const row = yield* loadLockedIntent(
            transaction,
            input.actor.userId,
            input.intentId,
            "commit",
          );
          if (row === null) return yield* Effect.fail(failure("commit", "not-found"));
          const document = documentFromRow(row);
          const providerId = asString(row.verification_provider_id);
          if (document === null || providerId === null) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          if (body.expected_revision !== document.revision) {
            return yield* Effect.fail(failure("commit", "revision-conflict"));
          }
          if (
            row.expired === true ||
            document.status !== "commit_ready" ||
            TERMINAL_STATUSES.has(document.status)
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const compilation = compileCommunityGatePolicy(document.draft.policy);
          if (
            compilation.kind !== "supported" ||
            compilation.canonical_policy_hash !== document.canonical_policy_hash ||
            compilation.verification_requirement_hash !== document.verification_requirement_hash ||
            providerId !== compilation.provider_binding.provider_id ||
            row.provider_configuration_kind !==
              compilation.provider_binding.provider_configuration.kind ||
            row.provider_configuration_ref !==
              compilation.provider_binding.provider_configuration.reference ||
            row.provider_configuration_version !==
              compilation.provider_binding.provider_configuration.version
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const sessionResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.lock-session",
            text: `SELECT proof_session_id, actor_id, intent_id, provider_id,
                          provider_configuration_kind, provider_configuration_ref,
                          provider_configuration_version, method, issuer, scope_kind,
                          issuer_rp_scope, issuer_rp_action_scope, request_mode,
                          requested_requirements, requested_claim_ids,
                          subject_binding_intent, protocol_version, environment,
                          status, expires_at, completed_at, terminal_at,
                          completion_idempotency_key, completion_result_hash
                     FROM proof_sessions
                    WHERE actor_id = $1 AND intent_id = $2
                    FOR UPDATE`,
            values: [input.actor.userId, input.intentId],
            readonly: false,
          });
          const session = oneRow(sessionResult.rows);
          if (session === undefined) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          if (session === null) return yield* Effect.fail(failure("commit", "constraint"));
          const proofSessionId = asString(session.proof_session_id);
          const completedAt = asTimestamp(session.completed_at);
          const terminalAt = asTimestamp(session.terminal_at);
          const sessionExpiresAt = asTimestamp(session.expires_at);
          if (
            proofSessionId === null ||
            session.actor_id !== input.actor.userId ||
            session.intent_id !== input.intentId ||
            session.status !== "completed" ||
            asString(session.completion_idempotency_key) === null ||
            !SHA256_HEX.test(asString(session.completion_result_hash) ?? "") ||
            completedAt === null ||
            terminalAt === null ||
            sessionExpiresAt === null ||
            completedAt !== terminalAt ||
            Date.parse(completedAt) >= Date.parse(sessionExpiresAt) ||
            session.provider_id !== compilation.provider_binding.provider_id ||
            session.provider_configuration_kind !==
              compilation.provider_binding.provider_configuration.kind ||
            session.provider_configuration_ref !==
              compilation.provider_binding.provider_configuration.reference ||
            session.provider_configuration_version !==
              compilation.provider_binding.provider_configuration.version ||
            session.method !== compilation.provider_binding.method ||
            session.issuer !== compilation.provider_binding.scope.issuer ||
            session.scope_kind !== compilation.provider_binding.scope.scope_semantics ||
            session.issuer_rp_scope !== compilation.provider_binding.scope.rp_scope ||
            session.issuer_rp_action_scope !== null ||
            session.request_mode !== "dynamic" ||
            !exactCanonicalJson(session.requested_requirements, HUMAN_MEMBERSHIP_REQUIREMENTS) ||
            !exactCanonicalJson(session.requested_claim_ids, HUMAN_MEMBERSHIP_CLAIM_IDS) ||
            session.subject_binding_intent !== "establish" ||
            session.protocol_version !== compilation.provider_binding.protocol_version ||
            asString(session.environment) === null
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const evidence = yield* loadCommitEvidence(transaction, {
            actorId: input.actor.userId,
            proofSessionId,
          });
          if (evidence === null) return yield* Effect.fail(failure("commit", "constraint"));

          const subjectResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.lock-subject",
            text: `SELECT subject_key_id, issuer, method, scope_kind,
                          issuer_rp_scope, issuer_rp_action_scope,
                          subject_digest, digest_algorithm
                     FROM subject_keys
                    WHERE subject_key_id = $1
                    FOR UPDATE`,
            values: [evidence.subjectKeyId],
            readonly: false,
          });
          const subject = oneRow(subjectResult.rows);
          if (subject === undefined) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          if (
            subject === null ||
            subject.subject_key_id !== evidence.subjectKeyId ||
            subject.issuer !== compilation.provider_binding.scope.issuer ||
            subject.method !== compilation.provider_binding.method ||
            subject.scope_kind !== compilation.provider_binding.scope.scope_semantics ||
            subject.issuer_rp_scope !== compilation.provider_binding.scope.rp_scope ||
            subject.issuer_rp_action_scope !== null ||
            !SHA256_HEX.test(asString(subject.subject_digest) ?? "") ||
            subject.digest_algorithm !== "sha256"
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const slotOneResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.lock-slot-one",
            text: `SELECT claim_id
                     FROM community_creation_subject_claims
                    WHERE subject_key_id = $1 AND slot_number = 1
                    FOR UPDATE`,
            values: [evidence.subjectKeyId],
            readonly: false,
          });
          const slotOne = oneRow(slotOneResult.rows);
          if (slotOne === undefined) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }

          let slotNumber = 1;
          let approvalId: string | null = null;
          if (slotOne !== null) {
            const approvalResult = yield* transaction.execute<Row>({
              label: "community.creation.commit.lock-approval",
              text: `SELECT approval.approval_id, approval.slot_number
                       FROM community_creation_quota_approvals AS approval
                      WHERE approval.subject_key_id = $1
                        AND approval.actor_id = $2
                        AND approval.expires_at > clock_timestamp()
                        AND NOT EXISTS (
                          SELECT 1
                            FROM community_creation_subject_claims AS claim
                           WHERE claim.approval_id = approval.approval_id
                              OR (
                                claim.subject_key_id = approval.subject_key_id
                                AND claim.slot_number = approval.slot_number
                              )
                        )
                      ORDER BY approval.slot_number, approval.approval_id
                      FOR UPDATE OF approval
                      LIMIT 1`,
              values: [evidence.subjectKeyId, input.actor.userId],
              readonly: false,
            });
            const approval = oneRow(approvalResult.rows);
            if (approval === undefined) {
              return yield* Effect.fail(failure("commit", "invalid-row"));
            }
            if (approval === null) {
              const transitioned = transitionCommunityCreationIntent(
                stateFromDocument(document, providerId),
                { type: "commit_quota_exceeded", expected_revision: document.revision },
              );
              if (transitioned.kind === "rejected") {
                return yield* Effect.fail(failure("commit", "constraint"));
              }
              const quotaExceeded = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
                ...document,
                revision: transitioned.state.revision,
                status: transitioned.state.status,
                next_action: creationNextAction(transitioned.state),
              });
              if (Option.isNone(quotaExceeded)) {
                return yield* Effect.fail(failure("commit", "invalid-row"));
              }
              const updated = yield* transaction.execute({
                label: "community.creation.commit.persist-quota-exceeded",
                text: `UPDATE community_creation_intents
                          SET revision = $1, status = 'quota_exceeded',
                              updated_at = clock_timestamp()
                        WHERE intent_id = $2 AND actor_id = $3 AND revision = $4
                          AND status = 'commit_ready'
                          AND expires_at > clock_timestamp()`,
                values: [
                  quotaExceeded.value.revision,
                  input.intentId,
                  input.actor.userId,
                  document.revision,
                ],
                readonly: false,
              });
              if (updated.rowCount !== 1) {
                return yield* Effect.fail(failure("commit", "invalid-row"));
              }
              yield* insertRevision(transaction, {
                intent: quotaExceeded.value,
                actorId: input.actor.userId,
                operation: "commit",
                idempotencyKey: body.idempotency_key,
                requestHash: input.requestHash,
              });
              return quotaExceeded.value;
            }
            approvalId = asString(approval.approval_id);
            const approvedSlot = asPositiveInteger(approval.slot_number);
            if (approvalId === null || approvedSlot === null || approvedSlot <= 1) {
              return yield* Effect.fail(failure("commit", "invalid-row"));
            }
            slotNumber = approvedSlot;
          }

          yield* transaction.execute({
            label: "community.creation.commit.lock-route-slug",
            text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 19012026))",
            values: [document.draft.slug],
            readonly: false,
          });
          const slugResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.check-route-slug",
            text: "SELECT community_id FROM communities WHERE route_slug = $1 FOR UPDATE",
            values: [document.draft.slug],
            readonly: false,
          });
          const existingSlug = oneRow(slugResult.rows);
          if (existingSlug === undefined) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          if (existingSlug !== null) return yield* Effect.fail(failure("commit", "constraint"));

          const communityId = nextCommunityId();
          const subjectClaimId = nextSubjectClaimId();
          if (!validId(communityId) || !validId(subjectClaimId)) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }
          const resource = {
            community_id: communityId,
            href: `/communities/${encodeURIComponent(communityId)}`,
          } as const;
          const transitioned = transitionCommunityCreationIntent(
            stateFromDocument(document, providerId),
            {
              type: "commit_completed",
              expected_revision: document.revision,
              resource,
            },
          );
          if (transitioned.kind === "rejected") {
            return yield* Effect.fail(failure("commit", "constraint"));
          }
          const committed = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
            ...document,
            revision: transitioned.state.revision,
            status: transitioned.state.status,
            next_action: creationNextAction(transitioned.state),
            committed_resource: resource,
          });
          if (Option.isNone(committed)) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }

          yield* transaction.execute({
            label: "community.creation.commit.insert-community",
            text: `INSERT INTO communities (
                     community_id, display_name, status, created_by_user_id,
                     created_at, updated_at, membership_mode,
                     human_verification_lane, route_slug, description
                   ) VALUES (
                     $1, $2, 'active', $3, clock_timestamp(), clock_timestamp(),
                     'gated', 'very', $4, $5
                   )`,
            values: [
              communityId,
              document.draft.name,
              input.actor.userId,
              document.draft.slug,
              document.draft.description,
            ],
            readonly: false,
          });
          yield* transaction.execute({
            label: "community.creation.commit.insert-policy",
            text: `INSERT INTO policy_versions (
                     policy_version_id, community_id, policy_key, revision,
                     policy_hash, policy, compiled_plan, compiler_version,
                     uniqueness_model, created_by_user_id, published_at,
                     policy_purpose
                   ) VALUES (
                     $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8,
                     '{"kind":"none"}'::jsonb, $9, clock_timestamp(), 'access'
                   )`,
            values: [
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
              communityId,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_revision,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
              JSON.stringify(CURATED_HUMAN_MEMBERSHIP_POLICY),
              JSON.stringify(compilation.compiled_plan),
              compilation.compiled_plan.compiler_version,
              input.actor.userId,
            ],
            readonly: false,
          });
          yield* transaction.execute({
            label: "community.creation.commit.insert-provider-binding",
            text: `INSERT INTO community_policy_provider_bindings (
                     community_id, policy_key, policy_version_id,
                     verification_requirement_hash, provider_id,
                     provider_configuration_kind, provider_configuration_ref,
                     provider_configuration_version, method, protocol_version,
                     issuer, scope_kind, issuer_rp_scope, issuer_rp_action_scope,
                     request_mode, evaluator_id
                   ) VALUES (
                     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                     $11, $12, $13, NULL, 'dynamic', $14
                   )`,
            values: [
              communityId,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
              document.verification_requirement_hash,
              compilation.provider_binding.provider_id,
              compilation.provider_binding.provider_configuration.kind,
              compilation.provider_binding.provider_configuration.reference,
              compilation.provider_binding.provider_configuration.version,
              compilation.provider_binding.method,
              compilation.provider_binding.protocol_version,
              compilation.provider_binding.scope.issuer,
              compilation.provider_binding.scope.scope_semantics,
              compilation.provider_binding.scope.rp_scope,
              compilation.compiled_plan.evaluator,
            ],
            readonly: false,
          });
          yield* transaction.execute({
            label: "community.creation.commit.insert-current-policy",
            text: `INSERT INTO community_policy_current (
                     community_id, policy_key, policy_version_id, activated_at
                   ) VALUES ($1, $2, $3, clock_timestamp())`,
            values: [
              communityId,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
            ],
            readonly: false,
          });
          yield* transaction.execute({
            label: "community.creation.commit.insert-subject-claim",
            text: `INSERT INTO community_creation_subject_claims (
                     claim_id, subject_key_id, actor_id, slot_number, approval_id,
                     intent_id, community_id, proof_session_id, evidence_receipt_id,
                     verification_requirement_hash
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            values: [
              subjectClaimId,
              evidence.subjectKeyId,
              input.actor.userId,
              slotNumber,
              approvalId,
              input.intentId,
              communityId,
              evidence.proofSessionId,
              evidence.evidenceReceiptId,
              document.verification_requirement_hash,
            ],
            readonly: false,
          });
          const updated = yield* transaction.execute<Row>({
            label: "community.creation.commit.persist-intent",
            text: `UPDATE community_creation_intents
                      SET revision = $1, status = 'committed',
                          committed_community_id = $2, committed_resource_href = $3,
                          updated_at = clock_timestamp()
                    WHERE intent_id = $4 AND actor_id = $5 AND revision = $6
                      AND status = 'commit_ready'
                      AND expires_at > clock_timestamp()
                    RETURNING ${rowColumns()}`,
            values: [
              committed.value.revision,
              communityId,
              resource.href,
              input.intentId,
              input.actor.userId,
              document.revision,
            ],
            readonly: false,
          });
          const updatedRow = oneRow(updated.rows);
          if (updatedRow === undefined || updatedRow === null) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          const stored = documentFromRow(updatedRow);
          if (stored === null || JSON.stringify(stored) !== JSON.stringify(committed.value)) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          yield* insertRevision(transaction, {
            intent: stored,
            actorId: input.actor.userId,
            operation: "commit",
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          return stored;
        }),
      );
    });

  return { create, get, update, commit };
}

export function makeControlPlaneCommunityCreationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: CommunityCreationRepositoryOptions = {},
): CommunityCreationStore["Service"] {
  const repository = makeControlPlaneCommunityCreationRepository(options);
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  return {
    create: (input) => provide(repository.create(input)),
    get: (input) => provide(repository.get(input)),
    update: (input) => provide(repository.update(input)),
    commit: (input) => provide(repository.commit(input)),
  };
}
