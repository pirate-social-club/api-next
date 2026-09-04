import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneTransaction,
  RouteAttachmentOwnershipProviderStartInput,
  RouteAttachmentOwnershipProviderStartResult,
  type RouteAttachmentOwnershipStartAuthority,
  type RouteAttachmentOwnershipStartAuthorityResolver,
  type RouteAttachmentOwnershipStartReservation,
  RouteAttachmentOwnershipStartStorageFailed,
  type RouteAttachmentOwnershipStartStore,
} from "@pirate/application";
import { ProviderPresentation } from "@pirate/contracts";
import { ProviderConfigurationRef } from "@pirate/domain/verification";
import { Effect, type Layer, Option, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Tx = ControlPlaneTransaction;
const exact = { onExcessProperty: "error" } as const;
const failed = () => new RouteAttachmentOwnershipStartStorageFailed();

function one<T>(result: ControlPlaneResult<T>): T | null | undefined {
  return result.rows.length > 1 ? undefined : (result.rows[0] ?? null);
}
function text(row: Row, key: string): string | null {
  return typeof row[key] === "string" ? row[key] : null;
}
function integer(value: unknown): number | null {
  const parsed = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function instant(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}
function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

const authoritySql = `SELECT
  intent.actor_id,intent.community_id,intent.attachment_intent_id,intent.revision,
  intent.status AS intent_status,intent.expires_at,
  state.requirement_hash,state.generation,state.status AS requirement_status,
  state.current_ceremony_intent_id,state.provider_id,state.provider_binding_hash,
  state.provider_configuration_kind,state.provider_configuration_ref,
  state.provider_configuration_version,state.family,state.root_label,
  state.root_label_display,state.path_segment,attempt.ceremony_intent_id,
  attempt.generation AS ceremony_generation,attempt.expires_at AS ceremony_expires_at,
  has_community_route_authority(intent.community_id,intent.actor_id) AS has_authority
 FROM community_route_attachment_intents AS intent
 JOIN community_route_attachment_requirement_states AS state
   ON state.attachment_intent_id=intent.attachment_intent_id
  AND state.requirement_kind='namespace_ownership'
 JOIN community_route_attachment_ceremony_attempts AS attempt
   ON attempt.ceremony_intent_id=state.current_ceremony_intent_id
 WHERE intent.actor_id=$1 AND intent.community_id=$2
   AND intent.attachment_intent_id=$3 AND attempt.ceremony_intent_id=$4`;

function authority(
  row: Row,
  expectedRevision?: number,
): RouteAttachmentOwnershipStartAuthority | null {
  const revision = integer(row.revision);
  const generation = integer(row.generation);
  const ceremonyGeneration = integer(row.ceremony_generation);
  const configuration = Schema.decodeUnknownOption(
    ProviderConfigurationRef,
    exact,
  )({
    kind: row.provider_configuration_kind,
    reference: row.provider_configuration_ref,
    version: row.provider_configuration_version,
  });
  if (
    revision === null ||
    generation === null ||
    ceremonyGeneration !== generation ||
    (expectedRevision !== undefined && revision !== expectedRevision) ||
    row.intent_status !== "verification_required" ||
    row.requirement_status !== "pending" ||
    row.has_authority !== true ||
    row.current_ceremony_intent_id !== row.ceremony_intent_id ||
    row.family !== "hns" ||
    Option.isNone(configuration) ||
    Date.parse(instant(row.expires_at) ?? "") <= Date.now() ||
    Date.parse(instant(row.ceremony_expires_at) ?? "") <= Date.now()
  )
    return null;
  const actor_id = text(row, "actor_id");
  const community_id = text(row, "community_id");
  const attachment_intent_id = text(row, "attachment_intent_id");
  const ceremony_intent_id = text(row, "ceremony_intent_id");
  const requirement_hash = text(row, "requirement_hash");
  const provider_id = text(row, "provider_id");
  const provider_binding_hash = text(row, "provider_binding_hash");
  const root_label = text(row, "root_label");
  const root_label_display = text(row, "root_label_display");
  const path_segment = text(row, "path_segment");
  if (
    actor_id === null ||
    community_id === null ||
    attachment_intent_id === null ||
    ceremony_intent_id === null ||
    requirement_hash === null ||
    provider_id === null ||
    provider_binding_hash === null ||
    root_label === null ||
    root_label_display === null ||
    path_segment === null
  )
    return null;
  return {
    actor_id,
    community_id,
    attachment_intent_id,
    ceremony_intent_id,
    expected_revision: revision,
    requirement_hash,
    generation,
    provider_id,
    provider_binding_hash,
    provider_configuration: configuration.value,
    route: {
      family: "hns",
      root_label,
      root_label_display,
      path_segment,
      href: `/c/${path_segment}`,
      app_host: null,
    },
  };
}

function readAuthority(
  tx: Tx,
  input: Parameters<RouteAttachmentOwnershipStartAuthorityResolver["resolve"]>[0],
  lock: boolean,
) {
  return Effect.gen(function* () {
    const result = yield* tx.execute<Row>({
      label: lock
        ? "route-attachment.start.lock-authority"
        : "route-attachment.start.resolve-authority",
      text: `${authoritySql}${lock ? " FOR UPDATE OF intent, state, attempt" : ""}`,
      values: [
        input.actor_id,
        input.community_id,
        input.attachment_intent_id,
        input.ceremony_intent_id,
      ],
      readonly: !lock,
    });
    const row = one(result);
    if (row === undefined) return yield* Effect.fail(failed());
    return row === null ? null : authority(row, input.expected_revision);
  });
}

function reservation(row: Row): RouteAttachmentOwnershipStartReservation | null {
  const reservation_id = text(row, "reservation_id"),
    namespace_session_id = text(row, "namespace_session_id");
  const expected_revision = integer(row.expected_revision),
    fence_token = integer(row.fence_token);
  const lease_expires_at = instant(row.lease_expires_at);
  return reservation_id === null ||
    namespace_session_id === null ||
    expected_revision === null ||
    fence_token === null ||
    lease_expires_at === null
    ? null
    : { reservation_id, namespace_session_id, expected_revision, fence_token, lease_expires_at };
}

function decodeStart(row: Row) {
  const configuration = Schema.decodeUnknownOption(
    ProviderConfigurationRef,
    exact,
  )({
    kind: row.provider_configuration_kind,
    reference: row.provider_configuration_ref,
    version: row.provider_configuration_version,
  });
  const payload = json(row.presentation_payload);
  const presentation = Schema.decodeUnknownOption(
    ProviderPresentation,
    exact,
  )({
    kind: row.presentation_kind,
    ...(payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {}),
  });
  const generation = integer(row.generation),
    expires_at = instant(row.expires_at);
  if (
    Option.isNone(configuration) ||
    Option.isNone(presentation) ||
    generation === null ||
    expires_at === null
  )
    return null;
  const candidate = {
    session: {
      operation_kind: "route_attachment",
      actor_id: row.actor_id,
      community_id: row.community_id,
      attachment_intent_id: row.attachment_intent_id,
      ceremony_intent_id: row.ceremony_intent_id,
      requirement_hash: row.requirement_hash,
      generation,
      request_hash: row.request_hash,
      provider_id: row.provider_id,
      provider_binding_hash: row.provider_binding_hash,
      provider_configuration: configuration.value,
      protocol_version: row.protocol_version,
      environment: row.environment,
      route: {
        family: "hns",
        root_label: row.route_root_label,
        root_label_display: row.route_root_label,
        path_segment: `app.${String(row.route_root_label)}`,
        href: `/c/app.${String(row.route_root_label)}`,
        app_host: null,
      },
      upstream_session_ref: row.upstream_session_ref,
      expires_at,
    },
    presentation: presentation.value,
  };
  const decoded = Schema.decodeUnknownOption(
    RouteAttachmentOwnershipProviderStartResult,
    exact,
  )(candidate);
  return Option.isSome(decoded) ? decoded.value : null;
}

function retry(lease: string): number {
  return Math.max(1, Math.ceil((Date.parse(lease) - Date.now()) / 1000));
}

function matchesStart(
  current: RouteAttachmentOwnershipStartAuthority,
  start: Schema.Schema.Type<typeof RouteAttachmentOwnershipProviderStartInput>,
  expectedRevision: number,
  providerId: string,
): boolean {
  return (
    current.actor_id === start.actor_id &&
    current.community_id === start.community_id &&
    current.attachment_intent_id === start.attachment_intent_id &&
    current.ceremony_intent_id === start.ceremony_intent_id &&
    current.expected_revision === expectedRevision &&
    current.requirement_hash === start.requirement_hash &&
    current.generation === start.generation &&
    current.provider_id === providerId &&
    current.provider_binding_hash === start.provider_binding_hash &&
    canonicalConfiguration(current.provider_configuration) ===
      canonicalConfiguration(start.provider_configuration) &&
    current.route.family === start.route.family &&
    current.route.root_label === start.route.root_label &&
    current.route.root_label_display === start.route.root_label_display &&
    current.route.path_segment === start.route.path_segment &&
    current.route.href === start.route.href &&
    start.route.app_host === null
  );
}

function canonicalConfiguration(
  value: Readonly<{ kind: string; reference: string; version: string }>,
): string {
  return `${value.kind}\u0000${value.reference}\u0000${value.version}`;
}

export function makeControlPlaneRouteAttachmentOwnershipStartAuthorityResolver(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RouteAttachmentOwnershipStartAuthorityResolver {
  return {
    resolve: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* readAuthority(db, input, false);
      }).pipe(
        Effect.provide(runtime),
        Effect.mapError(() => failed()),
      ),
  };
}

export function makeControlPlaneRouteAttachmentOwnershipStartStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RouteAttachmentOwnershipStartStore {
  const provide = <A>(effect: Effect.Effect<A, unknown, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(() => failed()));
  return {
    replay: (input) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const current = yield* readAuthority(tx, input, true);
              if (current === null) return { kind: "not_found" } as const;
              const found = yield* tx.execute<Row>({
                label: "route-attachment.start.replay",
                text: `SELECT reservation.*,
          session.requirement_hash,session.upstream_session_ref,session.presentation_kind,
          session.presentation_payload,session.expires_at,session.status AS session_status
          FROM community_route_attachment_start_reservations AS reservation
          LEFT JOIN community_route_attachment_namespace_sessions AS session
            ON session.start_reservation_id=reservation.reservation_id
          WHERE reservation.actor_id=$1 AND reservation.attachment_intent_id=$2
            AND reservation.client_idempotency_key=$3 FOR UPDATE OF reservation`,
                values: [input.actor_id, input.attachment_intent_id, input.client_idempotency_key],
                readonly: false,
              });
              const row = one(found);
              if (row === undefined) return yield* Effect.fail(failed());
              if (row === null) return { kind: "none" } as const;
              if (
                row.ceremony_intent_id !== input.ceremony_intent_id ||
                integer(row.expected_revision) !== input.expected_revision
              )
                return { kind: "conflict" } as const;
              if (row.session_status !== null && row.session_status !== undefined) {
                const start = decodeStart(row);
                const id = text(row, "namespace_session_id");
                return start === null || id === null
                  ? yield* Effect.fail(failed())
                  : ({ kind: "replay", namespace_session_id: id, start } as const);
              }
              const lease = instant(row.lease_expires_at);
              if (row.state === "acquired" && lease !== null && Date.parse(lease) > Date.now())
                return { kind: "in_flight", retry_after_seconds: retry(lease) } as const;
              return row.state === "finalized"
                ? yield* Effect.fail(failed())
                : ({ kind: "none" } as const);
            }),
          );
        }),
      ),
    reserve: (input) =>
      provide(
        Effect.gen(function* () {
          const decoded = Schema.decodeUnknownOption(
            RouteAttachmentOwnershipProviderStartInput,
            exact,
          )(input.start);
          if (Option.isNone(decoded)) return yield* Effect.fail(failed());
          const start = decoded.value,
            db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const current = yield* readAuthority(
                tx,
                {
                  actor_id: start.actor_id,
                  community_id: start.community_id,
                  attachment_intent_id: start.attachment_intent_id,
                  ceremony_intent_id: start.ceremony_intent_id,
                  expected_revision: input.expected_revision,
                },
                true,
              );
              if (
                current === null ||
                !matchesStart(current, start, input.expected_revision, input.provider_id)
              )
                return { kind: "conflict" } as const;
              const found = yield* tx.execute<Row>({
                label: "route-attachment.start.lock-reservation",
                text: `SELECT * FROM community_route_attachment_start_reservations
          WHERE actor_id=$1 AND attachment_intent_id=$2 AND (client_idempotency_key=$3 OR generation=$4) FOR UPDATE`,
                values: [
                  start.actor_id,
                  start.attachment_intent_id,
                  input.client_idempotency_key,
                  start.generation,
                ],
                readonly: false,
              });
              const row = one(found);
              if (row === undefined) return yield* Effect.fail(failed());
              if (row !== null) {
                if (row.request_hash !== start.request_hash) return { kind: "conflict" } as const;
                const sessions = yield* tx.execute<Row>({
                  label: "route-attachment.start.existing-session",
                  text: "SELECT * FROM community_route_attachment_namespace_sessions WHERE start_reservation_id=$1 FOR UPDATE",
                  values: [row.reservation_id],
                  readonly: false,
                });
                const session = one(sessions);
                if (session === undefined) return yield* Effect.fail(failed());
                if (session !== null) {
                  const value = decodeStart(session),
                    id = text(session, "namespace_session_id");
                  return value === null || id === null
                    ? yield* Effect.fail(failed())
                    : ({ kind: "replay", namespace_session_id: id, start: value } as const);
                }
                const lease = instant(row.lease_expires_at);
                if (row.state === "acquired" && lease !== null && Date.parse(lease) > Date.now())
                  return { kind: "in_flight", retry_after_seconds: retry(lease) } as const;
                const reacquired = yield* tx.execute<Row>({
                  label: "route-attachment.start.reacquire",
                  text: `UPDATE community_route_attachment_start_reservations SET state='acquired',fence_token=fence_token+1,
            lease_expires_at=clock_timestamp()+($1::bigint*interval '1 millisecond'),updated_at=clock_timestamp()
            WHERE reservation_id=$2 AND state IN ('released','acquired') RETURNING *`,
                  values: [input.ttl_ms, row.reservation_id],
                  readonly: false,
                });
                const value = one(reacquired);
                const parsed = value === null || value === undefined ? null : reservation(value);
                return parsed === null
                  ? yield* Effect.fail(failed())
                  : ({ kind: "acquired", reservation: parsed } as const);
              }
              const inserted = yield* tx.execute<Row>({
                label: "route-attachment.start.insert-reservation",
                text: `INSERT INTO community_route_attachment_start_reservations (
          reservation_id,namespace_session_id,actor_id,community_id,attachment_intent_id,ceremony_intent_id,generation,
          expected_revision,client_idempotency_key,request_hash,provider_id,provider_binding_hash,provider_configuration_kind,
          provider_configuration_ref,provider_configuration_version,protocol_version,environment,route_root_label,state,fence_token,lease_expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'acquired',1,
          clock_timestamp()+($19::bigint*interval '1 millisecond')) RETURNING *`,
                values: [
                  input.reservation_id,
                  input.namespace_session_id,
                  start.actor_id,
                  start.community_id,
                  start.attachment_intent_id,
                  start.ceremony_intent_id,
                  start.generation,
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
                  start.route.root_label,
                  input.ttl_ms,
                ],
                readonly: false,
              });
              const value = one(inserted),
                parsed = value === null || value === undefined ? null : reservation(value);
              return parsed === null
                ? yield* Effect.fail(failed())
                : ({ kind: "acquired", reservation: parsed } as const);
            }),
          );
        }),
      ),
    finalize: (reservationInput, untrusted) =>
      provide(
        Effect.gen(function* () {
          const decoded = Schema.decodeUnknownOption(
            RouteAttachmentOwnershipProviderStartResult,
            exact,
          )(untrusted);
          if (Option.isNone(decoded)) return yield* Effect.fail(failed());
          const start = decoded.value,
            db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const lock = yield* tx.execute<Row>({
                label: "route-attachment.start.lock-finalizer",
                text: "SELECT * FROM community_route_attachment_start_reservations WHERE reservation_id=$1 FOR UPDATE",
                values: [reservationInput.reservation_id],
                readonly: false,
              });
              const row = one(lock),
                current = row === null || row === undefined ? null : reservation(row);
              if (
                current === null ||
                current.fence_token !== reservationInput.fence_token ||
                row?.state !== "acquired" ||
                Date.parse(current.lease_expires_at) <= Date.now()
              )
                return { kind: "stale" } as const;
              const liveAuthority = yield* readAuthority(
                tx,
                {
                  actor_id: start.session.actor_id,
                  community_id: start.session.community_id,
                  attachment_intent_id: start.session.attachment_intent_id,
                  ceremony_intent_id: start.session.ceremony_intent_id,
                  expected_revision: reservationInput.expected_revision,
                },
                true,
              );
              if (
                liveAuthority === null ||
                !matchesStart(
                  liveAuthority,
                  {
                    ...start.session,
                    operation_kind: "route_attachment",
                  },
                  reservationInput.expected_revision,
                  start.session.provider_id,
                ) ||
                row?.request_hash !== start.session.request_hash ||
                row?.namespace_session_id !== reservationInput.namespace_session_id ||
                row?.attachment_intent_id !== start.session.attachment_intent_id
              )
                return { kind: "conflict" } as const;
              const fenced = yield* tx.execute({
                label: "route-attachment.start.finalize-reservation",
                text: "UPDATE community_route_attachment_start_reservations SET state='finalized',updated_at=clock_timestamp() WHERE reservation_id=$1 AND fence_token=$2 AND state='acquired' AND lease_expires_at>clock_timestamp()",
                values: [reservationInput.reservation_id, reservationInput.fence_token],
                readonly: false,
              });
              if (fenced.rowCount !== 1) return { kind: "stale" } as const;
              const p = start.presentation as { kind: string; [key: string]: unknown };
              const { kind, ...payload } = p;
              const inserted = yield* tx.execute<Row>({
                label: "route-attachment.start.insert-session",
                text: `INSERT INTO community_route_attachment_namespace_sessions (
          namespace_session_id,actor_id,community_id,attachment_intent_id,ceremony_intent_id,start_reservation_id,
          start_fence_token,expected_revision,generation,requirement_hash,request_hash,provider_id,provider_binding_hash,
          provider_configuration_kind,provider_configuration_ref,provider_configuration_version,protocol_version,environment,
          route_root_label,upstream_session_ref,presentation_kind,presentation_payload,status,started_at,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,
          'pending',clock_timestamp(),$23::timestamptz) ON CONFLICT (actor_id,ceremony_intent_id) DO NOTHING RETURNING *`,
                values: [
                  reservationInput.namespace_session_id,
                  start.session.actor_id,
                  start.session.community_id,
                  start.session.attachment_intent_id,
                  start.session.ceremony_intent_id,
                  reservationInput.reservation_id,
                  reservationInput.fence_token,
                  reservationInput.expected_revision,
                  start.session.generation,
                  start.session.requirement_hash,
                  start.session.request_hash,
                  start.session.provider_id,
                  start.session.provider_binding_hash,
                  start.session.provider_configuration.kind,
                  start.session.provider_configuration.reference,
                  start.session.provider_configuration.version,
                  start.session.protocol_version,
                  start.session.environment,
                  start.session.route.root_label,
                  start.session.upstream_session_ref,
                  kind,
                  JSON.stringify(payload),
                  start.session.expires_at,
                ],
                readonly: false,
              });
              const row2 = one(inserted);
              if (row2 === undefined) return yield* Effect.fail(failed());
              if (row2 === null) {
                const existing = yield* tx.execute<Row>({
                  label: "route-attachment.start.replay-finalized",
                  text: "SELECT * FROM community_route_attachment_namespace_sessions WHERE actor_id=$1 AND ceremony_intent_id=$2",
                  values: [start.session.actor_id, start.session.ceremony_intent_id],
                  readonly: true,
                });
                const erow = one(existing),
                  stored = erow === null || erow === undefined ? null : decodeStart(erow),
                  id =
                    erow === null || erow === undefined ? null : text(erow, "namespace_session_id");
                return stored !== null &&
                  id !== null &&
                  stored.session.request_hash === start.session.request_hash
                  ? ({ kind: "replay", namespace_session_id: id, start: stored } as const)
                  : ({ kind: "conflict" } as const);
              }
              const stored = decodeStart(row2),
                id = text(row2, "namespace_session_id");
              return stored === null || id === null
                ? yield* Effect.fail(failed())
                : ({ kind: "created", namespace_session_id: id, start: stored } as const);
            }),
          );
        }),
      ),
    release: (reservationInput) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((tx) =>
            tx.execute({
              label: "route-attachment.start.release",
              text: "UPDATE community_route_attachment_start_reservations SET state='released',updated_at=clock_timestamp() WHERE reservation_id=$1 AND fence_token=$2 AND state='acquired'",
              values: [reservationInput.reservation_id, reservationInput.fence_token],
              readonly: false,
            }),
          );
        }),
      ),
  };
}
