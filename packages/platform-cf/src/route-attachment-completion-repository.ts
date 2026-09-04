import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  RouteAttachmentCompletionStorageFailed,
  type RouteAttachmentCompletionStore,
  type RouteAttachmentCompletionStored,
  RouteAttachmentOwnershipSession,
} from "@pirate/application";
import { ProviderConfigurationRef } from "@pirate/domain/verification";
import { Effect, type Layer, Option, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
const exact = { onExcessProperty: "error" } as const;
const failed = () => new RouteAttachmentCompletionStorageFailed();

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
  return new Date(value).toISOString();
}
const columns = `
  ns.namespace_session_id,ns.actor_id,ns.community_id,ns.attachment_intent_id,
  ns.ceremony_intent_id,ns.expected_revision,ns.generation,ns.requirement_hash,
  ns.request_hash,ns.provider_id,ns.provider_binding_hash,
  ns.provider_configuration_kind,ns.provider_configuration_ref,
  ns.provider_configuration_version,ns.protocol_version,ns.environment,
  ns.route_root_label,ns.upstream_session_ref,ns.status,ns.expires_at,
  intent.revision AS attachment_revision,intent.status AS attachment_status,
  result.outcome_status,result.result_hash`;

function stored(row: Row): RouteAttachmentCompletionStored | null {
  const configuration = Schema.decodeUnknownOption(
    ProviderConfigurationRef,
    exact,
  )({
    kind: row.provider_configuration_kind,
    reference: row.provider_configuration_ref,
    version: row.provider_configuration_version,
  });
  const root = text(row, "route_root_label");
  const session = Schema.decodeUnknownOption(
    RouteAttachmentOwnershipSession,
    exact,
  )({
    operation_kind: "route_attachment",
    actor_id: row.actor_id,
    community_id: row.community_id,
    attachment_intent_id: row.attachment_intent_id,
    ceremony_intent_id: row.ceremony_intent_id,
    requirement_hash: row.requirement_hash,
    generation: integer(row.generation),
    request_hash: row.request_hash,
    provider_id: row.provider_id,
    provider_binding_hash: row.provider_binding_hash,
    provider_configuration: Option.isSome(configuration) ? configuration.value : null,
    protocol_version: row.protocol_version,
    environment: row.environment,
    route:
      root === null
        ? null
        : {
            family: "hns",
            root_label: root,
            root_label_display: root,
            path_segment: `app.${root}`,
            href: `/c/app.${root}`,
            app_host: null,
          },
    upstream_session_ref: row.upstream_session_ref,
    expires_at: instant(row.expires_at),
  });
  const id = text(row, "namespace_session_id");
  const revision = integer(row.expected_revision);
  const status = text(row, "status");
  if (Option.isNone(session) || id === null || revision === null) return null;
  if (status !== "pending" && status !== "completed" && status !== "failed" && status !== "expired")
    return null;
  const terminalStatus =
    status === "completed" ? "verified" : status === "failed" ? "rejected" : "expired";
  const resultHash = text(row, "result_hash");
  const outcome = text(row, "outcome_status");
  if (status === "pending") {
    if (resultHash !== null || outcome !== null) return null;
    return {
      namespace_session_id: id,
      revision,
      session: session.value,
      status,
      terminal: null,
    } as const;
  }
  if (resultHash === null || outcome !== (status === "completed" ? "satisfied" : status))
    return null;
  return {
    namespace_session_id: id,
    revision,
    session: session.value,
    status,
    terminal: { status: terminalStatus, result_hash: resultHash },
  } as const;
}

const loadSql = `SELECT ${columns}
 FROM community_route_attachment_namespace_sessions AS ns
 JOIN community_route_attachment_intents AS intent
   ON intent.actor_id=ns.actor_id AND intent.attachment_intent_id=ns.attachment_intent_id
 LEFT JOIN community_route_attachment_ceremony_results AS result
   ON result.ceremony_intent_id=ns.ceremony_intent_id
 WHERE ns.actor_id=$1 AND ns.community_id=$2 AND ns.attachment_intent_id=$3
   AND ns.ceremony_intent_id=$4 AND ns.namespace_session_id=$5`;

function matchesRequest(row: Row, request: Parameters<RouteAttachmentCompletionStore["load"]>[0]) {
  return (
    row.actor_id === request.actor_id &&
    row.community_id === request.community_id &&
    row.attachment_intent_id === request.attachment_intent_id &&
    row.ceremony_intent_id === request.ceremony_intent_id &&
    row.namespace_session_id === request.session_id &&
    integer(row.expected_revision) === request.expected_revision
  );
}

function attempt(row: Row) {
  const completion_attempt_id = text(row, "completion_attempt_id");
  const namespace_session_id = text(row, "namespace_session_id");
  const fence_token = integer(row.fence_token);
  const evidence_ref = text(row, "evidence_ref");
  const lease_expires_at = instant(row.lease_expires_at);
  return completion_attempt_id === null ||
    namespace_session_id === null ||
    fence_token === null ||
    evidence_ref === null ||
    lease_expires_at === null
    ? null
    : {
        completion_attempt_id,
        namespace_session_id,
        fence_token,
        evidence_ref,
        lease_expires_at,
      };
}

function retryAfter(expiresAt: string): number {
  return Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1_000));
}

export function makeControlPlaneRouteAttachmentCompletionStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RouteAttachmentCompletionStore {
  const provide = <A>(effect: Effect.Effect<A, unknown, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(() => failed()));
  return {
    load: (request) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "route-attachment.completion.load",
            text: loadSql,
            values: [
              request.actor_id,
              request.community_id,
              request.attachment_intent_id,
              request.ceremony_intent_id,
              request.session_id,
            ],
            readonly: true,
          });
          const row = one(result);
          if (row === undefined) return yield* Effect.fail(failed());
          if (row === null) return null;
          const value = stored(row);
          return value === null ? yield* Effect.fail(failed()) : value;
        }),
      ),
    reserve: (input) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const loaded = yield* tx.execute<Row>({
                label: "route-attachment.completion.lock-authority",
                text: `${loadSql} FOR UPDATE OF ns,intent`,
                values: [
                  input.request.actor_id,
                  input.request.community_id,
                  input.request.attachment_intent_id,
                  input.request.ceremony_intent_id,
                  input.request.session_id,
                ],
                readonly: false,
              });
              const row = one(loaded);
              if (row === undefined) return yield* Effect.fail(failed());
              if (row === null) return { kind: "not_found" } as const;
              const current = stored(row);
              if (current === null) return yield* Effect.fail(failed());
              if (current.terminal !== null) return { kind: "replay", stored: current } as const;
              if (
                !matchesRequest(row, input.request) ||
                row.status !== "pending" ||
                row.attachment_status !== "verification_required" ||
                Date.parse(instant(row.expires_at) ?? "") <= Date.now()
              )
                return { kind: "conflict" } as const;
              const authority = yield* tx.execute<Row>({
                label: "route-attachment.completion.check-authority",
                text: "SELECT has_community_route_authority($1,$2) AS allowed",
                values: [input.request.community_id, input.request.actor_id],
                readonly: false,
              });
              if (one(authority)?.allowed !== true) return { kind: "not_found" } as const;
              const prior = yield* tx.execute<Row>({
                label: "route-attachment.completion.lock-attempts",
                text: `SELECT * FROM community_route_attachment_completion_attempts
                  WHERE namespace_session_id=$1 ORDER BY attempt_number FOR UPDATE`,
                values: [input.request.session_id],
                readonly: false,
              });
              for (const value of prior.rows) {
                if (
                  value.idempotency_key === input.request.idempotency_key &&
                  value.completion_request_sha256 !== input.completion_request_sha256
                )
                  return { kind: "conflict" } as const;
                const lease = instant(value.lease_expires_at);
                if (value.state === "leased" && lease !== null && Date.parse(lease) > Date.now())
                  return { kind: "in_flight", retry_after_seconds: retryAfter(lease) } as const;
              }
              if (prior.rows.length >= Math.min(3, input.max_attempts))
                return { kind: "budget_exhausted" } as const;
              const inserted = yield* tx.execute<Row>({
                label: "route-attachment.completion.insert-attempt",
                text: `INSERT INTO community_route_attachment_completion_attempts (
            completion_attempt_id,namespace_session_id,actor_id,community_id,attachment_intent_id,
            ceremony_intent_id,expected_revision,attempt_number,idempotency_key,
            completion_request_sha256,evidence_ref,state,fence_token,lease_expires_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'leased',1,
            clock_timestamp()+($12::bigint*interval '1 millisecond')) RETURNING *`,
                values: [
                  input.completion_attempt_id,
                  input.request.session_id,
                  input.request.actor_id,
                  input.request.community_id,
                  input.request.attachment_intent_id,
                  input.request.ceremony_intent_id,
                  input.request.expected_revision,
                  prior.rows.length + 1,
                  input.request.idempotency_key,
                  input.completion_request_sha256,
                  input.evidence_ref,
                  input.lease_ms,
                ],
                readonly: false,
              });
              const value = one(inserted);
              const reservation = value === null || value === undefined ? null : attempt(value);
              return reservation === null
                ? yield* Effect.fail(failed())
                : ({ kind: "acquired", reservation } as const);
            }),
          );
        }),
      ),
    release: (input) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute({
            label: "route-attachment.completion.release",
            text: `UPDATE community_route_attachment_completion_attempts SET state='released',updated_at=clock_timestamp()
                WHERE completion_attempt_id=$1 AND namespace_session_id=$2 AND actor_id=$3
                  AND idempotency_key=$4 AND completion_request_sha256=$5 AND fence_token=$6 AND state='leased'`,
            values: [
              input.reservation.completion_attempt_id,
              input.request.session_id,
              input.request.actor_id,
              input.request.idempotency_key,
              input.completion_request_sha256,
              input.reservation.fence_token,
            ],
            readonly: false,
          });
          return result.rowCount === 1 ? ("released" as const) : ("lease_lost" as const);
        }),
      ),
    finalize: (input) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const loaded = yield* tx.execute<Row>({
                label: "route-attachment.completion.lock-finalizer",
                text: `SELECT attempt.*,ns.status AS session_status,ns.expected_revision,ns.generation,
            ns.requirement_hash,ns.provider_id,ns.provider_binding_hash,
            ns.provider_configuration_version,ns.route_root_label,ns.expires_at AS session_expires_at,
            intent.status AS attachment_status,intent.revision AS attachment_revision,
            result.outcome_status AS prior_outcome,result.result_hash AS prior_result_hash
          FROM community_route_attachment_completion_attempts AS attempt
          JOIN community_route_attachment_namespace_sessions AS ns
            ON ns.namespace_session_id=attempt.namespace_session_id
          JOIN community_route_attachment_intents AS intent
            ON intent.actor_id=attempt.actor_id AND intent.attachment_intent_id=attempt.attachment_intent_id
          LEFT JOIN community_route_attachment_ceremony_results AS result
            ON result.ceremony_intent_id=attempt.ceremony_intent_id
          WHERE attempt.completion_attempt_id=$1 FOR UPDATE OF attempt,ns,intent`,
                values: [input.reservation.completion_attempt_id],
                readonly: false,
              });
              const row = one(loaded);
              if (row === undefined) return yield* Effect.fail(failed());
              if (
                row === null ||
                !matchesRequest(row, input.request) ||
                row.completion_request_sha256 !== input.completion_request_sha256
              )
                return { kind: "conflict" } as const;
              if (row.state === "consumed")
                return row.result_hash === input.result_hash
                  ? ({
                      kind: "replay",
                      status: row.terminal_status as "verified" | "rejected" | "expired",
                      result_hash: input.result_hash,
                    } as const)
                  : ({ kind: "conflict" } as const);
              if (
                row.state !== "leased" ||
                integer(row.fence_token) !== input.reservation.fence_token ||
                Date.parse(instant(row.lease_expires_at) ?? "") <= Date.now() ||
                row.session_status !== "pending" ||
                row.attachment_status !== "verification_required"
              )
                return { kind: "lease_lost" } as const;
              const allowed = yield* tx.execute<Row>({
                label: "route-attachment.completion.recheck-authority",
                text: "SELECT has_community_route_authority($1,$2) AS allowed,clock_timestamp() AS now",
                values: [input.request.community_id, input.request.actor_id],
                readonly: false,
              });
              const clock = one(allowed);
              const now = clock === null || clock === undefined ? null : instant(clock.now);
              if (clock?.allowed !== true || now === null) return { kind: "conflict" } as const;
              const verified =
                input.status === "verified" &&
                input.provider_result.status === "verified" &&
                input.provider_response_sha256 !== null &&
                input.evidence_digest !== null &&
                input.provider_identity_digest !== null;
              if ((input.status === "verified") !== verified) return { kind: "conflict" } as const;
              const outcome =
                input.status === "verified"
                  ? "satisfied"
                  : input.status === "rejected"
                    ? "failed"
                    : "expired";
              const consumed = yield* tx.execute({
                label: "route-attachment.completion.consume-attempt",
                text: `UPDATE community_route_attachment_completion_attempts
                  SET state='consumed',terminal_status=$1,result_hash=$2,terminal_at=$3::timestamptz,
                      updated_at=$3::timestamptz
                  WHERE completion_attempt_id=$4 AND fence_token=$5 AND state='leased'
                    AND lease_expires_at>clock_timestamp()`,
                values: [
                  input.status,
                  input.result_hash,
                  now,
                  input.reservation.completion_attempt_id,
                  input.reservation.fence_token,
                ],
                readonly: false,
              });
              if (consumed.rowCount !== 1) return { kind: "lease_lost" } as const;
              const raw =
                "raw_response_bytes" in input.provider_result
                  ? input.provider_result.raw_response_bytes
                  : null;
              const observedAt =
                input.provider_result.status === "verified"
                  ? input.provider_result.observed_at
                  : null;
              const expiresAt =
                input.provider_result.status === "verified"
                  ? input.provider_result.expires_at
                  : null;
              const observation = yield* tx.execute({
                label: "route-attachment.completion.insert-observation",
                text: `INSERT INTO community_route_attachment_completion_observations (
            result_hash,completion_attempt_id,namespace_session_id,actor_id,community_id,
            attachment_intent_id,ceremony_intent_id,status,provider_response_sha256,
            evidence_digest,provider_identity_digest,raw_response_bytes,observed_at,expires_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz)`,
                values: [
                  input.result_hash,
                  input.reservation.completion_attempt_id,
                  input.request.session_id,
                  input.request.actor_id,
                  input.request.community_id,
                  input.request.attachment_intent_id,
                  input.request.ceremony_intent_id,
                  input.status,
                  input.provider_response_sha256,
                  input.evidence_digest,
                  input.provider_identity_digest,
                  raw,
                  observedAt,
                  expiresAt,
                ],
                readonly: false,
              });
              if (observation.rowCount !== 1) return yield* Effect.fail(failed());
              const result = yield* tx.execute({
                label: "route-attachment.completion.insert-result",
                text: `INSERT INTO community_route_attachment_ceremony_results (
            ceremony_intent_id,actor_id,attachment_intent_id,requirement_kind,generation,
            callback_idempotency_key,callback_request_hash,outcome_status,result_hash,
            evidence_ref,evidence_digest,provider_identity_digest,terminal_at,satisfied_at
          ) VALUES ($1,$2,$3,'namespace_ownership',$4,$5,$6,$7,$8,$9,$10,$11,
            $12::timestamptz,$13::timestamptz)`,
                values: [
                  input.request.ceremony_intent_id,
                  input.request.actor_id,
                  input.request.attachment_intent_id,
                  integer(row.generation),
                  input.request.idempotency_key,
                  input.completion_request_sha256,
                  outcome,
                  input.result_hash,
                  verified ? input.reservation.evidence_ref : null,
                  input.evidence_digest,
                  input.provider_identity_digest,
                  now,
                  verified ? now : null,
                ],
                readonly: false,
              });
              if (result.rowCount !== 1) return yield* Effect.fail(failed());
              const requirement = yield* tx.execute({
                label: "route-attachment.completion.transition-requirement",
                text: `UPDATE community_route_attachment_requirement_states
                  SET status=$1,satisfied_at=$2::timestamptz,updated_at=$3::timestamptz
                  WHERE attachment_intent_id=$4 AND actor_id=$5 AND requirement_kind='namespace_ownership'
                    AND status='pending' AND current_ceremony_intent_id=$6`,
                values: [
                  outcome,
                  verified ? now : null,
                  now,
                  input.request.attachment_intent_id,
                  input.request.actor_id,
                  input.request.ceremony_intent_id,
                ],
                readonly: false,
              });
              if (requirement.rowCount !== 1) return yield* Effect.fail(failed());
              if (verified) {
                const evidence = yield* tx.execute({
                  label: "route-attachment.completion.insert-evidence",
                  text: `INSERT INTO community_route_ownership_evidence (
              evidence_ref,creation_ceremony_intent_id,verified_by_actor_id,family,root_label,
              root_label_display,path_segment,requirement_hash,provider_id,provider_binding_hash,
              provider_configuration_version,provider_identity_digest,evidence_digest,
              evidence_receipt_id,binding_generation,verified_at,expires_at,origin,
              route_attachment_ceremony_intent_id
            ) VALUES ($1,NULL,$2,'hns',$3,$3,'app.'||$3,$4,$5,$6,$7,$8,$9,NULL,$10,
              $11::timestamptz,$12::timestamptz,'route_attachment',$13)`,
                  values: [
                    input.reservation.evidence_ref,
                    input.request.actor_id,
                    row.route_root_label,
                    row.requirement_hash,
                    row.provider_id,
                    row.provider_binding_hash,
                    row.provider_configuration_version,
                    input.provider_identity_digest,
                    input.evidence_digest,
                    integer(row.generation),
                    now,
                    expiresAt,
                    input.request.ceremony_intent_id,
                  ],
                  readonly: false,
                });
                if (evidence.rowCount !== 1) return yield* Effect.fail(failed());
              }
              const session = yield* tx.execute({
                label: "route-attachment.completion.transition-session",
                text: `UPDATE community_route_attachment_namespace_sessions
                  SET status=$1,completed_at=$2::timestamptz,terminal_at=$3::timestamptz,
                      updated_at=$3::timestamptz
                  WHERE namespace_session_id=$4 AND status='pending'`,
                values: [
                  verified ? "completed" : input.status === "rejected" ? "failed" : "expired",
                  verified ? now : null,
                  now,
                  input.request.session_id,
                ],
                readonly: false,
              });
              if (session.rowCount !== 1) return yield* Effect.fail(failed());
              const nextAttachment = verified
                ? "commit_ready"
                : input.status === "rejected"
                  ? "failed"
                  : "expired";
              const intent = yield* tx.execute({
                label: "route-attachment.completion.transition-intent",
                text: `UPDATE community_route_attachment_intents
                  SET status=$1,revision=revision+1,updated_at=$2::timestamptz
                  WHERE actor_id=$3 AND community_id=$4 AND attachment_intent_id=$5
                    AND status='verification_required'`,
                values: [
                  nextAttachment,
                  now,
                  input.request.actor_id,
                  input.request.community_id,
                  input.request.attachment_intent_id,
                ],
                readonly: false,
              });
              if (intent.rowCount !== 1) return yield* Effect.fail(failed());
              return {
                kind: "committed",
                status: input.status,
                result_hash: input.result_hash,
              } as const;
            }),
          );
        }),
      ),
  };
}
