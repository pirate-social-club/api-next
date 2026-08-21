import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  type HnsRouteRevalidationCompletionAttempt,
  type HnsRouteRevalidationCompletionFinalizeOutcome,
  type HnsRouteRevalidationCompletionReleaseOutcome,
  type HnsRouteRevalidationCompletionReservationOutcome,
  HnsRouteRevalidationCompletionStorageFailed,
  type HnsRouteRevalidationCompletionStore,
  type HnsRouteRevalidationSessionV1,
  type HnsRouteRevalidationStoredCompletion,
  type HnsRouteRevalidationCompletionAttemptReservation as Reservation,
} from "@pirate/application/route-revalidation";
import { HnsTxtChallengeV1 } from "@pirate/contracts";
import { ProviderConfigurationRef, Sha256Hex } from "@pirate/domain/verification";
import { Effect, type Layer, Option, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;
const exactParseOptions = { onExcessProperty: "error" } as const;
const storageFailure = () => new HnsRouteRevalidationCompletionStorageFailed();

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

function integerValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function timestampValue(row: Row, name: string): string | null {
  const raw = row[name];
  const value = raw instanceof Date ? raw.toISOString() : typeof raw === "string" ? raw : null;
  if (value === null || !Number.isFinite(Date.parse(value))) return null;
  const canonical = new Date(Date.parse(value)).toISOString();
  return canonical === value ? value : null;
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

function validHash(value: string | null): value is string {
  return value !== null && Option.isSome(Schema.decodeUnknownOption(Sha256Hex)(value));
}

const sessionPresentation = Schema.Struct({
  kind: Schema.Literal("embedded_sdk"),
  session_id: Schema.NonEmptyString,
  protocol: Schema.Literal("hns-txt-challenge"),
  version: Schema.Literal("1"),
  payload: HnsTxtChallengeV1,
});

function sessionFromRow(row: Row): HnsRouteRevalidationSessionV1 | null {
  const required = [
    "revalidation_session_id",
    "route_revalidation_id",
    "community_id",
    "route_binding_id",
    "principal_id",
    "requirement_hash",
    "start_request_hash",
    "provider_id",
    "provider_binding_hash",
    "provider_configuration_reference",
    "provider_configuration_version",
    "environment",
    "root_label",
    "root_label_display",
    "path_segment",
    "upstream_session_ref",
  ] as const;
  if (required.some((key) => stringValue(row, key) === null)) return null;
  const routeRevalidationId = stringValue(row, "route_revalidation_id");
  const sessionId = stringValue(row, "revalidation_session_id");
  const communityId = stringValue(row, "community_id");
  const routeBindingId = stringValue(row, "route_binding_id");
  const principalId = stringValue(row, "principal_id");
  const requirementHash = stringValue(row, "requirement_hash");
  const startRequestHash = stringValue(row, "start_request_hash");
  const providerId = stringValue(row, "provider_id");
  const providerBindingHash = stringValue(row, "provider_binding_hash");
  const configurationReference = stringValue(row, "provider_configuration_reference");
  const configurationVersion = stringValue(row, "provider_configuration_version");
  const environment = stringValue(row, "environment");
  const rootLabel = stringValue(row, "root_label");
  const rootLabelDisplay = stringValue(row, "root_label_display");
  const pathSegment = stringValue(row, "path_segment");
  const upstreamSessionRef = stringValue(row, "upstream_session_ref");
  const generation = integerValue(row.expected_binding_generation);
  const startFence = integerValue(row.start_fence_token);
  const startedAt = timestampValue(row, "started_at");
  const expiresAt = timestampValue(row, "expires_at");
  const terminalAt = row.terminal_at === null ? null : timestampValue(row, "terminal_at");
  const presentationOption = Schema.decodeUnknownOption(
    sessionPresentation,
    exactParseOptions,
  )(jsonValue(row, "start_presentation"));
  const presentation = Option.isSome(presentationOption) ? presentationOption.value : null;
  const configurationOption = Schema.decodeUnknownOption(
    ProviderConfigurationRef,
    exactParseOptions,
  )({
    kind: row.provider_configuration_kind,
    reference: configurationReference,
    version: configurationVersion,
  });
  const configuration = Option.isSome(configurationOption) ? configurationOption.value : null;
  if (
    routeRevalidationId === null ||
    sessionId === null ||
    communityId === null ||
    routeBindingId === null ||
    principalId === null ||
    requirementHash === null ||
    startRequestHash === null ||
    providerId === null ||
    providerBindingHash === null ||
    configurationReference === null ||
    configurationVersion === null ||
    environment === null ||
    rootLabel === null ||
    rootLabelDisplay === null ||
    pathSegment === null ||
    upstreamSessionRef === null ||
    generation === null ||
    generation < 1 ||
    startFence === null ||
    startFence < 1 ||
    startedAt === null ||
    expiresAt === null ||
    presentation === null ||
    configuration === null ||
    row.principal_kind !== "system" ||
    row.family !== "hns" ||
    row.protocol_version !== "hns-txt-v1" ||
    (row.status !== "pending" &&
      row.status !== "completed" &&
      row.status !== "failed" &&
      row.status !== "expired") ||
    (row.terminal_at !== null && terminalAt === null) ||
    !validHash(requirementHash) ||
    !validHash(startRequestHash) ||
    !validHash(providerBindingHash)
  )
    return null;
  return {
    authority: {
      version: "pirate-hns-route-revalidation-authority-v1",
      route_revalidation_id: routeRevalidationId,
      community_id: communityId,
      route_binding_id: routeBindingId,
      principal_kind: "system",
      principal_id: principalId,
      expected_binding_generation: generation,
      expected_verified_evidence_ref: optionalStringValue(row, "expected_verified_evidence_ref"),
      requirement_hash: requirementHash,
      provider_id: providerId,
      provider_binding_hash: providerBindingHash,
      provider_configuration_kind: configuration.kind,
      provider_configuration_reference: configuration.reference,
      provider_configuration_version: configuration.version,
      protocol_version: "hns-txt-v1",
      environment,
      family: "hns",
      root_label: rootLabel,
      root_label_display: rootLabelDisplay,
      path_segment: pathSegment,
    },
    revalidation_session_id: sessionId,
    start_request_hash: startRequestHash,
    upstream_session_ref: upstreamSessionRef,
    start_presentation: presentation,
    status: row.status as HnsRouteRevalidationSessionV1["status"],
    started_at: startedAt,
    expires_at: expiresAt,
    terminal_at: terminalAt,
  };
}

function attemptFromRow(row: Row, prefix: string): HnsRouteRevalidationCompletionAttempt | null {
  const id = stringValue(row, `${prefix}attempt_id`);
  const routeId = stringValue(row, `${prefix}route_revalidation_id`);
  const sessionId = stringValue(row, `${prefix}revalidation_session_id`);
  const bindingId = stringValue(row, `${prefix}route_binding_id`);
  const evidenceRef = stringValue(row, `${prefix}evidence_ref`);
  const key = stringValue(row, `${prefix}idempotency_key`);
  const requestHash = stringValue(row, `${prefix}completion_request_hash`);
  const generation = integerValue(row[`${prefix}expected_binding_generation`]);
  const number = integerValue(row[`${prefix}attempt_number`]);
  const fence = integerValue(row[`${prefix}fence_token`]);
  const lease = timestampValue(row, `${prefix}lease_expires_at`);
  const state = row[`${prefix}state`];
  if (
    id === null ||
    routeId === null ||
    sessionId === null ||
    bindingId === null ||
    evidenceRef === null ||
    key === null ||
    requestHash === null ||
    generation === null ||
    number === null ||
    fence === null ||
    lease === null ||
    !validHash(requestHash) ||
    (state !== "leased" && state !== "released" && state !== "consumed")
  )
    return null;
  const kind = optionalStringValue(row, `${prefix}consumption_kind`);
  const resultHash = optionalStringValue(row, `${prefix}result_hash`);
  if (state === "consumed" && (kind === null || resultHash === null || !validHash(resultHash)))
    return null;
  if (state !== "consumed" && (kind !== null || resultHash !== null)) return null;
  return {
    route_revalidation_attempt_id: id,
    route_revalidation_id: routeId,
    revalidation_session_id: sessionId,
    route_binding_id: bindingId,
    expected_binding_generation: generation,
    expected_verified_evidence_ref: optionalStringValue(
      row,
      `${prefix}expected_verified_evidence_ref`,
    ),
    attempt_number: number,
    idempotency_key: key,
    completion_request_hash: requestHash,
    evidence_ref: evidenceRef,
    state,
    fence_token: fence,
    lease_expires_at: lease,
    consumption_kind: kind as HnsRouteRevalidationCompletionAttempt["consumption_kind"],
    result_hash: resultHash,
  };
}

const sessionColumns = `
 s.revalidation_session_id, s.route_revalidation_id, s.start_fence_token,
 s.community_id, s.route_binding_id, s.principal_kind, s.principal_id,
 s.expected_binding_generation, s.expected_verified_evidence_ref, s.requirement_hash,
 s.start_request_hash, s.provider_id, s.provider_binding_hash,
 s.provider_configuration_kind, s.provider_configuration_reference,
 s.provider_configuration_version, s.protocol_version, s.environment, s.family,
 s.root_label, s.root_label_display, s.path_segment, s.upstream_session_ref,
 s.start_presentation, s.status, s.started_at, s.expires_at, s.terminal_at`;

const attemptColumns = (alias: string, prefix: string) => `
 ${alias}.route_revalidation_attempt_id AS ${prefix}attempt_id,
 ${alias}.route_revalidation_id AS ${prefix}route_revalidation_id,
 ${alias}.revalidation_session_id AS ${prefix}revalidation_session_id,
 ${alias}.route_binding_id AS ${prefix}route_binding_id,
 ${alias}.expected_binding_generation AS ${prefix}expected_binding_generation,
 ${alias}.expected_verified_evidence_ref AS ${prefix}expected_verified_evidence_ref,
 ${alias}.attempt_number AS ${prefix}attempt_number,
 ${alias}.idempotency_key AS ${prefix}idempotency_key,
 ${alias}.completion_request_hash AS ${prefix}completion_request_hash,
 ${alias}.evidence_ref AS ${prefix}evidence_ref,
 ${alias}.state AS ${prefix}state, ${alias}.fence_token AS ${prefix}fence_token,
 ${alias}.lease_expires_at AS ${prefix}lease_expires_at,
 ${alias}.consumption_kind AS ${prefix}consumption_kind,
 ${alias}.result_hash AS ${prefix}result_hash`;

function storedFromRow(row: Row): HnsRouteRevalidationStoredCompletion | null {
  const session = sessionFromRow(row);
  const expectedGeneration = integerValue(row.expected_binding_generation);
  const status = row.status;
  const sessionStatus = status as HnsRouteRevalidationSessionV1["status"];
  const current = attemptFromRow(row, "current_");
  const terminalAttempt = attemptFromRow(row, "terminal_");
  if (session === null || expectedGeneration === null || session.status !== sessionStatus)
    return null;
  if (sessionStatus === "pending") {
    return terminalAttempt === null
      ? {
          route_revalidation_id: session.authority.route_revalidation_id,
          revalidation_session_id: session.revalidation_session_id,
          expected_binding_generation: expectedGeneration,
          session,
          status: sessionStatus,
          terminal: null,
          attempt: current,
        }
      : null;
  }
  if (
    terminalAttempt === null ||
    terminalAttempt.state !== "consumed" ||
    terminalAttempt.consumption_kind === null ||
    terminalAttempt.result_hash === null
  )
    return null;
  return {
    route_revalidation_id: session.authority.route_revalidation_id,
    revalidation_session_id: session.revalidation_session_id,
    expected_binding_generation: expectedGeneration,
    session,
    status: sessionStatus,
    terminal: {
      status: terminalAttempt.consumption_kind,
      idempotency_key: terminalAttempt.idempotency_key,
      completion_request_hash: terminalAttempt.completion_request_hash,
      result_hash: terminalAttempt.result_hash,
    },
    attempt: current,
  };
}

function loadStored(
  transaction: Transaction,
  input: Readonly<{
    route_revalidation_id: string;
    revalidation_session_id: string;
    idempotency_key: string;
  }>,
): Effect.Effect<
  HnsRouteRevalidationStoredCompletion | null,
  ControlPlaneError | HnsRouteRevalidationCompletionStorageFailed
> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "route-revalidation.completion.load",
      text: `SELECT ${sessionColumns}, ${attemptColumns("a", "current_")},
                    ${attemptColumns("ta", "terminal_")}
               FROM community_route_revalidation_sessions AS s
               LEFT JOIN community_route_revalidation_completion_attempts AS a
                 ON a.route_revalidation_id = s.route_revalidation_id
                AND a.revalidation_session_id = s.revalidation_session_id
                AND a.idempotency_key = $3
               LEFT JOIN LATERAL (
                 SELECT * FROM community_route_revalidation_completion_attempts AS latest
                  WHERE latest.route_revalidation_id = s.route_revalidation_id
                    AND latest.revalidation_session_id = s.revalidation_session_id
                    AND latest.state = 'consumed'
                  ORDER BY latest.attempt_number DESC
                  LIMIT 1
               ) AS ta ON TRUE
              WHERE s.route_revalidation_id = $1
                AND s.revalidation_session_id = $2`,
      values: [input.route_revalidation_id, input.revalidation_session_id, input.idempotency_key],
      readonly: true,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    return row === null ? null : (storedFromRow(row) ?? (yield* Effect.fail(storageFailure())));
  });
}

function databaseNow(
  transaction: Transaction,
): Effect.Effect<string, ControlPlaneError | HnsRouteRevalidationCompletionStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "route-revalidation.completion.database-clock",
      text: "SELECT clock_timestamp() AS database_now",
      values: [],
      readonly: false,
    });
    const row = oneRow(result);
    const now = row === null || row === undefined ? null : timestampValue(row, "database_now");
    return now === null ? yield* Effect.fail(storageFailure()) : now;
  });
}

function lockRoute(
  transaction: Transaction,
  session: HnsRouteRevalidationSessionV1,
  requireExpected: boolean,
): Effect.Effect<Row | null, ControlPlaneError | HnsRouteRevalidationCompletionStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "route-revalidation.completion.lock-community-binding",
      text: `SELECT c.community_id, c.status AS community_status, c.canonical_route_binding_id,
                    b.route_binding_id, b.family, b.root_label, b.root_label_display, b.path_segment,
                    b.binding_generation, b.verified_evidence_ref, b.ownership_status,
                    b.route_lifecycle_status
               FROM communities AS c
               JOIN community_canonical_route_bindings AS b
                 ON b.community_id = c.community_id
                AND b.route_binding_id = $2
              WHERE c.community_id = $1
              FOR UPDATE OF c, b`,
      values: [session.authority.community_id, session.authority.route_binding_id],
      readonly: false,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    if (
      row === null ||
      row.community_status !== "active" ||
      row.canonical_route_binding_id !== session.authority.route_binding_id
    )
      return null;
    if (
      row.family !== session.authority.family ||
      row.root_label !== session.authority.root_label ||
      row.root_label_display !== session.authority.root_label_display ||
      row.path_segment !== session.authority.path_segment
    )
      return null;
    if (
      requireExpected &&
      (integerValue(row.binding_generation) !== session.authority.expected_binding_generation ||
        row.verified_evidence_ref !== session.authority.expected_verified_evidence_ref)
    )
      return null;
    return row;
  });
}

function reservationFromAttempt(row: Row, prefix = "current_"): Reservation | null {
  const attempt = attemptFromRow(row, prefix);
  if (attempt === null || attempt.state !== "leased") return null;
  return {
    route_revalidation_attempt_id: attempt.route_revalidation_attempt_id,
    route_revalidation_id: attempt.route_revalidation_id,
    revalidation_session_id: attempt.revalidation_session_id,
    route_binding_id: attempt.route_binding_id,
    expected_binding_generation: attempt.expected_binding_generation,
    expected_verified_evidence_ref: attempt.expected_verified_evidence_ref,
    attempt_number: attempt.attempt_number,
    idempotency_key: attempt.idempotency_key,
    completion_request_hash: attempt.completion_request_hash,
    evidence_ref: attempt.evidence_ref,
    fence_token: attempt.fence_token,
    lease_expires_at: attempt.lease_expires_at,
  };
}

const attemptSelect = attemptColumns("a", "current_");
const attemptReturning = `
 route_revalidation_attempt_id AS current_attempt_id,
 route_revalidation_id AS current_route_revalidation_id,
 revalidation_session_id AS current_revalidation_session_id,
 route_binding_id AS current_route_binding_id,
 expected_binding_generation AS current_expected_binding_generation,
 expected_verified_evidence_ref AS current_expected_verified_evidence_ref,
 attempt_number AS current_attempt_number, idempotency_key AS current_idempotency_key,
 completion_request_hash AS current_completion_request_hash, evidence_ref AS current_evidence_ref,
 state AS current_state, fence_token AS current_fence_token,
 lease_expires_at AS current_lease_expires_at,
 consumption_kind AS current_consumption_kind, result_hash AS current_result_hash`;

function replayOrConflict(
  stored: HnsRouteRevalidationStoredCompletion,
  input: Readonly<{ idempotency_key: string; completion_request_hash: string }>,
): HnsRouteRevalidationCompletionReservationOutcome {
  if (stored.terminal === null) return { kind: "consumed" };
  return stored.terminal.idempotency_key === input.idempotency_key &&
    stored.terminal.completion_request_hash === input.completion_request_hash
    ? { kind: "replay", stored }
    : { kind: "idempotency_conflict" };
}

function makeStore(db: ControlPlaneDb["Service"]): HnsRouteRevalidationCompletionStore {
  const load = (input: Parameters<HnsRouteRevalidationCompletionStore["load"]>[0]) =>
    loadStored(db, input).pipe(
      Effect.mapError((error) =>
        error instanceof HnsRouteRevalidationCompletionStorageFailed ? error : storageFailure(),
      ),
    );

  const reserve = (input: Parameters<HnsRouteRevalidationCompletionStore["reserve"]>[0]) =>
    db
      .withTransaction<
        HnsRouteRevalidationCompletionReservationOutcome,
        HnsRouteRevalidationCompletionStorageFailed | ControlPlaneError,
        never
      >((transaction) =>
        Effect.gen(function* () {
          if (
            input.lease_ms <= 0 ||
            input.lease_ms > 16_000 ||
            input.max_consumed_attempts !== 3 ||
            !validHash(input.completion_request_hash)
          )
            return { kind: "binding_conflict" } as const;
          const initial = yield* loadStored(transaction, input);
          if (initial === null) return { kind: "not_found" } as const;
          if (
            initial.session.authority.expected_binding_generation !==
              input.expected_binding_generation ||
            initial.session.authority.expected_verified_evidence_ref !==
              input.expected_verified_evidence_ref
          )
            return { kind: "binding_conflict" } as const;
          if (initial.terminal !== null) return replayOrConflict(initial, input);
          const routeLock = yield* lockRoute(transaction, initial.session, true);
          if (routeLock === null) return { kind: "binding_conflict" } as const;
          const lock = yield* transaction.execute<Row>({
            label: "route-revalidation.completion.lock-session",
            text: `SELECT ${sessionColumns} FROM community_route_revalidation_sessions AS s
               WHERE s.route_revalidation_id = $1 AND s.revalidation_session_id = $2 FOR UPDATE`,
            values: [input.route_revalidation_id, input.revalidation_session_id],
            readonly: false,
          });
          if (oneRow(lock) === undefined || oneRow(lock) === null)
            return { kind: "not_found" } as const;
          const current = yield* loadStored(transaction, input);
          if (current === null) return { kind: "not_found" } as const;
          if (current.terminal !== null) return replayOrConflict(current, input);
          const now = yield* databaseNow(transaction);
          const existingResult = yield* transaction.execute<Row>({
            label: "route-revalidation.completion.lock-attempt",
            text: `SELECT ${attemptSelect} FROM community_route_revalidation_completion_attempts AS a
               WHERE a.route_revalidation_id = $1 AND a.revalidation_session_id = $2
                 AND a.idempotency_key = $3 FOR UPDATE`,
            values: [
              input.route_revalidation_id,
              input.revalidation_session_id,
              input.idempotency_key,
            ],
            readonly: false,
          });
          const existing = oneRow(existingResult);
          if (existing === undefined) return yield* Effect.fail(storageFailure());
          if (existing !== null) {
            const existingAttempt = attemptFromRow(existing, "current_");
            if (
              existingAttempt === null ||
              existingAttempt.completion_request_hash !== input.completion_request_hash
            )
              return { kind: "idempotency_conflict" } as const;
            if (existingAttempt.state === "consumed") return { kind: "consumed" } as const;
            const leaseLive = Date.parse(existingAttempt.lease_expires_at) > Date.parse(now);
            if (existingAttempt.state === "leased" && leaseLive)
              return {
                kind: "in_flight",
                retry_after_seconds: Math.max(
                  1,
                  Math.ceil(
                    (Date.parse(existingAttempt.lease_expires_at) - Date.parse(now)) / 1000,
                  ),
                ),
              } as const;
            const reacquired = yield* transaction.execute<Row>({
              label: "route-revalidation.completion.reacquire-attempt",
              text: `UPDATE community_route_revalidation_completion_attempts
                    SET state = 'leased', fence_token = fence_token + 1,
                        lease_expires_at = LEAST(clock_timestamp() + ($4 * INTERVAL '1 millisecond'),
                                                (SELECT expires_at FROM community_route_revalidation_sessions WHERE revalidation_session_id = $2))
                  WHERE route_revalidation_id = $1 AND revalidation_session_id = $2
                    AND idempotency_key = $3 AND (state = 'released' OR lease_expires_at <= clock_timestamp())
                  RETURNING ${attemptReturning}`,
              values: [
                input.route_revalidation_id,
                input.revalidation_session_id,
                input.idempotency_key,
                input.lease_ms,
              ],
              readonly: false,
            });
            const row = oneRow(reacquired);
            const reservation =
              row === null || row === undefined ? null : reservationFromAttempt(row);
            return reservation === null
              ? ({ kind: "binding_conflict" } as const)
              : ({ kind: "acquired", reservation } as const);
          }
          const leased = yield* transaction.execute<Row>({
            label: "route-revalidation.completion.find-live-attempt",
            text: `SELECT route_revalidation_attempt_id, lease_expires_at
                 FROM community_route_revalidation_completion_attempts
                WHERE revalidation_session_id = $1 AND state = 'leased' FOR UPDATE`,
            values: [input.revalidation_session_id],
            readonly: false,
          });
          const leasedRow = oneRow(leased);
          if (leasedRow === undefined) return yield* Effect.fail(storageFailure());
          if (
            leasedRow !== null &&
            Date.parse(String(leasedRow.lease_expires_at)) > Date.parse(now)
          )
            return { kind: "in_flight", retry_after_seconds: 1 } as const;
          const consumed = yield* transaction.execute<Row>({
            label: "route-revalidation.completion.count-consumed",
            text: `SELECT count(*)::integer AS count FROM community_route_revalidation_completion_attempts
               WHERE route_revalidation_id = $1 AND state = 'consumed'`,
            values: [input.route_revalidation_id],
            readonly: false,
          });
          const consumedRow = oneRow(consumed);
          const consumedCount =
            consumedRow === null || consumedRow === undefined
              ? null
              : integerValue(consumedRow.count);
          if (consumedCount === null) return yield* Effect.fail(storageFailure());
          if (consumedCount >= input.max_consumed_attempts)
            return { kind: "budget_exhausted" } as const;
          const inserted = yield* transaction.execute<Row>({
            label: "route-revalidation.completion.insert-attempt",
            text: `INSERT INTO community_route_revalidation_completion_attempts (
                 route_revalidation_attempt_id, route_revalidation_id, revalidation_session_id,
                 route_binding_id, expected_binding_generation, expected_verified_evidence_ref,
                 attempt_number, idempotency_key, completion_request_hash, evidence_ref,
                 state, fence_token, lease_expires_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'leased',1,
                 LEAST(clock_timestamp() + ($11 * INTERVAL '1 millisecond'),
                       (SELECT expires_at FROM community_route_revalidation_sessions WHERE revalidation_session_id = $3)))
               RETURNING ${attemptReturning}`,
            values: [
              input.completion_attempt_id,
              input.route_revalidation_id,
              input.revalidation_session_id,
              initial.session.authority.route_binding_id,
              input.expected_binding_generation,
              input.expected_verified_evidence_ref,
              consumedCount + 1,
              input.idempotency_key,
              input.completion_request_hash,
              input.evidence_ref,
              input.lease_ms,
            ],
            readonly: false,
          });
          const row = oneRow(inserted);
          const reservation =
            row === null || row === undefined ? null : reservationFromAttempt(row);
          return reservation === null
            ? ({ kind: "binding_conflict" } as const)
            : ({ kind: "acquired", reservation } as const);
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof HnsRouteRevalidationCompletionStorageFailed ? error : storageFailure(),
        ),
      );

  const release = (input: Parameters<HnsRouteRevalidationCompletionStore["release"]>[0]) =>
    db
      .withTransaction<
        HnsRouteRevalidationCompletionReleaseOutcome,
        HnsRouteRevalidationCompletionStorageFailed | ControlPlaneError,
        never
      >((transaction) =>
        Effect.gen(function* () {
          const route = yield* lockRoute(transaction, input.expected.session, false);
          if (route === null) return { kind: "binding_conflict" } as const;
          const now = yield* databaseNow(transaction);
          const stateResult = yield* transaction.execute<Row>({
            label: "route-revalidation.completion.lock-release-attempt",
            text: `SELECT state, fence_token, lease_expires_at, idempotency_key, completion_request_hash
                 FROM community_route_revalidation_completion_attempts
                WHERE route_revalidation_attempt_id = $1 AND revalidation_session_id = $2 FOR UPDATE`,
            values: [
              input.attempt.route_revalidation_attempt_id,
              input.attempt.revalidation_session_id,
            ],
            readonly: false,
          });
          const row = oneRow(stateResult);
          if (row === undefined || row === null) return { kind: "lease_lost" } as const;
          if (row.state === "consumed") {
            const stored = yield* loadStored(transaction, {
              route_revalidation_id: input.expected.route_revalidation_id,
              revalidation_session_id: input.expected.revalidation_session_id,
              idempotency_key: input.idempotency_key,
            });
            return stored?.terminal !== null &&
              stored?.terminal.idempotency_key === input.idempotency_key &&
              stored.terminal.completion_request_hash === input.completion_request_hash
              ? ({ kind: "replay", stored } as const)
              : ({ kind: "lease_lost" } as const);
          }
          if (
            integerValue(row.fence_token) !== input.attempt.fence_token ||
            row.idempotency_key !== input.idempotency_key ||
            row.completion_request_hash !== input.completion_request_hash
          )
            return { kind: "lease_lost" } as const;
          if (Date.parse(String(row.lease_expires_at)) <= Date.parse(now))
            return { kind: "lease_lost" } as const;
          const expired = Date.parse(input.expected.session.expires_at) <= Date.parse(now);
          if (expired) {
            const consumed = yield* consumeAttempt(
              transaction,
              input.attempt,
              input.idempotency_key,
              input.completion_request_hash,
              "session_expired",
              input.expired_result_hash,
              now,
            );
            if (!consumed) return { kind: "lease_lost" } as const;
            const transitioned = yield* expireSession(transaction, input.expected, now);
            return transitioned
              ? ({ kind: "expired", result_hash: input.expired_result_hash } as const)
              : ({ kind: "lease_lost" } as const);
          }
          const released = yield* transaction.execute({
            label: "route-revalidation.completion.release-attempt",
            text: `UPDATE community_route_revalidation_completion_attempts
                  SET state = 'released', updated_at = $4::timestamptz
                WHERE route_revalidation_attempt_id = $1 AND revalidation_session_id = $2
                  AND fence_token = $3 AND state = 'leased' AND lease_expires_at > $4::timestamptz`,
            values: [
              input.attempt.route_revalidation_attempt_id,
              input.attempt.revalidation_session_id,
              input.attempt.fence_token,
              now,
            ],
            readonly: false,
          });
          return released.rowCount === 1
            ? ({ kind: "released" } as const)
            : ({ kind: "lease_lost" } as const);
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof HnsRouteRevalidationCompletionStorageFailed ? error : storageFailure(),
        ),
      );

  const finalizeFailure = (input: Parameters<HnsRouteRevalidationCompletionStore["reject"]>[0]) =>
    db
      .withTransaction<
        HnsRouteRevalidationCompletionFinalizeOutcome,
        HnsRouteRevalidationCompletionStorageFailed | ControlPlaneError,
        never
      >((transaction) =>
        Effect.gen(function* () {
          const route = yield* lockRoute(transaction, input.expected.session, false);
          if (route === null) return { kind: "binding_conflict" } as const;
          const now = yield* databaseNow(transaction);
          const current = yield* loadStored(transaction, {
            route_revalidation_id: input.expected.route_revalidation_id,
            revalidation_session_id: input.expected.revalidation_session_id,
            idempotency_key: input.idempotency_key,
          });
          if (current === null) return { kind: "binding_conflict" } as const;
          if (current.terminal !== null) {
            return current.terminal.idempotency_key === input.idempotency_key &&
              current.terminal.completion_request_hash === input.completion_request_hash &&
              current.terminal.result_hash === input.result_hash
              ? ({
                  kind: "replay",
                  status: current.terminal.status,
                  result_hash: current.terminal.result_hash,
                } as const)
              : ({ kind: "binding_conflict" } as const);
          }
          const attempt = current.attempt;
          if (
            attempt === null ||
            attempt.state !== "leased" ||
            attempt.fence_token !== input.attempt.fence_token ||
            attempt.completion_request_hash !== input.completion_request_hash
          )
            return { kind: "lease_lost" } as const;
          if (Date.parse(attempt.lease_expires_at) <= Date.parse(now)) {
            if (Date.parse(input.expected.session.expires_at) <= Date.parse(now)) {
              const consumed = yield* consumeAttempt(
                transaction,
                input.attempt,
                input.idempotency_key,
                input.completion_request_hash,
                "session_expired",
                input.expired_result_hash,
                now,
              );
              if (consumed && (yield* expireSession(transaction, input.expected, now)))
                return { kind: "expired", result_hash: input.expired_result_hash } as const;
            }
            return { kind: "lease_lost" } as const;
          }
          const consumed = yield* consumeAttempt(
            transaction,
            input.attempt,
            input.idempotency_key,
            input.completion_request_hash,
            input.status,
            input.result_hash,
            now,
          );
          if (!consumed) return { kind: "lease_lost" } as const;
          const transitioned = yield* transitionSession(
            transaction,
            input.expected,
            input.status === "session_expired" ? "expired" : "failed",
            now,
          );
          return transitioned
            ? ({ kind: "committed", status: input.status, result_hash: input.result_hash } as const)
            : ({ kind: "binding_conflict" } as const);
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof HnsRouteRevalidationCompletionStorageFailed ? error : storageFailure(),
        ),
      );

  const reject = (input: Parameters<HnsRouteRevalidationCompletionStore["reject"]>[0]) =>
    finalizeFailure(input);
  const consume = (input: Parameters<HnsRouteRevalidationCompletionStore["consume"]>[0]) =>
    finalizeFailure(input);

  const verify = (input: Parameters<HnsRouteRevalidationCompletionStore["verify"]>[0]) =>
    db
      .withTransaction<
        HnsRouteRevalidationCompletionFinalizeOutcome,
        HnsRouteRevalidationCompletionStorageFailed | ControlPlaneError,
        never
      >((transaction) =>
        Effect.gen(function* () {
          const route = yield* lockRoute(transaction, input.expected.session, false);
          if (route === null) return { kind: "binding_conflict" } as const;
          const now = yield* databaseNow(transaction);
          const current = yield* loadStored(transaction, {
            route_revalidation_id: input.expected.route_revalidation_id,
            revalidation_session_id: input.expected.revalidation_session_id,
            idempotency_key: input.idempotency_key,
          });
          if (current === null) return { kind: "binding_conflict" } as const;
          if (current.terminal !== null) {
            return current.terminal.idempotency_key === input.idempotency_key &&
              current.terminal.completion_request_hash === input.completion_request_hash &&
              current.terminal.result_hash === input.result_hash
              ? ({
                  kind: "replay",
                  status: current.terminal.status,
                  result_hash: current.terminal.result_hash,
                } as const)
              : ({ kind: "binding_conflict" } as const);
          }
          const attempt = current.attempt;
          if (
            attempt === null ||
            attempt.state !== "leased" ||
            attempt.fence_token !== input.attempt.fence_token ||
            attempt.completion_request_hash !== input.completion_request_hash
          )
            return { kind: "lease_lost" } as const;
          if (Date.parse(attempt.lease_expires_at) <= Date.parse(now))
            return { kind: "lease_lost" } as const;
          const authorityMatches =
            integerValue(route.binding_generation) ===
              input.expected.session.authority.expected_binding_generation &&
            route.verified_evidence_ref ===
              input.expected.session.authority.expected_verified_evidence_ref &&
            route.ownership_status ===
              (input.expected.session.authority.expected_verified_evidence_ref === null
                ? route.ownership_status
                : "verified") &&
            route.route_lifecycle_status ===
              (input.expected.session.authority.expected_verified_evidence_ref === null
                ? route.route_lifecycle_status
                : "active");
          if (!authorityMatches) {
            const consumed = yield* consumeAttempt(
              transaction,
              input.attempt,
              input.idempotency_key,
              input.completion_request_hash,
              "stale_cas",
              input.result_hash,
              now,
            );
            if (consumed && (yield* transitionSession(transaction, input.expected, "failed", now)))
              return { kind: "stale_cas" } as const;
            return { kind: "lease_lost" } as const;
          }
          const envelope = input.verified.envelope;
          const updated = yield* transaction.execute({
            label: "route-revalidation.completion.advance-binding",
            text: `UPDATE community_canonical_route_bindings
                  SET binding_generation = $1, verified_evidence_ref = $2,
                      ownership_status = 'verified', route_lifecycle_status = 'active', updated_at = $3::timestamptz
                WHERE community_id = $4 AND route_binding_id = $5
                  AND binding_generation = $6 AND verified_evidence_ref IS NOT DISTINCT FROM $7
                RETURNING route_binding_id`,
            values: [
              envelope.binding_generation,
              envelope.evidence_ref,
              now,
              envelope.community_id,
              envelope.route_binding_id,
              envelope.expected_binding_generation,
              envelope.expected_verified_evidence_ref,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1) return { kind: "stale_cas" } as const;
          if (
            !(yield* consumeAttempt(
              transaction,
              input.attempt,
              input.idempotency_key,
              input.completion_request_hash,
              "verified",
              input.result_hash,
              now,
            ))
          )
            return { kind: "lease_lost" } as const;
          if (!(yield* transitionSession(transaction, input.expected, "completed", now)))
            return { kind: "binding_conflict" } as const;
          const observation = JSON.stringify({
            status: "verified",
            observation: input.verified.observation,
          });
          const snapshot = yield* transaction.execute({
            label: "route-revalidation.completion.insert-evidence-snapshot",
            text: `INSERT INTO community_route_revalidation_evidence_snapshots (
          evidence_ref, route_revalidation_attempt_id, route_revalidation_id, revalidation_session_id,
          community_id, route_binding_id, principal_kind, principal_id, requirement_hash,
          expected_binding_generation, binding_generation, expected_verified_evidence_ref, start_request_hash,
          provider_id, provider_binding_hash, provider_configuration_kind, provider_configuration_reference,
          provider_configuration_version, protocol_version, environment, family, root_label, root_label_display,
          path_segment, upstream_session_ref, fence_token, abi_version, ownership_source, challenge_name,
          challenge_value_sha256, root_exists, root_control_verified, expiry_horizon_sufficient,
          chain_network, chain_anchor_height, chain_anchor_block_hash, chain_anchor_median_time, expiry_height,
          observed_at, expires_at, provider_evidence_ref, observation_sha256, provider_identity_digest,
          evidence_digest, observation, raw_response_bytes
        ) VALUES (${Array.from({ length: 46 }, (_, i) => `$${i + 1}`).join(", ")})`,
            values: [
              envelope.evidence_ref,
              envelope.route_revalidation_attempt_id,
              envelope.route_revalidation_id,
              envelope.revalidation_session_id,
              envelope.community_id,
              envelope.route_binding_id,
              envelope.principal_kind,
              envelope.principal_id,
              envelope.requirement_hash,
              envelope.expected_binding_generation,
              envelope.binding_generation,
              envelope.expected_verified_evidence_ref,
              envelope.start_request_hash,
              envelope.provider_id,
              envelope.provider_binding_hash,
              envelope.provider_configuration_kind,
              envelope.provider_configuration_reference,
              envelope.provider_configuration_version,
              envelope.protocol_version,
              envelope.environment,
              envelope.family,
              envelope.root_label,
              envelope.root_label_display,
              envelope.path_segment,
              envelope.upstream_session_ref,
              input.attempt.fence_token,
              envelope.version,
              envelope.ownership_source,
              envelope.challenge_name,
              envelope.challenge_value_sha256,
              envelope.root_exists,
              envelope.root_control_verified,
              envelope.expiry_horizon_sufficient,
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
              observation,
              input.verified.raw_response_bytes,
            ],
            readonly: false,
          });
          if (snapshot.rowCount !== 1) return { kind: "binding_conflict" } as const;
          const evidence = yield* transaction.execute({
            label: "route-revalidation.completion.insert-route-evidence",
            text: `INSERT INTO community_route_ownership_evidence (
          evidence_ref, creation_ceremony_intent_id, verified_by_actor_id, family, root_label,
          root_label_display, path_segment, requirement_hash, provider_id, provider_binding_hash,
          provider_configuration_version, provider_identity_digest, evidence_digest, evidence_receipt_id,
          binding_generation, verified_at, expires_at, origin, route_revalidation_attempt_id
        ) VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $13::timestamptz, $14::timestamptz, 'route_revalidation', $15)`,
            values: [
              envelope.evidence_ref,
              envelope.family,
              envelope.root_label,
              envelope.root_label_display,
              envelope.path_segment,
              envelope.requirement_hash,
              envelope.provider_id,
              envelope.provider_binding_hash,
              envelope.provider_configuration_version,
              envelope.provider_identity_digest,
              envelope.evidence_digest,
              envelope.binding_generation,
              envelope.observed_at,
              envelope.expires_at,
              envelope.route_revalidation_attempt_id,
            ],
            readonly: false,
          });
          if (evidence.rowCount !== 1) return { kind: "binding_conflict" } as const;
          return {
            kind: "committed" as const,
            status: "verified" as const,
            result_hash: input.result_hash,
          };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof HnsRouteRevalidationCompletionStorageFailed ? error : storageFailure(),
        ),
      );

  return { load, reserve, release, reject, consume, verify };
}

function consumeAttempt(
  transaction: Transaction,
  attempt: Reservation,
  idempotencyKey: string,
  requestHash: string,
  kind: HnsRouteRevalidationCompletionAttempt["consumption_kind"] & string,
  resultHash: string,
  now: string,
): Effect.Effect<boolean, ControlPlaneError | HnsRouteRevalidationCompletionStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute({
      label: "route-revalidation.completion.consume-attempt",
      text: `UPDATE community_route_revalidation_completion_attempts
                SET state = 'consumed', consumption_kind = $1, result_hash = $2,
                    terminal_at = $3::timestamptz, updated_at = $3::timestamptz
              WHERE route_revalidation_attempt_id = $4 AND revalidation_session_id = $5
                AND idempotency_key = $6 AND completion_request_hash = $7
                AND fence_token = $8 AND state = 'leased'`,
      values: [
        kind,
        resultHash,
        now,
        attempt.route_revalidation_attempt_id,
        attempt.revalidation_session_id,
        idempotencyKey,
        requestHash,
        attempt.fence_token,
      ],
      readonly: false,
    });
    return result.rowCount === 1;
  });
}

function transitionSession(
  transaction: Transaction,
  stored: HnsRouteRevalidationStoredCompletion,
  status: "completed" | "failed" | "expired",
  now: string,
): Effect.Effect<boolean, ControlPlaneError> {
  return transaction
    .execute({
      label: "route-revalidation.completion.transition-session",
      text: `UPDATE community_route_revalidation_sessions
              SET status = $1, terminal_at = $2::timestamptz, updated_at = $2::timestamptz
            WHERE route_revalidation_id = $3 AND revalidation_session_id = $4 AND status = 'pending'`,
      values: [status, now, stored.route_revalidation_id, stored.revalidation_session_id],
      readonly: false,
    })
    .pipe(Effect.map((result) => result.rowCount === 1));
}

function expireSession(
  transaction: Transaction,
  stored: HnsRouteRevalidationStoredCompletion,
  now: string,
): Effect.Effect<boolean, ControlPlaneError> {
  return transitionSession(transaction, stored, "expired", now);
}

export function makeControlPlaneRouteRevalidationCompletionStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HnsRouteRevalidationCompletionStore {
  const provide = <A, E>(use: (db: ControlPlaneDb["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* use(db);
    }).pipe(
      Effect.provide(runtime),
      Effect.mapError((error) =>
        error instanceof HnsRouteRevalidationCompletionStorageFailed ? error : storageFailure(),
      ),
    );
  const store = {
    load: (input: Parameters<HnsRouteRevalidationCompletionStore["load"]>[0]) =>
      provide((db) => makeStore(db).load(input)),
    reserve: (input: Parameters<HnsRouteRevalidationCompletionStore["reserve"]>[0]) =>
      provide((db) => makeStore(db).reserve(input)),
    release: (input: Parameters<HnsRouteRevalidationCompletionStore["release"]>[0]) =>
      provide((db) => makeStore(db).release(input)),
    reject: (input: Parameters<HnsRouteRevalidationCompletionStore["reject"]>[0]) =>
      provide((db) => makeStore(db).reject(input)),
    consume: (input: Parameters<HnsRouteRevalidationCompletionStore["consume"]>[0]) =>
      provide((db) => makeStore(db).consume(input)),
    verify: (input: Parameters<HnsRouteRevalidationCompletionStore["verify"]>[0]) =>
      provide((db) => makeStore(db).verify(input)),
  } satisfies HnsRouteRevalidationCompletionStore;
  return store;
}

export function makeControlPlaneRouteRevalidationCompletionRepository(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HnsRouteRevalidationCompletionStore {
  return makeControlPlaneRouteRevalidationCompletionStore(runtime);
}

