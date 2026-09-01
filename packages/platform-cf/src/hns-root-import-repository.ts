import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneTransaction,
  decodeHnsRootImportReadinessResultV1,
  type GetHnsRootImportInput,
  HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
  type HnsRootImportActivationRecord,
  type HnsRootImportActivationStoreOutcome,
  type HnsRootImportObservationRecord,
  type HnsRootImportObservationStartOutcome,
  type HnsRootImportOwnershipTerminalOutcome,
  type HnsRootImportPollAuthority,
  type HnsRootImportProvisionRecord,
  type HnsRootImportProvisionStartOutcome,
  type HnsRootImportStartRecord,
  type HnsRootImportStartStoreOutcome,
  HnsRootImportStorageFailed,
  type HnsRootImportStore,
  hnsRootImportNameProofMessage,
  prepareHnsDnsZoneActivationDocumentV1,
} from "@pirate/application";
import { decodeStrictHnsJsonBytes } from "@pirate/application/namespace-ownership";
import {
  type HnsRootImportSessionResponseV1 as HnsRootImportSessionResponse,
  HnsRootImportSessionResponseV1,
} from "@pirate/contracts";
import { handleSaleNamespaceActivationHash } from "@pirate/domain";
import { Effect, type Layer, Option, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;

const exactParseOptions = { onExcessProperty: "error" } as const;
const storageFailure = (): HnsRootImportStorageFailed => new HnsRootImportStorageFailed();

function oneRow<RowType>(result: ControlPlaneResult<RowType>): RowType | null | undefined {
  if (result.rows.length > 1) return undefined;
  return result.rows[0] ?? null;
}

function stringValue(row: Row, name: string): string | null {
  return typeof row[name] === "string" ? row[name] : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function instant(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function bytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return null;
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodePlan(value: unknown): HnsRootImportSessionResponse["publish_plan"] | undefined {
  if (value === null || value === undefined) return null;
  const retained = bytes(value);
  if (retained === null) return undefined;
  let decoded: unknown;
  try {
    decoded = decodeStrictHnsJsonBytes(retained, 1_048_576);
  } catch {
    return undefined;
  }
  const planResponse = Schema.decodeUnknownOption(
    HnsRootImportSessionResponseV1,
    exactParseOptions,
  )({
    creation_intent_id: "decode",
    ceremony_intent_id: "decode",
    root_import_session_id: "decode",
    namespace_session_id: "decode",
    root_label: "decode",
    revision: 1,
    expires_at: "2099-01-01T00:00:00.000Z",
    replayed: false,
    status: "awaiting_owner_update",
    publish_plan: decoded,
    publish_plan_sha256: "0".repeat(64),
    readiness_result_sha256: null,
    retry_after_seconds: 1,
  });
  return Option.isSome(planResponse) ? planResponse.value.publish_plan : undefined;
}

type HnsRootImportRepositoryOptions = Readonly<{ readonly environment: string }>;

const defaultRepositoryOptions: HnsRootImportRepositoryOptions = { environment: "production" };

function responseFromRow(
  row: Row,
  replayed: boolean,
  options: HnsRootImportRepositoryOptions,
): HnsRootImportSessionResponse | null {
  const actorId = stringValue(row, "actor_id");
  const creationIntentId = stringValue(row, "creation_intent_id");
  const ceremonyIntentId = stringValue(row, "ceremony_intent_id");
  const sessionId = stringValue(row, "root_import_session_id");
  const namespaceSessionId = stringValue(row, "namespace_session_id");
  const rootLabel = stringValue(row, "root_label");
  const challengeTxtValue = stringValue(row, "challenge_txt_value");
  const revision = positiveInteger(row.revision);
  const expiresAt = instant(row.expires_at);
  const status = stringValue(row, "status");
  const plan = decodePlan(row.publish_plan_bytes);
  const planHash =
    row.publish_plan_sha256 === null ? null : stringValue(row, "publish_plan_sha256");
  const readinessHash =
    row.readiness_result_sha256 === null ? null : stringValue(row, "readiness_result_sha256");
  if (
    actorId === null ||
    creationIntentId === null ||
    ceremonyIntentId === null ||
    sessionId === null ||
    namespaceSessionId === null ||
    rootLabel === null ||
    challengeTxtValue === null ||
    revision === null ||
    expiresAt === null ||
    status === null ||
    plan === undefined
  ) {
    return null;
  }
  const base = {
    creation_intent_id: creationIntentId,
    ceremony_intent_id: ceremonyIntentId,
    root_import_session_id: sessionId,
    namespace_session_id: namespaceSessionId,
    root_label: rootLabel,
    revision,
    expires_at: expiresAt,
    replayed,
  } as const;
  let nameProofMessage: string;
  try {
    nameProofMessage = hnsRootImportNameProofMessage({
      actor_id: actorId,
      creation_intent_id: creationIntentId,
      ceremony_intent_id: ceremonyIntentId,
      root_import_session_id: sessionId,
      namespace_session_id: namespaceSessionId,
      root_label: rootLabel,
      challenge_txt_value: challengeTxtValue,
      environment: options.environment,
      expires_at: expiresAt,
    });
  } catch {
    return null;
  }
  const candidate =
    status === "awaiting_ownership"
      ? {
          ...base,
          status,
          ownership_challenge: {
            ownership_source: "hns_parent_chain_txt" as const,
            record: { type: "TXT" as const, txt: [challengeTxtValue] as const },
          },
          provisioning_authorization: {
            kind: "hns_name_signature_v1" as const,
            wallet_rpc_method: "signmessagewithname" as const,
            message: nameProofMessage,
            expires_at: expiresAt,
          },
          publish_plan: null,
          publish_plan_sha256: null,
          readiness_result_sha256: null,
          retry_after_seconds: 5,
        }
      : status === "provisioning"
        ? {
            ...base,
            status,
            publish_plan: null,
            publish_plan_sha256: null,
            readiness_result_sha256: null,
            retry_after_seconds: 2,
          }
        : status === "awaiting_owner_update" || status === "observing"
          ? {
              ...base,
              status,
              publish_plan: plan,
              publish_plan_sha256: planHash,
              readiness_result_sha256: null,
              retry_after_seconds: 5,
            }
          : status === "ready"
            ? {
                ...base,
                status,
                publish_plan: plan,
                publish_plan_sha256: planHash,
                readiness_result_sha256: readinessHash,
                retry_after_seconds: null,
              }
            : status === "activated" || status === "failed" || status === "expired"
              ? {
                  ...base,
                  status,
                  publish_plan: plan,
                  publish_plan_sha256: planHash,
                  readiness_result_sha256: readinessHash,
                  retry_after_seconds: null,
                }
              : null;
  if (candidate === null) return null;
  const decoded = Schema.decodeUnknownOption(
    HnsRootImportSessionResponseV1,
    exactParseOptions,
  )(candidate);
  return Option.isSome(decoded) ? decoded.value : null;
}

const sessionColumns = `
  root_import_session_id, actor_id, creation_intent_id, ceremony_intent_id,
  namespace_session_id, ownership_generation, ownership_expected_revision,
  root_label, challenge_txt_value, status, revision, start_idempotency_key,
  start_request_sha256, provision_job_id, publish_plan_bytes,
  publish_plan_sha256, readiness_result_bytes, readiness_result_sha256,
  ownership_result_sha256, provision_authorization_kind,
  provision_authorization_sha256, observation_job_id, observation_idempotency_key,
  observation_request_sha256, activated_community_id, expires_at, created_at, updated_at`;

function loadSession(
  transaction: Transaction,
  input: GetHnsRootImportInput,
  lock: boolean,
  options: HnsRootImportRepositoryOptions,
): Effect.Effect<
  HnsRootImportSessionResponse | null,
  HnsRootImportStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: lock ? "hns.root-import.lock-session" : "hns.root-import.load-session",
      text: `SELECT ${sessionColumns}
               FROM hns_root_import_sessions
              WHERE actor_id = $1 AND creation_intent_id = $2
                AND root_import_session_id = $3${lock ? " FOR UPDATE" : ""}`,
      values: [input.actor_id, input.creation_intent_id, input.root_import_session_id],
      readonly: !lock,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    if (row === null) return null;
    const decoded = responseFromRow(row, false, options);
    return decoded === null ? yield* Effect.fail(storageFailure()) : decoded;
  });
}

interface HnsRootImportRepository {
  readonly start: (
    input: HnsRootImportStartRecord,
  ) => Effect.Effect<
    HnsRootImportStartStoreOutcome,
    HnsRootImportStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly get: (
    input: GetHnsRootImportInput,
  ) => Effect.Effect<
    HnsRootImportSessionResponse | null,
    HnsRootImportStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly loadPollAuthority: (
    input: GetHnsRootImportInput,
  ) => Effect.Effect<
    HnsRootImportPollAuthority | null,
    HnsRootImportStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly beginProvisioning: (
    input: HnsRootImportProvisionRecord,
  ) => Effect.Effect<
    HnsRootImportProvisionStartOutcome,
    HnsRootImportStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly beginObservation: (
    input: HnsRootImportObservationRecord,
  ) => Effect.Effect<
    HnsRootImportObservationStartOutcome,
    HnsRootImportStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly finishOwnershipTerminal: (input: {
    readonly poll: HnsRootImportObservationRecord["poll"];
    readonly ownership_status: "rejected" | "expired";
    readonly ownership_result_sha256: string;
  }) => Effect.Effect<
    HnsRootImportOwnershipTerminalOutcome,
    HnsRootImportStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly activate: (
    input: HnsRootImportActivationRecord,
  ) => Effect.Effect<
    HnsRootImportActivationStoreOutcome,
    HnsRootImportStorageFailed | ControlPlaneError,
    ControlPlaneDb
  >;
}

export function makeControlPlaneHnsRootImportRepository(
  options: HnsRootImportRepositoryOptions = defaultRepositoryOptions,
): HnsRootImportRepository {
  return {
    start: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const replayResult = yield* transaction.execute<Row>({
              label: "hns.root-import.start.find-replay",
              text: `SELECT ${sessionColumns}
                       FROM hns_root_import_sessions
                      WHERE actor_id = $1 AND creation_intent_id = $2
                        AND start_idempotency_key = $3
                      FOR UPDATE`,
              values: [input.actor_id, input.creation_intent_id, input.idempotency_key],
              readonly: false,
            });
            const replayRow = oneRow(replayResult);
            if (replayRow === undefined) return yield* Effect.fail(storageFailure());
            if (replayRow !== null) {
              const response = responseFromRow(replayRow, true, options);
              return response !== null && replayRow.start_request_sha256 === input.request_sha256
                ? ({ kind: "replay", session: response } as const)
                : ({ kind: "conflict" } as const);
            }

            const unavailableResult = yield* transaction.execute<Row>({
              label: "hns.root-import.start.root-unavailable",
              text: `SELECT (
                       $1 = 'pirate'
                       OR $1 ~ '^community_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                       OR EXISTS (
                         SELECT 1 FROM hns_dns_zone_activation_current
                          WHERE canonical_root = $1
                       )
                       OR EXISTS (
                         SELECT 1 FROM community_canonical_route_bindings
                          WHERE family = 'hns' AND root_label = $1
                            AND route_lifecycle_status = 'active'
                       )
                       OR EXISTS (
                         SELECT 1 FROM community_handle_sale_namespace_activation_current
                          WHERE family = 'hns' AND canonical_root = $1
                       )
                       OR EXISTS (
                         SELECT 1
                           FROM operator_managed_root_registry_current AS current_registry
                          WHERE operator_managed_registry_has_active_root(
                            current_registry.registry_reference,
                            current_registry.registry_version,
                            current_registry.registry_digest,
                            $1
                          )
                       )
                     ) AS unavailable`,
              values: [input.root_label],
              readonly: false,
            });
            const unavailable = oneRow(unavailableResult);
            if (unavailable === undefined || unavailable === null) {
              return yield* Effect.fail(storageFailure());
            }
            if (unavailable.unavailable === true) return { kind: "conflict" } as const;

            const insertedSession = yield* transaction.execute<Row>({
              label: "hns.root-import.start.insert-session",
              text: `INSERT INTO hns_root_import_sessions (
                       root_import_session_id, actor_id, creation_intent_id,
                       ceremony_intent_id, namespace_session_id,
                       ownership_generation, ownership_expected_revision,
                       root_label, challenge_txt_value, status, revision,
                       start_idempotency_key, start_request_sha256,
                       provision_job_id, expires_at
                     ) VALUES (
                       $1, $2, $3, $4, $5, $6::bigint, $7::bigint,
                       $8, $9, 'awaiting_ownership', 1, $10, $11, $12,
                       $13::timestamptz
                     )
                     ON CONFLICT DO NOTHING
                     RETURNING ${sessionColumns}`,
              values: [
                input.root_import_session_id,
                input.actor_id,
                input.creation_intent_id,
                input.ceremony_intent_id,
                input.namespace_session_id,
                input.ownership_generation,
                input.ownership_expected_revision,
                input.root_label,
                input.challenge_txt_value,
                input.idempotency_key,
                input.request_sha256,
                input.provision_job_id,
                input.expires_at,
              ],
              readonly: false,
            });
            const insertedRow = oneRow(insertedSession);
            if (insertedRow === undefined) return yield* Effect.fail(storageFailure());
            if (insertedRow === null) return { kind: "conflict" } as const;
            const response = responseFromRow(insertedRow, false, options);
            return response === null
              ? yield* Effect.fail(storageFailure())
              : ({ kind: "created", session: response } as const);
          }),
        );
      }),
    get: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          loadSession(transaction, input, false, options),
        );
      }),
    loadPollAuthority: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "hns.root-import.load-poll-authority",
          text: `SELECT session.*, provision.result_sha256 AS provision_result_sha256
                   FROM hns_root_import_sessions AS session
                   LEFT JOIN hns_authority_provision_jobs AS provision
                     ON provision.provision_job_id = session.provision_job_id
                  WHERE session.actor_id = $1 AND session.creation_intent_id = $2
                    AND session.root_import_session_id = $3`,
          values: [input.actor_id, input.creation_intent_id, input.root_import_session_id],
          readonly: true,
        });
        const row = oneRow(result);
        if (row === undefined) return yield* Effect.fail(storageFailure());
        if (row === null) return null;
        const session = responseFromRow(row, false, options);
        const ownershipRevision = positiveInteger(row.ownership_expected_revision);
        const challenge = stringValue(row, "challenge_txt_value");
        const provisionJobId = stringValue(row, "provision_job_id");
        const ownershipResultHash =
          row.ownership_result_sha256 === null ? null : stringValue(row, "ownership_result_sha256");
        const provisionResultHash =
          row.provision_result_sha256 === null ? null : stringValue(row, "provision_result_sha256");
        if (
          session === null ||
          ownershipRevision === null ||
          challenge === null ||
          provisionJobId === null ||
          (row.ownership_result_sha256 !== null && ownershipResultHash === null) ||
          (row.provision_result_sha256 !== null && provisionResultHash === null)
        ) {
          return yield* Effect.fail(storageFailure());
        }
        return {
          session,
          ownership_expected_revision: ownershipRevision,
          challenge_txt_value: challenge,
          provision_job_id: provisionJobId,
          ownership_result_sha256: ownershipResultHash,
          provision_result_sha256: provisionResultHash,
        };
      }),
    beginProvisioning: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const nameProof =
          input.authorization.kind === "hns_name_signature" ? input.authorization : null;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "hns.root-import.begin-provisioning",
              text: `SELECT * FROM begin_hns_root_import_provision_v2(
                       $1,$2,$3,$4::bigint,$5,$6,$7,$8,$9::bytea,$10,$11,
                       $12,$13::bytea,$14
                     )`,
              values: [
                input.poll.actor_id,
                input.poll.creation_intent_id,
                input.poll.root_import_session_id,
                input.poll.expected_revision,
                input.poll.idempotency_key,
                input.poll_request_sha256,
                input.authorization.kind,
                input.authorization.result_sha256,
                nameProof?.result_bytes ?? null,
                nameProof?.message_sha256 ?? null,
                nameProof?.signature_sha256 ?? null,
                input.provision_job_id,
                input.provision_request_bytes,
                input.provision_request_sha256,
              ],
              readonly: false,
            });
            const outcomeRow = oneRow(result);
            if (outcomeRow === undefined || outcomeRow === null) {
              return yield* Effect.fail(storageFailure());
            }
            if (outcomeRow.outcome === "not_found") return { kind: "not_found" } as const;
            if (outcomeRow.outcome === "conflict") return { kind: "conflict" } as const;
            if (outcomeRow.outcome !== "provisioning" && outcomeRow.outcome !== "replayed") {
              return yield* Effect.fail(storageFailure());
            }
            const session = yield* loadSession(transaction, input.poll, false, options);
            if (session === null) return yield* Effect.fail(storageFailure());
            return {
              kind: outcomeRow.outcome,
              session: { ...session, replayed: outcomeRow.outcome === "replayed" },
            } as const;
          }),
        );
      }),
    beginObservation: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "hns.root-import.begin-observation",
              text: `SELECT * FROM begin_hns_root_import_observation_v1(
                       $1,$2,$3,$4::bigint,$5,$6,$7,$8,$9::bytea,$10
                     )`,
              values: [
                input.poll.actor_id,
                input.poll.creation_intent_id,
                input.poll.root_import_session_id,
                input.poll.expected_revision,
                input.poll.idempotency_key,
                input.poll_request_sha256,
                input.ownership_result_sha256,
                input.observation_job_id,
                input.observation_request_bytes,
                input.observation_request_sha256,
              ],
              readonly: false,
            });
            const outcomeRow = oneRow(result);
            if (outcomeRow === undefined || outcomeRow === null) {
              return yield* Effect.fail(storageFailure());
            }
            if (outcomeRow.outcome === "not_found") return { kind: "not_found" } as const;
            if (outcomeRow.outcome === "conflict") return { kind: "conflict" } as const;
            if (outcomeRow.outcome !== "observing" && outcomeRow.outcome !== "replayed") {
              return yield* Effect.fail(storageFailure());
            }
            const session = yield* loadSession(transaction, input.poll, false, options);
            if (session === null) return yield* Effect.fail(storageFailure());
            return {
              kind: outcomeRow.outcome,
              session: { ...session, replayed: outcomeRow.outcome === "replayed" },
            } as const;
          }),
        );
      }),
    finishOwnershipTerminal: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "hns.root-import.finish-ownership-terminal",
              text: `SELECT * FROM finalize_hns_root_import_ownership_v1(
                       $1,$2,$3,$4::bigint,$5,$6
                     )`,
              values: [
                input.poll.actor_id,
                input.poll.creation_intent_id,
                input.poll.root_import_session_id,
                input.poll.expected_revision,
                input.ownership_status,
                input.ownership_result_sha256,
              ],
              readonly: false,
            });
            const outcomeRow = oneRow(result);
            if (outcomeRow === undefined || outcomeRow === null) {
              return yield* Effect.fail(storageFailure());
            }
            if (outcomeRow.outcome === "not_found") return { kind: "not_found" } as const;
            if (outcomeRow.outcome === "conflict") return { kind: "conflict" } as const;
            if (
              outcomeRow.outcome !== "failed" &&
              outcomeRow.outcome !== "expired" &&
              outcomeRow.outcome !== "replayed"
            ) {
              return yield* Effect.fail(storageFailure());
            }
            const session = yield* loadSession(transaction, input.poll, false, options);
            if (session === null) return yield* Effect.fail(storageFailure());
            return {
              kind: outcomeRow.outcome,
              session: { ...session, replayed: outcomeRow.outcome === "replayed" },
            } as const;
          }),
        );
      }),
    activate: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const replayResult = yield* transaction.execute<Row>({
              label: "hns.root-import.activate.find-replay",
              text: `SELECT *
                       FROM hns_root_import_activation_operations
                      WHERE actor_id=$1 AND root_import_session_id=$2
                        AND idempotency_key=$3
                      FOR UPDATE`,
              values: [
                input.input.actor_id,
                input.input.root_import_session_id,
                input.input.idempotency_key,
              ],
              readonly: false,
            });
            const replay = oneRow(replayResult);
            if (replay === undefined) return yield* Effect.fail(storageFailure());
            if (replay !== null) {
              if (
                replay.request_sha256 !== input.request_sha256 ||
                replay.creation_intent_id !== input.input.creation_intent_id ||
                replay.community_id !== input.community_id ||
                positiveInteger(replay.expected_session_revision) !== input.input.expected_revision
              ) {
                return { kind: "conflict" } as const;
              }
              const revision = positiveInteger(replay.result_session_revision);
              const replayCommunityId = stringValue(replay, "community_id");
              const replayDnsActivationId = stringValue(replay, "dns_zone_activation_id");
              const replayAppActivationId = stringValue(replay, "app_host_activation_id");
              const replaySaleActivationId = stringValue(replay, "sale_namespace_activation_id");
              const replaySaleHash = stringValue(replay, "sale_namespace_activation_sha256");
              const root = yield* loadSession(transaction, input.input, false, options);
              if (
                revision === null ||
                replayCommunityId === null ||
                replayDnsActivationId === null ||
                replayAppActivationId === null ||
                replaySaleActivationId === null ||
                replaySaleHash === null ||
                !/^[0-9a-f]{64}$/u.test(replaySaleHash) ||
                root === null ||
                root.status !== "activated" ||
                root.revision !== revision
              ) {
                return yield* Effect.fail(storageFailure());
              }
              return {
                kind: "replayed",
                response: {
                  creation_intent_id: input.input.creation_intent_id,
                  root_import_session_id: input.input.root_import_session_id,
                  root_label: root.root_label,
                  revision,
                  status: "activated",
                  community_id: replayCommunityId,
                  app_host: `app.${root.root_label}`,
                  dns_zone_activation_id: replayDnsActivationId,
                  dns_zone_activation_generation: 1,
                  app_host_activation_id: replayAppActivationId,
                  app_host_activation_generation: 1,
                  sale_namespace_activation_id: replaySaleActivationId,
                  sale_namespace_activation_generation: 1,
                  sale_namespace_activation_sha256: replaySaleHash,
                  handle_issuance_enabled: true,
                  replayed: true,
                },
              } as const;
            }

            const sessionResult = yield* transaction.execute<Row>({
              label: "hns.root-import.activate.lock-session",
              text: `SELECT session.*, observation.result_bytes AS observed_result_bytes
                       FROM hns_root_import_sessions AS session
                       LEFT JOIN hns_root_import_observation_jobs AS observation
                         ON observation.observation_job_id = session.observation_job_id
                      WHERE session.actor_id=$1 AND session.creation_intent_id=$2
                        AND session.root_import_session_id=$3
                      FOR UPDATE OF session`,
              values: [
                input.input.actor_id,
                input.input.creation_intent_id,
                input.input.root_import_session_id,
              ],
              readonly: false,
            });
            const session = oneRow(sessionResult);
            if (session === undefined) return yield* Effect.fail(storageFailure());
            if (session === null) return { kind: "not_found" } as const;
            const readinessBytes = bytes(session.observed_result_bytes);
            const sessionExpiresAt = instant(session.expires_at);
            if (
              session.status !== "ready" ||
              positiveInteger(session.revision) !== input.input.expected_revision ||
              session.publish_plan_sha256 !== input.input.publish_plan_sha256 ||
              session.readiness_result_sha256 !== input.input.readiness_result_sha256 ||
              readinessBytes === null ||
              sessionExpiresAt === null
            ) {
              return { kind: "conflict" } as const;
            }
            const readiness = yield* Effect.tryPromise({
              try: () => decodeHnsRootImportReadinessResultV1(readinessBytes),
              catch: storageFailure,
            });
            if (
              readiness.result_sha256 !== input.input.readiness_result_sha256 ||
              readiness.result.root_import_session_id !== input.input.root_import_session_id ||
              readiness.result.namespace_session_id !== session.namespace_session_id ||
              readiness.result.root_label !== session.root_label ||
              readiness.result.publish_plan_sha256 !== input.input.publish_plan_sha256 ||
              readiness.result.ownership_result_sha256 !== session.ownership_result_sha256
            ) {
              return { kind: "conflict" } as const;
            }
            const intentResult = yield* transaction.execute<Row>({
              label: "hns.root-import.activate.lock-committed-intent",
              text: `SELECT intent_id
                       FROM community_creation_intents
                      WHERE intent_id=$1 AND actor_id=$2 AND status='committed'
                        AND committed_community_id=$3
                      FOR SHARE`,
              values: [input.input.creation_intent_id, input.input.actor_id, input.community_id],
              readonly: false,
            });
            const committedIntent = oneRow(intentResult);
            if (
              committedIntent === undefined ||
              committedIntent?.intent_id !== input.input.creation_intent_id
            ) {
              return { kind: "conflict" } as const;
            }
            const routeResult = yield* transaction.execute<Row>({
              label: "hns.root-import.activate.lock-route",
              text: `SELECT community.canonical_route_binding_id,
                            binding.root_label_display, binding.binding_generation,
                            binding.verified_evidence_ref
                       FROM communities AS community
                       JOIN community_canonical_route_bindings AS binding
                         ON binding.route_binding_id = community.canonical_route_binding_id
                      WHERE community.community_id=$1
                        AND community.created_by_user_id=$2
                        AND community.status='active'
                        AND binding.family='hns' AND binding.root_label=$3
                        AND binding.ownership_status='verified'
                        AND binding.route_lifecycle_status='active'
                        AND binding.route_authority_kind='verified_namespace_v1'
                      FOR SHARE OF community, binding`,
              values: [input.community_id, input.input.actor_id, readiness.result.root_label],
              readonly: false,
            });
            const route = oneRow(routeResult);
            const routeRow = route === null || route === undefined ? null : route;
            const routeBindingId =
              routeRow === null ? null : stringValue(routeRow, "canonical_route_binding_id");
            const displayRoot =
              routeRow === null ? null : stringValue(routeRow, "root_label_display");
            const routeGeneration =
              routeRow === null ? null : positiveInteger(routeRow.binding_generation);
            const evidenceRef =
              routeRow === null ? null : stringValue(routeRow, "verified_evidence_ref");
            if (
              route === undefined ||
              routeBindingId === null ||
              displayRoot === null ||
              routeGeneration === null ||
              evidenceRef === null
            ) {
              return { kind: "conflict" } as const;
            }

            const dnsDocument = yield* Effect.tryPromise({
              try: () =>
                prepareHnsDnsZoneActivationDocumentV1({
                  payload: {
                    version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
                    dns_zone_activation_id: input.dns_zone_activation_id,
                    canonical_root: readiness.result.root_label,
                    dns_authority: [
                      "pirate_managed_dns_v1",
                      readiness.result.dns_authority_reference,
                      1,
                    ],
                    pirate_dns_authority_inventory: [
                      readiness.result.authority_inventory_reference,
                      readiness.result.authority_inventory_version,
                      readiness.result.authority_inventory_digest,
                    ],
                    zone_revision: readiness.result.powerdns_zone_serial,
                    dnssec_keyset: [
                      readiness.result.dnssec_keyset_reference,
                      readiness.result.dnssec_keyset_version,
                    ],
                    gateway: [
                      readiness.result.gateway_deployment_reference,
                      readiness.result.gateway_certificate_spki_sha256,
                    ],
                    stable_chain_delegation_snapshot: [
                      `hns-root-chain:${readiness.result.chain_resource_sha256}`,
                      readiness.result_sha256,
                    ],
                  },
                  zone_bytes: readiness.managed_zone_bytes,
                }),
              catch: storageFailure,
            });
            const activationDocumentDigest = yield* Effect.promise(() =>
              sha256Bytes(dnsDocument.activation_document_bytes),
            );

            const databaseClock = yield* transaction.execute<Row>({
              label: "hns.root-import.activate.database-clock",
              text: "SELECT clock_timestamp() AS database_now",
              values: [],
              readonly: false,
            });
            const nowRow = oneRow(databaseClock);
            const databaseNow = nowRow === null ? null : instant(nowRow?.database_now);
            if (
              nowRow === undefined ||
              databaseNow === null ||
              Date.parse(sessionExpiresAt) <= Date.parse(databaseNow) ||
              Date.parse(readiness.result.observed_at) > Date.parse(databaseNow) ||
              Date.parse(readiness.result.valid_until) <= Date.parse(databaseNow)
            ) {
              return { kind: "conflict" } as const;
            }

            yield* transaction.execute({
              label: "hns.root-import.activate.insert-inventory",
              text: `INSERT INTO hns_authority_inventories (
                       registry_reference, authority_inventory_reference,
                       authority_inventory_version, authority_inventory_digest,
                       environment, runtime_capability_set_digest, inventory_bytes,
                       published_at, expires_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7::bytea,$8::timestamptz,$9::timestamptz)`,
              values: [
                "hns-authority:root-import",
                readiness.result.authority_inventory_reference,
                readiness.result.authority_inventory_version,
                readiness.result.authority_inventory_digest,
                readiness.authority_inventory.environment,
                readiness.authority_inventory.runtime_capability_set_digest,
                readiness.authority_inventory_bytes,
                readiness.result.observed_at,
                readiness.result.valid_until,
              ],
              readonly: false,
            });

            const dnsOperationId = `hns-dns-activate:${input.request_sha256}`;
            const reservationResult = yield* transaction.execute<Row>({
              label: "hns.root-import.activate.reserve-dns",
              text: `SELECT * FROM reserve_hns_dns_zone_activation_v1(
                       $1,$2,$3,$4,0,60
                     )`,
              values: [
                dnsOperationId,
                `hns-root:${input.input.idempotency_key}`,
                activationDocumentDigest,
                input.dns_zone_activation_id,
              ],
              readonly: false,
            });
            const reservation = oneRow(reservationResult);
            const fenceToken =
              reservation === null || reservation === undefined
                ? null
                : positiveInteger(reservation.fence_token);
            if (
              reservation === undefined ||
              reservation?.outcome !== "reserved" ||
              reservation?.dns_zone_activation_id !== input.dns_zone_activation_id ||
              fenceToken === null
            ) {
              return yield* Effect.fail(storageFailure());
            }
            const finalizeResult = yield* transaction.execute<Row>({
              label: "hns.root-import.activate.finalize-dns",
              text: `SELECT * FROM finalize_hns_dns_zone_activation_v1(
                       $1,$2::bigint,$3::bytea,$4,$5,'pirate_managed_dns_v1',$6,1,
                       $7,$8,$9,$10::bigint,$11::bytea,$12,$13,$14,$15,$16,$17,$18
                     )`,
              values: [
                dnsOperationId,
                fenceToken,
                dnsDocument.activation_document_bytes,
                input.dns_zone_activation_id,
                readiness.result.root_label,
                readiness.result.dns_authority_reference,
                readiness.result.authority_inventory_reference,
                readiness.result.authority_inventory_version,
                readiness.result.authority_inventory_digest,
                readiness.result.powerdns_zone_serial,
                dnsDocument.zone_bytes,
                dnsDocument.zone_bytes_digest,
                readiness.result.dnssec_keyset_reference,
                readiness.result.dnssec_keyset_version,
                readiness.result.gateway_deployment_reference,
                readiness.result.gateway_certificate_spki_sha256,
                `hns-root-chain:${readiness.result.chain_resource_sha256}`,
                readiness.result_sha256,
              ],
              readonly: false,
            });
            const finalized = oneRow(finalizeResult);
            const dnsActivationGeneration =
              finalized === null || finalized === undefined
                ? null
                : positiveInteger(finalized.activation_generation);
            if (
              finalized === undefined ||
              finalized?.outcome !== "activated" ||
              finalized?.dns_zone_activation_id !== input.dns_zone_activation_id ||
              dnsActivationGeneration !== 1
            ) {
              return yield* Effect.fail(storageFailure());
            }
            const healthValidForSeconds = Math.floor(
              (Date.parse(readiness.result.valid_until) - Date.parse(databaseNow)) / 1_000,
            );
            if (healthValidForSeconds < 1 || healthValidForSeconds > 604_800) {
              return yield* Effect.fail(storageFailure());
            }
            const healthResult = yield* transaction.execute<Row>({
              label: "hns.root-import.activate.record-health",
              text: `SELECT * FROM record_hns_dns_zone_health_v1(
                       $1,$2,$3,$4,$5::bigint,0,$6,$7,$8,$9,$10,$11,$12,
                       $13::boolean,$14::boolean,$15::boolean,$16::boolean,$17::integer
                     )`,
              values: [
                `hns-health:${input.request_sha256}`,
                `hns-root-health:${input.input.idempotency_key}`,
                readiness.result_sha256,
                input.dns_zone_activation_id,
                dnsActivationGeneration,
                `hns-root-chain:${readiness.result.chain_resource_sha256}`,
                readiness.result_sha256,
                readiness.result.observed_zone_bytes_sha256,
                readiness.result.dnssec_keyset_reference,
                readiness.result.dnssec_keyset_version,
                readiness.result.gateway_deployment_reference,
                readiness.result.gateway_certificate_spki_sha256,
                readiness.result.delegation_matches,
                readiness.result.ds_authenticates_zone,
                readiness.result.retained_zone_digest_matches,
                readiness.result.gateway_healthy,
                healthValidForSeconds,
              ],
              readonly: false,
            });
            const health = oneRow(healthResult);
            if (
              health === undefined ||
              health?.outcome !== "recorded" ||
              health?.dns_zone_activation_id !== input.dns_zone_activation_id ||
              positiveInteger(health.activation_generation) !== dnsActivationGeneration ||
              positiveInteger(health.health_generation) !== 1
            ) {
              return yield* Effect.fail(storageFailure());
            }
            const appResult = yield* transaction.execute<Row>({
              label: "hns.root-import.activate.activate-app",
              text: `SELECT * FROM activate_hns_community_app_host_v1(
                       $1,$2,$3,$4,$5,$6,$7,'verified_namespace_v1',$8,$9::bigint,
                       $10,$11::bigint,$12
                     )`,
              values: [
                `hns-app:${input.request_sha256}`,
                `hns-root-app:${input.input.idempotency_key}`,
                input.request_sha256,
                input.app_host_activation_id,
                input.community_id,
                readiness.result.root_label,
                routeBindingId,
                evidenceRef,
                routeGeneration,
                input.dns_zone_activation_id,
                dnsActivationGeneration,
                readiness.result.gateway_deployment_reference,
              ],
              readonly: false,
            });
            const app = oneRow(appResult);
            const appActivationGeneration =
              app === null || app === undefined
                ? null
                : positiveInteger(app.app_host_activation_generation);
            if (
              app === undefined ||
              app?.outcome !== "activated" ||
              app?.app_host_activation_id !== input.app_host_activation_id ||
              app?.status !== "active" ||
              appActivationGeneration !== 1
            ) {
              return yield* Effect.fail(storageFailure());
            }

            yield* transaction.execute({
              label: "hns.root-import.activate.ensure-handle-authority",
              text: `INSERT INTO community_handle_sales_authority_grants (
                       grant_id,community_id,principal_account_id,authority,source_kind,
                       source_policy_ref,status,granted_at,granted_by_account_id
                     ) VALUES (
                       community_handle_sales_creator_grant_id_v1($1,$2),$1,$2,
                       'manage_handle_sales','creator_owner',NULL,'active',$3::timestamptz,$2
                     ) ON CONFLICT (community_id,principal_account_id,authority) DO NOTHING`,
              values: [input.community_id, input.input.actor_id, databaseNow],
              readonly: false,
            });
            const authorityResult = yield* transaction.execute<Row>({
              label: "hns.root-import.activate.read-handle-authority",
              text: `SELECT grant_id
                       FROM community_handle_sales_authority_grants
                      WHERE community_id=$1 AND principal_account_id=$2
                        AND authority='manage_handle_sales' AND status='active'
                      FOR SHARE`,
              values: [input.community_id, input.input.actor_id],
              readonly: false,
            });
            const salesAuthority = oneRow(authorityResult);
            const salesAuthorityId =
              salesAuthority === null ? null : stringValue(salesAuthority ?? {}, "grant_id");
            if (salesAuthority === undefined || salesAuthorityId === null) {
              return yield* Effect.fail(storageFailure());
            }
            const saleHash = handleSaleNamespaceActivationHash({
              sale_namespace_activation_id: input.sale_namespace_activation_id,
              sale_namespace_activation_generation: 1,
              community_id: input.community_id,
              family: "hns",
              canonical_root: readiness.result.root_label,
              namespace_authority_reference: evidenceRef,
              namespace_authority_generation: routeGeneration,
              dns_zone_activation_id: input.dns_zone_activation_id,
              dns_zone_activation_generation: dnsActivationGeneration,
            }).sha256;
            yield* transaction.execute({
              label: "hns.root-import.activate.insert-sale-revision",
              text: `INSERT INTO community_handle_sale_namespace_activation_revisions (
                       sale_namespace_activation_id,sale_namespace_activation_generation,
                       sale_namespace_activation_hash,community_id,family,canonical_root,
                       display_root,namespace_authority_kind,namespace_authority_reference,
                       namespace_authority_generation,serving_kind,dns_zone_activation_id,
                       dns_zone_activation_generation,root_replacement_kind,
                       dedicated_root_replacement_confirmed,status,reason_code,
                       actor_account_id,authority_grant_id,created_at,activated_at,
                       suspended_at,revoked_at,recorded_at
                     ) VALUES ($1,1,$2,$3,'hns',$4,$5,'verified_namespace_v1',$6,$7::bigint,
                       'hns_dns_zone_activation_v1',$8,$9::bigint,'dedicated_root_replace_v1',TRUE,
                       'active',NULL,$10,$11,$12::timestamptz,$12::timestamptz,
                       NULL,NULL,$12::timestamptz)`,
              values: [
                input.sale_namespace_activation_id,
                saleHash,
                input.community_id,
                readiness.result.root_label,
                displayRoot,
                evidenceRef,
                routeGeneration,
                input.dns_zone_activation_id,
                dnsActivationGeneration,
                input.input.actor_id,
                salesAuthorityId,
                databaseNow,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "hns.root-import.activate.insert-sale-current",
              text: `INSERT INTO community_handle_sale_namespace_activation_current (
                       sale_namespace_activation_id,family,canonical_root,community_id,
                       current_generation,updated_at
                     ) VALUES ($1,'hns',$2,$3,1,$4::timestamptz)`,
              values: [
                input.sale_namespace_activation_id,
                readiness.result.root_label,
                input.community_id,
                databaseNow,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "hns.root-import.activate.insert-sale-action",
              text: `INSERT INTO community_handle_sale_namespace_activation_actions (
                       action_id,actor_account_id,community_id,endpoint_template,
                       idempotency_key,request_hash,sale_namespace_activation_id,
                       expected_activation_generation,result_activation_generation,
                       result_activation_hash,committed_at
                     ) VALUES ($1,$2,$3,'/communities/:communityId/handle-sale-namespaces',
                       $4,$5,$6,0,1,$7,$8::timestamptz)`,
              values: [
                `hns-sale-action_${input.request_sha256}`,
                input.input.actor_id,
                input.community_id,
                `hns-root-${input.request_sha256.slice(0, 64)}`,
                input.request_sha256,
                input.sale_namespace_activation_id,
                saleHash,
                databaseNow,
              ],
              readonly: false,
            });

            const cancelledTeardown = yield* transaction.execute({
              label: "hns.root-import.activate.cancel-teardown",
              text: `UPDATE hns_root_import_teardown_jobs
                        SET state='cancelled',leased_by=NULL,lease_expires_at=NULL,
                            failure_code=NULL,completed_at=$1::timestamptz,
                            updated_at=$1::timestamptz
                      WHERE root_import_session_id=$2 AND state='waiting'`,
              values: [databaseNow, input.input.root_import_session_id],
              readonly: false,
            });
            if (cancelledTeardown.rowCount !== 1) {
              return yield* Effect.fail(storageFailure());
            }

            const updated = yield* transaction.execute({
              label: "hns.root-import.activate.update-session",
              text: `UPDATE hns_root_import_sessions
                        SET status='activated',revision=revision+1,
                            activated_community_id=$1,updated_at=$2::timestamptz
                      WHERE root_import_session_id=$3 AND status='ready'
                        AND revision=$4::bigint`,
              values: [
                input.community_id,
                databaseNow,
                input.input.root_import_session_id,
                input.input.expected_revision,
              ],
              readonly: false,
            });
            if (updated.rowCount !== 1) return yield* Effect.fail(storageFailure());
            yield* transaction.execute({
              label: "hns.root-import.activate.insert-operation",
              text: `INSERT INTO hns_root_import_activation_operations (
                       operation_id,root_import_session_id,actor_id,creation_intent_id,
                       idempotency_key,request_sha256,expected_session_revision,community_id,
                       dns_zone_activation_id,app_host_activation_id,
                       sale_namespace_activation_id,sale_namespace_activation_sha256,
                       result_session_revision,committed_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8,$9,$10,$11,$12,
                       $7::bigint+1,$13::timestamptz)`,
              values: [
                input.operation_id,
                input.input.root_import_session_id,
                input.input.actor_id,
                input.input.creation_intent_id,
                input.input.idempotency_key,
                input.request_sha256,
                input.input.expected_revision,
                input.community_id,
                input.dns_zone_activation_id,
                input.app_host_activation_id,
                input.sale_namespace_activation_id,
                saleHash,
                databaseNow,
              ],
              readonly: false,
            });
            return {
              kind: "activated",
              response: {
                creation_intent_id: input.input.creation_intent_id,
                root_import_session_id: input.input.root_import_session_id,
                root_label: readiness.result.root_label,
                revision: input.input.expected_revision + 1,
                status: "activated",
                community_id: input.community_id,
                app_host: `app.${readiness.result.root_label}`,
                dns_zone_activation_id: input.dns_zone_activation_id,
                dns_zone_activation_generation: dnsActivationGeneration,
                app_host_activation_id: input.app_host_activation_id,
                app_host_activation_generation: appActivationGeneration,
                sale_namespace_activation_id: input.sale_namespace_activation_id,
                sale_namespace_activation_generation: 1,
                sale_namespace_activation_sha256: saleHash,
                handle_issuance_enabled: true,
                replayed: false,
              },
            } as const;
          }),
        );
      }),
  };
}

export function makeControlPlaneHnsRootImportStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: HnsRootImportRepositoryOptions = defaultRepositoryOptions,
): HnsRootImportStore {
  const repository = makeControlPlaneHnsRootImportRepository(options);
  const provide = <A>(
    effect: Effect.Effect<A, HnsRootImportStorageFailed | ControlPlaneError, ControlPlaneDb>,
  ) => Effect.provide(runtime)(effect).pipe(Effect.mapError(() => storageFailure()));
  return {
    start: (input) => provide(repository.start(input)),
    get: (input) => provide(repository.get(input)),
    loadPollAuthority: (input) => provide(repository.loadPollAuthority(input)),
    beginProvisioning: (input) => provide(repository.beginProvisioning(input)),
    beginObservation: (input) => provide(repository.beginObservation(input)),
    finishOwnershipTerminal: (input) => provide(repository.finishOwnershipTerminal(input)),
    activate: (input) => provide(repository.activate(input)),
  };
}
