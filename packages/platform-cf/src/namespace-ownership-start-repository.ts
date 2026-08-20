import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneTransaction,
  NamespaceOwnershipProviderStartInput,
  NamespaceOwnershipProviderStartResult,
  NamespaceOwnershipRoute,
  type NamespaceOwnershipStartAuthority,
  type NamespaceOwnershipStartAuthorityResolver,
  type NamespaceOwnershipStartReplayInput,
  type NamespaceOwnershipStartReplayOutcome,
  type NamespaceOwnershipStartReservation,
  type NamespaceOwnershipStartReservationInput,
  type NamespaceOwnershipStartReservationOutcome,
  NamespaceOwnershipStartStorageFailed,
  type NamespaceOwnershipStartStore,
} from "@pirate/application";
import { ProviderPresentation } from "@pirate/contracts";
import { ProviderConfigurationRef, Sha256Hex } from "@pirate/domain/verification";
import { Effect, type Layer, Option, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;

const exactParseOptions = { onExcessProperty: "error" } as const;

const storageFailure = (): NamespaceOwnershipStartStorageFailed =>
  new NamespaceOwnershipStartStorageFailed();

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
  const decoded = Schema.decodeUnknownOption(
    Schema.String.check(
      Schema.makeFilter((candidate) =>
        Number.isFinite(Date.parse(candidate)) &&
        new Date(Date.parse(candidate)).toISOString() === candidate
          ? undefined
          : "Expected a canonical UTC instant",
      ),
    ),
  )(value);
  return Option.isSome(decoded) ? decoded.value : null;
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

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
  );
}

function routeFromRow(row: Row): NamespaceOwnershipStartAuthority["route"] | null {
  const route = {
    family: row.route_family,
    root_label: row.route_root_label,
    root_label_display: row.route_root_label_display,
    path_segment: row.route_path_segment,
    href:
      row.route_family === "hns" && typeof row.route_path_segment === "string"
        ? `/c/${row.route_path_segment}`
        : undefined,
    app_host: optionalStringValue(row, "route_app_host"),
  };
  const decoded = Schema.decodeUnknownOption(NamespaceOwnershipRoute, exactParseOptions)(route);
  return Option.isSome(decoded) ? decoded.value : null;
}

function authorityFromRow(row: Row): NamespaceOwnershipStartAuthority | null {
  const actorId = stringValue(row, "actor_id");
  const intentId = stringValue(row, "intent_id");
  const ceremonyId = stringValue(row, "current_ceremony_intent_id");
  const requirementHash = stringValue(row, "requirement_hash");
  const providerId = stringValue(row, "provider_id");
  const bindingHash = stringValue(row, "provider_binding_hash");
  const configurationKind = stringValue(row, "provider_configuration_kind");
  const configurationReference = stringValue(row, "provider_configuration_ref");
  const configurationVersion = stringValue(row, "provider_configuration_version");
  const revision = safeIntegerValue(row.revision);
  const generation = safeIntegerValue(row.generation);
  const ceremonyGeneration = safeIntegerValue(row.ceremony_generation);
  const route = routeFromRow(row);
  if (
    actorId === null ||
    intentId === null ||
    ceremonyId === null ||
    requirementHash === null ||
    bindingHash === null ||
    providerId === null ||
    configurationKind === null ||
    configurationReference === null ||
    configurationVersion === null ||
    revision === null ||
    generation === null ||
    ceremonyGeneration === null ||
    route === null
  ) {
    return null;
  }
  const configuration = Schema.decodeUnknownOption(
    ProviderConfigurationRef,
    exactParseOptions,
  )({
    kind: configurationKind,
    reference: configurationReference,
    version: configurationVersion,
  });
  if (Option.isNone(configuration)) return null;
  if (
    row.status !== "verification_required" ||
    row.requirement_kind !== "namespace_ownership" ||
    row.requirement_status !== "pending" ||
    row.current_ceremony_intent_id !== ceremonyId ||
    row.ceremony_requirement_kind !== "namespace_ownership" ||
    ceremonyGeneration !== generation ||
    row.ceremony_requirement_hash !== requirementHash ||
    row.ceremony_provider_id !== providerId ||
    row.ceremony_provider_binding_hash !== bindingHash ||
    row.ceremony_provider_configuration_kind !== configurationKind ||
    row.ceremony_provider_configuration_ref !== configurationReference ||
    row.ceremony_provider_configuration_version !== configurationVersion ||
    row.ceremony_route_family !== route.family ||
    row.ceremony_route_root_label !== route.root_label ||
    row.ceremony_route_root_label_display !== route.root_label_display ||
    row.ceremony_route_path_segment !== route.path_segment ||
    row.intent_active !== true ||
    row.ceremony_active !== true
  ) {
    return null;
  }
  return {
    actor_id: actorId,
    creation_intent_id: intentId,
    ceremony_intent_id: ceremonyId,
    expected_revision: revision,
    requirement_hash: requirementHash,
    generation,
    provider_id: providerId,
    provider_binding_hash: bindingHash,
    provider_configuration: configuration.value,
    route,
  };
}

const authorityColumns = `
  ci.intent_id,
  ci.actor_id,
  ci.revision,
  ci.status,
  ci.expires_at > clock_timestamp() AS intent_active,
  crs.requirement_kind,
  crs.status AS requirement_status,
  crs.requirement_hash,
  crs.provider_id,
  crs.provider_binding_hash,
  crs.provider_configuration_kind,
  crs.provider_configuration_ref,
  crs.provider_configuration_version,
  crs.route_family,
  crs.route_root_label,
  crs.route_root_label_display,
  crs.route_path_segment,
  crs.generation,
  crs.current_ceremony_intent_id,
  cca.requirement_kind AS ceremony_requirement_kind,
  cca.generation AS ceremony_generation,
  cca.requirement_hash AS ceremony_requirement_hash,
  cca.provider_id AS ceremony_provider_id,
  cca.provider_binding_hash AS ceremony_provider_binding_hash,
  cca.provider_configuration_kind AS ceremony_provider_configuration_kind,
  cca.provider_configuration_ref AS ceremony_provider_configuration_ref,
  cca.provider_configuration_version AS ceremony_provider_configuration_version,
  cca.route_family AS ceremony_route_family,
  cca.route_root_label AS ceremony_route_root_label,
  cca.route_root_label_display AS ceremony_route_root_label_display,
  cca.route_path_segment AS ceremony_route_path_segment,
  cca.expires_at > clock_timestamp() AS ceremony_active`;

const authorityQuery = (locked: boolean): string => `
  SELECT ${authorityColumns}
    FROM community_creation_intents AS ci
    JOIN community_creation_requirement_states AS crs
      ON crs.intent_id = ci.intent_id
     AND crs.actor_id = ci.actor_id
     AND crs.requirement_kind = 'namespace_ownership'
    JOIN community_creation_ceremony_attempts AS cca
      ON cca.actor_id = ci.actor_id
     AND cca.intent_id = ci.intent_id
     AND cca.requirement_kind = 'namespace_ownership'
     AND cca.ceremony_intent_id = $3
   WHERE ci.actor_id = $1
     AND ci.intent_id = $2
  ${locked ? "FOR UPDATE OF ci, crs, cca" : ""}`;

function sameConfiguration(
  left: NamespaceOwnershipStartAuthority["provider_configuration"],
  right: NamespaceOwnershipStartAuthority["provider_configuration"],
): boolean {
  return (
    left.kind === right.kind && left.reference === right.reference && left.version === right.version
  );
}

function sameRoute(
  left: NamespaceOwnershipStartAuthority["route"],
  right: NamespaceOwnershipStartAuthority["route"],
): boolean {
  return (
    left.family === right.family &&
    left.root_label === right.root_label &&
    left.root_label_display === right.root_label_display &&
    left.path_segment === right.path_segment &&
    left.href === right.href &&
    left.app_host === right.app_host
  );
}

function sameAuthorityStart(
  authority: NamespaceOwnershipStartAuthority,
  start: Schema.Schema.Type<typeof NamespaceOwnershipProviderStartInput>,
  expectedRevision: number,
): boolean {
  return (
    authority.actor_id === start.actor_id &&
    authority.creation_intent_id === start.creation_intent_id &&
    authority.ceremony_intent_id === start.ceremony_intent_id &&
    authority.expected_revision === expectedRevision &&
    authority.requirement_hash === start.requirement_hash &&
    authority.generation === start.generation &&
    authority.provider_binding_hash === start.provider_binding_hash &&
    sameConfiguration(authority.provider_configuration, start.provider_configuration) &&
    sameRoute(authority.route, start.route)
  );
}

function decodeStartRow(row: Row): NamespaceOwnershipProviderStartResult | null {
  const providerConfigurationKind = stringValue(row, "provider_configuration_kind");
  const providerConfigurationReference = stringValue(row, "provider_configuration_ref");
  const providerConfigurationVersion = stringValue(row, "provider_configuration_version");
  const providerId = stringValue(row, "provider_id");
  const actorId = stringValue(row, "actor_id");
  const creationIntentId = stringValue(row, "creation_intent_id");
  const ceremonyIntentId = stringValue(row, "ceremony_intent_id");
  const requirementHash = stringValue(row, "requirement_hash");
  const requestHash = stringValue(row, "request_hash");
  const bindingHash = stringValue(row, "provider_binding_hash");
  const protocolVersion = stringValue(row, "protocol_version");
  const environment = stringValue(row, "environment");
  const rootLabel = stringValue(row, "route_root_label");
  const rootLabelDisplay = stringValue(row, "route_root_label_display");
  const pathSegment = stringValue(row, "route_path_segment");
  const namespaceSessionId = stringValue(row, "namespace_session_id");
  const upstreamSessionRef = stringValue(row, "upstream_session_ref");
  const startedAt = timestampValue(row, "started_at");
  const expiresAt = timestampValue(row, "expires_at");
  const generation = safeIntegerValue(row.generation);
  if (
    providerConfigurationKind === null ||
    providerConfigurationReference === null ||
    providerConfigurationVersion === null ||
    providerId === null ||
    actorId === null ||
    creationIntentId === null ||
    ceremonyIntentId === null ||
    requirementHash === null ||
    requestHash === null ||
    bindingHash === null ||
    protocolVersion === null ||
    environment === null ||
    rootLabel === null ||
    rootLabelDisplay === null ||
    pathSegment === null ||
    namespaceSessionId === null ||
    upstreamSessionRef === null ||
    namespaceSessionId === upstreamSessionRef ||
    startedAt === null ||
    expiresAt === null ||
    generation === null
  ) {
    return null;
  }
  const presentationKind = stringValue(row, "presentation_kind");
  const presentationPayload = jsonValue(row, "presentation_payload");
  if (
    presentationKind === null ||
    presentationPayload === null ||
    typeof presentationPayload !== "object" ||
    Array.isArray(presentationPayload)
  ) {
    return null;
  }
  const configuration = Schema.decodeUnknownOption(
    ProviderConfigurationRef,
    exactParseOptions,
  )({
    kind: providerConfigurationKind,
    reference: providerConfigurationReference,
    version: providerConfigurationVersion,
  });
  if (Option.isNone(configuration)) return null;
  const presentation = Schema.decodeUnknownOption(
    ProviderPresentation,
    exactParseOptions,
  )({
    kind: presentationKind,
    ...(presentationPayload as Readonly<Record<string, unknown>>),
  });
  if (Option.isNone(presentation) || presentation.value.session_id !== upstreamSessionRef) {
    return null;
  }
  const decoded = Schema.decodeUnknownOption(
    NamespaceOwnershipProviderStartResult,
    exactParseOptions,
  )({
    session: {
      actor_id: actorId,
      creation_intent_id: creationIntentId,
      ceremony_intent_id: ceremonyIntentId,
      requirement_hash: requirementHash,
      generation,
      request_hash: requestHash,
      provider_id: providerId,
      provider_binding_hash: bindingHash,
      provider_configuration: configuration.value,
      protocol_version: protocolVersion,
      environment,
      route: {
        family: row.route_family,
        root_label: rootLabel,
        root_label_display: rootLabelDisplay,
        path_segment: pathSegment,
        href: `/c/${pathSegment}`,
        app_host: optionalStringValue(row, "route_app_host"),
      },
      upstream_session_ref: upstreamSessionRef,
      expires_at: expiresAt,
    },
    presentation: presentation.value,
  });
  return Option.isSome(decoded) ? decoded.value : null;
}

function startColumns(): string {
  return `namespace_session_id, start_reservation_id, start_fence_token, expected_revision,
    actor_id, creation_intent_id, ceremony_intent_id, generation, requirement_hash,
    request_hash, provider_id, provider_binding_hash,
    provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
    protocol_version, environment, route_family, route_root_label, route_root_label_display,
    route_path_segment, route_href, route_app_host, upstream_session_ref,
    presentation_kind, presentation_payload, status, started_at, expires_at`;
}

function reservationFromRow(row: Row): NamespaceOwnershipStartReservation | null {
  const reservationId = stringValue(row, "reservation_id");
  const namespaceSessionId = stringValue(row, "namespace_session_id");
  const expectedRevision = safeIntegerValue(row.expected_revision);
  const fenceToken = safeIntegerValue(row.fence_token);
  const leaseExpiresAt = timestampValue(row, "lease_expires_at");
  if (
    reservationId === null ||
    namespaceSessionId === null ||
    expectedRevision === null ||
    fenceToken === null ||
    fenceToken <= 0 ||
    leaseExpiresAt === null
  ) {
    return null;
  }
  return {
    reservation_id: reservationId,
    namespace_session_id: namespaceSessionId,
    expected_revision: expectedRevision,
    fence_token: fenceToken,
    lease_expires_at: leaseExpiresAt,
  };
}

function lockActor(
  transaction: Transaction,
  actorId: string,
): Effect.Effect<void, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.lock-actor",
      text: "SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE",
      values: [actorId],
      readonly: false,
    });
    const row = oneRow(result);
    if (row === undefined || row === null || stringValue(row, "user_id") !== actorId) {
      return yield* Effect.fail(storageFailure());
    }
  });
}

function lockIntent(
  transaction: Transaction,
  actorId: string,
  intentId: string,
): Effect.Effect<void, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.lock-intent",
      text: "SELECT intent_id FROM community_creation_intents WHERE actor_id = $1 AND intent_id = $2 FOR UPDATE",
      values: [actorId, intentId],
      readonly: false,
    });
    const row = oneRow(result);
    if (row === undefined || row === null || stringValue(row, "intent_id") !== intentId) {
      return yield* Effect.fail(storageFailure());
    }
  });
}

function lockRequirement(
  transaction: Transaction,
  actorId: string,
  intentId: string,
): Effect.Effect<void, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.lock-requirement",
      text: `SELECT intent_id FROM community_creation_requirement_states
              WHERE actor_id = $1 AND intent_id = $2 AND requirement_kind = 'namespace_ownership'
              FOR UPDATE`,
      values: [actorId, intentId],
      readonly: false,
    });
    const row = oneRow(result);
    if (row === undefined || row === null || stringValue(row, "intent_id") !== intentId) {
      return yield* Effect.fail(storageFailure());
    }
  });
}

function readAuthority(
  transaction: Transaction,
  input: Readonly<{
    readonly actor_id: string;
    readonly creation_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly expected_revision?: number;
  }>,
  locked: boolean,
): Effect.Effect<
  NamespaceOwnershipStartAuthority | null,
  ControlPlaneError | NamespaceOwnershipStartStorageFailed
> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: locked
        ? "namespace-ownership.start.lock-ceremony"
        : "namespace-ownership.start.resolve-authority",
      text: authorityQuery(locked),
      values: [input.actor_id, input.creation_intent_id, input.ceremony_intent_id],
      readonly: !locked,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    if (row === null) return null;
    const authority = authorityFromRow(row);
    if (
      authority === null ||
      (input.expected_revision !== undefined &&
        authority.expected_revision !== input.expected_revision)
    ) {
      return null;
    }
    return authority;
  });
}

function lockAuthority(
  transaction: Transaction,
  input: Readonly<{
    readonly actor_id: string;
    readonly creation_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly expected_revision?: number;
  }>,
): Effect.Effect<
  NamespaceOwnershipStartAuthority | null,
  ControlPlaneError | NamespaceOwnershipStartStorageFailed
> {
  return Effect.gen(function* () {
    yield* lockActor(transaction, input.actor_id);
    yield* lockIntent(transaction, input.actor_id, input.creation_intent_id);
    yield* lockRequirement(transaction, input.actor_id, input.creation_intent_id);
    return yield* readAuthority(transaction, input, true);
  });
}

function lockAuthorityRecord(
  transaction: Transaction,
  input: Readonly<{
    readonly actor_id: string;
    readonly creation_intent_id: string;
    readonly ceremony_intent_id: string;
  }>,
): Effect.Effect<Row | null, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const actor = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.replay-lock-actor",
      text: "SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE",
      values: [input.actor_id],
      readonly: false,
    });
    if (oneRow(actor) === null) return null;
    if (oneRow(actor) === undefined) return yield* Effect.fail(storageFailure());
    const intent = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.replay-lock-intent",
      text: "SELECT intent_id FROM community_creation_intents WHERE actor_id = $1 AND intent_id = $2 FOR UPDATE",
      values: [input.actor_id, input.creation_intent_id],
      readonly: false,
    });
    if (oneRow(intent) === null) return null;
    if (oneRow(intent) === undefined) return yield* Effect.fail(storageFailure());
    const requirement = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.replay-lock-requirement",
      text: `SELECT intent_id FROM community_creation_requirement_states
              WHERE actor_id = $1 AND intent_id = $2
                AND requirement_kind = 'namespace_ownership'
              FOR UPDATE`,
      values: [input.actor_id, input.creation_intent_id],
      readonly: false,
    });
    if (oneRow(requirement) === null) return null;
    if (oneRow(requirement) === undefined) return yield* Effect.fail(storageFailure());
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.lock-ceremony",
      text: authorityQuery(true),
      values: [input.actor_id, input.creation_intent_id, input.ceremony_intent_id],
      readonly: false,
    });
    const row = oneRow(result);
    return row === undefined ? yield* Effect.fail(storageFailure()) : row;
  });
}

function databaseNow(
  transaction: Transaction,
): Effect.Effect<string, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.database-clock",
      text: "SELECT clock_timestamp() AS database_now",
      values: [],
      readonly: false,
    });
    const row = oneRow(result);
    const now = row === null || row === undefined ? null : timestampValue(row, "database_now");
    return now === null ? yield* Effect.fail(storageFailure()) : now;
  });
}

function reservationColumns(): string {
  return `reservation_id, namespace_session_id, actor_id, creation_intent_id,
    ceremony_intent_id, generation, requirement_hash, expected_revision,
    client_idempotency_key, request_hash, provider_id, provider_binding_hash,
    provider_configuration_kind, provider_configuration_ref,
    provider_configuration_version, protocol_version, environment,
    route_family, route_root_label, route_root_label_display, route_path_segment,
    route_href, route_app_host, state, fence_token, lease_expires_at`;
}

function insertReservation(
  transaction: Transaction,
  input: NamespaceOwnershipStartReservationInput,
): Effect.Effect<
  NamespaceOwnershipStartReservation | null,
  ControlPlaneError | NamespaceOwnershipStartStorageFailed
> {
  return Effect.gen(function* () {
    const start = input.start;
    const route = start.route;
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.insert-reservation",
      text: `INSERT INTO namespace_ownership_start_reservations (
               reservation_id, namespace_session_id, actor_id, creation_intent_id,
               ceremony_intent_id, generation, requirement_hash, expected_revision,
               client_idempotency_key, request_hash, provider_id, provider_binding_hash,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, protocol_version, environment,
               route_family, route_root_label, route_root_label_display,
               route_path_segment, route_href, route_app_host, state, fence_token,
               lease_expires_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22, $23, 'acquired', 1,
               clock_timestamp() + ($24 * INTERVAL '1 millisecond')
             )
             RETURNING ${reservationColumns()}`,
      values: [
        input.reservation_id,
        input.namespace_session_id,
        start.actor_id,
        start.creation_intent_id,
        start.ceremony_intent_id,
        start.generation,
        start.requirement_hash,
        input.expected_revision,
        input.client_idempotency_key,
        start.request_hash,
        input.provider_id,
        start.provider_binding_hash,
        start.provider_configuration.kind,
        start.provider_configuration.reference,
        start.provider_configuration.version,
        start.protocol_version,
        start.environment,
        route.family,
        route.root_label,
        route.root_label_display,
        route.path_segment,
        route.href,
        route.app_host,
        input.ttl_ms,
      ],
      readonly: false,
    });
    const row = oneRow(result);
    return row === undefined || row === null ? null : reservationFromRow(row);
  });
}

function existingResultHash(
  transaction: Transaction,
  ceremonyIntentId: string,
): Effect.Effect<string | null, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.lock-terminal-result",
      text: `SELECT outcome_status, result_hash
                FROM community_creation_ceremony_results
               WHERE ceremony_intent_id = $1
               FOR UPDATE`,
      values: [ceremonyIntentId],
      readonly: false,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    if (row === null || row.outcome_status !== "satisfied") return null;
    const hash = stringValue(row, "result_hash");
    return hash === null || Option.isNone(Schema.decodeUnknownOption(Sha256Hex)(hash))
      ? yield* Effect.fail(storageFailure())
      : hash;
  });
}

function sessionForCeremony(
  transaction: Transaction,
  actorId: string,
  ceremonyIntentId: string,
): Effect.Effect<Row | null, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.lock-session",
      text: `SELECT ${startColumns()}
                FROM namespace_ownership_sessions
               WHERE actor_id = $1 AND ceremony_intent_id = $2
               FOR UPDATE`,
      values: [actorId, ceremonyIntentId],
      readonly: false,
    });
    const row = oneRow(result);
    return row === undefined ? yield* Effect.fail(storageFailure()) : row;
  });
}

function reservationForKey(
  transaction: Transaction,
  actorId: string,
  intentId: string,
  key: string,
): Effect.Effect<Row | null, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.lock-key-reservation",
      text: `SELECT ${reservationColumns()}
                FROM namespace_ownership_start_reservations
               WHERE actor_id = $1 AND creation_intent_id = $2
                 AND client_idempotency_key = $3
               FOR UPDATE`,
      values: [actorId, intentId, key],
      readonly: false,
    });
    const row = oneRow(result);
    return row === undefined ? yield* Effect.fail(storageFailure()) : row;
  });
}

function reservationForGeneration(
  transaction: Transaction,
  intentId: string,
  generation: number,
): Effect.Effect<Row | null, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.lock-generation-reservation",
      text: `SELECT ${reservationColumns()}
                FROM namespace_ownership_start_reservations
               WHERE creation_intent_id = $1
                 AND requirement_kind = 'namespace_ownership'
                 AND generation = $2
               FOR UPDATE`,
      values: [intentId, generation],
      readonly: false,
    });
    const row = oneRow(result);
    return row === undefined ? yield* Effect.fail(storageFailure()) : row;
  });
}

function reservationState(row: Row): string | null {
  return stringValue(row, "state");
}

function reservationRequestHash(row: Row): string | null {
  return stringValue(row, "request_hash");
}

function retryAfterSeconds(lease: string, now: string): number {
  return Math.max(1, Math.ceil((Date.parse(lease) - Date.parse(now)) / 1_000));
}

function replayAuthorityStatus(
  row: Row,
  input: Readonly<{
    readonly actor_id: string;
    readonly creation_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly expected_revision: number;
  }>,
): "pending" | "satisfied" | "failed" | "expired" | null {
  const revision = safeIntegerValue(row.revision);
  const generation = safeIntegerValue(row.generation);
  const ceremonyGeneration = safeIntegerValue(row.ceremony_generation);
  const requirementStatus = stringValue(row, "requirement_status");
  if (
    row.actor_id !== input.actor_id ||
    row.intent_id !== input.creation_intent_id ||
    revision !== input.expected_revision ||
    row.requirement_kind !== "namespace_ownership" ||
    row.current_ceremony_intent_id !== input.ceremony_intent_id ||
    row.ceremony_requirement_kind !== "namespace_ownership" ||
    generation === null ||
    ceremonyGeneration !== generation ||
    row.ceremony_requirement_hash !== row.requirement_hash ||
    row.ceremony_provider_id !== row.provider_id ||
    row.ceremony_provider_binding_hash !== row.provider_binding_hash ||
    row.ceremony_provider_configuration_kind !== row.provider_configuration_kind ||
    row.ceremony_provider_configuration_ref !== row.provider_configuration_ref ||
    row.ceremony_provider_configuration_version !== row.provider_configuration_version ||
    row.ceremony_route_family !== row.route_family ||
    row.ceremony_route_root_label !== row.route_root_label ||
    row.ceremony_route_root_label_display !== row.route_root_label_display ||
    row.ceremony_route_path_segment !== row.route_path_segment ||
    !["pending", "satisfied", "failed", "expired"].includes(requirementStatus ?? "")
  ) {
    return null;
  }
  if (
    requirementStatus === "pending" &&
    (row.status !== "verification_required" ||
      row.intent_active !== true ||
      row.ceremony_active !== true)
  ) {
    return null;
  }
  return requirementStatus as "pending" | "satisfied" | "failed" | "expired";
}

function reservationMatchesAuthority(row: Row, authority: Row): boolean {
  return (
    row.actor_id === authority.actor_id &&
    row.creation_intent_id === authority.intent_id &&
    row.ceremony_intent_id === authority.current_ceremony_intent_id &&
    safeIntegerValue(row.expected_revision) === safeIntegerValue(authority.revision) &&
    safeIntegerValue(row.generation) === safeIntegerValue(authority.generation) &&
    row.requirement_hash === authority.requirement_hash &&
    row.provider_id === authority.provider_id &&
    row.provider_binding_hash === authority.provider_binding_hash &&
    row.provider_configuration_kind === authority.provider_configuration_kind &&
    row.provider_configuration_ref === authority.provider_configuration_ref &&
    row.provider_configuration_version === authority.provider_configuration_version &&
    row.route_family === authority.route_family &&
    row.route_root_label === authority.route_root_label &&
    row.route_root_label_display === authority.route_root_label_display &&
    row.route_path_segment === authority.route_path_segment &&
    row.route_href === `/c/${String(authority.route_path_segment)}` &&
    row.route_app_host === null
  );
}

function reservationMatchesStart(
  row: Row,
  start: Schema.Schema.Type<typeof NamespaceOwnershipProviderStartResult>["session"],
): boolean {
  const route = start.route;
  const configuration = start.provider_configuration;
  return (
    row.actor_id === start.actor_id &&
    row.creation_intent_id === start.creation_intent_id &&
    row.ceremony_intent_id === start.ceremony_intent_id &&
    safeIntegerValue(row.generation) === start.generation &&
    row.requirement_hash === start.requirement_hash &&
    row.request_hash === start.request_hash &&
    row.provider_id === start.provider_id &&
    row.provider_binding_hash === start.provider_binding_hash &&
    row.provider_configuration_kind === configuration.kind &&
    row.provider_configuration_ref === configuration.reference &&
    row.provider_configuration_version === configuration.version &&
    row.protocol_version === start.protocol_version &&
    row.environment === start.environment &&
    row.route_family === route.family &&
    row.route_root_label === route.root_label &&
    row.route_root_label_display === route.root_label_display &&
    row.route_path_segment === route.path_segment &&
    row.route_href === route.href &&
    row.route_app_host === route.app_host
  );
}

function sessionMatchesReservation(session: Row, reservation: Row): boolean {
  const names = [
    "namespace_session_id",
    "actor_id",
    "creation_intent_id",
    "ceremony_intent_id",
    "generation",
    "requirement_hash",
    "request_hash",
    "provider_id",
    "provider_binding_hash",
    "provider_configuration_kind",
    "provider_configuration_ref",
    "provider_configuration_version",
    "protocol_version",
    "environment",
    "route_family",
    "route_root_label",
    "route_root_label_display",
    "route_path_segment",
    "route_href",
    "route_app_host",
  ] as const;
  return (
    names.every((name) => session[name] === reservation[name]) &&
    session.start_reservation_id === reservation.reservation_id &&
    safeIntegerValue(session.start_fence_token) === safeIntegerValue(reservation.fence_token) &&
    safeIntegerValue(session.expected_revision) === safeIntegerValue(reservation.expected_revision)
  );
}

function classifySession(
  transaction: Transaction,
  row: Row,
  expected: Schema.Schema.Type<typeof NamespaceOwnershipProviderStartInput>,
): Effect.Effect<
  NamespaceOwnershipStartReservationOutcome | null,
  ControlPlaneError | NamespaceOwnershipStartStorageFailed
> {
  return Effect.gen(function* () {
    const stored = decodeStartRow(row);
    if (stored === null) return yield* Effect.fail(storageFailure());
    if (stored.session.request_hash !== expected.request_hash) return { kind: "conflict" } as const;
    const now = yield* databaseNow(transaction);
    if (row.status === "pending") {
      if (Date.parse(stored.session.expires_at) > Date.parse(now)) {
        const namespaceSessionId = stringValue(row, "namespace_session_id");
        if (namespaceSessionId === null) return yield* Effect.fail(storageFailure());
        return { kind: "replay", namespace_session_id: namespaceSessionId, start: stored } as const;
      }
      return { kind: "terminal", status: "expired" } as const;
    }
    if (row.status === "completed") {
      const resultHash = yield* existingResultHash(transaction, expected.ceremony_intent_id);
      return resultHash === null
        ? yield* Effect.fail(storageFailure())
        : ({ kind: "terminal", status: "verified", result_hash: resultHash } as const);
    }
    if (row.status === "failed" || row.status === "expired") {
      return { kind: "terminal", status: row.status } as const;
    }
    return yield* Effect.fail(storageFailure());
  });
}

function classifyStoredSession(
  transaction: Transaction,
  sessionRow: Row,
  reservationRow: Row,
): Effect.Effect<
  NamespaceOwnershipStartReplayOutcome,
  ControlPlaneError | NamespaceOwnershipStartStorageFailed
> {
  return Effect.gen(function* () {
    if (!sessionMatchesReservation(sessionRow, reservationRow)) {
      return yield* Effect.fail(storageFailure());
    }
    const stored = decodeStartRow(sessionRow);
    const namespaceSessionId = stringValue(sessionRow, "namespace_session_id");
    if (stored === null || namespaceSessionId === null) {
      return yield* Effect.fail(storageFailure());
    }
    const now = yield* databaseNow(transaction);
    if (sessionRow.status === "pending") {
      return Date.parse(stored.session.expires_at) > Date.parse(now)
        ? ({
            kind: "replay",
            namespace_session_id: namespaceSessionId,
            start: stored,
          } as const)
        : ({
            kind: "terminal",
            creation_intent_id: stored.session.creation_intent_id,
            ceremony_intent_id: stored.session.ceremony_intent_id,
            generation: stored.session.generation,
            status: "expired",
          } as const);
    }
    if (sessionRow.status === "completed") {
      const resultHash = yield* existingResultHash(transaction, stored.session.ceremony_intent_id);
      return resultHash === null
        ? yield* Effect.fail(storageFailure())
        : ({
            kind: "terminal",
            creation_intent_id: stored.session.creation_intent_id,
            ceremony_intent_id: stored.session.ceremony_intent_id,
            generation: stored.session.generation,
            status: "verified",
            result_hash: resultHash,
          } as const);
    }
    if (sessionRow.status === "failed" || sessionRow.status === "expired") {
      return {
        kind: "terminal",
        creation_intent_id: stored.session.creation_intent_id,
        ceremony_intent_id: stored.session.ceremony_intent_id,
        generation: stored.session.generation,
        status: sessionRow.status,
      } as const;
    }
    return yield* Effect.fail(storageFailure());
  });
}

function reacquire(
  transaction: Transaction,
  row: Row,
  input: NamespaceOwnershipStartReservationInput,
): Effect.Effect<
  NamespaceOwnershipStartReservation | null,
  ControlPlaneError | NamespaceOwnershipStartStorageFailed
> {
  return Effect.gen(function* () {
    const reservationId = stringValue(row, "reservation_id");
    const state = reservationState(row);
    const requestHash = reservationRequestHash(row);
    const oldFence = safeIntegerValue(row.fence_token);
    if (reservationId === null || state === null || requestHash === null || oldFence === null) {
      return yield* Effect.fail(storageFailure());
    }
    if (requestHash !== input.start.request_hash) return null;
    const renewed = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.reacquire-reservation",
      text: `UPDATE namespace_ownership_start_reservations
                SET state = 'acquired', fence_token = fence_token + 1,
                    lease_expires_at = clock_timestamp() + ($2 * INTERVAL '1 millisecond'),
                    updated_at = clock_timestamp()
              WHERE reservation_id = $1 AND state = 'released'
           RETURNING ${reservationColumns()}`,
      values: [reservationId, input.ttl_ms],
      readonly: false,
    });
    const renewedRow = oneRow(renewed);
    return renewedRow === undefined || renewedRow === null ? null : reservationFromRow(renewedRow);
  });
}

function releaseExpiredAcquired(
  transaction: Transaction,
  row: Row,
  input: NamespaceOwnershipStartReservationInput,
): Effect.Effect<Row | null, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const reservationId = stringValue(row, "reservation_id");
    const fence = safeIntegerValue(row.fence_token);
    if (reservationId === null || fence === null) return yield* Effect.fail(storageFailure());
    const released = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.release-expired-reservation",
      text: `UPDATE namespace_ownership_start_reservations
                SET state = 'released',
                    lease_expires_at = clock_timestamp() + ($3 * INTERVAL '1 millisecond'),
                    updated_at = clock_timestamp()
              WHERE reservation_id = $1 AND fence_token = $2
                AND state = 'acquired' AND lease_expires_at <= clock_timestamp()
           RETURNING ${reservationColumns()}`,
      values: [reservationId, fence, input.ttl_ms],
      readonly: false,
    });
    const releasedRow = oneRow(released);
    return releasedRow === undefined ? yield* Effect.fail(storageFailure()) : releasedRow;
  });
}

function insertNamespaceSession(
  transaction: Transaction,
  reservation: NamespaceOwnershipStartReservation,
  start: NamespaceOwnershipProviderStartResult,
): Effect.Effect<Row | null, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const session = start.session;
    const presentation = start.presentation;
    const payload = Object.fromEntries(
      Object.entries(presentation).filter(([key]) => key !== "kind"),
    );
    const route = session.route;
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.insert-session",
      text: `INSERT INTO namespace_ownership_sessions (
               namespace_session_id, actor_id, creation_intent_id, ceremony_intent_id,
               start_reservation_id, start_fence_token, expected_revision, generation,
               requirement_hash, request_hash, provider_id, provider_binding_hash,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, protocol_version, environment,
               route_family, route_root_label, route_root_label_display,
               route_path_segment, route_href, route_app_host, upstream_session_ref,
               presentation_kind, presentation_payload, status, started_at, expires_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26::jsonb,
               'pending', clock_timestamp(), $27
             )
             ON CONFLICT (actor_id, ceremony_intent_id) DO NOTHING
             RETURNING ${startColumns()}`,
      values: [
        reservation.namespace_session_id,
        session.actor_id,
        session.creation_intent_id,
        session.ceremony_intent_id,
        reservation.reservation_id,
        reservation.fence_token,
        reservation.expected_revision,
        session.generation,
        session.requirement_hash,
        session.request_hash,
        session.provider_id,
        session.provider_binding_hash,
        session.provider_configuration.kind,
        session.provider_configuration.reference,
        session.provider_configuration.version,
        session.protocol_version,
        session.environment,
        route.family,
        route.root_label,
        route.root_label_display,
        route.path_segment,
        route.href,
        route.app_host,
        session.upstream_session_ref,
        presentation.kind,
        JSON.stringify(payload),
        session.expires_at,
      ],
      readonly: false,
    });
    const row = oneRow(result);
    return row === undefined ? yield* Effect.fail(storageFailure()) : row;
  });
}

function authorityExpectedRevision(
  transaction: Transaction,
  reservationId: string,
): Effect.Effect<number | null, ControlPlaneError | NamespaceOwnershipStartStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "namespace-ownership.start.read-reservation-revision",
      text: "SELECT expected_revision FROM namespace_ownership_start_reservations WHERE reservation_id = $1",
      values: [reservationId],
      readonly: true,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    return row === null ? null : safeIntegerValue(row.expected_revision);
  });
}

export function makeControlPlaneNamespaceOwnershipStartAuthorityResolver(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): NamespaceOwnershipStartAuthorityResolver {
  return {
    resolve: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* readAuthority(db, input, false);
      }).pipe(
        Effect.provide(runtime),
        Effect.mapError(() => storageFailure()),
      ),
  };
}

export function makeControlPlaneNamespaceOwnershipStartRepository() {
  return {
    replay: (input: NamespaceOwnershipStartReplayInput) =>
      Effect.gen(function* () {
        if (
          !validIdentifier(input.actor_id) ||
          !validIdentifier(input.creation_intent_id) ||
          !validIdentifier(input.ceremony_intent_id) ||
          !validIdentifier(input.client_idempotency_key) ||
          !Number.isSafeInteger(input.expected_revision) ||
          input.expected_revision <= 0
        ) {
          return yield* Effect.fail(storageFailure());
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const authority = yield* lockAuthorityRecord(transaction, input);
            if (authority === null) return { kind: "not_found" } as const;
            const authorityStatus = replayAuthorityStatus(authority, input);
            if (authorityStatus === null) return { kind: "conflict" } as const;

            const keyRow = yield* reservationForKey(
              transaction,
              input.actor_id,
              input.creation_intent_id,
              input.client_idempotency_key,
            );
            const generation = safeIntegerValue(authority.generation);
            if (generation === null) return yield* Effect.fail(storageFailure());
            const generationRow = yield* reservationForGeneration(
              transaction,
              input.creation_intent_id,
              generation,
            );
            if (keyRow === null && generationRow === null) {
              if (authorityStatus === "pending") return { kind: "none" } as const;
              if (authorityStatus === "satisfied") return yield* Effect.fail(storageFailure());
              return {
                kind: "terminal",
                creation_intent_id: input.creation_intent_id,
                ceremony_intent_id: input.ceremony_intent_id,
                generation,
                status: authorityStatus,
              } as const;
            }
            if (
              keyRow === null ||
              generationRow === null ||
              keyRow.reservation_id !== generationRow.reservation_id ||
              !reservationMatchesAuthority(keyRow, authority)
            ) {
              return { kind: "conflict" } as const;
            }

            const sessionRow = yield* sessionForCeremony(
              transaction,
              input.actor_id,
              input.ceremony_intent_id,
            );
            if (sessionRow !== null) {
              return yield* classifyStoredSession(transaction, sessionRow, keyRow);
            }
            const state = reservationState(keyRow);
            const lease = timestampValue(keyRow, "lease_expires_at");
            if (state === null || lease === null) return yield* Effect.fail(storageFailure());
            if (authorityStatus !== "pending") {
              if (authorityStatus === "satisfied") return yield* Effect.fail(storageFailure());
              return {
                kind: "terminal",
                creation_intent_id: input.creation_intent_id,
                ceremony_intent_id: input.ceremony_intent_id,
                generation,
                status: authorityStatus,
              } as const;
            }
            if (state === "finalized") return yield* Effect.fail(storageFailure());
            if (state === "released") return { kind: "none" } as const;
            const now = yield* databaseNow(transaction);
            return Date.parse(lease) > Date.parse(now)
              ? ({
                  kind: "in_flight",
                  retry_after_seconds: retryAfterSeconds(lease, now),
                } as const)
              : ({ kind: "none" } as const);
          }),
        );
      }),
    reserve: (input: NamespaceOwnershipStartReservationInput) =>
      Effect.gen(function* () {
        const start = Schema.decodeUnknownOption(
          NamespaceOwnershipProviderStartInput,
          exactParseOptions,
        )(input.start);
        if (
          Option.isNone(start) ||
          start.value.route.family !== "hns" ||
          start.value.route.app_host !== null ||
          !validIdentifier(input.reservation_id) ||
          !validIdentifier(input.namespace_session_id) ||
          !validIdentifier(input.client_idempotency_key) ||
          !Number.isSafeInteger(input.expected_revision) ||
          input.expected_revision <= 0 ||
          !Number.isSafeInteger(input.ttl_ms) ||
          input.ttl_ms <= 0
        ) {
          return yield* Effect.fail(storageFailure());
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const authority = yield* lockAuthority(transaction, {
              actor_id: start.value.actor_id,
              creation_intent_id: start.value.creation_intent_id,
              ceremony_intent_id: start.value.ceremony_intent_id,
            });
            if (
              authority === null ||
              !sameAuthorityStart(authority, start.value, input.expected_revision)
            ) {
              return { kind: "conflict" } as const;
            }

            const keyRow = yield* reservationForKey(
              transaction,
              start.value.actor_id,
              start.value.creation_intent_id,
              input.client_idempotency_key,
            );
            const generationRow = yield* reservationForGeneration(
              transaction,
              start.value.creation_intent_id,
              start.value.generation,
            );
            const sessionRow = yield* sessionForCeremony(
              transaction,
              start.value.actor_id,
              start.value.ceremony_intent_id,
            );

            if (keyRow !== null && reservationRequestHash(keyRow) !== start.value.request_hash) {
              return { kind: "conflict" } as const;
            }
            if (
              generationRow !== null &&
              reservationRequestHash(generationRow) !== start.value.request_hash
            ) {
              return { kind: "conflict" } as const;
            }
            if (sessionRow !== null) {
              const classified = yield* classifySession(transaction, sessionRow, start.value);
              if (classified !== null) return classified;
            }
            const reservationRow = keyRow ?? generationRow;
            if (reservationRow !== null) {
              const state = reservationState(reservationRow);
              const requestHash = reservationRequestHash(reservationRow);
              if (requestHash !== start.value.request_hash || state === null) {
                return { kind: "conflict" } as const;
              }
              const now = yield* databaseNow(transaction);
              const lease = timestampValue(reservationRow, "lease_expires_at");
              if (lease === null) return yield* Effect.fail(storageFailure());
              if (state === "acquired" && Date.parse(lease) > Date.parse(now)) {
                return {
                  kind: "in_flight",
                  retry_after_seconds: retryAfterSeconds(lease, now),
                } as const;
              }
              if (state === "finalized") return yield* Effect.fail(storageFailure());
              if (state === "acquired")
                yield* releaseExpiredAcquired(transaction, reservationRow, input);
              const reacquired = yield* reacquire(transaction, reservationRow, input);
              const parsed = reacquired ?? reservationFromRow(reservationRow);
              return parsed === null
                ? yield* Effect.fail(storageFailure())
                : ({ kind: "acquired", reservation: parsed } as const);
            }
            const inserted = yield* insertReservation(transaction, {
              ...input,
              start: start.value,
            });
            return inserted === null
              ? yield* Effect.fail(storageFailure())
              : ({ kind: "acquired", reservation: inserted } as const);
          }),
        );
      }),
    finalize: (
      reservation: NamespaceOwnershipStartReservation,
      untrustedStart: NamespaceOwnershipProviderStartResult,
    ) =>
      Effect.gen(function* () {
        const start = Schema.decodeUnknownOption(
          NamespaceOwnershipProviderStartResult,
          exactParseOptions,
        )(untrustedStart);
        if (
          Option.isNone(start) ||
          start.value.session.route.family !== "hns" ||
          start.value.session.route.app_host !== null
        ) {
          return yield* Effect.fail(storageFailure());
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const authority = yield* lockAuthority(transaction, {
              actor_id: start.value.session.actor_id,
              creation_intent_id: start.value.session.creation_intent_id,
              ceremony_intent_id: start.value.session.ceremony_intent_id,
            });
            const expectedRevision = yield* authorityExpectedRevision(
              transaction,
              reservation.reservation_id,
            );
            const lock = yield* transaction.execute<Row>({
              label: "namespace-ownership.start.lock-finalizer",
              text: `SELECT ${reservationColumns()}, actor_id, creation_intent_id,
                             ceremony_intent_id, generation, expected_revision,
                             requirement_hash, provider_id, provider_binding_hash,
                             provider_configuration_kind, provider_configuration_ref,
                             provider_configuration_version, protocol_version, environment,
                             route_family, route_root_label, route_root_label_display,
                             route_path_segment, route_href, route_app_host
                        FROM namespace_ownership_start_reservations
                       WHERE reservation_id = $1
                       FOR UPDATE`,
              values: [reservation.reservation_id],
              readonly: false,
            });
            const row = oneRow(lock);
            const current = row === undefined || row === null ? null : reservationFromRow(row);
            if (
              authority === null ||
              expectedRevision === null ||
              current === null ||
              current.fence_token !== reservation.fence_token ||
              reservation.namespace_session_id !== current.namespace_session_id ||
              row?.state !== "acquired"
            ) {
              return { kind: "stale" } as const;
            }
            if (
              row === undefined ||
              row === null ||
              !reservationMatchesStart(row, start.value.session) ||
              start.value.session.provider_id !== authority.provider_id ||
              !sameAuthorityStart(
                authority,
                {
                  ...start.value.session,
                } as NamespaceOwnershipProviderStartInput,
                expectedRevision,
              )
            ) {
              return { kind: "conflict" } as const;
            }
            if (
              Date.parse(start.value.session.expires_at) <= Date.parse(current.lease_expires_at)
            ) {
              return yield* Effect.fail(storageFailure());
            }
            const fenced = yield* transaction.execute<Row>({
              label: "namespace-ownership.start.finalize-reservation",
              text: `UPDATE namespace_ownership_start_reservations
                        SET state = 'finalized', updated_at = clock_timestamp()
                      WHERE reservation_id = $1 AND fence_token = $2
                        AND state = 'acquired' AND lease_expires_at > clock_timestamp()
                   RETURNING ${reservationColumns()}`,
              values: [reservation.reservation_id, reservation.fence_token],
              readonly: false,
            });
            if (fenced.rowCount !== 1) return { kind: "stale" } as const;
            const inserted = yield* insertNamespaceSession(transaction, current, start.value);
            if (inserted === null) {
              const existing = yield* sessionForCeremony(
                transaction,
                start.value.session.actor_id,
                start.value.session.ceremony_intent_id,
              );
              if (existing === null) return yield* Effect.fail(storageFailure());
              const decoded = decodeStartRow(existing);
              const targetId = stringValue(existing, "namespace_session_id");
              if (decoded === null || targetId === null)
                return yield* Effect.fail(storageFailure());
              return decoded.session.request_hash === start.value.session.request_hash
                ? ({ kind: "replay", namespace_session_id: targetId, start: decoded } as const)
                : ({ kind: "conflict" } as const);
            }
            const persisted = decodeStartRow(inserted);
            const targetId = stringValue(inserted, "namespace_session_id");
            if (persisted === null || targetId === null)
              return yield* Effect.fail(storageFailure());
            return { kind: "created", namespace_session_id: targetId, start: persisted } as const;
          }),
        );
      }),
    release: (reservation: NamespaceOwnershipStartReservation) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          transaction.execute({
            label: "namespace-ownership.start.release-reservation",
            text: `UPDATE namespace_ownership_start_reservations
                      SET state = 'released', updated_at = clock_timestamp()
                    WHERE reservation_id = $1 AND fence_token = $2 AND state = 'acquired'`,
            values: [reservation.reservation_id, reservation.fence_token],
            readonly: false,
          }),
        );
      }),
  };
}

export function makeControlPlaneNamespaceOwnershipStartStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): NamespaceOwnershipStartStore {
  const repository = makeControlPlaneNamespaceOwnershipStartRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(() => storageFailure()));
  return {
    replay: (input) => provide(repository.replay(input)),
    reserve: (input) => provide(repository.reserve(input)),
    finalize: (reservation, start) => provide(repository.finalize(reservation, start)),
    release: (reservation) => provide(repository.release(reservation)),
  };
}
