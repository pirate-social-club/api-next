import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneTransaction,
  type NamespaceOwnershipCompletionAttemptReservation,
  type NamespaceOwnershipCompletionFinalizeOutcome,
  type NamespaceOwnershipCompletionReleaseOutcome,
  type NamespaceOwnershipCompletionReservationOutcome,
  NamespaceOwnershipCompletionStorageFailed,
  type NamespaceOwnershipCompletionStore,
  NamespaceOwnershipSession,
  type NamespaceOwnershipStoredCompletion,
} from "@pirate/application";
import { ProviderConfigurationRef, Sha256Hex } from "@pirate/domain/verification";
import { Effect, type Layer, Option, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;

const exactParseOptions = { onExcessProperty: "error" } as const;
const storageFailure = (): NamespaceOwnershipCompletionStorageFailed =>
  new NamespaceOwnershipCompletionStorageFailed();

function oneRow<RowType>(result: ControlPlaneResult<RowType>): RowType | null | undefined {
  if (result.rows.length > 1) return undefined;
  return result.rows[0] ?? null;
}

function stringValue(row: Row, name: string): string | null {
  return typeof row[name] === "string" ? row[name] : null;
}

function optionalStringValue(row: Row, name: string): string | null {
  return row[name] === null || row[name] === undefined ? null : stringValue(row, name);
}

function safeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function timestampValue(row: Row, name: string): string | null {
  const raw = row[name];
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.toISOString();
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(Date.parse(raw)).toISOString();
}

function validIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 512 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
  );
}

function validHash(value: string): boolean {
  return Option.isSome(Schema.decodeUnknownOption(Sha256Hex)(value));
}

const completionColumns = `
  ns.namespace_session_id,
  ns.actor_id,
  ns.creation_intent_id,
  ns.ceremony_intent_id,
  ns.expected_revision,
  ns.generation,
  ns.requirement_hash,
  ns.request_hash,
  ns.provider_id,
  ns.provider_binding_hash,
  ns.provider_configuration_kind,
  ns.provider_configuration_ref,
  ns.provider_configuration_version,
  ns.protocol_version,
  ns.environment,
  ns.route_family,
  ns.route_root_label,
  ns.route_root_label_display,
  ns.route_path_segment,
  ns.route_href,
  ns.route_app_host,
  ns.upstream_session_ref,
  ns.status,
  ns.expires_at,
  result.callback_idempotency_key,
  result.callback_request_hash,
  result.outcome_status,
  result.result_hash`;

function storedFromRow(row: Row): NamespaceOwnershipStoredCompletion | null {
  const providerConfiguration = Schema.decodeUnknownOption(
    ProviderConfigurationRef,
    exactParseOptions,
  )({
    kind: row.provider_configuration_kind,
    reference: row.provider_configuration_ref,
    version: row.provider_configuration_version,
  });
  if (Option.isNone(providerConfiguration)) return null;
  const session = Schema.decodeUnknownOption(
    NamespaceOwnershipSession,
    exactParseOptions,
  )({
    actor_id: row.actor_id,
    creation_intent_id: row.creation_intent_id,
    ceremony_intent_id: row.ceremony_intent_id,
    requirement_hash: row.requirement_hash,
    generation: safeInteger(row.generation),
    request_hash: row.request_hash,
    provider_id: row.provider_id,
    provider_binding_hash: row.provider_binding_hash,
    provider_configuration: providerConfiguration.value,
    protocol_version: row.protocol_version,
    environment: row.environment,
    route: {
      family: row.route_family,
      root_label: row.route_root_label,
      root_label_display: row.route_root_label_display,
      path_segment: row.route_path_segment,
      href: row.route_href,
      app_host: optionalStringValue(row, "route_app_host"),
    },
    upstream_session_ref: row.upstream_session_ref,
    expires_at: timestampValue(row, "expires_at"),
  });
  const namespaceSessionId = stringValue(row, "namespace_session_id");
  const revision = safeInteger(row.expected_revision);
  const status = stringValue(row, "status");
  if (
    Option.isNone(session) ||
    namespaceSessionId === null ||
    revision === null ||
    revision <= 0 ||
    (status !== "pending" && status !== "completed" && status !== "failed" && status !== "expired")
  ) {
    return null;
  }
  const outcome = optionalStringValue(row, "outcome_status");
  const resultHash = optionalStringValue(row, "result_hash");
  const idempotencyKey = optionalStringValue(row, "callback_idempotency_key");
  const requestHash = optionalStringValue(row, "callback_request_hash");
  if (status === "pending") {
    return outcome === null &&
      resultHash === null &&
      idempotencyKey === null &&
      requestHash === null
      ? {
          namespace_session_id: namespaceSessionId,
          revision,
          session: session.value,
          status,
          terminal: null,
        }
      : null;
  }
  const expectedOutcome =
    status === "completed" ? "satisfied" : status === "failed" ? "failed" : "expired";
  const publicStatus =
    status === "completed" ? "verified" : status === "failed" ? "rejected" : "expired";
  if (
    outcome !== expectedOutcome ||
    resultHash === null ||
    idempotencyKey === null ||
    requestHash === null ||
    !validHash(resultHash) ||
    !validHash(requestHash)
  ) {
    return null;
  }
  return {
    namespace_session_id: namespaceSessionId,
    revision,
    session: session.value,
    status,
    terminal: {
      status: publicStatus,
      idempotency_key: idempotencyKey,
      completion_request_hash: requestHash,
      result_hash: resultHash,
    },
  };
}

function loadStored(
  transaction: Transaction,
  input: {
    readonly actor_id: string;
    readonly ceremony_intent_id: string;
    readonly session_id: string;
  },
  lock: boolean,
): Effect.Effect<
  NamespaceOwnershipStoredCompletion | null,
  NamespaceOwnershipCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: lock
        ? "namespace-ownership.completion.lock-session"
        : "namespace-ownership.completion.load-session",
      text: `SELECT ${completionColumns}
               FROM namespace_ownership_sessions AS ns
               LEFT JOIN community_creation_ceremony_results AS result
                 ON result.namespace_session_id = ns.namespace_session_id
              WHERE ns.actor_id = $1
                AND ns.ceremony_intent_id = $2
                AND ns.namespace_session_id = $3${lock ? " FOR UPDATE OF ns" : ""}`,
      values: [input.actor_id, input.ceremony_intent_id, input.session_id],
      readonly: !lock,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    if (row === null) return null;
    const stored = storedFromRow(row);
    return stored === null ? yield* Effect.fail(storageFailure()) : stored;
  });
}

type LockedAuthority = Readonly<{
  readonly stored: NamespaceOwnershipStoredCompletion;
  readonly intent_revision: number;
  readonly intent_status: string;
  readonly intent_active: boolean;
  readonly requirement_status: string;
}>;

function lockAuthority(
  transaction: Transaction,
  input: {
    readonly actor_id: string;
    readonly ceremony_intent_id: string;
    readonly session_id: string;
  },
): Effect.Effect<
  LockedAuthority | null,
  NamespaceOwnershipCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    const candidateResult = yield* transaction.execute<Row>({
      label: "namespace-ownership.completion.find-authority",
      text: `SELECT creation_intent_id
               FROM namespace_ownership_sessions
              WHERE namespace_session_id = $1
                AND actor_id = $2
                AND ceremony_intent_id = $3`,
      values: [input.session_id, input.actor_id, input.ceremony_intent_id],
      readonly: false,
    });
    const candidate = oneRow(candidateResult);
    if (candidate === undefined) return yield* Effect.fail(storageFailure());
    if (candidate === null) return null;
    const intentId = stringValue(candidate, "creation_intent_id");
    if (intentId === null) return yield* Effect.fail(storageFailure());

    const actor = yield* transaction.execute<Row>({
      label: "namespace-ownership.completion.lock-actor",
      text: "SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE",
      values: [input.actor_id],
      readonly: false,
    });
    if (oneRow(actor) === null) return null;
    const intent = yield* transaction.execute<Row>({
      label: "namespace-ownership.completion.lock-intent",
      text: `SELECT revision, status, expires_at > clock_timestamp() AS active
               FROM community_creation_intents
              WHERE intent_id = $1 AND actor_id = $2
              FOR UPDATE`,
      values: [intentId, input.actor_id],
      readonly: false,
    });
    const intentRow = oneRow(intent);
    if (intentRow === undefined) return yield* Effect.fail(storageFailure());
    if (intentRow === null) return null;
    const requirement = yield* transaction.execute<Row>({
      label: "namespace-ownership.completion.lock-requirement",
      text: `SELECT status, generation, current_ceremony_intent_id, requirement_hash,
                    provider_id, provider_binding_hash, provider_configuration_kind,
                    provider_configuration_ref, provider_configuration_version,
                    route_family, route_root_label, route_root_label_display, route_path_segment
               FROM community_creation_requirement_states
              WHERE intent_id = $1 AND actor_id = $2
                AND requirement_kind = 'namespace_ownership'
              FOR UPDATE`,
      values: [intentId, input.actor_id],
      readonly: false,
    });
    const requirementRow = oneRow(requirement);
    if (requirementRow === undefined) return yield* Effect.fail(storageFailure());
    if (requirementRow === null) return null;
    const ceremony = yield* transaction.execute<Row>({
      label: "namespace-ownership.completion.lock-ceremony",
      text: `SELECT generation, requirement_hash, provider_id, provider_binding_hash,
                    provider_configuration_kind, provider_configuration_ref,
                    provider_configuration_version, route_family, route_root_label,
                    route_root_label_display, route_path_segment
               FROM community_creation_ceremony_attempts
              WHERE ceremony_intent_id = $1 AND actor_id = $2 AND intent_id = $3
              FOR SHARE`,
      values: [input.ceremony_intent_id, input.actor_id, intentId],
      readonly: false,
    });
    const ceremonyRow = oneRow(ceremony);
    if (ceremonyRow === undefined) return yield* Effect.fail(storageFailure());
    if (ceremonyRow === null) return null;
    const stored = yield* loadStored(transaction, input, true);
    if (stored === null) return null;
    const intentRevision = safeInteger(intentRow.revision);
    const requirementGeneration = safeInteger(requirementRow.generation);
    const ceremonyGeneration = safeInteger(ceremonyRow.generation);
    const sameBinding =
      requirementGeneration === stored.session.generation &&
      ceremonyGeneration === stored.session.generation &&
      requirementRow.current_ceremony_intent_id === stored.session.ceremony_intent_id &&
      requirementRow.requirement_hash === stored.session.requirement_hash &&
      ceremonyRow.requirement_hash === stored.session.requirement_hash &&
      requirementRow.provider_id === stored.session.provider_id &&
      ceremonyRow.provider_id === stored.session.provider_id &&
      requirementRow.provider_binding_hash === stored.session.provider_binding_hash &&
      ceremonyRow.provider_binding_hash === stored.session.provider_binding_hash &&
      requirementRow.provider_configuration_kind === stored.session.provider_configuration.kind &&
      ceremonyRow.provider_configuration_kind === stored.session.provider_configuration.kind &&
      requirementRow.provider_configuration_ref ===
        stored.session.provider_configuration.reference &&
      ceremonyRow.provider_configuration_ref === stored.session.provider_configuration.reference &&
      requirementRow.provider_configuration_version ===
        stored.session.provider_configuration.version &&
      ceremonyRow.provider_configuration_version ===
        stored.session.provider_configuration.version &&
      requirementRow.route_family === stored.session.route.family &&
      ceremonyRow.route_family === stored.session.route.family &&
      requirementRow.route_root_label === stored.session.route.root_label &&
      ceremonyRow.route_root_label === stored.session.route.root_label &&
      requirementRow.route_root_label_display === stored.session.route.root_label_display &&
      ceremonyRow.route_root_label_display === stored.session.route.root_label_display &&
      requirementRow.route_path_segment === stored.session.route.path_segment &&
      ceremonyRow.route_path_segment === stored.session.route.path_segment;
    if (intentRevision === null || !sameBinding) return yield* Effect.fail(storageFailure());
    const intentStatus = stringValue(intentRow, "status");
    const requirementStatus = stringValue(requirementRow, "status");
    if (intentStatus === null || requirementStatus === null)
      return yield* Effect.fail(storageFailure());
    return {
      stored,
      intent_revision: intentRevision,
      intent_status: intentStatus,
      intent_active: intentRow.active === true,
      requirement_status: requirementStatus,
    };
  });
}

function databaseNow(
  transaction: Transaction,
): Effect.Effect<string, NamespaceOwnershipCompletionStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.completion.database-now",
      text: "SELECT clock_timestamp() AS database_now",
      values: [],
      readonly: false,
    });
    const row = oneRow(result);
    const value = row === undefined || row === null ? null : timestampValue(row, "database_now");
    return value === null ? yield* Effect.fail(storageFailure()) : value;
  });
}

function reservationFromRow(
  row: Row,
  ceremonyIntentId: string,
): NamespaceOwnershipCompletionAttemptReservation | null {
  const completionAttemptId = stringValue(row, "completion_attempt_id");
  const namespaceSessionId = stringValue(row, "namespace_session_id");
  const actorId = stringValue(row, "actor_id");
  const evidenceRef = stringValue(row, "evidence_ref");
  const fenceToken = safeInteger(row.fence_token);
  const leaseExpiresAt = timestampValue(row, "lease_expires_at");
  return completionAttemptId !== null &&
    namespaceSessionId !== null &&
    actorId !== null &&
    evidenceRef !== null &&
    fenceToken !== null &&
    fenceToken > 0 &&
    leaseExpiresAt !== null
    ? {
        completion_attempt_id: completionAttemptId,
        namespace_session_id: namespaceSessionId,
        actor_id: actorId,
        ceremony_intent_id: ceremonyIntentId,
        evidence_ref: evidenceRef,
        fence_token: fenceToken,
        lease_expires_at: leaseExpiresAt,
      }
    : null;
}

const attemptColumns = `completion_attempt_id, namespace_session_id, actor_id,
  evidence_ref, fence_token, lease_expires_at`;

function insertTerminalResult(
  transaction: Transaction,
  input: {
    readonly stored: NamespaceOwnershipStoredCompletion;
    readonly attempt_id: string | null;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
    readonly outcome: "satisfied" | "failed" | "expired";
    readonly result_hash: string;
    readonly terminal_at: string;
    readonly evidence_ref: string | null;
    readonly evidence_digest: string | null;
    readonly provider_identity_digest: string | null;
  },
): Effect.Effect<void, NamespaceOwnershipCompletionStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute({
      label: "namespace-ownership.completion.insert-result",
      text: `INSERT INTO community_creation_ceremony_results (
               ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
               requirement_hash, provider_id, provider_binding_hash,
               provider_configuration_version, callback_idempotency_key,
               callback_request_hash, outcome_status, result_hash, evidence_ref,
               evidence_digest, provider_identity_digest, terminal_at, satisfied_at,
               namespace_session_id, completion_attempt_id, submission_channel
             ) VALUES (
               $1, $2, $3, 'namespace_ownership', $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14, $15, $16,
               CASE WHEN $11 = 'satisfied' THEN $16::timestamptz ELSE NULL END,
               $17, $18, 'poll_result'
             ) ON CONFLICT (ceremony_intent_id) DO NOTHING`,
      values: [
        input.stored.session.ceremony_intent_id,
        input.stored.session.actor_id,
        input.stored.session.creation_intent_id,
        input.stored.session.generation,
        input.stored.session.requirement_hash,
        input.stored.session.provider_id,
        input.stored.session.provider_binding_hash,
        input.stored.session.provider_configuration.version,
        input.idempotency_key,
        input.completion_request_hash,
        input.outcome,
        input.result_hash,
        input.evidence_ref,
        input.evidence_digest,
        input.provider_identity_digest,
        input.terminal_at,
        input.stored.namespace_session_id,
        input.attempt_id,
      ],
      readonly: false,
    });
    if (result.rowCount !== 1) return yield* Effect.fail(storageFailure());
  });
}

function transitionTerminal(
  transaction: Transaction,
  input: {
    readonly stored: NamespaceOwnershipStoredCompletion;
    readonly outcome: "satisfied" | "failed" | "expired";
    readonly terminal_at: string;
  },
): Effect.Effect<void, NamespaceOwnershipCompletionStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const requirement = yield* transaction.execute({
      label: "namespace-ownership.completion.transition-requirement",
      text: `UPDATE community_creation_requirement_states
                SET status = $1,
                    satisfied_at = CASE WHEN $1 = 'satisfied' THEN $2::timestamptz ELSE NULL END,
                    updated_at = $2::timestamptz
              WHERE intent_id = $3 AND actor_id = $4
                AND requirement_kind = 'namespace_ownership'
                AND status = 'pending' AND generation = $5
                AND current_ceremony_intent_id = $6`,
      values: [
        input.outcome,
        input.terminal_at,
        input.stored.session.creation_intent_id,
        input.stored.session.actor_id,
        input.stored.session.generation,
        input.stored.session.ceremony_intent_id,
      ],
      readonly: false,
    });
    if (requirement.rowCount !== 1) return yield* Effect.fail(storageFailure());
    const sessionStatus =
      input.outcome === "satisfied"
        ? "completed"
        : input.outcome === "failed"
          ? "failed"
          : "expired";
    const session = yield* transaction.execute({
      label: "namespace-ownership.completion.transition-session",
      text: `UPDATE namespace_ownership_sessions
                SET status = $1,
                    completed_at = CASE WHEN $1 = 'completed' THEN $2::timestamptz ELSE NULL END,
                    terminal_at = $2::timestamptz,
                    updated_at = $2::timestamptz
              WHERE namespace_session_id = $3 AND actor_id = $4 AND status = 'pending'`,
      values: [
        sessionStatus,
        input.terminal_at,
        input.stored.namespace_session_id,
        input.stored.session.actor_id,
      ],
      readonly: false,
    });
    if (session.rowCount !== 1) return yield* Effect.fail(storageFailure());
  });
}

function expireWithoutAttempt(
  transaction: Transaction,
  input: {
    readonly stored: NamespaceOwnershipStoredCompletion;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
    readonly result_hash: string;
    readonly database_now: string;
  },
): Effect.Effect<void, NamespaceOwnershipCompletionStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    yield* insertTerminalResult(transaction, {
      ...input,
      attempt_id: null,
      outcome: "expired",
      terminal_at: input.database_now,
      evidence_ref: null,
      evidence_digest: null,
      provider_identity_digest: null,
    });
    yield* transitionTerminal(transaction, {
      stored: input.stored,
      outcome: "expired",
      terminal_at: input.database_now,
    });
  });
}

function terminalReplayOutcome(
  stored: NamespaceOwnershipStoredCompletion,
  idempotencyKey: string,
  completionRequestHash: string,
): NamespaceOwnershipCompletionReservationOutcome {
  if (stored.terminal === null) return { kind: "binding_conflict" };
  if (stored.terminal.idempotency_key !== idempotencyKey) {
    return { kind: "idempotency_conflict" };
  }
  if (stored.terminal.completion_request_hash !== completionRequestHash) {
    return { kind: "idempotency_conflict" };
  }
  return { kind: "replay", stored };
}

function lockAttempt(
  transaction: Transaction,
  attempt: NamespaceOwnershipCompletionAttemptReservation,
): Effect.Effect<Row | null, NamespaceOwnershipCompletionStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.completion.lock-attempt",
      text: `SELECT *, lease_expires_at > clock_timestamp() AS lease_live
               FROM namespace_ownership_completion_attempts
              WHERE completion_attempt_id = $1
                AND namespace_session_id = $2
                AND actor_id = $3
              FOR UPDATE`,
      values: [attempt.completion_attempt_id, attempt.namespace_session_id, attempt.actor_id],
      readonly: false,
    });
    const row = oneRow(result);
    return row === undefined ? yield* Effect.fail(storageFailure()) : row;
  });
}

function attemptMatches(
  row: Row,
  attempt: NamespaceOwnershipCompletionAttemptReservation,
  idempotencyKey: string,
  completionRequestHash: string,
): boolean {
  return (
    row.state === "leased" &&
    row.fence_token !== null &&
    safeInteger(row.fence_token) === attempt.fence_token &&
    row.evidence_ref === attempt.evidence_ref &&
    row.idempotency_key === idempotencyKey &&
    row.completion_request_hash === completionRequestHash
  );
}

type CompletionConsumptionKind = "semantic_contradiction" | "verified" | "rejected";

function consumeLiveAttempt(
  transaction: Transaction,
  input: {
    readonly attempt: NamespaceOwnershipCompletionAttemptReservation;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
    readonly consumption_kind: CompletionConsumptionKind;
  },
): Effect.Effect<string | null, NamespaceOwnershipCompletionStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.completion.consume-live-attempt",
      text: `WITH db_now AS (SELECT clock_timestamp() AS now)
             UPDATE namespace_ownership_completion_attempts AS attempt
                SET state = 'consumed', consumption_kind = $1,
                    updated_at = db_now.now
               FROM db_now
              WHERE attempt.completion_attempt_id = $2
                AND attempt.namespace_session_id = $3
                AND attempt.actor_id = $4
                AND attempt.idempotency_key = $5
                AND attempt.completion_request_hash = $6
                AND attempt.evidence_ref = $7
                AND attempt.fence_token = $8
                AND attempt.state = 'leased'
                AND attempt.lease_expires_at > db_now.now
                AND EXISTS (
                  SELECT 1 FROM namespace_ownership_sessions AS session
                   WHERE session.namespace_session_id = attempt.namespace_session_id
                     AND session.actor_id = attempt.actor_id
                     AND session.status = 'pending'
                     AND session.expires_at > db_now.now
                )
          RETURNING updated_at`,
      values: [
        input.consumption_kind,
        input.attempt.completion_attempt_id,
        input.attempt.namespace_session_id,
        input.attempt.actor_id,
        input.idempotency_key,
        input.completion_request_hash,
        input.attempt.evidence_ref,
        input.attempt.fence_token,
      ],
      readonly: false,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    if (row === null) return null;
    const consumedAt = timestampValue(row, "updated_at");
    return consumedAt === null ? yield* Effect.fail(storageFailure()) : consumedAt;
  });
}

function consumeExpiredAttempt(
  transaction: Transaction,
  input: {
    readonly attempt: NamespaceOwnershipCompletionAttemptReservation;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
  },
): Effect.Effect<string | null, NamespaceOwnershipCompletionStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.completion.consume-expired-attempt",
      text: `WITH db_now AS (SELECT clock_timestamp() AS now)
             UPDATE namespace_ownership_completion_attempts AS attempt
                SET state = 'consumed', consumption_kind = 'expired',
                    updated_at = db_now.now
               FROM db_now
              WHERE attempt.completion_attempt_id = $1
                AND attempt.namespace_session_id = $2
                AND attempt.actor_id = $3
                AND attempt.idempotency_key = $4
                AND attempt.completion_request_hash = $5
                AND attempt.evidence_ref = $6
                AND attempt.fence_token = $7
                AND attempt.state = 'leased'
                AND EXISTS (
                  SELECT 1 FROM namespace_ownership_sessions AS session
                   WHERE session.namespace_session_id = attempt.namespace_session_id
                     AND session.actor_id = attempt.actor_id
                     AND session.status = 'pending'
                     AND session.expires_at <= db_now.now
                )
          RETURNING updated_at`,
      values: [
        input.attempt.completion_attempt_id,
        input.attempt.namespace_session_id,
        input.attempt.actor_id,
        input.idempotency_key,
        input.completion_request_hash,
        input.attempt.evidence_ref,
        input.attempt.fence_token,
      ],
      readonly: false,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    if (row === null) return null;
    const consumedAt = timestampValue(row, "updated_at");
    return consumedAt === null ? yield* Effect.fail(storageFailure()) : consumedAt;
  });
}

function expireReservedAttempt(
  transaction: Transaction,
  input: {
    readonly stored: NamespaceOwnershipStoredCompletion;
    readonly attempt: NamespaceOwnershipCompletionAttemptReservation;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
    readonly expired_result_hash: string;
  },
): Effect.Effect<
  { readonly kind: "expired"; readonly result_hash: string } | { readonly kind: "lease_lost" },
  NamespaceOwnershipCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    const terminalAt = yield* consumeExpiredAttempt(transaction, input);
    if (terminalAt === null) return { kind: "lease_lost" } as const;
    yield* insertTerminalResult(transaction, {
      stored: input.stored,
      attempt_id: input.attempt.completion_attempt_id,
      idempotency_key: input.idempotency_key,
      completion_request_hash: input.completion_request_hash,
      outcome: "expired",
      result_hash: input.expired_result_hash,
      terminal_at: terminalAt,
      evidence_ref: null,
      evidence_digest: null,
      provider_identity_digest: null,
    });
    yield* transitionTerminal(transaction, {
      stored: input.stored,
      outcome: "expired",
      terminal_at: terminalAt,
    });
    return { kind: "expired", result_hash: input.expired_result_hash } as const;
  });
}

type AttemptReleaseOutcome = "released_live" | "released_stale" | null;

function releaseAttempt(
  transaction: Transaction,
  attempt: NamespaceOwnershipCompletionAttemptReservation,
): Effect.Effect<
  AttemptReleaseOutcome,
  NamespaceOwnershipCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.completion.release-attempt",
      text: `WITH db_now AS (SELECT clock_timestamp() AS now)
             UPDATE namespace_ownership_completion_attempts AS attempt
                SET state = 'released', updated_at = db_now.now
               FROM db_now
              WHERE attempt.completion_attempt_id = $1
                AND attempt.namespace_session_id = $2
                AND attempt.actor_id = $3
                AND attempt.state = 'leased'
                AND attempt.fence_token = $4
                AND EXISTS (
                  SELECT 1 FROM namespace_ownership_sessions AS session
                   WHERE session.namespace_session_id = attempt.namespace_session_id
                     AND session.actor_id = attempt.actor_id
                     AND session.status = 'pending'
                     AND session.expires_at > db_now.now
                )
          RETURNING attempt.lease_expires_at > attempt.updated_at AS lease_was_live`,
      values: [
        attempt.completion_attempt_id,
        attempt.namespace_session_id,
        attempt.actor_id,
        attempt.fence_token,
      ],
      readonly: false,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    if (row === null) return null;
    return row.lease_was_live === true ? "released_live" : "released_stale";
  });
}

interface NamespaceOwnershipCompletionRepository {
  readonly load: (
    input: Parameters<NamespaceOwnershipCompletionStore["load"]>[0],
  ) => Effect.Effect<
    NamespaceOwnershipStoredCompletion | null,
    NamespaceOwnershipCompletionStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly reserve: (
    input: Parameters<NamespaceOwnershipCompletionStore["reserve"]>[0],
  ) => Effect.Effect<
    NamespaceOwnershipCompletionReservationOutcome,
    NamespaceOwnershipCompletionStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly release: (
    input: Parameters<NamespaceOwnershipCompletionStore["release"]>[0],
  ) => Effect.Effect<
    NamespaceOwnershipCompletionReleaseOutcome,
    NamespaceOwnershipCompletionStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly reject: (
    input: Parameters<NamespaceOwnershipCompletionStore["reject"]>[0],
  ) => Effect.Effect<
    NamespaceOwnershipCompletionFinalizeOutcome,
    NamespaceOwnershipCompletionStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly consume: (
    input: Parameters<NamespaceOwnershipCompletionStore["consume"]>[0],
  ) => Effect.Effect<
    NamespaceOwnershipCompletionFinalizeOutcome,
    NamespaceOwnershipCompletionStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly verify: (
    input: Parameters<NamespaceOwnershipCompletionStore["verify"]>[0],
  ) => Effect.Effect<
    NamespaceOwnershipCompletionFinalizeOutcome,
    NamespaceOwnershipCompletionStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
}

function makeRepository(): NamespaceOwnershipCompletionRepository {
  return {
    load: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* loadStored(db, input, false);
      }),
    reserve: (input) =>
      Effect.gen(function* () {
        if (
          !Number.isSafeInteger(input.lease_ms) ||
          input.lease_ms <= 1_000 ||
          input.lease_ms > 601_000 ||
          input.max_consumed_attempts !== 3 ||
          !validIdentifier(input.completion_attempt_id) ||
          !validIdentifier(input.evidence_ref) ||
          !validHash(input.completion_request_hash) ||
          !validHash(input.expired_result_hash)
        ) {
          return yield* Effect.fail(storageFailure());
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const authority = yield* lockAuthority(transaction, input);
            if (authority === null) return { kind: "not_found" } as const;
            const stored = authority.stored;
            if (stored.status !== "pending") {
              return terminalReplayOutcome(
                stored,
                input.idempotency_key,
                input.completion_request_hash,
              );
            }
            if (
              authority.intent_revision !== input.expected_revision ||
              stored.revision !== input.expected_revision
            ) {
              return { kind: "binding_conflict" } as const;
            }
            if (
              authority.intent_status !== "verification_required" ||
              !authority.intent_active ||
              authority.requirement_status !== "pending"
            ) {
              return { kind: "binding_conflict" } as const;
            }
            const now = yield* databaseNow(transaction);
            if (Date.parse(stored.session.expires_at) <= Date.parse(now)) {
              yield* expireWithoutAttempt(transaction, {
                stored,
                idempotency_key: input.idempotency_key,
                completion_request_hash: input.completion_request_hash,
                result_hash: input.expired_result_hash,
                database_now: now,
              });
              return { kind: "expired", result_hash: input.expired_result_hash } as const;
            }

            const existingResult = yield* transaction.execute<Row>({
              label: "namespace-ownership.completion.lock-idempotency",
              text: `SELECT *, lease_expires_at > $3::timestamptz AS lease_live
                       FROM namespace_ownership_completion_attempts
                      WHERE namespace_session_id = $1 AND idempotency_key = $2
                      FOR UPDATE`,
              values: [input.session_id, input.idempotency_key, now],
              readonly: false,
            });
            const existing = oneRow(existingResult);
            if (existing === undefined) return yield* Effect.fail(storageFailure());
            if (existing !== null) {
              if (existing.completion_request_hash !== input.completion_request_hash) {
                return { kind: "idempotency_conflict" } as const;
              }
              if (existing.state === "consumed") return { kind: "consumed" } as const;
              if (existing.state === "leased" && existing.lease_live === true) {
                const expiresAt = timestampValue(existing, "lease_expires_at");
                if (expiresAt === null) return yield* Effect.fail(storageFailure());
                return {
                  kind: "in_flight",
                  retry_after_seconds: Math.max(
                    1,
                    Math.ceil((Date.parse(expiresAt) - Date.parse(now)) / 1_000),
                  ),
                } as const;
              }
            }

            const admissionResult = yield* transaction.execute<Row>({
              label: "namespace-ownership.completion.count-attempts",
              text: `SELECT
                       count(*) FILTER (WHERE state = 'consumed')::integer AS consumed_count,
                       min(lease_expires_at) FILTER (
                         WHERE state = 'leased' AND lease_expires_at > $2::timestamptz
                       ) AS active_lease_expires_at
                       FROM namespace_ownership_completion_attempts
                      WHERE namespace_session_id = $1`,
              values: [input.session_id, now],
              readonly: false,
            });
            const admission = oneRow(admissionResult);
            if (admission === undefined || admission === null) {
              return yield* Effect.fail(storageFailure());
            }
            const consumed = safeInteger(admission.consumed_count);
            if (consumed === null) return yield* Effect.fail(storageFailure());
            if (consumed >= input.max_consumed_attempts) {
              return { kind: "budget_exhausted" } as const;
            }
            const activeExpires = timestampValue(admission, "active_lease_expires_at");
            if (activeExpires !== null) {
              return {
                kind: "in_flight",
                retry_after_seconds: Math.max(
                  1,
                  Math.ceil((Date.parse(activeExpires) - Date.parse(now)) / 1_000),
                ),
              } as const;
            }
            const leaseExpiresAt = new Date(Date.parse(now) + input.lease_ms).toISOString();
            if (Date.parse(leaseExpiresAt) > Date.parse(stored.session.expires_at)) {
              return {
                kind: "in_flight",
                retry_after_seconds: Math.max(
                  1,
                  Math.ceil((Date.parse(stored.session.expires_at) - Date.parse(now)) / 1_000),
                ),
              } as const;
            }
            if (existing !== null) {
              const reacquired = yield* transaction.execute<Row>({
                label: "namespace-ownership.completion.reacquire-attempt",
                text: `UPDATE namespace_ownership_completion_attempts
                          SET state = 'leased', fence_token = fence_token + 1,
                              lease_expires_at = $1::timestamptz,
                              updated_at = clock_timestamp()
                        WHERE completion_attempt_id = $2
                          AND namespace_session_id = $3
                          AND idempotency_key = $4
                          AND completion_request_hash = $5
                          AND (
                            state = 'released'
                            OR (state = 'leased' AND lease_expires_at <= $6::timestamptz)
                          )
                     RETURNING ${attemptColumns}`,
                values: [
                  leaseExpiresAt,
                  existing.completion_attempt_id,
                  input.session_id,
                  input.idempotency_key,
                  input.completion_request_hash,
                  now,
                ],
                readonly: false,
              });
              const row = oneRow(reacquired);
              const reservation =
                row === undefined || row === null
                  ? null
                  : reservationFromRow(row, stored.session.ceremony_intent_id);
              return reservation === null
                ? yield* Effect.fail(storageFailure())
                : ({ kind: "acquired", reservation } as const);
            }
            const inserted = yield* transaction.execute<Row>({
              label: "namespace-ownership.completion.insert-attempt",
              text: `INSERT INTO namespace_ownership_completion_attempts (
                       completion_attempt_id, namespace_session_id, actor_id,
                       idempotency_key, completion_request_hash, evidence_ref,
                       submission_channel, state, fence_token, lease_expires_at
                     ) VALUES ($1, $2, $3, $4, $5, $6, 'poll_result', 'leased', 1,
                       $7::timestamptz)
                     RETURNING ${attemptColumns}`,
              values: [
                input.completion_attempt_id,
                input.session_id,
                input.actor_id,
                input.idempotency_key,
                input.completion_request_hash,
                input.evidence_ref,
                leaseExpiresAt,
              ],
              readonly: false,
            });
            const row = oneRow(inserted);
            const reservation =
              row === undefined || row === null
                ? null
                : reservationFromRow(row, stored.session.ceremony_intent_id);
            return reservation === null
              ? yield* Effect.fail(storageFailure())
              : ({ kind: "acquired", reservation } as const);
          }),
        );
      }),
    release: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const authority = yield* lockAuthority(transaction, {
              actor_id: input.actor_id,
              ceremony_intent_id: input.expected.session.ceremony_intent_id,
              session_id: input.expected.namespace_session_id,
            });
            if (authority === null) return { kind: "binding_conflict" } as const;
            if (authority.stored.status !== "pending") {
              const terminal = authority.stored.terminal;
              return terminal !== null &&
                terminal.idempotency_key === input.idempotency_key &&
                terminal.completion_request_hash === input.completion_request_hash
                ? ({ kind: "replay", stored: authority.stored } as const)
                : ({ kind: "binding_conflict" } as const);
            }
            if (
              authority.intent_revision !== input.expected.revision ||
              authority.requirement_status !== "pending" ||
              authority.intent_status !== "verification_required" ||
              !authority.intent_active
            ) {
              return { kind: "binding_conflict" } as const;
            }
            const locked = yield* lockAttempt(transaction, input.attempt);
            if (
              locked === null ||
              !attemptMatches(
                locked,
                input.attempt,
                input.idempotency_key,
                input.completion_request_hash,
              )
            )
              return { kind: "lease_lost" } as const;
            const now = yield* databaseNow(transaction);
            if (Date.parse(authority.stored.session.expires_at) <= Date.parse(now)) {
              return yield* expireReservedAttempt(transaction, {
                stored: authority.stored,
                attempt: input.attempt,
                idempotency_key: input.idempotency_key,
                completion_request_hash: input.completion_request_hash,
                expired_result_hash: input.expired_result_hash,
              });
            }
            const released = yield* releaseAttempt(transaction, input.attempt);
            if (released === null) {
              const afterRelease = yield* databaseNow(transaction);
              if (Date.parse(authority.stored.session.expires_at) <= Date.parse(afterRelease)) {
                return yield* expireReservedAttempt(transaction, {
                  stored: authority.stored,
                  attempt: input.attempt,
                  idempotency_key: input.idempotency_key,
                  completion_request_hash: input.completion_request_hash,
                  expired_result_hash: input.expired_result_hash,
                });
              }
              return { kind: "lease_lost" } as const;
            }
            return released === "released_live"
              ? ({ kind: "released" } as const)
              : ({ kind: "lease_lost" } as const);
          }),
        );
      }),
    reject: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          finalizeTerminal(transaction, { ...input, kind: "rejected" }),
        );
      }),
    consume: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          finalizeTerminal(transaction, { ...input, kind: "contradiction" }),
        );
      }),
    verify: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          finalizeTerminal(transaction, { ...input, kind: "verified" }),
        );
      }),
  };
}

type TerminalFinalizeInput =
  | (Parameters<NamespaceOwnershipCompletionStore["reject"]>[0] & {
      readonly kind: "rejected";
    })
  | (Parameters<NamespaceOwnershipCompletionStore["verify"]>[0] & {
      readonly kind: "verified";
    })
  | (Parameters<NamespaceOwnershipCompletionStore["consume"]>[0] & {
      readonly kind: "contradiction";
    });

function finalizeTerminal(
  transaction: Transaction,
  input: TerminalFinalizeInput,
): Effect.Effect<
  NamespaceOwnershipCompletionFinalizeOutcome,
  NamespaceOwnershipCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    const authority = yield* lockAuthority(transaction, {
      actor_id: input.actor_id,
      ceremony_intent_id: input.expected.session.ceremony_intent_id,
      session_id: input.expected.namespace_session_id,
    });
    if (authority === null) return { kind: "binding_conflict" } as const;
    if (authority.stored.status !== "pending") {
      const terminal = authority.stored.terminal;
      return terminal !== null &&
        terminal.idempotency_key === input.idempotency_key &&
        terminal.completion_request_hash === input.completion_request_hash
        ? ({
            kind: "replay",
            status: terminal.status,
            result_hash: terminal.result_hash,
          } as const)
        : ({ kind: "binding_conflict" } as const);
    }
    if (
      authority.intent_revision !== input.expected.revision ||
      authority.requirement_status !== "pending" ||
      authority.intent_status !== "verification_required" ||
      !authority.intent_active
    ) {
      return { kind: "binding_conflict" } as const;
    }
    const attemptRow = yield* lockAttempt(transaction, input.attempt);
    if (
      attemptRow === null ||
      !attemptMatches(
        attemptRow,
        input.attempt,
        input.idempotency_key,
        input.completion_request_hash,
      )
    ) {
      return { kind: "lease_lost" } as const;
    }
    const now = yield* databaseNow(transaction);
    const sessionExpired = Date.parse(authority.stored.session.expires_at) <= Date.parse(now);
    if (sessionExpired) {
      return yield* expireReservedAttempt(transaction, {
        stored: authority.stored,
        attempt: input.attempt,
        idempotency_key: input.idempotency_key,
        completion_request_hash: input.completion_request_hash,
        expired_result_hash: input.expired_result_hash,
      });
    }
    const consumptionKind =
      input.kind === "contradiction"
        ? "semantic_contradiction"
        : input.kind === "verified"
          ? "verified"
          : "rejected";
    const consumedAt = yield* consumeLiveAttempt(transaction, {
      attempt: input.attempt,
      idempotency_key: input.idempotency_key,
      completion_request_hash: input.completion_request_hash,
      consumption_kind: consumptionKind,
    });
    if (consumedAt === null) {
      const afterConsume = yield* databaseNow(transaction);
      if (Date.parse(authority.stored.session.expires_at) <= Date.parse(afterConsume)) {
        return yield* expireReservedAttempt(transaction, {
          stored: authority.stored,
          attempt: input.attempt,
          idempotency_key: input.idempotency_key,
          completion_request_hash: input.completion_request_hash,
          expired_result_hash: input.expired_result_hash,
        });
      }
      const released = yield* releaseAttempt(transaction, input.attempt);
      if (released === null) {
        const afterRelease = yield* databaseNow(transaction);
        if (Date.parse(authority.stored.session.expires_at) <= Date.parse(afterRelease)) {
          return yield* expireReservedAttempt(transaction, {
            stored: authority.stored,
            attempt: input.attempt,
            idempotency_key: input.idempotency_key,
            completion_request_hash: input.completion_request_hash,
            expired_result_hash: input.expired_result_hash,
          });
        }
      }
      return { kind: "lease_lost" } as const;
    }
    if (input.kind === "contradiction") return { kind: "consumed" } as const;

    if (input.kind === "verified") {
      const envelope = input.verified.envelope;
      const snapshot = yield* transaction.execute({
        label: "namespace-ownership.completion.insert-snapshot",
        text: `INSERT INTO namespace_ownership_evidence_snapshots (
                 evidence_ref, completion_attempt_id, namespace_session_id, actor_id,
                 creation_intent_id, ceremony_intent_id, generation, requirement_hash,
                 request_hash, provider_id, provider_binding_hash,
                 provider_configuration_kind, provider_configuration_ref,
                 provider_configuration_version, protocol_version, environment,
                 family, root_label, root_label_display, path_segment, href, app_host,
                 upstream_session_ref, fence_token, abi_version, ownership_source,
                 challenge_name, challenge_value_sha256, root_exists,
                 root_control_verified, expiry_horizon_sufficient, chain_network,
                 chain_anchor_height, chain_anchor_block_hash, chain_anchor_median_time,
                 expiry_height, observed_at, expires_at, provider_evidence_ref,
                 observation_sha256, provider_identity_digest, evidence_digest,
                 observation, raw_response_bytes
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, 'hns', $17, $18, $19, $20, NULL, $21, $22,
                 'pirate-hns-ownership-evidence-v1', $23, $24, $25, TRUE, TRUE, TRUE,
                 $26, $27, $28, $29, $30, $31::timestamptz, $32::timestamptz,
                 $33, $34, $35, $36, $37::jsonb, $38)`,
        values: [
          envelope.evidence_ref,
          input.attempt.completion_attempt_id,
          authority.stored.namespace_session_id,
          envelope.actor_id,
          envelope.creation_intent_id,
          envelope.ceremony_intent_id,
          envelope.generation,
          envelope.requirement_hash,
          envelope.request_hash,
          envelope.provider_id,
          envelope.provider_binding_hash,
          envelope.provider_configuration_kind,
          envelope.provider_configuration_reference,
          envelope.provider_configuration_version,
          envelope.protocol_version,
          envelope.environment,
          envelope.root_label,
          envelope.root_label_display,
          envelope.path_segment,
          authority.stored.session.route.href,
          envelope.upstream_session_ref,
          input.attempt.fence_token,
          envelope.ownership_source,
          envelope.challenge_name,
          envelope.challenge_value_sha256,
          envelope.chain_network,
          envelope.chain_anchor_height,
          envelope.chain_anchor_block_hash,
          envelope.chain_anchor_median_time,
          envelope.expiry_height,
          envelope.observed_at,
          envelope.expires_at,
          envelope.provider_evidence_ref,
          envelope.observation_sha256,
          envelope.provider_identity_digest,
          envelope.evidence_digest,
          JSON.stringify(input.verified.observation),
          input.verified.raw_response_bytes,
        ],
        readonly: false,
      });
      if (snapshot.rowCount !== 1) return yield* Effect.fail(storageFailure());
    }
    const outcome = input.kind === "verified" ? "satisfied" : "failed";
    const envelope = input.kind === "verified" ? input.verified.envelope : null;
    yield* insertTerminalResult(transaction, {
      stored: authority.stored,
      attempt_id: input.attempt.completion_attempt_id,
      idempotency_key: input.idempotency_key,
      completion_request_hash: input.completion_request_hash,
      outcome,
      result_hash: input.result_hash,
      terminal_at: consumedAt,
      evidence_ref: envelope?.evidence_ref ?? null,
      evidence_digest: envelope?.evidence_digest ?? null,
      provider_identity_digest: envelope?.provider_identity_digest ?? null,
    });
    yield* transitionTerminal(transaction, {
      stored: authority.stored,
      outcome,
      terminal_at: consumedAt,
    });
    if (envelope !== null) {
      const routeEvidence = yield* transaction.execute({
        label: "namespace-ownership.completion.insert-route-evidence",
        text: `INSERT INTO community_route_ownership_evidence (
                 evidence_ref, creation_ceremony_intent_id, verified_by_actor_id,
                 family, root_label, root_label_display, path_segment,
                 requirement_hash, provider_id, provider_binding_hash,
                 provider_configuration_version, provider_identity_digest,
                 evidence_digest, evidence_receipt_id, binding_generation,
                 verified_at, expires_at
               ) VALUES (
                 $1, $2, $3, 'hns', $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 NULL, $13, $14::timestamptz, $15::timestamptz
               )`,
        values: [
          envelope.evidence_ref,
          envelope.ceremony_intent_id,
          envelope.actor_id,
          envelope.root_label,
          envelope.root_label_display,
          envelope.path_segment,
          envelope.requirement_hash,
          envelope.provider_id,
          envelope.provider_binding_hash,
          envelope.provider_configuration_version,
          envelope.provider_identity_digest,
          envelope.evidence_digest,
          envelope.generation,
          consumedAt,
          envelope.expires_at,
        ],
        readonly: false,
      });
      if (routeEvidence.rowCount !== 1) return yield* Effect.fail(storageFailure());
    }
    return { kind: "committed", result_hash: input.result_hash } as const;
  });
}

export function makeControlPlaneNamespaceOwnershipCompletionRepository(): NamespaceOwnershipCompletionRepository {
  return makeRepository();
}

export function makeControlPlaneNamespaceOwnershipCompletionStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): NamespaceOwnershipCompletionStore {
  const repository = makeRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(() => storageFailure()));
  return {
    load: (input) => provide(repository.load(input)),
    reserve: (input) => provide(repository.reserve(input)),
    release: (input) => provide(repository.release(input)),
    reject: (input) => provide(repository.reject(input)),
    consume: (input) => provide(repository.consume(input)),
    verify: (input) => provide(repository.verify(input)),
  };
}
