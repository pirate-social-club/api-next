import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  ProviderPresentation,
  ProviderSessionStart,
  VerificationProviderStartInput,
  type VerificationSessionStartReservation,
  type VerificationSessionStartReservationInput,
  type VerificationSessionStartStore,
  VerificationStartStorageFailed,
} from "@pirate/application/verification";
import {
  communityCreationCeremonyReservationHash,
  communityCreationProviderBindingHash,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "@pirate/domain";
import { CanonicalIsoInstant, ProofSession } from "@pirate/domain/verification";
import { Effect, type Layer, Option, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;

const storageFailure = (): VerificationStartStorageFailed => new VerificationStartStorageFailed();

function oneRow(rows: readonly Row[]): Effect.Effect<Row | null, VerificationStartStorageFailed> {
  return rows.length <= 1 ? Effect.succeed(rows[0] ?? null) : Effect.fail(storageFailure());
}

function optionalString(row: Row, name: string): string | undefined | null {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function requiredString(row: Row, name: string): string | null {
  const value = row[name];
  return typeof value === "string" ? value : null;
}

function timestamp(row: Row, name: string): string | null {
  const value = row[name];
  const candidate =
    value instanceof Date && Number.isFinite(value.getTime())
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : null;
  if (candidate === null) return null;
  const decoded = Schema.decodeUnknownOption(CanonicalIsoInstant)(candidate);
  return Option.isSome(decoded) ? decoded.value : null;
}

function optionalTimestamp(row: Row, name: string): string | undefined | null {
  if (row[name] === null || row[name] === undefined) return undefined;
  return timestamp(row, name);
}

function jsonValue(row: Row, name: string): unknown {
  const value = row[name];
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function sessionFromRow(row: Row): ProofSession | null {
  const scopeKind = requiredString(row, "scope_kind");
  const issuer = requiredString(row, "issuer");
  const rpScope = optionalString(row, "issuer_rp_scope");
  const actionScope = optionalString(row, "issuer_rp_action_scope");
  const providerConfigurationKind = requiredString(row, "provider_configuration_kind");
  const providerConfigurationReference = requiredString(row, "provider_configuration_ref");
  const providerConfigurationVersion = requiredString(row, "provider_configuration_version");
  if (
    issuer === null ||
    providerConfigurationKind === null ||
    providerConfigurationReference === null ||
    providerConfigurationVersion === null
  ) {
    return null;
  }

  const scope =
    scopeKind === "none" && rpScope === undefined && actionScope === undefined
      ? { kind: "none" as const, issuer }
      : scopeKind === "issuer_rp_scope" &&
          rpScope !== null &&
          rpScope !== undefined &&
          actionScope === undefined
        ? {
            kind: "named" as const,
            scope_semantics: "issuer_rp_scope" as const,
            issuer,
            rp_scope: rpScope,
          }
        : scopeKind === "issuer_rp_action_scope" &&
            rpScope !== null &&
            rpScope !== undefined &&
            actionScope !== null &&
            actionScope !== undefined
          ? {
              kind: "named" as const,
              scope_semantics: "issuer_rp_action_scope" as const,
              issuer,
              rp_scope: rpScope,
              action_scope: actionScope,
            }
          : null;
  if (scope === null) return null;

  const upstream = optionalString(row, "upstream_session_ref");
  const completedAt = optionalTimestamp(row, "completed_at");
  if (completedAt === null) return null;
  const decoded = Schema.decodeUnknownOption(ProofSession)({
    id: row.proof_session_id,
    actor_id: row.actor_id,
    intent_id: row.intent_id,
    request_hash: row.request_hash,
    provider_id: row.provider_id,
    ...(upstream === undefined ? {} : { upstream_session_ref: upstream }),
    provider_configuration: {
      kind: providerConfigurationKind,
      reference: providerConfigurationReference,
      version: providerConfigurationVersion,
    },
    method: row.method,
    scope,
    request_mode: row.request_mode,
    requested_requirements: jsonValue(row, "requested_requirements"),
    requested_claim_ids: jsonValue(row, "requested_claim_ids"),
    subject_binding_intent: row.subject_binding_intent,
    protocol_version: row.protocol_version,
    environment: row.environment,
    status: row.status,
    started_at: timestamp(row, "started_at"),
    expires_at: timestamp(row, "expires_at"),
    ...(completedAt === undefined ? {} : { completed_at: completedAt }),
  });
  return Option.isSome(decoded) ? decoded.value : null;
}

function presentationFromRow(row: Row): ProviderPresentation | null {
  const kind = requiredString(row, "presentation_kind");
  const payload = jsonValue(row, "payload");
  if (kind === null || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const decoded = Schema.decodeUnknownOption(ProviderPresentation)({
    kind,
    ...(payload as Readonly<Record<string, unknown>>),
  });
  return Option.isSome(decoded) ? decoded.value : null;
}

/** Stable equality for decoded JSON-shaped domain values. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sessionColumns(): string {
  return `
    proof_session_id, actor_id, intent_id, request_hash, provider_id,
    provider_configuration_kind, provider_configuration_ref,
    provider_configuration_version, method, issuer, scope_kind,
    issuer_rp_scope, issuer_rp_action_scope, request_mode, requested_requirements,
    requested_claim_ids, upstream_session_ref, subject_binding_intent,
    protocol_version, environment, status, started_at, expires_at, completed_at,
    creation_ceremony_intent_id`;
}

function decodeStart(sessionRow: Row, presentationRow: Row): ProviderSessionStart | null {
  const session = sessionFromRow(sessionRow);
  const presentation = presentationFromRow(presentationRow);
  if (session === null || presentation === null) return null;
  const decoded = Schema.decodeUnknownOption(ProviderSessionStart)({ session, presentation });
  return Option.isSome(decoded) ? decoded.value : null;
}

type ExistingStart = Readonly<{
  readonly start: ProviderSessionStart;
  readonly creation_ceremony_intent_id?: string;
  /** Evaluated by PostgreSQL's clock while the session row is locked. */
  readonly active: boolean;
}>;

function identityMatches(actual: ProviderSessionStart, expected: ProviderSessionStart): boolean {
  return (
    sameValue(actual.session, expected.session) &&
    sameValue(actual.presentation, expected.presentation)
  );
}

function invalidStart(input: unknown): ProviderSessionStart | null {
  const decoded = Schema.decodeUnknownOption(ProviderSessionStart)(input);
  return Option.isSome(decoded) ? decoded.value : null;
}

function reservationFromRow(row: Row): VerificationSessionStartReservation | null {
  const reservation_id = requiredString(row, "reservation_id");
  const lease_expires_at = timestamp(row, "lease_expires_at");
  const token = row.fence_token;
  const fence_token =
    typeof token === "number"
      ? token
      : typeof token === "string" && /^[0-9]+$/u.test(token)
        ? Number(token)
        : NaN;
  if (
    reservation_id === null ||
    lease_expires_at === null ||
    !Number.isSafeInteger(fence_token) ||
    fence_token <= 0
  ) {
    return null;
  }
  const creationIntentId = optionalString(row, "creation_intent_id");
  const ceremonyIntentId = optionalString(row, "intent_id");
  const creationRequirement = optionalString(row, "creation_requirement_kind");
  const creationGeneration = row.creation_generation;
  const clientIdempotencyKey = optionalString(row, "client_idempotency_key");
  const parsedGeneration =
    typeof creationGeneration === "number"
      ? creationGeneration
      : typeof creationGeneration === "string" && /^[0-9]+$/u.test(creationGeneration)
        ? Number(creationGeneration)
        : undefined;
  if (
    creationIntentId === null ||
    ceremonyIntentId === null ||
    creationRequirement === null ||
    clientIdempotencyKey === null
  ) {
    return null;
  }
  const hasCreation = creationIntentId !== undefined;
  if (
    hasCreation !== (creationRequirement !== undefined) ||
    hasCreation !== (parsedGeneration !== undefined) ||
    hasCreation !== (clientIdempotencyKey !== undefined) ||
    (hasCreation &&
      (creationRequirement !== "human_identity" ||
        !Number.isSafeInteger(parsedGeneration) ||
        (parsedGeneration ?? 0) <= 0 ||
        ceremonyIntentId === undefined))
  ) {
    return null;
  }
  return {
    reservation_id,
    fence_token,
    lease_expires_at,
    ...(creationIntentId === undefined ||
    ceremonyIntentId === undefined ||
    creationRequirement === undefined ||
    parsedGeneration === undefined ||
    clientIdempotencyKey === undefined
      ? {}
      : {
          creation: {
            creation_intent_id: creationIntentId,
            ceremony_intent_id: ceremonyIntentId,
            requirement: "human_identity" as const,
            generation: parsedGeneration,
            idempotency_key: clientIdempotencyKey,
          },
        }),
  };
}

function reservationColumns(): string {
  return `reservation_id, actor_id, intent_id, request_hash, state, fence_token,
          lease_expires_at, creation_intent_id, creation_requirement_kind,
          creation_generation, client_idempotency_key`;
}

function reservationMatchesInput(
  reservation: VerificationSessionStartReservation,
  start: VerificationProviderStartInput,
  creation: VerificationSessionStartReservationInput["creation"],
): boolean {
  if (creation === undefined) return reservation.creation === undefined;
  return (
    reservation.creation?.creation_intent_id === creation.creation_intent_id &&
    reservation.creation.ceremony_intent_id === start.intent_id &&
    reservation.creation.requirement === creation.requirement &&
    reservation.creation.generation === creation.generation &&
    reservation.creation.idempotency_key === creation.idempotency_key
  );
}

type CreationReservation = NonNullable<VerificationSessionStartReservationInput["creation"]>;

const HUMAN_REQUIREMENTS = [
  { claim_id: "credential.subject_unique" },
  { claim_id: "human.personhood" },
] as const;
const HUMAN_CLAIM_IDS = ["credential.subject_unique", "human.personhood"] as const;

function exactHumanProviderInput(
  start: VerificationProviderStartInput,
  creation: CreationReservation,
): boolean {
  return (
    creation.requirement === "human_identity" &&
    creation.provider_id === VERY_WEB_PROVIDER_ID &&
    start.provider_configuration.kind === "dynamic" &&
    start.provider_configuration.reference === VERY_WEB_CONFIGURATION_REFERENCE &&
    start.provider_configuration.version === VERY_WEB_CONFIGURATION_VERSION &&
    start.method === VERY_WEB_METHOD &&
    start.scope.kind === "named" &&
    start.scope.scope_semantics === "issuer_rp_scope" &&
    start.scope.issuer === VERY_WEB_ISSUER &&
    start.scope.rp_scope === VERY_WEB_RP_SCOPE &&
    start.request_mode === "dynamic" &&
    sameValue(start.requested_requirements, HUMAN_REQUIREMENTS) &&
    sameValue(start.requested_claim_ids, HUMAN_CLAIM_IDS) &&
    start.subject_binding_intent === "establish" &&
    start.protocol_version === VERY_WEB_PROTOCOL_VERSION
  );
}

function lockCreationAuthority(
  transaction: Transaction,
  start: VerificationProviderStartInput,
  creation: CreationReservation,
  requireRevision: boolean,
): Effect.Effect<boolean, VerificationStartStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    if (!exactHumanProviderInput(start, creation)) return false;
    const bindingHash = communityCreationProviderBindingHash({
      requirement: "human_identity",
      family: null,
      provider_id: creation.provider_id,
      provider_configuration: start.provider_configuration,
      protocol_version: start.protocol_version,
    });
    const reservationHash = communityCreationCeremonyReservationHash({
      actor_id: start.actor_id,
      creation_intent_id: creation.creation_intent_id,
      ceremony_intent_id: start.intent_id,
      requirement: creation.requirement,
      generation: creation.generation,
      requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
      provider_id: creation.provider_id,
      provider_binding_hash: bindingHash,
      route: null,
    });
    const result = yield* transaction.execute<Row>({
      label: "verification.start.lock-creation-authority",
      text: `SELECT intent.revision,
                    intent.status,
                    intent.creation_contract_version,
                    intent.expires_at > clock_timestamp() AS intent_active,
                    state.status AS requirement_status,
                    state.requirement_hash,
                    state.provider_id,
                    state.provider_binding_hash,
                    state.provider_configuration_kind,
                    state.provider_configuration_ref,
                    state.provider_configuration_version,
                    state.generation,
                    state.current_ceremony_intent_id,
                    state.route_family,
                    attempt.requirement_hash AS attempt_requirement_hash,
                    attempt.provider_id AS attempt_provider_id,
                    attempt.provider_binding_hash AS attempt_provider_binding_hash,
                    attempt.provider_configuration_kind AS attempt_configuration_kind,
                    attempt.provider_configuration_ref AS attempt_configuration_ref,
                    attempt.provider_configuration_version AS attempt_configuration_version,
                    attempt.generation AS attempt_generation,
                    attempt.route_family AS attempt_route_family,
                    attempt.reservation_request_hash,
                    attempt.expires_at > clock_timestamp() AS attempt_active
               FROM community_creation_intents AS intent
               JOIN community_creation_requirement_states AS state
                 ON state.intent_id = intent.intent_id
                AND state.actor_id = intent.actor_id
                AND state.requirement_kind = 'human_identity'
               JOIN community_creation_ceremony_attempts AS attempt
                 ON attempt.actor_id = intent.actor_id
                AND attempt.intent_id = intent.intent_id
                AND attempt.requirement_kind = state.requirement_kind
                AND attempt.generation = state.generation
                AND attempt.ceremony_intent_id = state.current_ceremony_intent_id
              WHERE intent.actor_id = $1
                AND intent.intent_id = $2
                AND attempt.ceremony_intent_id = $3
              FOR UPDATE OF intent, state, attempt`,
      values: [start.actor_id, creation.creation_intent_id, start.intent_id],
      readonly: false,
    });
    const row = yield* oneRow(result.rows);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    if (row === null) return false;
    return (
      (!requireRevision || Number(row.revision) === creation.expected_revision) &&
      row.status === "verification_required" &&
      (row.creation_contract_version === "route_v1" ||
        row.creation_contract_version === "optional_route_v2") &&
      row.intent_active === true &&
      row.requirement_status === "pending" &&
      row.requirement_hash === HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH &&
      row.provider_id === creation.provider_id &&
      row.provider_binding_hash === bindingHash &&
      row.provider_configuration_kind === start.provider_configuration.kind &&
      row.provider_configuration_ref === start.provider_configuration.reference &&
      row.provider_configuration_version === start.provider_configuration.version &&
      Number(row.generation) === creation.generation &&
      row.current_ceremony_intent_id === start.intent_id &&
      row.route_family === null &&
      row.attempt_requirement_hash === HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH &&
      row.attempt_provider_id === creation.provider_id &&
      row.attempt_provider_binding_hash === bindingHash &&
      row.attempt_configuration_kind === start.provider_configuration.kind &&
      row.attempt_configuration_ref === start.provider_configuration.reference &&
      row.attempt_configuration_version === start.provider_configuration.version &&
      Number(row.attempt_generation) === creation.generation &&
      row.attempt_route_family === null &&
      row.reservation_request_hash === reservationHash &&
      row.attempt_active === true
    );
  });
}

function reservationInput(input: unknown): VerificationProviderStartInput | null {
  const decoded = Schema.decodeUnknownOption(VerificationProviderStartInput)(input);
  return Option.isSome(decoded) ? decoded.value : null;
}

function loadExisting(
  transaction: Transaction,
  actorId: string,
  intentId: string,
): Effect.Effect<ExistingStart | null, VerificationStartStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const sessionResult = yield* transaction.execute<Row>({
      label: "verification.start.lock-session-by-intent",
      text: `SELECT ${sessionColumns()}
               FROM proof_sessions
              WHERE actor_id = $1 AND intent_id = $2
              FOR UPDATE`,
      values: [actorId, intentId],
      readonly: false,
    });
    const sessionRow = yield* oneRow(sessionResult.rows);
    if (sessionRow === null) return null;

    const presentationResult = yield* transaction.execute<Row>({
      label: "verification.start.lock-presentation",
      text: `SELECT proof_session_id, presentation_kind, payload
               FROM proof_session_presentations
              WHERE proof_session_id = $1
              FOR UPDATE`,
      values: [sessionRow.proof_session_id],
      readonly: false,
    });
    const presentationRow = yield* oneRow(presentationResult.rows);
    if (presentationRow === null) return yield* Effect.fail(storageFailure());
    const decoded = decodeStart(sessionRow, presentationRow);
    if (decoded === null) return yield* Effect.fail(storageFailure());
    const clockResult = yield* transaction.execute<Row>({
      label: "verification.start.session-clock",
      text: "SELECT clock_timestamp() AS database_now",
      values: [],
      readonly: false,
    });
    const clockRow = yield* oneRow(clockResult.rows);
    const databaseNow = clockRow === null ? null : timestamp(clockRow, "database_now");
    if (databaseNow === null) return yield* Effect.fail(storageFailure());
    const creationCeremonyIntentId = optionalString(sessionRow, "creation_ceremony_intent_id");
    if (creationCeremonyIntentId === null) return yield* Effect.fail(storageFailure());
    return {
      start: decoded,
      ...(creationCeremonyIntentId === undefined
        ? {}
        : { creation_ceremony_intent_id: creationCeremonyIntentId }),
      active: Date.parse(decoded.session.expires_at) > Date.parse(databaseNow),
    };
  });
}

function lockActor(
  transaction: Transaction,
  actorId: string,
): Effect.Effect<void, VerificationStartStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "verification.start.lock-actor",
      text: "SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE",
      values: [actorId],
      readonly: false,
    });
    const row = yield* oneRow(result.rows);
    if (row === null || requiredString(row, "user_id") !== actorId) {
      return yield* Effect.fail(storageFailure());
    }
  });
}

function valuesFor(start: ProviderSessionStart): readonly unknown[] {
  const session = start.session;
  const scope = session.scope;
  return [
    session.id,
    session.actor_id,
    session.intent_id,
    session.request_hash,
    session.provider_id,
    session.provider_configuration.kind,
    session.provider_configuration.reference,
    session.provider_configuration.version,
    session.method,
    scope.issuer,
    scope.kind === "named" ? scope.scope_semantics : "none",
    scope.kind === "named" ? scope.rp_scope : null,
    scope.kind === "named" && scope.scope_semantics === "issuer_rp_action_scope"
      ? scope.action_scope
      : null,
    session.request_mode,
    JSON.stringify(session.requested_requirements),
    JSON.stringify(session.requested_claim_ids),
    session.upstream_session_ref ?? null,
    session.subject_binding_intent,
    session.protocol_version,
    session.environment,
    session.status,
    session.started_at,
    session.expires_at,
  ];
}

function insertSession(
  transaction: Transaction,
  start: ProviderSessionStart,
  creationCeremonyIntentId?: string,
): Effect.Effect<Row | null, VerificationStartStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "verification.start.insert-session",
      text: `INSERT INTO proof_sessions (
               proof_session_id, actor_id, intent_id, request_hash, provider_id,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, method, issuer, scope_kind,
               issuer_rp_scope, issuer_rp_action_scope, request_mode,
               requested_requirements, requested_claim_ids, upstream_session_ref,
               subject_binding_intent, protocol_version, environment, status,
               started_at, expires_at, creation_ceremony_intent_id
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15::jsonb, $16::jsonb, $17, $18, $19, $20, $21, $22, $23, $24
             )
             ON CONFLICT (actor_id, intent_id) DO NOTHING
             RETURNING ${sessionColumns()}`,
      values: [...valuesFor(start), creationCeremonyIntentId ?? null],
      readonly: false,
    });
    return yield* oneRow(result.rows);
  });
}

function insertPresentation(
  transaction: Transaction,
  start: ProviderSessionStart,
): Effect.Effect<Row, VerificationStartStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "verification.start.insert-presentation",
      text: `INSERT INTO proof_session_presentations (proof_session_id, presentation_kind, payload)
             VALUES ($1, $2, $3::jsonb)
             RETURNING proof_session_id, presentation_kind, payload`,
      values: [
        start.session.id,
        start.presentation.kind,
        JSON.stringify(
          Object.fromEntries(Object.entries(start.presentation).filter(([key]) => key !== "kind")),
        ),
      ],
      readonly: false,
    });
    const row = yield* oneRow(result.rows);
    return row === null ? yield* Effect.fail(storageFailure()) : row;
  });
}

export function makeControlPlaneVerificationSessionStartRepository() {
  return {
    reserve: (input: VerificationSessionStartReservationInput) =>
      Effect.gen(function* () {
        const start = reservationInput(input.start);
        if (
          start === null ||
          !Number.isSafeInteger(input.ttl_ms) ||
          input.ttl_ms <= 0 ||
          (input.creation !== undefined &&
            (!Number.isSafeInteger(input.creation.expected_revision) ||
              input.creation.expected_revision <= 0 ||
              !Number.isSafeInteger(input.creation.generation) ||
              input.creation.generation <= 0 ||
              input.creation.idempotency_key.trim() !== input.creation.idempotency_key ||
              input.creation.idempotency_key.length === 0))
        ) {
          return yield* Effect.fail(storageFailure());
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* lockActor(transaction, start.actor_id);
            if (
              input.creation !== undefined &&
              !(yield* lockCreationAuthority(transaction, start, input.creation, true))
            ) {
              return { kind: "conflict" } as const;
            }
            const existing = yield* loadExisting(transaction, start.actor_id, start.intent_id);
            if (existing !== null) {
              if (
                (input.creation === undefined) !==
                  (existing.creation_ceremony_intent_id === undefined) ||
                (input.creation !== undefined &&
                  existing.creation_ceremony_intent_id !== start.intent_id)
              ) {
                return { kind: "conflict" } as const;
              }
              if (existing.start.session.request_hash !== start.request_hash) {
                return { kind: "conflict" } as const;
              }
              if (existing.start.session.status === "pending" && existing.active) {
                return { kind: "replay", start: existing.start } as const;
              }
              return {
                kind: "terminal",
                status:
                  existing.start.session.status === "pending"
                    ? "expired"
                    : existing.start.session.status,
                start: existing.start,
              } as const;
            }

            const reservationId = start.request_hash;
            const result = yield* transaction.execute<Row>({
              label: "verification.start.lock-reservation",
              text: `SELECT ${reservationColumns()}
                        FROM verification_start_reservations
                       WHERE actor_id = $1
                         AND (
                           intent_id = $2
                           OR (
                             $3::text IS NOT NULL
                             AND creation_intent_id = $3
                             AND creation_requirement_kind = $4
                             AND client_idempotency_key = $5
                           )
                         )
                       FOR UPDATE`,
              values: [
                start.actor_id,
                start.intent_id,
                input.creation?.creation_intent_id ?? null,
                input.creation?.requirement ?? null,
                input.creation?.idempotency_key ?? null,
              ],
              readonly: false,
            });
            const row = yield* oneRow(result.rows);
            if (row !== null) {
              const requestHash = requiredString(row, "request_hash");
              const persistedReservation = reservationFromRow(row);
              if (
                requestHash !== start.request_hash ||
                persistedReservation === null ||
                !reservationMatchesInput(persistedReservation, start, input.creation)
              ) {
                return { kind: "conflict" } as const;
              }
              const state = requiredString(row, "state");
              const lease = timestamp(row, "lease_expires_at");
              if (state === null || lease === null) {
                return yield* Effect.fail(storageFailure());
              }
              const clockResult = yield* transaction.execute<Row>({
                label: "verification.start.reservation-clock",
                text: "SELECT clock_timestamp() AS database_now",
                values: [],
                readonly: false,
              });
              const clockRow = yield* oneRow(clockResult.rows);
              const databaseNow = clockRow === null ? null : timestamp(clockRow, "database_now");
              if (databaseNow === null) return yield* Effect.fail(storageFailure());
              if (state === "acquired" && Date.parse(lease) > Date.parse(databaseNow)) {
                const retryAfter = Math.max(
                  1,
                  Math.ceil((Date.parse(lease) - Date.parse(databaseNow)) / 1_000),
                );
                return { kind: "in_flight", retry_after_seconds: retryAfter } as const;
              }
              if (state === "finalized") return yield* Effect.fail(storageFailure());
              const renewed = yield* transaction.execute<Row>({
                label: "verification.start.renew-reservation",
                text: `UPDATE verification_start_reservations
                          SET state = 'acquired',
                              fence_token = fence_token + 1,
                              request = $3::jsonb,
                              lease_expires_at = clock_timestamp() + ($4 * INTERVAL '1 millisecond'),
                              updated_at = clock_timestamp()
                        WHERE actor_id = $1 AND intent_id = $2
                        RETURNING ${reservationColumns()}`,
                values: [
                  start.actor_id,
                  start.intent_id,
                  JSON.stringify({ start, creation: input.creation ?? null }),
                  input.ttl_ms,
                ],
                readonly: false,
              });
              const renewedRow = yield* oneRow(renewed.rows);
              const reservation = renewedRow === null ? null : reservationFromRow(renewedRow);
              return reservation === null
                ? yield* Effect.fail(storageFailure())
                : ({ kind: "acquired", reservation } as const);
            }

            const inserted = yield* transaction.execute<Row>({
              label: "verification.start.insert-reservation",
              text: `INSERT INTO verification_start_reservations (
                       reservation_id, actor_id, intent_id, request_hash, request,
                       state, fence_token, lease_expires_at, creation_intent_id,
                       creation_requirement_kind, creation_generation,
                       client_idempotency_key
                     ) VALUES ($1, $2, $3, $4, $5::jsonb, 'acquired', 1,
                               clock_timestamp() + ($6 * INTERVAL '1 millisecond'),
                               $7, $8, $9, $10)
                     RETURNING ${reservationColumns()}`,
              values: [
                reservationId,
                start.actor_id,
                start.intent_id,
                start.request_hash,
                JSON.stringify({ start, creation: input.creation ?? null }),
                input.ttl_ms,
                input.creation?.creation_intent_id ?? null,
                input.creation?.requirement ?? null,
                input.creation?.generation ?? null,
                input.creation?.idempotency_key ?? null,
              ],
              readonly: false,
            });
            const insertedRow = yield* oneRow(inserted.rows);
            const reservation = insertedRow === null ? null : reservationFromRow(insertedRow);
            return reservation === null
              ? yield* Effect.fail(storageFailure())
              : ({ kind: "acquired", reservation } as const);
          }),
        );
      }),
    finalize: (reservation: VerificationSessionStartReservation, input: ProviderSessionStart) =>
      Effect.gen(function* () {
        const start = invalidStart(input);
        if (start === null || start.session.status !== "pending") {
          return yield* Effect.fail(storageFailure());
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* lockActor(transaction, start.session.actor_id);
            if (
              reservation.creation !== undefined &&
              !(yield* lockCreationAuthority(
                transaction,
                start.session,
                {
                  creation_intent_id: reservation.creation.creation_intent_id,
                  requirement: reservation.creation.requirement,
                  generation: reservation.creation.generation,
                  expected_revision: 1,
                  idempotency_key: reservation.creation.idempotency_key,
                  provider_id: start.session.provider_id,
                },
                false,
              ))
            ) {
              return { kind: "stale" } as const;
            }
            const lock = yield* transaction.execute<Row>({
              label: "verification.start.lock-finalizer",
              text: `SELECT ${reservationColumns()}
                        FROM verification_start_reservations
                       WHERE reservation_id = $1
                       FOR UPDATE`,
              values: [reservation.reservation_id],
              readonly: false,
            });
            const row = yield* oneRow(lock.rows);
            const current = row === null ? null : reservationFromRow(row);
            if (
              current === null ||
              current.fence_token !== reservation.fence_token ||
              !sameValue(current.creation, reservation.creation) ||
              requiredString(row ?? {}, "state") !== "acquired"
            ) {
              return { kind: "stale" } as const;
            }
            if (requiredString(row ?? {}, "request_hash") !== start.session.request_hash) {
              return { kind: "conflict" } as const;
            }
            const fenced = yield* transaction.execute<Row>({
              label: "verification.start.finalize-reservation",
              text: `UPDATE verification_start_reservations
                         SET state = 'finalized', updated_at = clock_timestamp()
                       WHERE reservation_id = $1
                         AND fence_token = $2
                         AND state = 'acquired'
                         AND lease_expires_at > clock_timestamp()`,
              values: [reservation.reservation_id, reservation.fence_token],
              readonly: false,
            });
            if (fenced.rowCount !== 1) return { kind: "stale" } as const;
            const insertedSession = yield* insertSession(
              transaction,
              start,
              current.creation?.ceremony_intent_id,
            );
            if (insertedSession === null) {
              const existing = yield* loadExisting(
                transaction,
                start.session.actor_id,
                start.session.intent_id,
              );
              if (existing === null) return yield* Effect.fail(storageFailure());
              return sameValue(existing.start, start)
                ? ({ kind: "replay", start: existing.start } as const)
                : ({ kind: "conflict" } as const);
            }
            const insertedPresentation = yield* insertPresentation(transaction, start);
            const persisted = decodeStart(insertedSession, insertedPresentation);
            if (persisted === null || !identityMatches(persisted, start)) {
              return yield* Effect.fail(storageFailure());
            }
            return { kind: "created", start: persisted } as const;
          }),
        );
      }),
    release: (reservation: VerificationSessionStartReservation) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          transaction.execute({
            label: "verification.start.release-reservation",
            text: `UPDATE verification_start_reservations
                       SET state = 'released', updated_at = clock_timestamp()
                     WHERE reservation_id = $1
                       AND fence_token = $2
                       AND state = 'acquired'`,
            values: [reservation.reservation_id, reservation.fence_token],
            readonly: false,
          }),
        );
      }),
  };
}

export function makeControlPlaneVerificationSessionStartStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VerificationSessionStartStore {
  const repository = makeControlPlaneVerificationSessionStartRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(() => storageFailure()));
  return {
    reserve: (input) => provide(repository.reserve(input)),
    finalize: (reservation, input) => provide(repository.finalize(reservation, input)),
    release: (reservation) => provide(repository.release(reservation)),
  };
}
