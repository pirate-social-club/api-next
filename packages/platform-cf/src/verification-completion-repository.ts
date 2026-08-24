import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  type StoredVerificationCompletion,
  type VerificationCompletionAttemptReservation,
  type VerificationCompletionAttemptReservationOutcome,
  type VerificationCompletionHasher,
  VerificationCompletionHashFailed,
  VerificationCompletionStorageFailed,
  type VerificationCompletionStore,
} from "@pirate/application/verification";
import {
  CanonicalIsoInstant,
  type EvidenceBundle,
  ProofSession,
  Sha256Hex,
  type SubjectKey,
} from "@pirate/domain/verification";
import { Data, Effect, type Layer, Option, Schema } from "effect";
import { advanceCommunityCreationVerificationInTransaction } from "./community-creation-repository.ts";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;

class SubjectBindingConflict extends Data.TaggedError("SubjectBindingConflict") {}
class VerificationCompletionExpired extends Data.TaggedError("VerificationCompletionExpired") {}

function storageFailure(): VerificationCompletionStorageFailed {
  return new VerificationCompletionStorageFailed();
}

function oneRow(
  rows: readonly Row[],
): Effect.Effect<Row | null, VerificationCompletionStorageFailed> {
  return rows.length <= 1 ? Effect.succeed(rows[0] ?? null) : Effect.fail(storageFailure());
}

function stringField(row: Row, name: string): string | null {
  const value = row[name];
  return typeof value === "string" ? value : null;
}

function integerField(row: Row, name: string): number | null {
  const value = row[name];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function attemptFromRow(row: Row): VerificationCompletionAttemptReservation | null {
  const attempt_id = stringField(row, "attempt_id");
  const lease_expires_at = dateField(row, "lease_expires_at");
  const fence_token = integerField(row, "fence_token");
  return attempt_id !== null && lease_expires_at !== null && fence_token !== null && fence_token > 0
    ? { attempt_id, fence_token, lease_expires_at }
    : null;
}

function dateField(row: Row, name: string): string | null {
  const value = row[name];
  let candidate: string | null = null;
  if (value instanceof Date && Number.isFinite(value.getTime())) candidate = value.toISOString();
  if (typeof value === "string") candidate = value;
  if (candidate === null) return null;
  const decoded = Schema.decodeUnknownOption(CanonicalIsoInstant)(candidate);
  return Option.isSome(decoded) ? decoded.value : null;
}

function optionalDateField(row: Row, name: string): string | undefined | null {
  return row[name] === null ? undefined : dateField(row, name);
}

function sessionFromRow(row: Row): StoredVerificationCompletion | null {
  const scopeKind = stringField(row, "scope_kind");
  const issuer = stringField(row, "issuer");
  const rpScope = stringField(row, "issuer_rp_scope");
  const actionScope = stringField(row, "issuer_rp_action_scope");
  const providerConfigurationKind = stringField(row, "provider_configuration_kind");
  const providerConfigurationReference = stringField(row, "provider_configuration_ref");
  const providerConfigurationVersion = stringField(row, "provider_configuration_version");
  if (
    issuer === null ||
    providerConfigurationKind === null ||
    providerConfigurationReference === null ||
    providerConfigurationVersion === null
  ) {
    return null;
  }
  const scope =
    scopeKind === "none"
      ? { kind: "none" as const, issuer }
      : scopeKind === "issuer_rp_scope" && rpScope !== null
        ? {
            kind: "named" as const,
            scope_semantics: "issuer_rp_scope" as const,
            issuer,
            rp_scope: rpScope,
          }
        : scopeKind === "issuer_rp_action_scope" && rpScope !== null && actionScope !== null
          ? {
              kind: "named" as const,
              scope_semantics: "issuer_rp_action_scope" as const,
              issuer,
              rp_scope: rpScope,
              action_scope: actionScope,
            }
          : null;
  const completedAt = optionalDateField(row, "completed_at");
  if (scope === null || completedAt === null) return null;
  const decoded = Schema.decodeUnknownOption(ProofSession)({
    id: row.proof_session_id,
    actor_id: row.actor_id,
    intent_id: row.intent_id,
    request_hash: row.request_hash,
    provider_id: row.provider_id,
    ...(row.upstream_session_ref === null
      ? {}
      : { upstream_session_ref: row.upstream_session_ref }),
    provider_configuration: {
      kind: providerConfigurationKind,
      reference: providerConfigurationReference,
      version: providerConfigurationVersion,
    },
    method: row.method,
    scope,
    request_mode: row.request_mode,
    requested_requirements: row.requested_requirements,
    requested_claim_ids: row.requested_claim_ids,
    subject_binding_intent: row.subject_binding_intent,
    protocol_version: row.protocol_version,
    environment: row.environment,
    status: row.status,
    started_at: dateField(row, "started_at"),
    expires_at: dateField(row, "expires_at"),
    ...(completedAt === undefined ? {} : { completed_at: completedAt }),
  });
  if (Option.isNone(decoded)) return null;
  if (decoded.value.status === "pending") {
    return row.completion_result_hash === null ? { session: decoded.value, terminal: null } : null;
  }
  const resultHash = stringField(row, "completion_result_hash");
  const idempotencyKey = stringField(row, "completion_idempotency_key");
  const decodedResultHash = Schema.decodeUnknownOption(Sha256Hex)(resultHash);
  return resultHash === null || idempotencyKey === null || Option.isNone(decodedResultHash)
    ? null
    : {
        session: decoded.value,
        terminal: {
          status: decoded.value.status,
          idempotency_key: idempotencyKey,
          result_hash: decodedResultHash.value,
        },
      };
}

const sessionColumns = `
  proof_session_id, actor_id, intent_id, request_hash, provider_id,
  provider_configuration_kind, provider_configuration_ref,
  provider_configuration_version, method, issuer,
  scope_kind, issuer_rp_scope, issuer_rp_action_scope, request_mode, requested_requirements,
  requested_claim_ids, upstream_session_ref,
  subject_binding_intent, protocol_version, environment, status, started_at,
  expires_at, completed_at, completion_idempotency_key, completion_result_hash`;

function loadSession(
  transaction: Transaction,
  proofSessionId: string,
  lock: boolean,
): Effect.Effect<
  StoredVerificationCompletion | null,
  VerificationCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: lock ? "verification.completion.lock-session" : "verification.completion.load-session",
      text: `SELECT ${sessionColumns}
               FROM proof_sessions
              WHERE proof_session_id = $1${lock ? " FOR UPDATE" : ""}`,
      values: [proofSessionId],
      readonly: !lock,
    });
    const row = yield* oneRow(result.rows);
    if (row === null) return null;
    const parsed = sessionFromRow(row);
    return parsed === null ? yield* Effect.fail(storageFailure()) : parsed;
  });
}

/**
 * Community-creation completion and commit both touch the actor, intent, and
 * proof session. Acquire those rows in the same order before completion locks
 * its session so the two transactions cannot form an intent/session cycle.
 * Generic verification sessions have no matching creation intent and pass
 * through without taking these additional locks.
 */
function prelockCommunityCreationCompletion(
  transaction: Transaction,
  input: Readonly<{ readonly actorId: string; readonly proofSessionId: string }>,
): Effect.Effect<void, VerificationCompletionStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const candidateResult = yield* transaction.execute<Row>({
      label: "verification.completion.prelock-creation-candidate",
      text: `SELECT intent.intent_id, intent.creation_contract_version,
                    attempt.ceremony_intent_id
               FROM proof_sessions AS session
               JOIN community_creation_ceremony_attempts AS attempt
                 ON attempt.ceremony_intent_id = session.creation_ceremony_intent_id
                AND attempt.actor_id = session.actor_id
                AND attempt.requirement_kind = 'human_identity'
               JOIN community_creation_intents AS intent
                 ON intent.intent_id = attempt.intent_id
                AND intent.actor_id = attempt.actor_id
                AND intent.creation_contract_version IN ('route_v1', 'optional_route_v2')
              WHERE session.proof_session_id = $1
                AND session.actor_id = $2`,
      values: [input.proofSessionId, input.actorId],
      readonly: false,
    });
    const candidate = yield* oneRow(candidateResult.rows);
    if (candidate === null) return;
    const intentId = stringField(candidate, "intent_id");
    const ceremonyIntentId = stringField(candidate, "ceremony_intent_id");
    const contractVersion = stringField(candidate, "creation_contract_version");
    if (
      intentId === null ||
      ceremonyIntentId === null ||
      (contractVersion !== "route_v1" && contractVersion !== "optional_route_v2")
    ) {
      return yield* Effect.fail(storageFailure());
    }

    const actorResult = yield* transaction.execute<Row>({
      label: "verification.completion.prelock-creation-actor",
      text: "SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE",
      values: [input.actorId],
      readonly: false,
    });
    const actor = yield* oneRow(actorResult.rows);
    if (actor === null || stringField(actor, "user_id") !== input.actorId) {
      return yield* Effect.fail(storageFailure());
    }

    const intentResult = yield* transaction.execute<Row>({
      label: "verification.completion.prelock-creation-intent",
      text: `SELECT intent_id
               FROM community_creation_intents
              WHERE intent_id = $1 AND actor_id = $2
              FOR UPDATE`,
      values: [intentId, input.actorId],
      readonly: false,
    });
    const intent = yield* oneRow(intentResult.rows);
    if (intent === null || stringField(intent, "intent_id") !== intentId) {
      return yield* Effect.fail(storageFailure());
    }
    const requirementsResult = yield* transaction.execute<Row>({
      label: "verification.completion.prelock-creation-requirements",
      text: `SELECT requirement_kind
               FROM community_creation_requirement_states
              WHERE intent_id = $1 AND actor_id = $2
              ORDER BY CASE requirement_kind
                WHEN 'human_identity' THEN 1
                WHEN 'namespace_ownership' THEN 2
              END
              FOR UPDATE`,
      values: [intentId, input.actorId],
      readonly: false,
    });
    const requirementsMatch =
      contractVersion === "optional_route_v2"
        ? requirementsResult.rows.length === 1 &&
          requirementsResult.rows[0]?.requirement_kind === "human_identity"
        : requirementsResult.rows.length === 2 &&
          requirementsResult.rows[0]?.requirement_kind === "human_identity" &&
          requirementsResult.rows[1]?.requirement_kind === "namespace_ownership";
    if (!requirementsMatch) {
      return yield* Effect.fail(storageFailure());
    }
    const attemptResult = yield* transaction.execute<Row>({
      label: "verification.completion.prelock-creation-attempt",
      text: `SELECT ceremony_intent_id
               FROM community_creation_ceremony_attempts
              WHERE ceremony_intent_id = $1
                AND actor_id = $2
                AND intent_id = $3
                AND requirement_kind = 'human_identity'
              FOR UPDATE`,
      values: [ceremonyIntentId, input.actorId, intentId],
      readonly: false,
    });
    const attempt = yield* oneRow(attemptResult.rows);
    if (attempt === null || stringField(attempt, "ceremony_intent_id") !== ceremonyIntentId) {
      return yield* Effect.fail(storageFailure());
    }
  });
}

function reserveAttemptInTransaction(
  transaction: Transaction,
  input: Parameters<VerificationCompletionStore["reserveAttempt"]>[0],
): Effect.Effect<
  VerificationCompletionAttemptReservationOutcome,
  VerificationCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    const sessionResult = yield* transaction.execute<Row>({
      label: "verification.completion-attempts.lock-session",
      text: `SELECT proof_session_id, status, expires_at
               FROM proof_sessions
              WHERE proof_session_id = $1
              FOR UPDATE`,
      values: [input.proof_session_id],
      readonly: false,
    });
    const sessionRow = yield* oneRow(sessionResult.rows);
    if (
      sessionRow === null ||
      stringField(sessionRow, "proof_session_id") !== input.proof_session_id
    ) {
      return { kind: "unavailable" } as const;
    }
    const status = stringField(sessionRow, "status");
    const expiresAt = dateField(sessionRow, "expires_at");
    if (status !== "pending" || expiresAt === null) {
      return { kind: "unavailable" } as const;
    }
    const sessionClockResult = yield* transaction.execute<Row>({
      label: "verification.completion-attempts.session-clock",
      text: "SELECT clock_timestamp() AS database_now",
      values: [],
      readonly: false,
    });
    const sessionClockRow = yield* oneRow(sessionClockResult.rows);
    const sessionNow = sessionClockRow === null ? null : dateField(sessionClockRow, "database_now");
    if (sessionNow === null) return yield* Effect.fail(storageFailure());
    if (Date.parse(expiresAt) <= Date.parse(sessionNow)) return { kind: "expired" } as const;

    const existingResult = yield* transaction.execute<Row>({
      label: "verification.completion-attempts.lock-idempotency",
      text: `SELECT attempt_id, state, fence_token, lease_expires_at
               FROM verification_completion_attempts
              WHERE proof_session_id = $1 AND idempotency_key = $2
              FOR UPDATE`,
      values: [input.proof_session_id, input.idempotency_key],
      readonly: false,
    });
    const existing = yield* oneRow(existingResult.rows);
    const attemptClockResult = yield* transaction.execute<Row>({
      label: "verification.completion-attempts.attempt-clock",
      text: "SELECT clock_timestamp() AS database_now",
      values: [],
      readonly: false,
    });
    const attemptClockRow = yield* oneRow(attemptClockResult.rows);
    const attemptNow = attemptClockRow === null ? null : dateField(attemptClockRow, "database_now");
    if (attemptNow === null) return yield* Effect.fail(storageFailure());
    if (existing !== null) {
      const state = stringField(existing, "state");
      if (state === "consumed") return { kind: "consumed" } as const;
      const leaseExpiresAt = dateField(existing, "lease_expires_at");
      if (
        state === "leased" &&
        leaseExpiresAt !== null &&
        Date.parse(leaseExpiresAt) > Date.parse(attemptNow)
      ) {
        const retryAfter = Math.ceil((Date.parse(leaseExpiresAt) - Date.parse(attemptNow)) / 1_000);
        return {
          kind: "in_flight",
          retry_after_seconds: Math.max(1, retryAfter),
        } as const;
      }
    }

    const consumedResult = yield* transaction.execute<Row>({
      label: "verification.completion-attempts.count-admission-and-spent",
      text: `SELECT
               count(*) FILTER (WHERE state = 'consumed')::integer AS consumed_count,
               count(*) FILTER (
                 WHERE state = 'leased' AND lease_expires_at > $2::timestamptz
               )::integer AS active_count,
               min(lease_expires_at) FILTER (
                 WHERE state = 'leased' AND lease_expires_at > $2::timestamptz
               ) AS next_lease_expires_at
               FROM verification_completion_attempts
              WHERE proof_session_id = $1`,
      values: [input.proof_session_id, attemptNow],
      readonly: true,
    });
    const consumedRow = yield* oneRow(consumedResult.rows);
    if (consumedRow === null) return yield* Effect.fail(storageFailure());
    const consumedCount = integerField(consumedRow, "consumed_count");
    const activeCount = integerField(consumedRow, "active_count");
    if (consumedCount === null || activeCount === null) {
      return yield* Effect.fail(storageFailure());
    }
    if (consumedCount >= input.max_consumed_attempts) {
      return { kind: "budget_exhausted" } as const;
    }
    if (consumedCount + activeCount >= input.max_consumed_attempts) {
      const nextLeaseExpiresAt = dateField(consumedRow, "next_lease_expires_at");
      if (nextLeaseExpiresAt === null) return yield* Effect.fail(storageFailure());
      const retryAfter = Math.ceil(
        (Date.parse(nextLeaseExpiresAt) - Date.parse(attemptNow)) / 1_000,
      );
      return {
        kind: "in_flight",
        retry_after_seconds: Math.max(1, retryAfter),
      } as const;
    }

    if (existing !== null) {
      const reacquired = yield* transaction.execute<Row>({
        label: "verification.completion-attempts.reacquire",
        text: `UPDATE verification_completion_attempts
                  SET state = 'leased', fence_token = fence_token + 1,
                      lease_expires_at = clock_timestamp() + ($2::double precision * INTERVAL '1 millisecond'),
                      updated_at = clock_timestamp()
                WHERE attempt_id = $1
                RETURNING attempt_id, fence_token, lease_expires_at`,
        values: [existing.attempt_id, input.lease_ms],
        readonly: false,
      });
      const reacquiredRow = yield* oneRow(reacquired.rows);
      const reservation = reacquiredRow === null ? null : attemptFromRow(reacquiredRow);
      return reservation === null
        ? yield* Effect.fail(storageFailure())
        : ({ kind: "acquired", reservation } as const);
    }

    const inserted = yield* transaction.execute<Row>({
      label: "verification.completion-attempts.insert",
      text: `INSERT INTO verification_completion_attempts (
               attempt_id, proof_session_id, idempotency_key, state,
               fence_token, lease_expires_at
             ) VALUES (
               $1, $2, $3, 'leased', 1,
               clock_timestamp() + ($4::double precision * INTERVAL '1 millisecond')
             )
             RETURNING attempt_id, fence_token, lease_expires_at`,
      values: [crypto.randomUUID(), input.proof_session_id, input.idempotency_key, input.lease_ms],
      readonly: false,
    });
    const insertedRow = yield* oneRow(inserted.rows);
    const reservation = insertedRow === null ? null : attemptFromRow(insertedRow);
    return reservation === null
      ? yield* Effect.fail(storageFailure())
      : ({ kind: "acquired", reservation } as const);
  });
}

function settleAttemptInTransaction(
  transaction: Transaction,
  reservation: VerificationCompletionAttemptReservation,
  state: "released" | "consumed",
): Effect.Effect<void, VerificationCompletionStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute({
      label: `verification.completion-attempts.${state}`,
      text: `UPDATE verification_completion_attempts
                SET state = $1, updated_at = clock_timestamp()
              WHERE attempt_id = $2 AND fence_token = $3 AND state = 'leased'`,
      values: [state, reservation.attempt_id, reservation.fence_token],
      readonly: false,
    });
    if (result.rowCount !== 0 && result.rowCount !== 1) return yield* Effect.fail(storageFailure());
  });
}

function lockAttempt(
  transaction: Transaction,
  reservation: VerificationCompletionAttemptReservation,
): Effect.Effect<Row | null, VerificationCompletionStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "verification.completion-attempts.lock-reservation",
      text: `SELECT attempt_id, state, fence_token, lease_expires_at
               FROM verification_completion_attempts
              WHERE attempt_id = $1
              FOR UPDATE`,
      values: [reservation.attempt_id],
      readonly: false,
    });
    return yield* oneRow(result.rows);
  });
}

function scopeColumns(scope: SubjectKey["scope"]): readonly [string, string, string | null] {
  return [
    scope.scope_semantics,
    scope.rp_scope,
    scope.scope_semantics === "issuer_rp_action_scope" ? scope.action_scope : null,
  ];
}

interface PersistedSubjectBinding {
  readonly subjectKeyId: string;
  readonly bindingEventId: string;
  readonly bindingEpoch: number;
}

function persistSubjectBinding(
  transaction: Transaction,
  input: {
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly session: StoredVerificationCompletion["session"];
    readonly subject: SubjectKey;
    readonly boundAt: string;
  },
): Effect.Effect<
  PersistedSubjectBinding,
  VerificationCompletionStorageFailed | ControlPlaneError | SubjectBindingConflict
> {
  return Effect.gen(function* () {
    const [scopeKind, rpScope, actionScope] = scopeColumns(input.subject.scope);
    const candidateId = `subject-key-${crypto.randomUUID()}`;
    yield* transaction.execute({
      label: "verification.subject-keys.ensure",
      text: `INSERT INTO subject_keys (
               subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
               issuer_rp_action_scope, subject_digest, digest_algorithm
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'sha256')
             ON CONFLICT DO NOTHING`,
      values: [
        candidateId,
        input.subject.issuer,
        input.subject.method,
        scopeKind,
        rpScope,
        actionScope,
        input.subject.subject_digest,
      ],
      readonly: false,
    });
    const subjectResult = yield* transaction.execute<Row>({
      label: "verification.subject-keys.lock-stable-identity",
      text: `SELECT subject_key_id
               FROM subject_keys
              WHERE issuer = $1
                AND method = $2
                AND scope_kind = $3
                AND issuer_rp_scope = $4
                AND issuer_rp_action_scope IS NOT DISTINCT FROM $5
                AND subject_digest = $6
              FOR UPDATE`,
      values: [
        input.subject.issuer,
        input.subject.method,
        scopeKind,
        rpScope,
        actionScope,
        input.subject.subject_digest,
      ],
      readonly: false,
    });
    const subjectRow = yield* oneRow(subjectResult.rows);
    const subjectKeyId = subjectRow === null ? null : stringField(subjectRow, "subject_key_id");
    if (subjectKeyId === null) return yield* Effect.fail(storageFailure());

    const activeResult = yield* transaction.execute<Row>({
      label: "verification.subject-bindings.lock-active",
      text: `SELECT binding_event_id, binding_epoch, user_id
               FROM active_subject_key_bindings
              WHERE subject_key_id = $1
              FOR UPDATE`,
      values: [subjectKeyId],
      readonly: false,
    });
    const active = yield* oneRow(activeResult.rows);
    if (active === null) {
      if (input.session.subject_binding_intent !== "establish") {
        return yield* Effect.fail(new SubjectBindingConflict());
      }
      const bindingEventId = `subject-binding-${crypto.randomUUID()}`;
      yield* transaction.execute({
        label: "verification.subject-bindings.insert-initial",
        text: `INSERT INTO subject_key_binding_events (
                 binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
                 binding_kind, previous_binding_event_id, idempotency_key, bound_at
               ) VALUES ($1, $2, 1, $3, $4, 'initial', NULL, $5, $6)`,
        values: [
          bindingEventId,
          subjectKeyId,
          input.actorId,
          input.session.id,
          `${input.idempotencyKey}:${input.subject.id}`,
          input.boundAt,
        ],
        readonly: false,
      });
      return { subjectKeyId, bindingEventId, bindingEpoch: 1 };
    }

    const activeEventId = stringField(active, "binding_event_id");
    const activeUserId = stringField(active, "user_id");
    const rawEpoch = active.binding_epoch;
    const activeEpoch =
      typeof rawEpoch === "number"
        ? rawEpoch
        : typeof rawEpoch === "string" && /^\d+$/u.test(rawEpoch)
          ? Number(rawEpoch)
          : Number.NaN;
    if (activeEventId === null || activeUserId === null || !Number.isSafeInteger(activeEpoch)) {
      return yield* Effect.fail(storageFailure());
    }
    if (activeUserId === input.actorId) {
      if (input.session.subject_binding_intent === "recover") {
        return yield* Effect.fail(new SubjectBindingConflict());
      }
      return { subjectKeyId, bindingEventId: activeEventId, bindingEpoch: activeEpoch };
    }
    if (input.session.subject_binding_intent !== "recover") {
      return yield* Effect.fail(new SubjectBindingConflict());
    }

    const bindingEventId = `subject-binding-${crypto.randomUUID()}`;
    const bindingEpoch = activeEpoch + 1;
    yield* transaction.execute({
      label: "verification.subject-bindings.insert-recovery",
      text: `INSERT INTO subject_key_binding_events (
               binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
               binding_kind, previous_binding_event_id, idempotency_key, bound_at
             ) VALUES ($1, $2, $3, $4, $5, 'recovery', $6, $7, $8)`,
      values: [
        bindingEventId,
        subjectKeyId,
        bindingEpoch,
        input.actorId,
        input.session.id,
        activeEventId,
        `${input.idempotencyKey}:${input.subject.id}`,
        input.boundAt,
      ],
      readonly: false,
    });
    return { subjectKeyId, bindingEventId, bindingEpoch };
  });
}

function sessionIdentityMatches(
  actual: StoredVerificationCompletion["session"],
  expected: StoredVerificationCompletion["session"],
): boolean {
  return (
    actual.id === expected.id &&
    actual.actor_id === expected.actor_id &&
    actual.intent_id === expected.intent_id &&
    actual.request_hash === expected.request_hash &&
    actual.provider_id === expected.provider_id &&
    actual.upstream_session_ref === expected.upstream_session_ref &&
    actual.provider_configuration.kind === expected.provider_configuration.kind &&
    actual.provider_configuration.reference === expected.provider_configuration.reference &&
    actual.provider_configuration.version === expected.provider_configuration.version &&
    actual.method === expected.method &&
    actual.protocol_version === expected.protocol_version &&
    actual.environment === expected.environment &&
    actual.subject_binding_intent === expected.subject_binding_intent &&
    actual.request_mode === expected.request_mode &&
    JSON.stringify(actual.scope) === JSON.stringify(expected.scope) &&
    JSON.stringify(actual.requested_requirements) ===
      JSON.stringify(expected.requested_requirements) &&
    JSON.stringify(actual.requested_claim_ids) === JSON.stringify(expected.requested_claim_ids)
  );
}

export function makeControlPlaneVerificationCompletionRepository() {
  return {
    load: ({ proof_session_id }: { readonly proof_session_id: string }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* loadSession(db, proof_session_id, false);
      }),
    reserveAttempt: (input: Parameters<VerificationCompletionStore["reserveAttempt"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          reserveAttemptInTransaction(transaction, input),
        );
      }),
    releaseAttempt: (reservation: VerificationCompletionAttemptReservation) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          settleAttemptInTransaction(transaction, reservation, "released"),
        );
      }),
    consumeAttempt: (reservation: VerificationCompletionAttemptReservation) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          settleAttemptInTransaction(transaction, reservation, "consumed"),
        );
      }),
    settleCompleted: (input: Parameters<VerificationCompletionStore["settleCompleted"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* prelockCommunityCreationCompletion(transaction, {
              actorId: input.actor_id,
              proofSessionId: input.proof_session_id,
            });
            const stored = yield* loadSession(transaction, input.proof_session_id, true);
            if (
              stored === null ||
              stored.session.actor_id !== input.actor_id ||
              stored.terminal?.status !== "completed" ||
              stored.terminal.idempotency_key !== input.idempotency_key ||
              stored.terminal.result_hash !== input.result_hash
            ) {
              return yield* Effect.fail(storageFailure());
            }
            yield* advanceCommunityCreationVerificationInTransaction(transaction, {
              actor_id: input.actor_id,
              proof_session_id: input.proof_session_id,
              result_hash: input.result_hash,
            });
          }),
        );
      }),
    commit: (input: Parameters<VerificationCompletionStore["commit"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db
          .withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* prelockCommunityCreationCompletion(transaction, {
                actorId: input.actor_id,
                proofSessionId: input.expected_session.id,
              });
              const stored = yield* loadSession(transaction, input.expected_session.id, true);
              if (stored === null || stored.session.actor_id !== input.actor_id) {
                return { kind: "rejected", reason: "unavailable" } as const;
              }
              if (stored.terminal !== null) {
                const attemptRow = yield* lockAttempt(transaction, input.attempt);
                const attemptFence =
                  attemptRow === null ? null : integerField(attemptRow, "fence_token");
                const attemptState = attemptRow === null ? null : stringField(attemptRow, "state");
                const exactReplay =
                  stored.terminal.status === "completed" &&
                  stored.terminal.idempotency_key === input.idempotency_key &&
                  stored.terminal.result_hash === input.result_hash;
                if (exactReplay) {
                  yield* advanceCommunityCreationVerificationInTransaction(transaction, {
                    actor_id: input.actor_id,
                    proof_session_id: stored.session.id,
                    result_hash: input.result_hash,
                  });
                }
                if (attemptFence === input.attempt.fence_token && attemptState === "leased") {
                  yield* settleAttemptInTransaction(transaction, input.attempt, "consumed");
                }
                return exactReplay
                  ? ({ kind: "replay", result_hash: stored.terminal.result_hash } as const)
                  : ({
                      kind: "rejected",
                      reason: stored.terminal.status === "expired" ? "expired" : "terminal",
                    } as const);
              }
              if (!sessionIdentityMatches(stored.session, input.expected_session)) {
                return { kind: "rejected", reason: "unavailable" } as const;
              }
              const clockResult = yield* transaction.execute<Row>({
                label: "verification.completion.database-clock",
                text: "SELECT clock_timestamp() AS database_now",
                values: [],
                readonly: false,
              });
              const clockRow = yield* oneRow(clockResult.rows);
              const completedAt = clockRow === null ? null : dateField(clockRow, "database_now");
              if (
                completedAt === null ||
                Date.parse(stored.session.expires_at) <= Date.parse(completedAt)
              ) {
                return { kind: "rejected", reason: "expired" } as const;
              }
              const attemptRow = yield* lockAttempt(transaction, input.attempt);
              const attemptFence =
                attemptRow === null ? null : integerField(attemptRow, "fence_token");
              const attemptState = attemptRow === null ? null : stringField(attemptRow, "state");
              const attemptLease =
                attemptRow === null ? null : dateField(attemptRow, "lease_expires_at");
              if (
                attemptRow === null ||
                attemptFence !== input.attempt.fence_token ||
                attemptState !== "leased" ||
                attemptLease === null
              ) {
                return { kind: "rejected", reason: "unavailable" } as const;
              }
              if (Date.parse(attemptLease) <= Date.parse(completedAt)) {
                return { kind: "rejected", reason: "unavailable" } as const;
              }
              if (
                (stored.session.subject_binding_intent === "none") !==
                (input.bundle.subject_keys.length === 0)
              ) {
                return yield* Effect.fail(storageFailure());
              }

              const subjects = new Map<string, PersistedSubjectBinding>();
              for (const subject of input.bundle.subject_keys) {
                const persisted = yield* persistSubjectBinding(transaction, {
                  actorId: input.actor_id,
                  idempotencyKey: input.idempotency_key,
                  session: stored.session,
                  subject,
                  boundAt: completedAt,
                });
                subjects.set(subject.id, persisted);
              }

              const receipts = new Map<string, string>();
              for (const receipt of input.bundle.receipts) {
                const receiptId = `evidence-receipt-${crypto.randomUUID()}`;
                const subject =
                  receipt.subject_key_id === undefined
                    ? undefined
                    : subjects.get(receipt.subject_key_id);
                if (receipt.subject_key_id !== undefined && subject === undefined) {
                  return yield* Effect.fail(storageFailure());
                }
                const scope = receipt.scope;
                const scopeKind = scope.kind === "none" ? "none" : scope.scope_semantics;
                const rpScope = scope.kind === "named" ? scope.rp_scope : null;
                const actionScope =
                  scope.kind === "named" && scope.scope_semantics === "issuer_rp_action_scope"
                    ? scope.action_scope
                    : null;
                yield* transaction.execute({
                  label: "verification.evidence-receipts.insert",
                  text: `INSERT INTO evidence_receipts (
                           evidence_receipt_id, proof_session_id, user_id, provider_id,
                           provider_configuration_kind, provider_configuration_ref,
                           provider_configuration_version, issuer, method, scope_kind,
                           issuer_rp_scope, issuer_rp_action_scope,
                           protocol_version, environment, evidence_kind, evidence_hash,
                           receipt_metadata, observed_at, expires_at, provenance_kind,
                           subject_key_id, subject_binding_event_id, subject_binding_epoch
                         ) VALUES (
                           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                           $14, $15, $16, $17::jsonb, $18, $19, 'proof_session',
                           $20, $21, $22
                         )`,
                  values: [
                    receiptId,
                    stored.session.id,
                    input.actor_id,
                    receipt.provider_id,
                    receipt.provider_configuration.kind,
                    receipt.provider_configuration.reference,
                    receipt.provider_configuration.version,
                    receipt.issuer,
                    receipt.method,
                    scopeKind,
                    rpScope,
                    actionScope,
                    receipt.protocol_version,
                    receipt.environment,
                    receipt.evidence_kind,
                    receipt.evidence_hash,
                    JSON.stringify(receipt.metadata ?? {}),
                    receipt.observed_at,
                    receipt.expires_at ?? null,
                    subject?.subjectKeyId ?? null,
                    subject?.bindingEventId ?? null,
                    subject?.bindingEpoch ?? null,
                  ],
                  readonly: false,
                });
                receipts.set(receipt.id, receiptId);
              }

              const bindings = new Map<string, string>();
              for (const binding of input.bundle.binding_groups) {
                const bindingId = `assertion-binding-${crypto.randomUUID()}`;
                const subject =
                  binding.kind === "same_subject"
                    ? subjects.get(binding.subject_key_id)
                    : undefined;
                const receiptId =
                  binding.kind === "same_receipt"
                    ? receipts.get(binding.evidence_receipt_id)
                    : undefined;
                if (
                  (binding.kind === "same_subject" && subject === undefined) ||
                  (binding.kind === "same_receipt" && receiptId === undefined)
                ) {
                  return yield* Effect.fail(storageFailure());
                }
                yield* transaction.execute({
                  label: "verification.assertion-bindings.insert",
                  text: `INSERT INTO assertion_bindings (
                           binding_group_id, user_id, binding_mode, subject_key_id,
                           evidence_receipt_id, subject_binding_event_id, subject_binding_epoch
                         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                  values: [
                    bindingId,
                    input.actor_id,
                    binding.kind,
                    subject?.subjectKeyId ?? null,
                    receiptId ?? null,
                    subject?.bindingEventId ?? null,
                    subject?.bindingEpoch ?? null,
                  ],
                  readonly: false,
                });
                bindings.set(binding.id, bindingId);
              }

              for (const assertion of input.bundle.assertions) {
                const receiptId = receipts.get(assertion.evidence_receipt_id);
                const bindingId = bindings.get(assertion.binding_group_id);
                const subject =
                  assertion.subject_key_id === undefined
                    ? undefined
                    : subjects.get(assertion.subject_key_id);
                if (
                  receiptId === undefined ||
                  bindingId === undefined ||
                  (assertion.subject_key_id !== undefined && subject === undefined)
                ) {
                  return yield* Effect.fail(storageFailure());
                }
                yield* transaction.execute({
                  label: "verification.assertions.insert",
                  text: `INSERT INTO assertions (
                           assertion_id, binding_group_id, evidence_receipt_id, subject_key_id,
                           user_id, claim_id, assertion_value, assurance, observed_at, expires_at
                         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
                  values: [
                    `assertion-${crypto.randomUUID()}`,
                    bindingId,
                    receiptId,
                    subject?.subjectKeyId ?? null,
                    input.actor_id,
                    assertion.claim_id,
                    JSON.stringify(assertion.value),
                    assertion.assurance,
                    assertion.observed_at,
                    assertion.expires_at ?? null,
                  ],
                  readonly: false,
                });
              }

              const updated = yield* transaction.execute({
                label: "verification.proof-sessions.complete",
                text: `UPDATE proof_sessions
                          SET status = 'completed', completion_idempotency_key = $1,
                              completion_result_hash = $2, terminal_at = final_clock.terminal_at,
                              completed_at = final_clock.terminal_at,
                              updated_at = final_clock.terminal_at
                         FROM (SELECT clock_timestamp() AS terminal_at) AS final_clock
                        WHERE proof_session_id = $3 AND actor_id = $4 AND status = 'pending'
                          AND expires_at > final_clock.terminal_at`,
                values: [
                  input.idempotency_key,
                  input.result_hash,
                  stored.session.id,
                  input.actor_id,
                ],
                readonly: false,
              });
              if (updated.rowCount === 0) {
                return yield* Effect.fail(new VerificationCompletionExpired());
              }
              if (updated.rowCount !== 1) {
                return yield* Effect.fail(storageFailure());
              }
              yield* advanceCommunityCreationVerificationInTransaction(transaction, {
                actor_id: input.actor_id,
                proof_session_id: stored.session.id,
                result_hash: input.result_hash,
              });
              yield* settleAttemptInTransaction(transaction, input.attempt, "consumed");
              yield* transaction.execute({
                label: "verification.proof-session-completions.insert",
                text: `INSERT INTO proof_session_completion_events (
                         completion_event_id, proof_session_id, actor_id, idempotency_key,
                         terminal_status, result_hash, terminal_at
                       )
                       SELECT $1, proof_session_id, actor_id, completion_idempotency_key,
                              status, completion_result_hash, terminal_at
                         FROM proof_sessions
                        WHERE proof_session_id = $2 AND actor_id = $3`,
                values: [
                  `proof-completion-${crypto.randomUUID()}`,
                  stored.session.id,
                  input.actor_id,
                ],
                readonly: false,
              });
              return { kind: "committed", result_hash: input.result_hash } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SubjectBindingConflict", () =>
              Effect.succeed({ kind: "rejected", reason: "binding_conflict" } as const),
            ),
            Effect.catchTag("VerificationCompletionExpired", () =>
              Effect.succeed({ kind: "rejected", reason: "expired" } as const),
            ),
          );
      }),
  };
}

export function makeControlPlaneVerificationCompletionStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VerificationCompletionStore {
  const repository = makeControlPlaneVerificationCompletionRepository();
  const provide = <A, E>(
    effect: Effect.Effect<A, E, ControlPlaneDb>,
  ): Effect.Effect<A, VerificationCompletionStorageFailed> =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(() => storageFailure()));
  return {
    load: (input) => provide(repository.load(input)),
    reserveAttempt: (input) => provide(repository.reserveAttempt(input)),
    releaseAttempt: (reservation) => provide(repository.releaseAttempt(reservation)),
    consumeAttempt: (reservation) => provide(repository.consumeAttempt(reservation)),
    settleCompleted: (input) => provide(repository.settleCompleted(input)),
    commit: (input) => provide(repository.commit(input)),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function makeSha256VerificationCompletionHasher(): VerificationCompletionHasher {
  return {
    hash: (bundle: EvidenceBundle) =>
      Effect.tryPromise({
        try: async () => {
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(canonicalJson(bundle)),
          );
          return [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        },
        catch: () => new VerificationCompletionHashFailed(),
      }),
  };
}
