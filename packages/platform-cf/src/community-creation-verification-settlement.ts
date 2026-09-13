import type { ControlPlaneError, ControlPlaneTransaction } from "@pirate/application";
import { VerificationCompletionStorageFailed } from "@pirate/application/verification";
import { CommunityCreationIntent as CommunityCreationIntentContract } from "@pirate/contracts";
import {
  communityCreationProviderBindingHash,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  transitionCreationRequirement,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "@pirate/domain";
import { Effect, Option, Schema } from "effect";
import {
  asPositiveInteger,
  asString,
  asTimestamp,
  documentFromRow,
  exactCanonicalJson,
  HUMAN_MEMBERSHIP_CLAIM_IDS,
  HUMAN_MEMBERSHIP_REQUIREMENTS,
  insertRevision,
  loadCommitEvidence,
  loadLockedIntent,
  oneRow,
  type Row,
  reserveNextCreationRequirement,
  SHA256_HEX,
  TERMINAL_STATUSES,
  VERY_WEB_EVIDENCE_KIND,
  validId,
} from "./community-creation-internals.ts";

/**
 * Historical community creation settlement.
 *
 * These helpers settle proofs produced by retired flows - identity completion
 * and grandfathered route-v1 HNS namespace ownership - against a creation
 * intent. They run only inside the caller's transaction and preserve the
 * original locking, revision and idempotency behavior. Current creation and
 * activation stay in the creation repository; the shared SQL and document
 * helpers it owns are imported here.
 */

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

function verificationStorageFailure(): VerificationCompletionStorageFailed {
  return new VerificationCompletionStorageFailed();
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
                    completion_idempotency_key, completion_result_hash,
                    creation_ceremony_intent_id
               FROM proof_sessions
              WHERE proof_session_id = $1 AND actor_id = $2
              FOR UPDATE`,
      values: [input.proof_session_id, input.actor_id],
      readonly: false,
    });
    const session = oneRow(sessionResult.rows);
    if (session === undefined) return yield* Effect.fail(verificationStorageFailure());
    if (session === null) return { kind: "not_applicable" } as const;

    const ceremonyIntentId = asString(session.creation_ceremony_intent_id);
    const completedAt = asTimestamp(session.completed_at);
    const terminalAt = asTimestamp(session.terminal_at);
    const sessionExpiresAt = asTimestamp(session.expires_at);
    if (
      ceremonyIntentId === null ||
      session.proof_session_id !== input.proof_session_id ||
      session.actor_id !== input.actor_id ||
      session.intent_id !== ceremonyIntentId ||
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

    const authorityResult = yield* transaction.execute<Row>({
      label: "community.creation.verification.lock-authority",
      text: `SELECT attempt.intent_id,
                    attempt.requirement_kind AS attempt_requirement_kind,
                    attempt.generation AS attempt_generation,
                    attempt.requirement_hash AS attempt_requirement_hash,
                    attempt.provider_id AS attempt_provider_id,
                    attempt.provider_binding_hash AS attempt_provider_binding_hash,
                    attempt.provider_configuration_kind AS attempt_configuration_kind,
                    attempt.provider_configuration_ref AS attempt_configuration_ref,
                    attempt.provider_configuration_version AS attempt_configuration_version,
                    attempt.route_family AS attempt_route_family,
                    attempt.expires_at AS attempt_expires_at,
                    state.status AS requirement_status,
                    state.generation AS requirement_generation,
                    state.requirement_hash,
                    state.provider_id,
                    state.provider_binding_hash,
                    state.provider_configuration_kind,
                    state.provider_configuration_ref,
                    state.provider_configuration_version,
                    state.current_ceremony_intent_id,
                    state.route_family
               FROM community_creation_ceremony_attempts AS attempt
               JOIN community_creation_requirement_states AS state
                 ON state.intent_id = attempt.intent_id
                AND state.actor_id = attempt.actor_id
                AND state.requirement_kind = attempt.requirement_kind
              WHERE attempt.ceremony_intent_id = $1
                AND attempt.actor_id = $2
                AND attempt.requirement_kind = 'human_identity'
              FOR UPDATE OF attempt, state`,
      values: [ceremonyIntentId, input.actor_id],
      readonly: false,
    });
    const authority = oneRow(authorityResult.rows);
    if (authority === undefined) return yield* Effect.fail(verificationStorageFailure());
    if (authority === null) return { kind: "not_applicable" } as const;
    const intentId = asString(authority.intent_id);
    const generation = asPositiveInteger(authority.attempt_generation);
    const requirementHash = asString(authority.attempt_requirement_hash);
    const providerId = asString(authority.attempt_provider_id);
    const providerBindingHash = asString(authority.attempt_provider_binding_hash);
    const configurationVersion = asString(authority.attempt_configuration_version);
    const attemptExpiresAt = asTimestamp(authority.attempt_expires_at);
    const expectedProviderBindingHash = communityCreationProviderBindingHash({
      requirement: "human_identity",
      family: null,
      provider_id: VERY_WEB_PROVIDER_ID,
      provider_configuration: {
        kind: "dynamic",
        reference: VERY_WEB_CONFIGURATION_REFERENCE,
        version: VERY_WEB_CONFIGURATION_VERSION,
      },
      protocol_version: VERY_WEB_PROTOCOL_VERSION,
    });
    if (
      intentId === null ||
      generation === null ||
      requirementHash !== HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH ||
      providerId !== VERY_WEB_PROVIDER_ID ||
      providerBindingHash !== expectedProviderBindingHash ||
      configurationVersion !== VERY_WEB_CONFIGURATION_VERSION ||
      attemptExpiresAt === null ||
      Date.parse(completedAt) >= Date.parse(attemptExpiresAt) ||
      authority.attempt_requirement_kind !== "human_identity" ||
      authority.attempt_configuration_kind !== "dynamic" ||
      authority.attempt_configuration_ref !== VERY_WEB_CONFIGURATION_REFERENCE ||
      authority.attempt_route_family !== null ||
      Number(authority.requirement_generation) !== generation ||
      authority.requirement_hash !== requirementHash ||
      authority.provider_id !== providerId ||
      authority.provider_binding_hash !== providerBindingHash ||
      authority.provider_configuration_kind !== authority.attempt_configuration_kind ||
      authority.provider_configuration_ref !== authority.attempt_configuration_ref ||
      authority.provider_configuration_version !== configurationVersion ||
      authority.current_ceremony_intent_id !== ceremonyIntentId ||
      authority.route_family !== null
    ) {
      return { kind: "stale", reason: "session_binding_drift" } as const;
    }

    const intentRow = yield* loadLockedIntent(transaction, input.actor_id, intentId, "get").pipe(
      Effect.mapError(() => verificationStorageFailure()),
    );
    if (intentRow === null) return { kind: "not_applicable" } as const;
    const document = documentFromRow(intentRow);
    if (document === null) {
      return yield* Effect.fail(verificationStorageFailure());
    }
    if (TERMINAL_STATUSES.has(document.status)) {
      return { kind: "stale", reason: "intent_terminal" } as const;
    }
    if (intentRow.expired === true) {
      return { kind: "stale", reason: "intent_expired" } as const;
    }

    if (document.requirements.human_identity === undefined) {
      return { kind: "stale", reason: "intent_not_verification_required" } as const;
    }
    const exactBinding =
      document.requirements.human_identity.requirement_hash ===
        HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH &&
      session.provider_id === providerId &&
      session.provider_configuration_kind === authority.attempt_configuration_kind &&
      session.provider_configuration_ref === authority.attempt_configuration_ref &&
      session.provider_configuration_version === configurationVersion &&
      session.method === VERY_WEB_METHOD &&
      session.issuer === VERY_WEB_ISSUER &&
      session.scope_kind === "issuer_rp_scope" &&
      session.issuer_rp_scope === VERY_WEB_RP_SCOPE &&
      session.issuer_rp_action_scope === null &&
      session.request_mode === "dynamic" &&
      exactCanonicalJson(session.requested_requirements, HUMAN_MEMBERSHIP_REQUIREMENTS) &&
      exactCanonicalJson(session.requested_claim_ids, HUMAN_MEMBERSHIP_CLAIM_IDS) &&
      session.subject_binding_intent === "establish" &&
      session.protocol_version === VERY_WEB_PROTOCOL_VERSION &&
      asString(session.environment) !== null;
    if (!exactBinding) {
      return { kind: "stale", reason: "session_binding_drift" } as const;
    }

    if (authority.requirement_status === "satisfied") {
      if (document.status !== "verification_required" && document.status !== "commit_ready") {
        return { kind: "stale", reason: "intent_not_verification_required" } as const;
      }
      const replayResult = yield* transaction.execute<Row>({
        label: "community.creation.verification.load-result-replay",
        text: `SELECT proof_session_id, callback_idempotency_key, callback_request_hash,
                      outcome_status, result_hash, terminal_at, satisfied_at
                 FROM community_creation_ceremony_results
                WHERE ceremony_intent_id = $1 AND actor_id = $2`,
        values: [ceremonyIntentId, input.actor_id],
        readonly: false,
      });
      const replay = oneRow(replayResult.rows);
      if (
        replay === undefined ||
        replay === null ||
        replay.proof_session_id !== input.proof_session_id ||
        replay.callback_idempotency_key !== session.completion_idempotency_key ||
        replay.callback_request_hash !== input.result_hash ||
        replay.outcome_status !== "satisfied" ||
        replay.result_hash !== input.result_hash ||
        asTimestamp(replay.terminal_at) !== completedAt ||
        asTimestamp(replay.satisfied_at) !== completedAt
      ) {
        return { kind: "stale", reason: "session_binding_drift" } as const;
      }
      return {
        kind: "already_ready",
        intent_id: document.intent_id,
        revision: document.revision,
      } as const;
    }
    if (document.status !== "verification_required") {
      return { kind: "stale", reason: "intent_not_verification_required" } as const;
    }
    if (authority.requirement_status !== "pending") {
      return { kind: "stale", reason: "intent_not_verification_required" } as const;
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
      values: [input.proof_session_id, VERY_WEB_EVIDENCE_KIND, input.actor_id],
      readonly: false,
    });
    const evidenceRow = oneRow(evidenceResult.rows);
    if (evidenceRow === undefined || evidenceRow === null) {
      return yield* Effect.fail(verificationStorageFailure());
    }
    if (evidenceRow.evidence_valid !== true) {
      return { kind: "stale", reason: "evidence_invalid" } as const;
    }

    const evidence = yield* loadCommitEvidence(transaction, {
      actorId: input.actor_id,
      proofSessionId: input.proof_session_id,
    });
    if (evidence === null) {
      return { kind: "stale", reason: "evidence_invalid" } as const;
    }

    const transitioned = transitionCreationRequirement(
      {
        requirement: "human_identity",
        status: "pending",
        requirement_hash: requirementHash,
        provider_id: providerId,
        provider_binding_hash: providerBindingHash,
        generation,
        ceremony_intent_id: ceremonyIntentId,
        satisfied_at: null,
      },
      {
        type: "ceremony_satisfied",
        generation,
        ceremony_intent_id: ceremonyIntentId,
        satisfied_at: completedAt,
      },
    );
    if (transitioned.kind === "rejected") {
      return yield* Effect.fail(verificationStorageFailure());
    }
    const insertedResult = yield* transaction.execute({
      label: "community.creation.verification.insert-result",
      text: `INSERT INTO community_creation_ceremony_results (
               ceremony_intent_id, actor_id, intent_id, requirement_kind,
               generation, requirement_hash, provider_id, provider_binding_hash,
               provider_configuration_version, callback_idempotency_key,
               callback_request_hash, outcome_status, result_hash, proof_session_id,
               evidence_receipt_id, evidence_ref, evidence_digest,
               provider_identity_digest, terminal_at, satisfied_at
             ) VALUES (
               $1, $2, $3, 'human_identity', $4, $5, $6, $7, $8, $9,
               $10, 'satisfied', $10, $11, $12, $12, $13, $14, $15, $15
             )`,
      values: [
        ceremonyIntentId,
        input.actor_id,
        intentId,
        generation,
        requirementHash,
        providerId,
        providerBindingHash,
        configurationVersion,
        session.completion_idempotency_key,
        input.result_hash,
        input.proof_session_id,
        evidence.evidenceReceiptId,
        evidence.evidenceDigest,
        evidence.subjectDigest,
        completedAt,
      ],
      readonly: false,
    });
    if (insertedResult.rowCount !== 1) return yield* Effect.fail(verificationStorageFailure());
    const satisfied = yield* transaction.execute({
      label: "community.creation.verification.satisfy-human-requirement",
      text: `UPDATE community_creation_requirement_states
                SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
              WHERE intent_id = $2 AND actor_id = $3
                AND requirement_kind = 'human_identity'
                AND status = 'pending' AND generation = $4
                AND current_ceremony_intent_id = $5`,
      values: [completedAt, intentId, input.actor_id, generation, ceremonyIntentId],
      readonly: false,
    });
    if (satisfied.rowCount !== 1) return yield* Effect.fail(verificationStorageFailure());

    const requirementProgress = yield* reserveNextCreationRequirement(transaction, {
      actorId: input.actor_id,
      intentId,
      ceremonyIntentId: `community-creation-ceremony-${crypto.randomUUID()}`,
      operation: "get",
    }).pipe(Effect.mapError(() => verificationStorageFailure()));
    const nextStatus =
      requirementProgress === "complete" ? "commit_ready" : "verification_required";
    const nextRevision = document.revision + 1;
    const updated = yield* transaction.execute({
      label: "community.creation.verification.persist-intent",
      text: `UPDATE community_creation_intents
                SET revision = $1, status = $2, updated_at = clock_timestamp()
              WHERE intent_id = $3 AND actor_id = $4 AND revision = $5
                AND status = 'verification_required'
                AND expires_at > clock_timestamp()`,
      values: [nextRevision, nextStatus, intentId, input.actor_id, document.revision],
      readonly: false,
    });
    if (updated.rowCount === 0) {
      return { kind: "stale", reason: "intent_expired" } as const;
    }
    if (updated.rowCount !== 1) return yield* Effect.fail(verificationStorageFailure());
    const nextRow = yield* loadLockedIntent(transaction, input.actor_id, intentId, "get").pipe(
      Effect.mapError(() => verificationStorageFailure()),
    );
    const next = nextRow === null ? null : documentFromRow(nextRow);
    if (next === null) return yield* Effect.fail(verificationStorageFailure());
    yield* insertRevision(transaction, {
      intent: next,
      actorId: input.actor_id,
      operation: "verification",
      requestHash: input.result_hash,
    });
    return { kind: "advanced", intent_id: intentId, revision: next.revision } as const;
  });
}

export function advanceCommunityCreationNamespaceVerificationInTransaction(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly actor_id: string;
    readonly intent_id: string;
    readonly result_hash: string;
    readonly database_now: string;
  }>,
): Effect.Effect<
  CommunityCreationVerificationAdvanceOutcome,
  VerificationCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    if (
      !validId(input.actor_id) ||
      !validId(input.intent_id) ||
      !SHA256_HEX.test(input.result_hash)
    ) {
      return yield* Effect.fail(verificationStorageFailure());
    }
    const intentRow = yield* loadLockedIntent(
      transaction,
      input.actor_id,
      input.intent_id,
      "get",
      input.database_now,
    ).pipe(Effect.mapError(() => verificationStorageFailure()));
    if (intentRow === null) return { kind: "not_applicable" } as const;
    const document = documentFromRow(intentRow);
    if (document === null) return yield* Effect.fail(verificationStorageFailure());
    if (TERMINAL_STATUSES.has(document.status)) {
      return { kind: "stale", reason: "intent_terminal" } as const;
    }
    if (intentRow.expired === true) {
      return { kind: "stale", reason: "intent_expired" } as const;
    }
    if (document.status === "commit_ready") {
      return {
        kind: "already_ready",
        intent_id: document.intent_id,
        revision: document.revision,
      } as const;
    }
    if (document.status !== "verification_required") {
      return { kind: "stale", reason: "intent_not_verification_required" } as const;
    }

    const authorityResult = yield* transaction.execute<Row>({
      label: "community.creation.namespace-verification.lock-authority",
      text: `SELECT state.requirement_kind, state.status, state.generation,
                    state.current_ceremony_intent_id, state.satisfied_at,
                    result.outcome_status, result.result_hash,
                    result.satisfied_at AS result_satisfied_at
               FROM community_creation_requirement_states AS state
               JOIN community_creation_ceremony_results AS result
                 ON result.ceremony_intent_id = state.current_ceremony_intent_id
                AND result.actor_id = state.actor_id
                AND result.intent_id = state.intent_id
                AND result.requirement_kind = state.requirement_kind
                AND result.generation = state.generation
              WHERE state.intent_id = $1 AND state.actor_id = $2
              ORDER BY CASE state.requirement_kind
                WHEN 'human_identity' THEN 1
                WHEN 'namespace_ownership' THEN 2
              END
              FOR UPDATE OF state, result`,
      values: [input.intent_id, input.actor_id],
      readonly: false,
    });
    if (authorityResult.rows.length !== 2) {
      return { kind: "stale", reason: "session_binding_drift" } as const;
    }
    const human = authorityResult.rows[0];
    const namespace = authorityResult.rows[1];
    const namespaceSatisfiedAt = asTimestamp(namespace?.satisfied_at);
    if (
      human?.requirement_kind !== "human_identity" ||
      namespace?.requirement_kind !== "namespace_ownership" ||
      human.status !== "satisfied" ||
      namespace.status !== "satisfied" ||
      human.outcome_status !== "satisfied" ||
      namespace.outcome_status !== "satisfied" ||
      asPositiveInteger(human.generation) === null ||
      asPositiveInteger(namespace.generation) === null ||
      asString(human.current_ceremony_intent_id) === null ||
      asString(namespace.current_ceremony_intent_id) === null ||
      asTimestamp(human.satisfied_at) !== asTimestamp(human.result_satisfied_at) ||
      namespaceSatisfiedAt === null ||
      namespaceSatisfiedAt !== asTimestamp(namespace.result_satisfied_at) ||
      namespace.result_hash !== input.result_hash
    ) {
      return { kind: "stale", reason: "session_binding_drift" } as const;
    }

    const nextRevision = document.revision + 1;
    const ready = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
      ...document,
      revision: nextRevision,
      status: "commit_ready",
      next_action: { kind: "commit" },
    });
    if (Option.isNone(ready)) return yield* Effect.fail(verificationStorageFailure());
    const updated = yield* transaction.execute({
      label: "community.creation.namespace-verification.persist-intent",
      text: `UPDATE community_creation_intents
                SET revision = $1, status = 'commit_ready', updated_at = $5::timestamptz
              WHERE intent_id = $2 AND actor_id = $3 AND revision = $4
                AND status = 'verification_required'
                AND creation_contract_version = 'route_v1'
                AND expires_at > $5::timestamptz`,
      values: [
        nextRevision,
        input.intent_id,
        input.actor_id,
        document.revision,
        input.database_now,
      ],
      readonly: false,
    });
    if (updated.rowCount !== 1) return yield* Effect.fail(verificationStorageFailure());
    const storedRow = yield* loadLockedIntent(
      transaction,
      input.actor_id,
      input.intent_id,
      "get",
      input.database_now,
    ).pipe(Effect.mapError(() => verificationStorageFailure()));
    const stored = storedRow === null ? null : documentFromRow(storedRow);
    if (stored === null || JSON.stringify(stored) !== JSON.stringify(ready.value)) {
      return yield* Effect.fail(verificationStorageFailure());
    }
    yield* insertRevision(transaction, {
      intent: stored,
      actorId: input.actor_id,
      operation: "verification",
      requestHash: input.result_hash,
    });
    return { kind: "advanced", intent_id: stored.intent_id, revision: stored.revision } as const;
  });
}
