import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneTransaction,
  type HnsRouteRevalidationSessionV1,
  type HnsRouteRevalidationStartAuthority,
  type HnsRouteRevalidationStartReplayOutcome,
  type HnsRouteRevalidationStartReservation,
  type HnsRouteRevalidationStartReservationInput,
  type HnsRouteRevalidationStartReservationOutcome,
  HnsRouteRevalidationStartStorageFailed,
  type HnsRouteRevalidationStartStore,
  type HnsRouteRevalidationProviderStartResult as ProviderStartResult,
} from "@pirate/application";
import { HnsTxtChallengeV1 } from "@pirate/contracts";
import { ProviderConfigurationRef, Sha256Hex } from "@pirate/domain/verification";
import { Effect, type Layer, Option, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;
const exactParseOptions = { onExcessProperty: "error" } as const;

const storageFailure = (): HnsRouteRevalidationStartStorageFailed =>
  new HnsRouteRevalidationStartStorageFailed();

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

function safeIntegerValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function timestampValue(row: Row, name: string): string | null {
  const raw = row[name];
  const value =
    raw instanceof Date && Number.isFinite(raw.getTime())
      ? raw.toISOString()
      : typeof raw === "string"
        ? raw
        : null;
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
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

function routeMatches(row: Row, authority: HnsRouteRevalidationStartAuthority): boolean {
  return (
    row.community_id === authority.community_id &&
    row.route_binding_id === authority.route_binding_id &&
    row.family === authority.family &&
    row.root_label === authority.root_label &&
    row.root_label_display === authority.root_label_display &&
    row.path_segment === authority.path_segment &&
    safeIntegerValue(row.binding_generation) === authority.expected_binding_generation &&
    row.verified_evidence_ref === authority.expected_verified_evidence_ref
  );
}

function reservationMatchesAuthority(
  row: Row,
  authority: HnsRouteRevalidationStartAuthority,
): boolean {
  return (
    row.community_id === authority.community_id &&
    row.route_binding_id === authority.route_binding_id &&
    safeIntegerValue(row.expected_binding_generation) === authority.expected_binding_generation &&
    row.expected_verified_evidence_ref === authority.expected_verified_evidence_ref &&
    row.principal_kind === authority.principal_kind &&
    row.principal_id === authority.principal_id &&
    row.requirement_hash === authority.requirement_hash &&
    row.provider_id === authority.provider_id &&
    row.provider_binding_hash === authority.provider_binding_hash &&
    row.provider_configuration_kind === authority.provider_configuration_kind &&
    row.provider_configuration_reference === authority.provider_configuration_reference &&
    row.provider_configuration_version === authority.provider_configuration_version &&
    row.protocol_version === authority.protocol_version &&
    row.environment === authority.environment &&
    row.family === authority.family &&
    row.root_label === authority.root_label &&
    row.root_label_display === authority.root_label_display &&
    row.path_segment === authority.path_segment
  );
}

const AuthorityColumns = `
  c.community_id,
  c.status AS community_status,
  c.canonical_route_binding_id,
  b.route_binding_id,
  b.family,
  b.root_label,
  b.root_label_display,
  b.path_segment,
  b.binding_generation,
  b.verified_evidence_ref,
  b.ownership_status,
  b.route_lifecycle_status,
  EXISTS (
    SELECT 1
      FROM effective_active_route(c.community_id, clock_timestamp()) AS effective
     WHERE effective.route_binding_id = b.route_binding_id
  ) AS is_effective_active_route`;

function lockRoute(
  transaction: Transaction,
  authority: HnsRouteRevalidationStartAuthority,
): Effect.Effect<Row | null, ControlPlaneError | HnsRouteRevalidationStartStorageFailed> {
  return Effect.fn("routeRevalidationStart.lockRoute")(function* (): Effect.fn.Return<
    Row | null,
    ControlPlaneError | HnsRouteRevalidationStartStorageFailed,
    never
  > {
    // The migration trigger uses this same common order: community -> binding.
    const result = yield* transaction.execute<Row>({
      label: "route-revalidation.start.lock-community-binding",
      text: `SELECT ${AuthorityColumns}
               FROM communities AS c
               JOIN community_canonical_route_bindings AS b
                 ON b.community_id = c.community_id
                AND b.route_binding_id = $2
              WHERE c.community_id = $1
              FOR UPDATE OF c, b`,
      values: [authority.community_id, authority.route_binding_id],
      readonly: false,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    if (row === null) return null;
    if (
      row.community_status !== "active" ||
      row.canonical_route_binding_id !== authority.route_binding_id ||
      !routeMatches(row, authority) ||
      (authority.expected_verified_evidence_ref !== null && row.is_effective_active_route !== true)
    ) {
      return null;
    }
    return row;
  })();
}

function databaseNow(
  transaction: Transaction,
): Effect.Effect<string, ControlPlaneError | HnsRouteRevalidationStartStorageFailed> {
  return Effect.fn("routeRevalidationStart.databaseNow")(function* (): Effect.fn.Return<
    string,
    ControlPlaneError | HnsRouteRevalidationStartStorageFailed,
    never
  > {
    const result = yield* transaction.execute<Row>({
      label: "route-revalidation.start.database-clock",
      text: "SELECT clock_timestamp() AS database_now",
      values: [],
      readonly: false,
    });
    const row = oneRow(result);
    const now = row === null || row === undefined ? null : timestampValue(row, "database_now");
    return now === null ? yield* Effect.fail(storageFailure()) : now;
  })();
}

const ReservationColumns = `
  route_revalidation_id, revalidation_session_id, community_id, route_binding_id,
  principal_kind, principal_id, expected_binding_generation,
  expected_verified_evidence_ref, requirement_hash, provider_id,
  provider_binding_hash, provider_configuration_kind, provider_configuration_reference,
  provider_configuration_version, protocol_version, environment, family, root_label,
  root_label_display, path_segment, start_request_hash, state, fence_token,
  lease_expires_at`;

const SessionColumns = `
  revalidation_session_id, route_revalidation_id, start_fence_token,
  community_id, route_binding_id, principal_kind, principal_id,
  expected_binding_generation, expected_verified_evidence_ref, requirement_hash,
  start_request_hash, provider_id, provider_binding_hash,
  provider_configuration_kind, provider_configuration_reference,
  provider_configuration_version, protocol_version, environment, family,
  root_label, root_label_display, path_segment, upstream_session_ref,
  start_presentation, status, started_at, expires_at, terminal_at`;

function reservationFromRow(row: Row): HnsRouteRevalidationStartReservation | null {
  const routeRevalidationId = stringValue(row, "route_revalidation_id");
  const sessionId = stringValue(row, "revalidation_session_id");
  const fenceToken = safeIntegerValue(row.fence_token);
  const leaseExpiresAt = timestampValue(row, "lease_expires_at");
  if (
    routeRevalidationId === null ||
    sessionId === null ||
    fenceToken === null ||
    fenceToken < 1 ||
    leaseExpiresAt === null
  ) {
    return null;
  }
  return {
    route_revalidation_id: routeRevalidationId,
    revalidation_session_id: sessionId,
    fence_token: fenceToken,
    lease_expires_at: leaseExpiresAt,
  };
}

function presentationFromRow(row: Row): HnsRouteRevalidationSessionV1["start_presentation"] | null {
  const raw = jsonValue(row, "start_presentation");
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({
      kind: Schema.Literal("embedded_sdk"),
      session_id: Schema.NonEmptyString,
      protocol: Schema.Literal("hns-txt-challenge"),
      version: Schema.Literal("1"),
      payload: HnsTxtChallengeV1,
    }),
    exactParseOptions,
  )(raw);
  return Option.isSome(decoded) ? decoded.value : null;
}

function sessionFromRow(row: Row): HnsRouteRevalidationSessionV1 | null {
  const ids = [
    "revalidation_session_id",
    "route_revalidation_id",
    "community_id",
    "route_binding_id",
    "principal_kind",
    "principal_id",
    "requirement_hash",
    "provider_id",
    "provider_binding_hash",
    "provider_configuration_kind",
    "provider_configuration_reference",
    "provider_configuration_version",
    "protocol_version",
    "environment",
    "root_label",
    "root_label_display",
    "path_segment",
    "start_request_hash",
    "upstream_session_ref",
  ] as const;
  if (ids.some((name) => stringValue(row, name) === null)) return null;
  const routeRevalidationId = stringValue(row, "route_revalidation_id");
  const sessionId = stringValue(row, "revalidation_session_id");
  const communityId = stringValue(row, "community_id");
  const routeBindingId = stringValue(row, "route_binding_id");
  const principalId = stringValue(row, "principal_id");
  const providerId = stringValue(row, "provider_id");
  const environment = stringValue(row, "environment");
  const rootLabel = stringValue(row, "root_label");
  const rootLabelDisplay = stringValue(row, "root_label_display");
  const pathSegment = stringValue(row, "path_segment");
  const upstreamSessionRef = stringValue(row, "upstream_session_ref");
  if (
    routeRevalidationId === null ||
    sessionId === null ||
    communityId === null ||
    routeBindingId === null ||
    principalId === null ||
    providerId === null ||
    environment === null ||
    rootLabel === null ||
    rootLabelDisplay === null ||
    pathSegment === null ||
    upstreamSessionRef === null
  ) {
    return null;
  }
  const generation = safeIntegerValue(row.expected_binding_generation);
  const startFence = safeIntegerValue(row.start_fence_token);
  const startedAt = timestampValue(row, "started_at");
  const expiresAt = timestampValue(row, "expires_at");
  const terminalAt = row.terminal_at === null ? null : timestampValue(row, "terminal_at");
  const presentation = presentationFromRow(row);
  if (
    generation === null ||
    generation < 1 ||
    startFence === null ||
    startFence < 1 ||
    startedAt === null ||
    expiresAt === null ||
    (row.terminal_at !== null && terminalAt === null) ||
    presentation === null ||
    row.principal_kind !== "system" ||
    row.family !== "hns" ||
    row.status !== "pending"
  ) {
    return null;
  }
  const config = Schema.decodeUnknownOption(
    ProviderConfigurationRef,
    exactParseOptions,
  )({
    kind: row.provider_configuration_kind,
    reference: row.provider_configuration_reference,
    version: row.provider_configuration_version,
  });
  if (Option.isNone(config)) return null;
  const providerHash = Schema.decodeUnknownOption(Sha256Hex)(row.provider_binding_hash);
  const requirementHash = Schema.decodeUnknownOption(Sha256Hex)(row.requirement_hash);
  const startRequestHash = Schema.decodeUnknownOption(Sha256Hex)(row.start_request_hash);
  if (
    Option.isNone(providerHash) ||
    Option.isNone(requirementHash) ||
    Option.isNone(startRequestHash)
  ) {
    return null;
  }
  const route = {
    family: "hns" as const,
    root_label: rootLabel,
    root_label_display: rootLabelDisplay,
    path_segment: pathSegment,
    href: `/c/${pathSegment}`,
    app_host: null,
  };
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
      requirement_hash: requirementHash.value,
      provider_id: providerId,
      provider_binding_hash: providerHash.value,
      provider_configuration_kind: config.value.kind,
      provider_configuration_reference: config.value.reference,
      provider_configuration_version: config.value.version,
      protocol_version: "hns-txt-v1",
      environment,
      family: "hns",
      root_label: route.root_label,
      root_label_display: route.root_label_display,
      path_segment: route.path_segment,
    },
    revalidation_session_id: sessionId,
    start_request_hash: startRequestHash.value,
    upstream_session_ref: upstreamSessionRef,
    start_presentation: presentation,
    status: "pending",
    started_at: startedAt,
    expires_at: expiresAt,
    terminal_at: terminalAt,
  };
}

function retryAfterSeconds(lease: string, now: string): number {
  return Math.max(1, Math.ceil((Date.parse(lease) - Date.parse(now)) / 1_000));
}

function lockReservationAndSession(
  transaction: Transaction,
  routeRevalidationId: string,
  sessionId: string,
  label: string,
): Effect.Effect<
  { readonly reservation: Row; readonly session: Row | null; readonly now: string } | null,
  ControlPlaneError | HnsRouteRevalidationStartStorageFailed
> {
  return Effect.fn("routeRevalidationStart.lockReservationAndSession")(
    function* (): Effect.fn.Return<
      { readonly reservation: Row; readonly session: Row | null; readonly now: string } | null,
      ControlPlaneError | HnsRouteRevalidationStartStorageFailed,
      never
    > {
      const result = yield* transaction.execute<Row>({
        label: `${label}.lock-reservation`,
        text: `SELECT ${ReservationColumns}
               FROM community_route_revalidation_start_reservations
              WHERE route_revalidation_id = $1
                AND revalidation_session_id = $2
              FOR UPDATE`,
        values: [routeRevalidationId, sessionId],
        readonly: false,
      });
      const reservation = oneRow(result);
      if (reservation === undefined) return yield* Effect.fail(storageFailure());
      if (reservation === null) return null;
      const now = yield* databaseNow(transaction);
      const sessionResult = yield* transaction.execute<Row>({
        label: `${label}.lock-session`,
        text: `SELECT ${SessionColumns}
               FROM community_route_revalidation_sessions AS s
              WHERE s.route_revalidation_id = $1
                AND s.revalidation_session_id = $2
              FOR UPDATE`,
        values: [routeRevalidationId, sessionId],
        readonly: false,
      });
      const session = oneRow(sessionResult);
      if (session === undefined) return yield* Effect.fail(storageFailure());
      return { reservation, session, now };
    },
  )();
}

function sessionForReservation(
  transaction: Transaction,
  reservation: Row,
): Effect.Effect<Row | null, ControlPlaneError | HnsRouteRevalidationStartStorageFailed> {
  return Effect.fn("routeRevalidationStart.sessionForReservation")(function* (): Effect.fn.Return<
    Row | null,
    ControlPlaneError | HnsRouteRevalidationStartStorageFailed,
    never
  > {
    const result = yield* transaction.execute<Row>({
      label: "route-revalidation.start.lock-session",
      text: `SELECT ${SessionColumns}
               FROM community_route_revalidation_sessions AS s
              WHERE s.route_revalidation_id = $1
                AND s.revalidation_session_id = $2
              FOR UPDATE`,
      values: [reservation.route_revalidation_id, reservation.revalidation_session_id],
      readonly: false,
    });
    const row = oneRow(result);
    return row === undefined ? yield* Effect.fail(storageFailure()) : row;
  })();
}

function existingReplay(row: {
  readonly reservation: Row;
  readonly session: Row | null;
  readonly now: string;
}): HnsRouteRevalidationStartReplayOutcome {
  const state = stringValue(row.reservation, "state");
  const session = row.session === null ? null : sessionFromRow(row.session);
  if (state === "finalized") {
    return session === null ? { kind: "conflict" } : { kind: "replay", session };
  }
  if (state === "acquired") {
    const lease = timestampValue(row.reservation, "lease_expires_at");
    if (lease === null) return { kind: "conflict" };
    return Date.parse(lease) > Date.parse(row.now)
      ? { kind: "in_flight", retry_after_seconds: retryAfterSeconds(lease, row.now) }
      : { kind: "none" };
  }
  if (state === "released") return { kind: "none" };
  return { kind: "conflict" };
}

function updateReservationReacquire(
  transaction: Transaction,
  reservation: Row,
  ttlMs: number,
): Effect.Effect<Row | null, ControlPlaneError | HnsRouteRevalidationStartStorageFailed> {
  return Effect.fn("routeRevalidationStart.updateReservationReacquire")(
    function* (): Effect.fn.Return<
      Row | null,
      ControlPlaneError | HnsRouteRevalidationStartStorageFailed,
      never
    > {
      const result = yield* transaction.execute<Row>({
        label: "route-revalidation.start.reacquire-reservation",
        text: `UPDATE community_route_revalidation_start_reservations
                SET state = 'acquired',
                    fence_token = fence_token + 1,
                    lease_expires_at = clock_timestamp() + ($2 * INTERVAL '1 millisecond')
              WHERE route_revalidation_id = $1
                AND state IN ('released', 'acquired')
                AND (state = 'released' OR lease_expires_at <= clock_timestamp())
              RETURNING ${ReservationColumns}`,
        values: [reservation.route_revalidation_id, ttlMs],
        readonly: false,
      });
      const row = oneRow(result);
      if (row === undefined) return yield* Effect.fail(storageFailure());
      return row;
    },
  )();
}

function insertReservation(
  transaction: Transaction,
  input: HnsRouteRevalidationStartReservationInput & Readonly<{ revalidation_session_id: string }>,
): Effect.Effect<Row | null, ControlPlaneError | HnsRouteRevalidationStartStorageFailed> {
  return Effect.fn("routeRevalidationStart.insertReservation")(function* (): Effect.fn.Return<
    Row | null,
    ControlPlaneError | HnsRouteRevalidationStartStorageFailed,
    never
  > {
    const authority = input.authority;
    const result = yield* transaction.execute<Row>({
      label: "route-revalidation.start.insert-reservation",
      text: `INSERT INTO community_route_revalidation_start_reservations (
               route_revalidation_id, revalidation_session_id, community_id, route_binding_id,
               principal_kind, principal_id, expected_binding_generation,
               expected_verified_evidence_ref, requirement_hash, provider_id,
               provider_binding_hash, provider_configuration_kind,
               provider_configuration_reference, provider_configuration_version,
               protocol_version, environment, family, root_label, root_label_display,
               path_segment, start_request_hash, state, fence_token, lease_expires_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, 'acquired', 1,
               clock_timestamp() + ($22 * INTERVAL '1 millisecond')
             )
             RETURNING ${ReservationColumns}`,
      values: [
        authority.route_revalidation_id,
        input.revalidation_session_id,
        authority.community_id,
        authority.route_binding_id,
        authority.principal_kind,
        authority.principal_id,
        authority.expected_binding_generation,
        authority.expected_verified_evidence_ref,
        authority.requirement_hash,
        authority.provider_id,
        authority.provider_binding_hash,
        authority.provider_configuration_kind,
        authority.provider_configuration_reference,
        authority.provider_configuration_version,
        authority.protocol_version,
        authority.environment,
        authority.family,
        authority.root_label,
        authority.root_label_display,
        authority.path_segment,
        input.start_request_hash,
        input.ttl_ms,
      ],
      readonly: false,
    });
    const row = oneRow(result);
    return row === undefined ? yield* Effect.fail(storageFailure()) : row;
  })();
}

function reservationResult(row: Row): HnsRouteRevalidationStartReservationOutcome | null {
  const reservation = reservationFromRow(row);
  return reservation === null ? null : { kind: "acquired", reservation };
}

function makeStore(db: ControlPlaneDb["Service"]): HnsRouteRevalidationStartStore {
  const replay = (
    input: Readonly<{
      readonly route_revalidation_id: string;
      readonly revalidation_session_id: string;
      readonly start_request_hash: string;
    }>,
  ) =>
    db
      .withTransaction((transaction) =>
        Effect.gen(function* () {
          const routeResult = yield* transaction.execute<Row>({
            label: "route-revalidation.start.replay-lock-route",
            text: `SELECT r.community_id, r.route_binding_id, r.state
                   FROM community_route_revalidation_start_reservations AS r
                   WHERE r.route_revalidation_id = $1
                     AND r.revalidation_session_id = $2
                   `,
            values: [input.route_revalidation_id, input.revalidation_session_id],
            readonly: true,
          });
          const route = oneRow(routeResult);
          if (route === undefined) return yield* Effect.fail(storageFailure());
          if (route === null) return { kind: "none" } as const;
          const routeLock = yield* transaction.execute<Row>({
            label: "route-revalidation.start.replay-lock-community-binding",
            text: `SELECT c.community_id, b.route_binding_id
                    FROM communities AS c
                    JOIN community_canonical_route_bindings AS b
                      ON b.community_id = c.community_id
                     AND b.route_binding_id = $2
                   WHERE c.community_id = $1
                   FOR UPDATE OF c, b`,
            values: [route.community_id, route.route_binding_id],
            readonly: false,
          });
          const routeLockRow = oneRow(routeLock);
          if (routeLockRow === undefined) return yield* Effect.fail(storageFailure());
          if (routeLockRow === null) return { kind: "not_found" } as const;
          const locked = yield* lockReservationAndSession(
            transaction,
            input.route_revalidation_id,
            input.revalidation_session_id,
            "route-revalidation.start.replay",
          );
          if (locked === null) return { kind: "none" } as const;
          if (locked.reservation.start_request_hash !== input.start_request_hash) {
            return { kind: "conflict" } as const;
          }
          return existingReplay(locked);
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof HnsRouteRevalidationStartStorageFailed ? error : storageFailure(),
        ),
      );

  const reserve = (
    input: HnsRouteRevalidationStartReservationInput &
      Readonly<{ revalidation_session_id: string }>,
  ) =>
    db
      .withTransaction((transaction) =>
        Effect.gen(function* () {
          const route = yield* lockRoute(transaction, input.authority);
          if (route === null) return { kind: "not_found" } as const;
          const existingResult = yield* transaction.execute<Row>({
            label: "route-revalidation.start.lock-reservation",
            text: `SELECT ${ReservationColumns}
                   FROM community_route_revalidation_start_reservations
                  WHERE route_revalidation_id = $1
                  FOR UPDATE`,
            values: [input.authority.route_revalidation_id],
            readonly: false,
          });
          const existing = oneRow(existingResult);
          if (existing === undefined) return yield* Effect.fail(storageFailure());
          if (existing !== null) {
            if (
              existing.revalidation_session_id !== input.revalidation_session_id ||
              existing.start_request_hash !== input.start_request_hash ||
              !reservationMatchesAuthority(existing, input.authority)
            ) {
              return { kind: "conflict" } as const;
            }
            const session = yield* sessionForReservation(transaction, existing);
            const now = yield* databaseNow(transaction);
            const state = stringValue(existing, "state");
            if (state === "finalized") {
              const decoded = session === null ? null : sessionFromRow(session);
              return decoded === null
                ? ({ kind: "conflict" } as const)
                : ({ kind: "replay", session: decoded } as const);
            }
            const lease = timestampValue(existing, "lease_expires_at");
            if (state === "acquired" && lease !== null && Date.parse(lease) > Date.parse(now)) {
              return {
                kind: "in_flight",
                retry_after_seconds: retryAfterSeconds(lease, now),
              } as const;
            }
            const reacquired = yield* updateReservationReacquire(
              transaction,
              existing,
              input.ttl_ms,
            );
            const result = reacquired === null ? null : reservationResult(reacquired);
            return result ?? ({ kind: "conflict" } as const);
          }
          const generationResult = yield* transaction.execute<Row>({
            label: "route-revalidation.start.lock-generation-reservation",
            text: `SELECT route_revalidation_id
                   FROM community_route_revalidation_start_reservations
                  WHERE route_binding_id = $1
                    AND expected_binding_generation = $2
                  FOR UPDATE`,
            values: [input.authority.route_binding_id, input.authority.expected_binding_generation],
            readonly: false,
          });
          const generationReservation = oneRow(generationResult);
          if (generationReservation === undefined) return yield* Effect.fail(storageFailure());
          if (generationReservation !== null) return { kind: "conflict" } as const;
          const inserted = yield* insertReservation(transaction, input);
          const result = inserted === null ? null : reservationResult(inserted);
          return result ?? ({ kind: "conflict" } as const);
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof HnsRouteRevalidationStartStorageFailed ? error : storageFailure(),
        ),
      );

  const finalize = (
    reservation: HnsRouteRevalidationStartReservation,
    result: ProviderStartResult,
  ) =>
    db
      .withTransaction((transaction) =>
        Effect.gen(function* () {
          const authorityResult = yield* transaction.execute<Row>({
            label: "route-revalidation.start.finalize-lock-authority",
            text: `SELECT r.community_id, r.route_binding_id
                    FROM community_route_revalidation_start_reservations AS r
                   WHERE r.route_revalidation_id = $1
                   `,
            values: [reservation.route_revalidation_id],
            readonly: true,
          });
          const authorityRow = oneRow(authorityResult);
          if (authorityRow === undefined || authorityRow === null)
            return { kind: "stale" } as const;
          const bindingResult = yield* transaction.execute<Row>({
            label: "route-revalidation.start.finalize-lock-community-binding",
            text: `SELECT c.community_id, b.route_binding_id
                    FROM communities AS c
                    JOIN community_canonical_route_bindings AS b
                      ON b.community_id = c.community_id
                     AND b.route_binding_id = $2
                   WHERE c.community_id = $1
                   FOR UPDATE OF c, b`,
            values: [authorityRow.community_id, authorityRow.route_binding_id],
            readonly: false,
          });
          const bindingRow = oneRow(bindingResult);
          if (bindingRow === undefined || bindingRow === null) return { kind: "stale" } as const;
          const locked = yield* lockReservationAndSession(
            transaction,
            reservation.route_revalidation_id,
            reservation.revalidation_session_id,
            "route-revalidation.start.finalize",
          );
          if (locked === null) return { kind: "stale" } as const;
          const currentFence = safeIntegerValue(locked.reservation.fence_token);
          const state = stringValue(locked.reservation, "state");
          if (currentFence !== reservation.fence_token || state !== "acquired") {
            const session = locked.session === null ? null : sessionFromRow(locked.session);
            return state === "finalized" && session !== null
              ? ({ kind: "replay", session } as const)
              : ({ kind: "stale" } as const);
          }
          const now = yield* databaseNow(transaction);
          const lease = timestampValue(locked.reservation, "lease_expires_at");
          if (
            lease === null ||
            Date.parse(lease) <= Date.parse(now) ||
            Date.parse(result.expires_at) <= Date.parse(now)
          ) {
            return { kind: "stale" } as const;
          }
          const presentationJson = JSON.stringify(result.presentation);
          const insert = yield* transaction.execute<Row>({
            label: "route-revalidation.start.insert-session",
            text: `INSERT INTO community_route_revalidation_sessions (
                   revalidation_session_id, route_revalidation_id, start_fence_token,
                   community_id, route_binding_id, principal_kind, principal_id,
                   expected_binding_generation, expected_verified_evidence_ref,
                   requirement_hash, start_request_hash, provider_id,
                   provider_binding_hash, provider_configuration_kind,
                   provider_configuration_reference, provider_configuration_version,
                   protocol_version, environment, family, root_label, root_label_display,
                   path_segment, upstream_session_ref, start_presentation, status,
                   started_at, expires_at, terminal_at
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                   $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb,
                   'pending', $25, $26, NULL
                 )
                 RETURNING ${SessionColumns}`,
            values: [
              reservation.revalidation_session_id,
              reservation.route_revalidation_id,
              reservation.fence_token,
              locked.reservation.community_id,
              locked.reservation.route_binding_id,
              locked.reservation.principal_kind,
              locked.reservation.principal_id,
              locked.reservation.expected_binding_generation,
              locked.reservation.expected_verified_evidence_ref,
              locked.reservation.requirement_hash,
              locked.reservation.start_request_hash,
              locked.reservation.provider_id,
              locked.reservation.provider_binding_hash,
              locked.reservation.provider_configuration_kind,
              locked.reservation.provider_configuration_reference,
              locked.reservation.provider_configuration_version,
              locked.reservation.protocol_version,
              locked.reservation.environment,
              locked.reservation.family,
              locked.reservation.root_label,
              locked.reservation.root_label_display,
              locked.reservation.path_segment,
              result.upstream_session_ref,
              presentationJson,
              now,
              result.expires_at,
            ],
            readonly: false,
          });
          const sessionRow = oneRow(insert);
          if (sessionRow === undefined || sessionRow === null) return { kind: "conflict" } as const;
          const session = sessionFromRow(sessionRow);
          if (session === null) return yield* Effect.fail(storageFailure());
          const updated = yield* transaction.execute<Row>({
            label: "route-revalidation.start.finalize-reservation",
            text: `UPDATE community_route_revalidation_start_reservations
                    SET state = 'finalized'
                  WHERE route_revalidation_id = $1
                    AND state = 'acquired'
                    AND fence_token = $2
                  RETURNING ${ReservationColumns}`,
            values: [reservation.route_revalidation_id, reservation.fence_token],
            readonly: false,
          });
          if (oneRow(updated) === null) return { kind: "stale" } as const;
          return { kind: "created", session } as const;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof HnsRouteRevalidationStartStorageFailed ? error : storageFailure(),
        ),
      );

  const release = (reservation: HnsRouteRevalidationStartReservation) =>
    db
      .withTransaction((transaction) =>
        transaction
          .execute({
            label: "route-revalidation.start.release-reservation",
            text: `UPDATE community_route_revalidation_start_reservations
                    SET state = 'released'
                  WHERE route_revalidation_id = $1
                    AND revalidation_session_id = $2
                    AND state = 'acquired'
                    AND fence_token = $3
                    AND lease_expires_at > clock_timestamp()`,
            values: [
              reservation.route_revalidation_id,
              reservation.revalidation_session_id,
              reservation.fence_token,
            ],
            readonly: false,
          })
          .pipe(Effect.asVoid),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof HnsRouteRevalidationStartStorageFailed ? error : storageFailure(),
        ),
      );

  return { replay, reserve, finalize, release };
}

export function makeControlPlaneRouteRevalidationStartStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  _options: Readonly<{ readonly reservation_ttl_ms?: number }> = {},
): HnsRouteRevalidationStartStore {
  const provide = <A, E>(
    use: (db: ControlPlaneDb["Service"]) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | HnsRouteRevalidationStartStorageFailed> =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* use(db);
    }).pipe(
      Effect.provide(runtime),
      Effect.mapError((error) =>
        error instanceof HnsRouteRevalidationStartStorageFailed ? error : storageFailure(),
      ),
    );
  const store = {
    replay: (input: Parameters<HnsRouteRevalidationStartStore["replay"]>[0]) =>
      provide((db) => makeStore(db).replay(input)),
    reserve: (input: Parameters<HnsRouteRevalidationStartStore["reserve"]>[0]) =>
      provide((db) => makeStore(db).reserve(input)),
    finalize: (
      reservation: Parameters<HnsRouteRevalidationStartStore["finalize"]>[0],
      result: Parameters<HnsRouteRevalidationStartStore["finalize"]>[1],
    ) => provide((db) => makeStore(db).finalize(reservation, result)),
    release: (reservation: Parameters<HnsRouteRevalidationStartStore["release"]>[0]) =>
      provide((db) => makeStore(db).release(reservation)),
  } satisfies HnsRouteRevalidationStartStore;
  return store;
}

export function makeControlPlaneRouteRevalidationStartRepository(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: Readonly<{ readonly reservation_ttl_ms?: number }> = {},
): HnsRouteRevalidationStartStore {
  return makeControlPlaneRouteRevalidationStartStore(runtime, options);
}
