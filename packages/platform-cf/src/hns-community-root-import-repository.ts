import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneTransaction,
  type HnsCommunityRootImportActivationStore,
  type HnsCommunityRootImportPollStore,
  type HnsCommunityRootImportPreparation,
  type HnsCommunityRootImportStartRecord,
  type HnsCommunityRootImportStartStore,
  HnsCommunityRootImportStorageFailed,
  hnsCommunityRootImportNameProofMessage,
} from "@pirate/application";
import { decodeStrictHnsJsonBytes } from "@pirate/application/namespace-ownership";
import {
  type HnsCommunityRootImportSessionResponseV1 as HnsCommunityRootImportSessionResponse,
  HnsCommunityRootImportSessionResponseV1,
} from "@pirate/contracts";
import {
  type CommunityCreationProviderBinding,
  canonicalJson,
  communityCreationProviderBindingHash,
} from "@pirate/domain";
import { Effect, type Layer, Option, Schema } from "effect";
import { makeControlPlaneHnsRootImportStore } from "./hns-root-import-repository.ts";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;

const exactParseOptions = { onExcessProperty: "error" } as const;
const storageFailure = (): HnsCommunityRootImportStorageFailed =>
  new HnsCommunityRootImportStorageFailed();

export type HnsCommunityRootImportRepositoryOptions = Readonly<{
  readonly environment: string;
  readonly provider_binding: CommunityCreationProviderBinding;
  readonly session_ttl_seconds?: number;
}>;

function oneRow<T>(result: ControlPlaneResult<T>): T | null | undefined {
  if (result.rows.length > 1) return undefined;
  return result.rows[0] ?? null;
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

function bytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return null;
}

function decodePlan(
  value: unknown,
): HnsCommunityRootImportSessionResponse["publish_plan"] | undefined {
  if (value === null || value === undefined) return null;
  const retained = bytes(value);
  if (retained === null) return undefined;
  try {
    return decodeStrictHnsJsonBytes(
      retained,
      1_048_576,
    ) as HnsCommunityRootImportSessionResponse["publish_plan"];
  } catch {
    return undefined;
  }
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const preparationColumns = `
  preparation.actor_id, preparation.community_id, preparation.attachment_intent_id,
  preparation.ceremony_intent_id, preparation.root_label,
  preparation.root_import_session_id, preparation.provision_job_id,
  attachment.revision AS attachment_revision, preparation.start_request_sha256,
  preparation.expires_at`;

function decodePreparation(row: Row): HnsCommunityRootImportPreparation | null {
  const actor_id = text(row, "actor_id");
  const community_id = text(row, "community_id");
  const attachment_intent_id = text(row, "attachment_intent_id");
  const ceremony_intent_id = text(row, "ceremony_intent_id");
  const root_label = text(row, "root_label");
  const root_import_session_id = text(row, "root_import_session_id");
  const provision_job_id = text(row, "provision_job_id");
  const attachment_revision = integer(row.attachment_revision);
  return actor_id === null ||
    community_id === null ||
    attachment_intent_id === null ||
    ceremony_intent_id === null ||
    root_label === null ||
    root_import_session_id === null ||
    provision_job_id === null ||
    attachment_revision === null
    ? null
    : {
        actor_id,
        community_id,
        attachment_intent_id,
        ceremony_intent_id,
        root_label,
        attachment_revision,
        root_import_session_id,
        provision_job_id,
      };
}

function sessionResponse(
  row: Row,
  environment: string,
  replayed: boolean,
): HnsCommunityRootImportSessionResponse | null {
  const actor_id = text(row, "actor_id");
  const community_id = text(row, "community_id");
  const attachment_intent_id = text(row, "attachment_intent_id");
  const root_import_session_id = text(row, "root_import_session_id");
  const namespace_session_id = text(row, "namespace_session_id");
  const root_label = text(row, "root_label");
  const challenge_txt_value = text(row, "challenge_txt_value");
  const revision = integer(row.revision);
  const expires_at = instant(row.expires_at);
  const status = text(row, "status");
  const plan = decodePlan(row.publish_plan_bytes);
  const planHash = row.publish_plan_sha256 === null ? null : text(row, "publish_plan_sha256");
  const readinessHash =
    row.readiness_result_sha256 === null ? null : text(row, "readiness_result_sha256");
  if (
    actor_id === null ||
    community_id === null ||
    attachment_intent_id === null ||
    root_import_session_id === null ||
    namespace_session_id === null ||
    root_label === null ||
    challenge_txt_value === null ||
    revision === null ||
    expires_at === null ||
    status === null ||
    plan === undefined
  ) {
    return null;
  }
  let message: string;
  try {
    message = hnsCommunityRootImportNameProofMessage({
      actor_id,
      community_id,
      attachment_intent_id,
      root_import_session_id,
      namespace_session_id,
      root_label,
      challenge_txt_value,
      environment,
      expires_at,
    });
  } catch {
    return null;
  }
  const base = {
    community_id,
    attachment_intent_id,
    root_import_session_id,
    root_label,
    revision,
    expires_at,
    replayed,
  } as const;
  const candidate =
    status === "awaiting_ownership"
      ? {
          ...base,
          status,
          provisioning_authorization: {
            kind: "hns_name_signature_v1" as const,
            wallet_rpc_method: "signmessagewithname" as const,
            message,
            expires_at,
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
    HnsCommunityRootImportSessionResponseV1,
    exactParseOptions,
  )(candidate);
  return Option.isSome(decoded) ? decoded.value : null;
}

function loadPreparation(
  transaction: Transaction,
  actorId: string,
  communityId: string,
  idempotencyKey: string,
): Effect.Effect<Row | null, ControlPlaneError | HnsCommunityRootImportStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "hns.community-root-import.load-preparation",
      text: `SELECT ${preparationColumns}
               FROM hns_community_root_import_preparations AS preparation
               JOIN community_route_attachment_intents AS attachment
                 ON attachment.attachment_intent_id = preparation.attachment_intent_id
              WHERE preparation.actor_id=$1 AND preparation.community_id=$2
                AND preparation.start_idempotency_key=$3
              FOR UPDATE OF preparation, attachment`,
      values: [actorId, communityId, idempotencyKey],
      readonly: false,
    });
    const row = oneRow(result);
    return row === undefined ? yield* Effect.fail(storageFailure()) : row;
  });
}

export function makeControlPlaneHnsCommunityRootImportRepository(
  options: HnsCommunityRootImportRepositoryOptions,
) {
  const binding = options.provider_binding;
  if (binding.requirement !== "namespace_ownership" || binding.family !== "hns") {
    throw new TypeError("Community HNS root import requires an HNS namespace provider binding");
  }
  const providerBindingHash = communityCreationProviderBindingHash(binding);
  const ttlSeconds = options.session_ttl_seconds ?? 604_800;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 604_800) {
    throw new TypeError("Community HNS root import session TTL is invalid");
  }

  return {
    prepare: (input: Parameters<HnsCommunityRootImportStartStore["prepare"]>[0]) =>
      Effect.gen(function* () {
        const requirementHash = yield* Effect.promise(() =>
          digest({
            version: "pirate-community-route-attachment-requirement-v1",
            community_id: input.request.community_id,
            actor_id: input.request.actor_id,
            family: "hns",
            root_label: input.request.root_label,
            provider_binding_hash: providerBindingHash,
          }),
        );
        const reservation = {
          version: "pirate-community-route-attachment-ceremony-reservation-v1",
          actor_id: input.request.actor_id,
          community_id: input.request.community_id,
          attachment_intent_id: input.attachment_intent_id,
          ceremony_intent_id: input.ceremony_intent_id,
          generation: 1,
          requirement_hash: requirementHash,
          provider_id: binding.provider_id,
          provider_binding_hash: providerBindingHash,
          route: { family: "hns", root_label: input.request.root_label },
        } as const;
        const reservationHash = yield* Effect.promise(() => digest(reservation));
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute({
              label: "hns.community-root-import.lock-root",
              text: "SELECT pg_advisory_xact_lock(hashtext($1))",
              values: [input.request.root_label],
              readonly: false,
            });
            yield* transaction.execute({
              label: "hns.community-root-import.lock-idempotency",
              text: "SELECT pg_advisory_xact_lock(hashtext($1))",
              values: [
                `${new TextEncoder().encode(input.request.actor_id).byteLength}:${input.request.actor_id}${input.request.idempotency_key}`,
              ],
              readonly: false,
            });
            const replay = yield* loadPreparation(
              transaction,
              input.request.actor_id,
              input.request.community_id,
              input.request.idempotency_key,
            );
            if (replay !== null) {
              const value = decodePreparation(replay);
              return value !== null && replay.start_request_sha256 === input.request_sha256
                ? ({ kind: "replay", value } as const)
                : ({ kind: "conflict" } as const);
            }
            const reusedKey = yield* transaction.execute<Row>({
              label: "hns.community-root-import.check-idempotency",
              text: `SELECT attachment_intent_id
                       FROM community_route_attachment_intents
                      WHERE actor_id=$1 AND create_idempotency_key=$2`,
              values: [input.request.actor_id, input.request.idempotency_key],
              readonly: false,
            });
            const reusedKeyRow = oneRow(reusedKey);
            if (reusedKeyRow === undefined) return yield* Effect.fail(storageFailure());
            if (reusedKeyRow !== null) return { kind: "conflict" } as const;
            const authority = yield* transaction.execute<Row>({
              label: "hns.community-root-import.lock-authority",
              text: `SELECT route_grant.grant_id
                       FROM communities AS target_community
                       JOIN community_route_authority_grants AS route_grant
                         ON route_grant.community_id=target_community.community_id
                        AND route_grant.principal_user_id=$1
                        AND route_grant.authority='manage_routes' AND route_grant.status='active'
                      WHERE target_community.community_id=$2 AND target_community.status='active'
                        AND target_community.route_authority_version='optional_route_v2'
                        AND target_community.canonical_route_binding_id IS NULL
                      FOR UPDATE OF target_community, route_grant`,
              values: [input.request.actor_id, input.request.community_id],
              readonly: false,
            });
            const authorityRow = oneRow(authority);
            if (authorityRow === undefined) return yield* Effect.fail(storageFailure());
            const grantId = authorityRow === null ? null : text(authorityRow, "grant_id");
            if (grantId === null) return { kind: "not_found" } as const;
            const unavailable = yield* transaction.execute<Row>({
              label: "hns.community-root-import.check-root",
              text: `SELECT (
                       $1='pirate'
                       OR EXISTS (SELECT 1 FROM hns_dns_zone_activation_current WHERE canonical_root=$1)
                       OR EXISTS (SELECT 1 FROM community_canonical_route_bindings
                                   WHERE family='hns' AND root_label=$1 AND route_lifecycle_status='active')
                       OR EXISTS (SELECT 1 FROM community_handle_sale_namespace_activation_current
                                   WHERE family='hns' AND canonical_root=$1)
                       OR EXISTS (SELECT 1 FROM hns_root_import_sessions
                                   WHERE root_label=$1
                                     AND status IN ('provisioning','awaiting_owner_update','observing','ready','activated')
                                     AND (status='activated' OR expires_at>clock_timestamp()))
                       OR EXISTS (
                         SELECT 1 FROM operator_managed_root_registry_current AS registry
                          WHERE operator_managed_registry_has_active_root(
                            registry.registry_reference,registry.registry_version,
                            registry.registry_digest,$1
                          )
                       )
                     ) AS unavailable`,
              values: [input.request.root_label],
              readonly: false,
            });
            const unavailableRow = oneRow(unavailable);
            if (unavailableRow === undefined) return yield* Effect.fail(storageFailure());
            if (unavailableRow?.unavailable !== false) return { kind: "conflict" } as const;

            const expires = yield* transaction.execute<Row>({
              label: "hns.community-root-import.database-time",
              text: "SELECT (clock_timestamp()+($1::bigint * interval '1 second')) AS expires_at",
              values: [ttlSeconds],
              readonly: false,
            });
            const expiresAt = instant(oneRow(expires)?.expires_at);
            if (expiresAt === null) return yield* Effect.fail(storageFailure());
            yield* transaction.execute({
              label: "hns.community-root-import.insert-intent",
              text: `INSERT INTO community_route_attachment_intents (
                       attachment_intent_id,community_id,actor_id,authority_grant_id,
                       create_idempotency_key,create_request_hash,revision,status,family,
                       root_label,root_label_display,requirement_hash,provider_id,
                       provider_binding_hash,provider_configuration_kind,
                       provider_configuration_ref,provider_configuration_version,
                       protocol_version,expires_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,1,'verification_required','hns',$7,$7,
                       $8,$9,$10,$11,$12,$13,$14,$15::timestamptz)`,
              values: [
                input.attachment_intent_id,
                input.request.community_id,
                input.request.actor_id,
                grantId,
                input.request.idempotency_key,
                input.request_sha256,
                input.request.root_label,
                requirementHash,
                binding.provider_id,
                providerBindingHash,
                binding.provider_configuration.kind,
                binding.provider_configuration.reference,
                binding.provider_configuration.version,
                binding.protocol_version,
                expiresAt,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "hns.community-root-import.insert-requirement",
              text: `INSERT INTO community_route_attachment_requirement_states (
                       attachment_intent_id,actor_id,requirement_kind,status,requirement_hash,
                       provider_id,provider_binding_hash,provider_configuration_kind,
                       provider_configuration_ref,provider_configuration_version,family,
                       root_label,root_label_display,path_segment,generation
                     ) VALUES ($1,$2,'namespace_ownership','unmet',$3,$4,$5,$6,$7,$8,
                       'hns',$9,$9,'app.'||$9,0)`,
              values: [
                input.attachment_intent_id,
                input.request.actor_id,
                requirementHash,
                binding.provider_id,
                providerBindingHash,
                binding.provider_configuration.kind,
                binding.provider_configuration.reference,
                binding.provider_configuration.version,
                input.request.root_label,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "hns.community-root-import.insert-ceremony",
              text: `INSERT INTO community_route_attachment_ceremony_attempts (
                       ceremony_intent_id,attachment_intent_id,actor_id,requirement_kind,
                       generation,requirement_hash,provider_id,provider_binding_hash,
                       provider_configuration_kind,provider_configuration_ref,
                       provider_configuration_version,family,root_label,root_label_display,
                       path_segment,reservation_request_hash,reservation_request,expires_at
                     ) VALUES ($1,$2,$3,'namespace_ownership',1,$4,$5,$6,$7,$8,$9,
                       'hns',$10,$10,'app.'||$10,$11,$12::jsonb,$13::timestamptz)`,
              values: [
                input.ceremony_intent_id,
                input.attachment_intent_id,
                input.request.actor_id,
                requirementHash,
                binding.provider_id,
                providerBindingHash,
                binding.provider_configuration.kind,
                binding.provider_configuration.reference,
                binding.provider_configuration.version,
                input.request.root_label,
                reservationHash,
                JSON.stringify(reservation),
                expiresAt,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "hns.community-root-import.begin-requirement",
              text: `UPDATE community_route_attachment_requirement_states
                        SET status='pending',generation=1,current_ceremony_intent_id=$1,
                            updated_at=clock_timestamp()
                      WHERE attachment_intent_id=$2 AND status='unmet' AND generation=0`,
              values: [input.ceremony_intent_id, input.attachment_intent_id],
              readonly: false,
            });
            yield* transaction.execute({
              label: "hns.community-root-import.insert-preparation",
              text: `INSERT INTO hns_community_root_import_preparations (
                       attachment_intent_id,actor_id,community_id,ceremony_intent_id,
                       root_label,root_import_session_id,provision_job_id,
                       start_idempotency_key,start_request_sha256,expires_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)`,
              values: [
                input.attachment_intent_id,
                input.request.actor_id,
                input.request.community_id,
                input.ceremony_intent_id,
                input.request.root_label,
                input.root_import_session_id,
                input.provision_job_id,
                input.request.idempotency_key,
                input.request_sha256,
                expiresAt,
              ],
              readonly: false,
            });
            const value: HnsCommunityRootImportPreparation = {
              actor_id: input.request.actor_id,
              community_id: input.request.community_id,
              attachment_intent_id: input.attachment_intent_id,
              ceremony_intent_id: input.ceremony_intent_id,
              root_label: input.request.root_label,
              attachment_revision: 1,
              root_import_session_id: input.root_import_session_id,
              provision_job_id: input.provision_job_id,
            };
            return { kind: "created", value } as const;
          }),
        );
      }),
    start: (input: HnsCommunityRootImportStartRecord) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const existing = yield* transaction.execute<Row>({
              label: "hns.community-root-import.find-session",
              text: `SELECT * FROM hns_root_import_sessions
                      WHERE actor_id=$1 AND community_id=$2 AND start_idempotency_key=$3
                      FOR UPDATE`,
              values: [
                input.preparation.actor_id,
                input.preparation.community_id,
                input.idempotency_key,
              ],
              readonly: false,
            });
            const existingRow = oneRow(existing);
            if (existingRow === undefined) return yield* Effect.fail(storageFailure());
            if (existingRow !== null) {
              const response = sessionResponse(existingRow, options.environment, true);
              return response !== null && existingRow.start_request_sha256 === input.request_sha256
                ? ({ kind: "replay", session: response } as const)
                : ({ kind: "conflict" } as const);
            }
            const preparation = yield* loadPreparation(
              transaction,
              input.preparation.actor_id,
              input.preparation.community_id,
              input.idempotency_key,
            );
            if (preparation === null) return { kind: "not_found" } as const;
            const decodedPreparation = decodePreparation(preparation);
            if (
              decodedPreparation === null ||
              canonicalJson(decodedPreparation) !== canonicalJson(input.preparation) ||
              preparation.start_request_sha256 !== input.request_sha256
            ) {
              return { kind: "conflict" } as const;
            }
            const authority = yield* transaction.execute<Row>({
              label: "hns.community-root-import.recheck-authority",
              text: `SELECT attachment.attachment_intent_id
                       FROM community_route_attachment_intents AS attachment
                       JOIN communities AS target_community
                         ON target_community.community_id=attachment.community_id
                      WHERE attachment.actor_id=$1 AND attachment.community_id=$2
                        AND attachment.attachment_intent_id=$3
                        AND attachment.status='verification_required'
                        AND attachment.expires_at>clock_timestamp()
                        AND target_community.status='active'
                        AND target_community.route_authority_version='optional_route_v2'
                        AND target_community.canonical_route_binding_id IS NULL
                        AND has_community_route_authority($2,$1)
                      FOR UPDATE OF attachment,target_community`,
              values: [
                input.preparation.actor_id,
                input.preparation.community_id,
                input.preparation.attachment_intent_id,
              ],
              readonly: false,
            });
            const authorityRow = oneRow(authority);
            if (authorityRow === undefined) return yield* Effect.fail(storageFailure());
            if (authorityRow === null) return { kind: "not_found" } as const;
            const ownership = yield* transaction.execute<Row>({
              label: "hns.community-root-import.lock-ownership-session",
              text: `SELECT * FROM community_route_attachment_namespace_sessions
                      WHERE namespace_session_id=$1 AND actor_id=$2
                        AND community_id=$3 AND attachment_intent_id=$4
                        AND ceremony_intent_id=$5 FOR SHARE`,
              values: [
                input.ownership.session_id,
                input.preparation.actor_id,
                input.preparation.community_id,
                input.preparation.attachment_intent_id,
                input.preparation.ceremony_intent_id,
              ],
              readonly: false,
            });
            const ownershipRow = oneRow(ownership);
            if (
              ownershipRow === undefined ||
              ownershipRow === null ||
              ownershipRow.status !== "pending" ||
              text(ownershipRow, "route_root_label") !== input.preparation.root_label ||
              instant(ownershipRow.expires_at) !== input.ownership.expires_at
            ) {
              return ownershipRow === null
                ? ({ kind: "not_found" } as const)
                : ({ kind: "conflict" } as const);
            }
            const inserted = yield* transaction.execute<Row>({
              label: "hns.community-root-import.insert-session",
              text: `INSERT INTO hns_root_import_sessions (
                       root_import_session_id,actor_id,origin_kind,creation_intent_id,
                       ceremony_intent_id,namespace_session_id,community_id,attachment_intent_id,
                       ownership_generation,ownership_expected_revision,root_label,
                       challenge_txt_value,status,revision,start_idempotency_key,
                       start_request_sha256,provision_job_id,expires_at
                     ) VALUES ($1,$2,'community_attachment',NULL,NULL,$3,$4,$5,1,$6,$7,$8,
                       'awaiting_ownership',1,$9,$10,$11,$12::timestamptz)
                     RETURNING *`,
              values: [
                input.preparation.root_import_session_id,
                input.preparation.actor_id,
                input.ownership.session_id,
                input.preparation.community_id,
                input.preparation.attachment_intent_id,
                input.preparation.attachment_revision,
                input.preparation.root_label,
                input.ownership.challenge.challenge_value,
                input.idempotency_key,
                input.request_sha256,
                input.preparation.provision_job_id,
                input.ownership.expires_at,
              ],
              readonly: false,
            });
            const row = oneRow(inserted);
            if (row === undefined || row === null) return yield* Effect.fail(storageFailure());
            const response = sessionResponse(row, options.environment, false);
            return response === null
              ? yield* Effect.fail(storageFailure())
              : ({ kind: "created", session: response } as const);
          }),
        );
      }),
    get: (input: Parameters<HnsCommunityRootImportPollStore["get"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "hns.community-root-import.get",
          text: `SELECT * FROM hns_root_import_sessions
                  WHERE actor_id=$1 AND community_id=$2
                    AND root_import_session_id=$3 AND origin_kind='community_attachment'`,
          values: [input.actor_id, input.community_id, input.root_import_session_id],
          readonly: true,
        });
        const row = oneRow(result);
        if (row === undefined) return yield* Effect.fail(storageFailure());
        return row === null ? null : sessionResponse(row, options.environment, false);
      }),
    loadPollAuthority: (
      input: Parameters<HnsCommunityRootImportPollStore["loadPollAuthority"]>[0],
    ) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "hns.community-root-import.load-poll-authority",
          text: `SELECT session.*, ownership.ceremony_intent_id,
                        provision.result_sha256 AS provision_result_sha256
                   FROM hns_root_import_sessions AS session
                   JOIN community_route_attachment_namespace_sessions AS ownership
                     ON ownership.namespace_session_id=session.namespace_session_id
                    AND ownership.actor_id=session.actor_id
                    AND ownership.community_id=session.community_id
                    AND ownership.attachment_intent_id=session.attachment_intent_id
                   LEFT JOIN hns_authority_provision_jobs AS provision
                     ON provision.provision_job_id=session.provision_job_id
                  WHERE session.actor_id=$1 AND session.community_id=$2
                    AND session.root_import_session_id=$3
                    AND session.origin_kind='community_attachment'`,
          values: [input.actor_id, input.community_id, input.root_import_session_id],
          readonly: true,
        });
        const row = oneRow(result);
        if (row === undefined) return yield* Effect.fail(storageFailure());
        if (row === null) return null;
        const session = sessionResponse(row, options.environment, false);
        const ceremonyIntentId = text(row, "ceremony_intent_id");
        const namespaceSessionId = text(row, "namespace_session_id");
        const ownershipRevision = integer(row.ownership_expected_revision);
        const challenge = text(row, "challenge_txt_value");
        const provisionJobId = text(row, "provision_job_id");
        const ownershipResultHash =
          row.ownership_result_sha256 === null ? null : text(row, "ownership_result_sha256");
        const provisionResultHash =
          row.provision_result_sha256 === null ? null : text(row, "provision_result_sha256");
        if (
          session === null ||
          ceremonyIntentId === null ||
          namespaceSessionId === null ||
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
          ceremony_intent_id: ceremonyIntentId,
          namespace_session_id: namespaceSessionId,
          ownership_expected_revision: ownershipRevision,
          challenge_txt_value: challenge,
          provision_job_id: provisionJobId,
          ownership_result_sha256: ownershipResultHash,
          provision_result_sha256: provisionResultHash,
        };
      }),
    beginProvisioning: (
      input: Parameters<HnsCommunityRootImportPollStore["beginProvisioning"]>[0],
    ) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "hns.community-root-import.begin-provisioning",
              text: `SELECT * FROM begin_hns_root_import_provision_v2(
                       $1,$2,$3,$4::bigint,$5,$6,'hns_name_signature',$7,$8::bytea,
                       $9,$10,$11,$12::bytea,$13
                     )`,
              values: [
                input.poll.actor_id,
                input.poll.community_id,
                input.poll.root_import_session_id,
                input.poll.expected_revision,
                input.poll.idempotency_key,
                input.poll_request_sha256,
                input.proof_result_sha256,
                input.proof_result_bytes,
                input.proof_message_sha256,
                input.proof_signature_sha256,
                input.provision_job_id,
                input.provision_request_bytes,
                input.provision_request_sha256,
              ],
              readonly: false,
            });
            const outcome = oneRow(result);
            if (outcome === undefined || outcome === null) {
              return yield* Effect.fail(storageFailure());
            }
            if (outcome.outcome === "not_found") return { kind: "not_found" } as const;
            if (outcome.outcome === "conflict") return { kind: "conflict" } as const;
            if (outcome.outcome !== "provisioning" && outcome.outcome !== "replayed") {
              return yield* Effect.fail(storageFailure());
            }
            const loaded = yield* transaction.execute<Row>({
              label: "hns.community-root-import.load-provisioned-session",
              text: `SELECT * FROM hns_root_import_sessions
                      WHERE actor_id=$1 AND community_id=$2 AND root_import_session_id=$3
                        AND origin_kind='community_attachment'`,
              values: [
                input.poll.actor_id,
                input.poll.community_id,
                input.poll.root_import_session_id,
              ],
              readonly: false,
            });
            const row = oneRow(loaded);
            const session =
              row === null || row === undefined
                ? null
                : sessionResponse(row, options.environment, outcome.outcome === "replayed");
            return session === null
              ? yield* Effect.fail(storageFailure())
              : ({ kind: outcome.outcome, session } as const);
          }),
        );
      }),
    beginObservation: (input: Parameters<HnsCommunityRootImportPollStore["beginObservation"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "hns.community-root-import.begin-observation",
              text: `SELECT * FROM begin_hns_root_import_observation_v1(
                       $1,$2,$3,$4::bigint,$5,$6,$7,$8,$9::bytea,$10
                     )`,
              values: [
                input.poll.actor_id,
                input.poll.community_id,
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
            const outcome = oneRow(result);
            if (outcome === undefined || outcome === null) {
              return yield* Effect.fail(storageFailure());
            }
            if (outcome.outcome === "not_found") return { kind: "not_found" } as const;
            if (outcome.outcome === "conflict") return { kind: "conflict" } as const;
            if (outcome.outcome !== "observing" && outcome.outcome !== "replayed") {
              return yield* Effect.fail(storageFailure());
            }
            const loaded = yield* transaction.execute<Row>({
              label: "hns.community-root-import.load-observing-session",
              text: `SELECT * FROM hns_root_import_sessions
                      WHERE actor_id=$1 AND community_id=$2 AND root_import_session_id=$3
                        AND origin_kind='community_attachment'`,
              values: [
                input.poll.actor_id,
                input.poll.community_id,
                input.poll.root_import_session_id,
              ],
              readonly: false,
            });
            const row = oneRow(loaded);
            const session =
              row === null || row === undefined
                ? null
                : sessionResponse(row, options.environment, outcome.outcome === "replayed");
            return session === null
              ? yield* Effect.fail(storageFailure())
              : ({ kind: outcome.outcome, session } as const);
          }),
        );
      }),
  };
}

export function makeControlPlaneHnsCommunityRootImportStartStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: HnsCommunityRootImportRepositoryOptions,
): HnsCommunityRootImportStartStore &
  HnsCommunityRootImportPollStore &
  HnsCommunityRootImportActivationStore {
  const repository = makeControlPlaneHnsCommunityRootImportRepository(options);
  const provide = <A>(effect: Effect.Effect<A, unknown, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(() => storageFailure()));
  const activationStore = makeControlPlaneHnsRootImportStore(runtime, {
    environment: options.environment,
  });
  return {
    prepare: (input) => provide(repository.prepare(input)),
    start: (input) => provide(repository.start(input)),
    get: (input) => provide(repository.get(input)),
    loadPollAuthority: (input) => provide(repository.loadPollAuthority(input)),
    beginProvisioning: (input) => provide(repository.beginProvisioning(input)),
    beginObservation: (input) => provide(repository.beginObservation(input)),
    activate: (input) =>
      activationStore
        .activate({
          input: {
            ...input.input,
            creation_intent_id: input.attachment_intent_id,
          },
          request_sha256: input.request_sha256,
          community_id: input.input.community_id,
          dns_zone_activation_id: input.dns_zone_activation_id,
          app_host_activation_id: input.app_host_activation_id,
          sale_namespace_activation_id: input.sale_namespace_activation_id,
          operation_id: input.operation_id,
          community_origin: {
            attachment_intent_id: input.attachment_intent_id,
            route_binding_id: input.route_binding_id,
          },
        } as Parameters<typeof activationStore.activate>[0] & {
          readonly community_origin: Readonly<{
            readonly attachment_intent_id: string;
            readonly route_binding_id: string;
          }>;
        })
        .pipe(
          Effect.map((outcome) => {
            if (!("response" in outcome)) return outcome;
            return {
              kind: outcome.kind,
              response: {
                community_id: input.input.community_id,
                attachment_intent_id: input.attachment_intent_id,
                root_import_session_id: outcome.response.root_import_session_id,
                root_label: outcome.response.root_label,
                revision: outcome.response.revision,
                status: "activated" as const,
                app_host: outcome.response.app_host,
                dns_zone_activation_id: outcome.response.dns_zone_activation_id,
                dns_zone_activation_generation: 1 as const,
                app_host_activation_id: outcome.response.app_host_activation_id,
                app_host_activation_generation: 1 as const,
                sale_namespace_activation_id: outcome.response.sale_namespace_activation_id,
                sale_namespace_activation_generation: 1 as const,
                sale_namespace_activation_sha256: outcome.response.sale_namespace_activation_sha256,
                handle_issuance_enabled: true as const,
                replayed: outcome.response.replayed,
              },
            };
          }),
          Effect.mapError(() => storageFailure()),
        ),
  };
}
