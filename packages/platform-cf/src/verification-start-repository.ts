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
    protocol_version, environment, status, started_at, expires_at, completed_at`;
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
  return { reservation_id, fence_token, lease_expires_at };
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
    return {
      start: decoded,
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
               started_at, expires_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15::jsonb, $16::jsonb, $17, $18, $19, $20, $21, $22, $23
             )
             ON CONFLICT (actor_id, intent_id) DO NOTHING
             RETURNING ${sessionColumns()}`,
      values: valuesFor(start),
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
        if (start === null || !Number.isSafeInteger(input.ttl_ms) || input.ttl_ms <= 0) {
          return yield* Effect.fail(storageFailure());
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* lockActor(transaction, start.actor_id);
            const existing = yield* loadExisting(transaction, start.actor_id, start.intent_id);
            if (existing !== null) {
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
              text: `SELECT reservation_id, request_hash, state, fence_token,
                             lease_expires_at
                        FROM verification_start_reservations
                       WHERE actor_id = $1 AND intent_id = $2
                       FOR UPDATE`,
              values: [start.actor_id, start.intent_id],
              readonly: false,
            });
            const row = yield* oneRow(result.rows);
            if (row !== null) {
              const requestHash = requiredString(row, "request_hash");
              if (requestHash !== start.request_hash) {
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
                        RETURNING reservation_id, fence_token, lease_expires_at`,
                values: [start.actor_id, start.intent_id, JSON.stringify(start), input.ttl_ms],
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
                       state, fence_token, lease_expires_at
                     ) VALUES ($1, $2, $3, $4, $5::jsonb, 'acquired', 1,
                               clock_timestamp() + ($6 * INTERVAL '1 millisecond'))
                     RETURNING reservation_id, fence_token, lease_expires_at`,
              values: [
                reservationId,
                start.actor_id,
                start.intent_id,
                start.request_hash,
                JSON.stringify(start),
                input.ttl_ms,
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
            const lock = yield* transaction.execute<Row>({
              label: "verification.start.lock-finalizer",
              text: `SELECT reservation_id, request_hash, state, fence_token,
                             lease_expires_at
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
            yield* lockActor(transaction, start.session.actor_id);
            const insertedSession = yield* insertSession(transaction, start);
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
