import {
  ControlPlaneDb,
  type ControlPlaneError,
  decodeHnsAppHostTransitionDocumentV1,
  decodeHnsDnsHealthDocumentV1,
  decodeHnsDnsZonePersistenceDocumentV1,
  type HnsAuthoritySuccessorGenerationSnapshotV1,
  type HnsCommunityAppHostActivationOutcomeV1,
  type HnsCommunityAppHostAuthorityStateV1,
  type HnsCommunityAppHostStatusChangeInputV1,
  type HnsDnsZoneActivationDocumentV1,
  type HnsDnsZoneActivationOutcomeV1,
  type HnsDnsZoneActivationReservationV1,
  type HnsDnsZoneHealthInputV1,
  type HnsDnsZoneHealthOutcomeV1,
  type HnsFirstPartyHostPersistenceStoreV1,
  type HnsForwarderGatewayAuthoritySourceV1,
  type HnsForwarderWorkerAuthoritySourceV1,
  type HnsLifecycleOutcomeV1,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

function dnsHealthStatement(input: HnsDnsZoneHealthInputV1) {
  return {
    label: "hns.hosts.dns-zone.record-health",
    text: `SELECT * FROM record_hns_dns_zone_health_v1(
      $1, $2, $3, $4, $5::bigint, $6::bigint, $7, $8, $9, $10, $11,
      $12, $13, $14::boolean, $15::boolean, $16::boolean, $17::boolean, $18::integer
    )`,
    values: [
      input.operation_id,
      input.idempotency_key,
      input.request_hash,
      input.dns_zone_activation_id,
      input.activation_generation,
      input.expected_health_generation,
      input.stable_chain_delegation_snapshot_reference,
      input.stable_chain_delegation_snapshot_digest,
      input.observed_zone_bytes_digest,
      input.observed_dnssec_keyset_reference,
      input.observed_dnssec_keyset_version,
      input.observed_gateway_deployment_reference,
      input.observed_gateway_certificate_spki_sha256,
      input.delegation_matches,
      input.ds_authenticates_zone,
      input.retained_zone_digest_matches,
      input.gateway_healthy,
      input.valid_for_seconds,
    ],
    readonly: false,
  } as const;
}

export function hnsDnsHealthStatementFromReviewedDocument(bytes: Uint8Array) {
  return dnsHealthStatement(decodeHnsDnsHealthDocumentV1(bytes));
}

function appHostTransitionStatement(input: HnsCommunityAppHostStatusChangeInputV1) {
  return {
    label: "hns.hosts.community-app.change-status",
    text: "SELECT * FROM change_hns_community_app_host_status_v1($1, $2, $3, $4, $5::bigint, $6, $7)",
    values: [
      input.operation_id,
      input.idempotency_key,
      input.request_hash,
      input.app_host_activation_id,
      input.expected_activation_generation,
      input.target_status,
      input.reason_code,
    ],
    readonly: false,
  } as const;
}

function dnsZoneFinalizationStatement(
  reservation: HnsDnsZoneActivationReservationV1,
  document: HnsDnsZoneActivationDocumentV1,
) {
  return {
    label: "hns.hosts.dns-zone.finalize",
    text: `SELECT * FROM finalize_hns_dns_zone_activation_v1(
      $1, $2::bigint, $3::bytea, $4, $5, $6, $7, $8::bigint, $9, $10,
      $11, $12::bigint, $13::bytea, $14, $15, $16, $17, $18, $19, $20
    )`,
    values: [
      reservation.operation_id,
      reservation.fence_token,
      document.activation_document_bytes,
      document.dns_zone_activation_id,
      document.canonical_root,
      document.dns_authority_kind,
      document.dns_authority_reference,
      document.dns_authority_generation,
      document.pirate_dns_authority_inventory_reference,
      document.pirate_dns_authority_inventory_version,
      document.pirate_dns_authority_inventory_digest,
      document.zone_revision,
      document.zone_bytes,
      document.zone_bytes_digest,
      document.dnssec_keyset_reference,
      document.dnssec_keyset_version,
      document.gateway_deployment_reference,
      document.gateway_certificate_spki_sha256,
      document.stable_chain_delegation_snapshot_reference,
      document.stable_chain_delegation_snapshot_digest,
    ],
    readonly: false,
  } as const;
}

/** Derives every authority-controlled finalization value from reviewed canonical bytes. */
export async function hnsDnsZoneFinalizationStatementFromReviewedDocument(
  reservation: HnsDnsZoneActivationReservationV1,
  bytes: Uint8Array,
) {
  return dnsZoneFinalizationStatement(
    reservation,
    await decodeHnsDnsZonePersistenceDocumentV1(bytes),
  );
}

export function hnsAppHostTransitionStatementFromReviewedDocument(bytes: Uint8Array) {
  return appHostTransitionStatement(decodeHnsAppHostTransitionDocumentV1(bytes));
}

function identity(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value === value.trim() ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const normalized =
    typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  return typeof normalized === "number" && Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  const normalized = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  return typeof normalized === "number" && Number.isSafeInteger(normalized) && normalized >= 0
    ? normalized
    : null;
}

function decodeGenerationSnapshot(row: Row): HnsAuthoritySuccessorGenerationSnapshotV1 {
  const dns = positiveInteger(row.dns_current_generation);
  const app = positiveInteger(row.app_host_current_generation);
  const health = nonnegativeInteger(row.successor_dns_latest_health_generation);
  if (dns === null || app === null || health === null) {
    throw new Error("HNS successor generation snapshot returned an invalid row");
  }
  return {
    dns_current_generation: dns,
    app_host_current_generation: app,
    successor_dns_latest_health_generation: health,
  };
}

function optionalPositiveInteger(value: unknown): number | null | undefined {
  return value === null ? null : (positiveInteger(value) ?? undefined);
}

function exactlyOne(result: { readonly rows: readonly Row[] }, label: string): Row {
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) {
    throw new Error(`${label} returned invalid cardinality`);
  }
  return row;
}

function decodeReservation(row: Row): HnsDnsZoneActivationReservationV1 {
  const operationId = identity(row.operation_id);
  const activationId = identity(row.dns_zone_activation_id);
  const fenceToken = positiveInteger(row.fence_token);
  const generation = optionalPositiveInteger(row.activation_generation);
  const lease = row.lease_expires_at;
  const leaseExpiresAt =
    lease instanceof Date ? lease.toISOString() : typeof lease === "string" ? lease : null;
  if (
    (row.outcome !== "reserved" && row.outcome !== "replayed") ||
    operationId === null ||
    activationId === null ||
    fenceToken === null ||
    generation === undefined ||
    leaseExpiresAt === null ||
    Number.isNaN(Date.parse(leaseExpiresAt)) ||
    (row.outcome === "reserved" && generation !== null) ||
    (row.outcome === "replayed" && generation === null)
  ) {
    throw new Error("HNS DNS activation reservation returned an invalid row");
  }
  return {
    outcome: row.outcome,
    operation_id: operationId,
    dns_zone_activation_id: activationId,
    fence_token: fenceToken,
    lease_expires_at: leaseExpiresAt,
    activation_generation: generation,
  };
}

function decodeDnsOutcome(row: Row): HnsDnsZoneActivationOutcomeV1 {
  const activationId = identity(row.dns_zone_activation_id);
  const generation = positiveInteger(row.activation_generation);
  if (
    (row.outcome !== "activated" && row.outcome !== "replayed") ||
    activationId === null ||
    generation === null
  ) {
    throw new Error("HNS DNS activation finalizer returned an invalid row");
  }
  return {
    outcome: row.outcome,
    dns_zone_activation_id: activationId,
    activation_generation: generation,
  };
}

function lifecycleStatus(value: unknown): "active" | "suspended" | "revoked" | null {
  return value === "active" || value === "suspended" || value === "revoked" ? value : null;
}

function decodeLifecycle(row: Row): HnsLifecycleOutcomeV1 {
  const activationId = identity(row.activation_id);
  const generation = positiveInteger(row.activation_generation);
  const status = lifecycleStatus(row.status);
  if (
    (row.outcome !== "changed" && row.outcome !== "replayed") ||
    activationId === null ||
    generation === null ||
    status === null
  ) {
    throw new Error("HNS DNS lifecycle transition returned an invalid row");
  }
  return {
    outcome: row.outcome,
    activation_id: activationId,
    activation_generation: generation,
    status,
  };
}

function decodeHealth(row: Row): HnsDnsZoneHealthOutcomeV1 {
  const activationId = identity(row.dns_zone_activation_id);
  const activationGeneration = positiveInteger(row.activation_generation);
  const healthGeneration = positiveInteger(row.health_generation);
  if (
    (row.outcome !== "recorded" && row.outcome !== "replayed") ||
    activationId === null ||
    activationGeneration === null ||
    healthGeneration === null
  ) {
    throw new Error("HNS DNS health operation returned an invalid row");
  }
  return {
    outcome: row.outcome,
    dns_zone_activation_id: activationId,
    activation_generation: activationGeneration,
    health_generation: healthGeneration,
  };
}

function decodeAppOutcome(row: Row): HnsCommunityAppHostActivationOutcomeV1 {
  const activationId = identity(row.app_host_activation_id);
  const generation = positiveInteger(row.app_host_activation_generation);
  const status = lifecycleStatus(row.status);
  if (
    (row.outcome !== "activated" && row.outcome !== "changed" && row.outcome !== "replayed") ||
    activationId === null ||
    generation === null ||
    status === null
  ) {
    throw new Error("HNS app-host operation returned an invalid row");
  }
  return {
    outcome: row.outcome,
    app_host_activation_id: activationId,
    app_host_activation_generation: generation,
    status,
  };
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function decodeAuthority(row: Row): HnsCommunityAppHostAuthorityStateV1 {
  const normalizedHost = identity(row.normalized_host);
  const canonicalRoot = identity(row.canonical_root);
  const communityId = identity(row.community_id);
  const appActivationId = identity(row.app_host_activation_id);
  const appGeneration = positiveInteger(row.app_host_activation_generation);
  const appStatus = lifecycleStatus(row.app_host_activation_status);
  const activationDnsZoneId = identity(row.activation_dns_zone_id);
  const activationDnsZoneGeneration = positiveInteger(row.activation_dns_zone_generation);
  const activationGateway = identity(row.activation_gateway_deployment_reference);
  const routeBindingId = identity(row.route_binding_id);
  const routeBindingCurrent = boolean(row.route_binding_current);
  const routeKind = row.route_authority_kind;
  const routeReference = identity(row.route_authority_reference);
  const routeGeneration = positiveInteger(row.route_authority_generation);
  const routeEffective = boolean(row.route_authority_effective);
  const dnsZoneId = identity(row.dns_zone_activation_id);
  const dnsZoneGeneration = positiveInteger(row.dns_zone_activation_generation);
  const dnsStatus = lifecycleStatus(row.dns_zone_status);
  const delegationMatches = boolean(row.stable_chain_delegation_matches);
  const dsAuthenticates = boolean(row.dnssec_ds_authenticates_zone);
  const zoneDigestMatches = boolean(row.retained_zone_digest_matches);
  const gatewayReference = identity(row.gateway_deployment_reference);
  const gatewaySpki = identity(row.gateway_certificate_spki_sha256);
  const gatewayHealth = row.gateway_health;
  if (
    normalizedHost === null ||
    canonicalRoot === null ||
    communityId === null ||
    appActivationId === null ||
    appGeneration === null ||
    appStatus === null ||
    activationDnsZoneId === null ||
    activationDnsZoneGeneration === null ||
    activationGateway === null ||
    routeBindingId === null ||
    routeBindingCurrent === null ||
    (routeKind !== "verified_namespace_v1" && routeKind !== "operator_managed_route_v1") ||
    routeReference === null ||
    routeGeneration === null ||
    routeEffective === null ||
    dnsZoneId === null ||
    dnsZoneGeneration === null ||
    dnsStatus === null ||
    delegationMatches === null ||
    dsAuthenticates === null ||
    zoneDigestMatches === null ||
    gatewayReference === null ||
    gatewaySpki === null ||
    (gatewayHealth !== "healthy" && gatewayHealth !== "unavailable")
  ) {
    throw new Error("HNS app-host authority resolver returned an invalid row");
  }
  return {
    variant: "community_app_v1",
    normalized_host: normalizedHost,
    canonical_root: canonicalRoot,
    community_id: communityId,
    app_host_activation_id: appActivationId,
    app_host_activation_generation: appGeneration,
    app_host_activation_status: appStatus,
    activation_dns_zone_id: activationDnsZoneId,
    activation_dns_zone_generation: activationDnsZoneGeneration,
    activation_gateway_deployment_reference: activationGateway,
    route_binding_id: routeBindingId,
    route_binding_current: routeBindingCurrent,
    route_authority_kind: routeKind,
    route_authority_reference: routeReference,
    route_authority_generation: routeGeneration,
    route_authority_effective: routeEffective,
    dns_zone: {
      dns_zone_activation_id: dnsZoneId,
      dns_zone_activation_generation: dnsZoneGeneration,
      status: dnsStatus,
      stable_chain_delegation_matches: delegationMatches,
      dnssec_ds_authenticates_zone: dsAuthenticates,
      retained_zone_digest_matches: zoneDigestMatches,
      gateway_deployment_reference: gatewayReference,
      gateway_certificate_spki_sha256: gatewaySpki,
      gateway_health: gatewayHealth,
    },
  };
}

export interface HnsFirstPartyHostPersistenceRepositoryV1 {
  readonly store: HnsFirstPartyHostPersistenceStoreV1;
  readonly readSuccessorGenerationSnapshot: (
    input: Readonly<{
      dns_zone_activation_id: string;
      app_host_activation_id: string;
    }>,
  ) => Effect.Effect<HnsAuthoritySuccessorGenerationSnapshotV1, ControlPlaneError>;
  readonly resolveCommunityAppHost: (
    normalizedHost: string,
  ) => Effect.Effect<HnsCommunityAppHostAuthorityStateV1 | null, ControlPlaneError>;
}

export function makeControlPlaneHnsFirstPartyHostPersistenceRepository(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: Readonly<{ authority_schema?: "api_next" }> = {},
): HnsFirstPartyHostPersistenceRepositoryV1 {
  const authorityResolver =
    options.authority_schema === "api_next"
      ? "api_next.resolve_hns_community_app_host_authority_v1"
      : "resolve_hns_community_app_host_authority_v1";
  const execute = <A>(
    statement: Readonly<{
      label: string;
      text: string;
      values: readonly unknown[];
      readonly: boolean;
    }>,
    decode: (row: Row) => A,
  ) =>
    Effect.provide(runtime)(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>(statement);
        return decode(exactlyOne(result, statement.label));
      }),
    );

  const store: HnsFirstPartyHostPersistenceStoreV1 = {
    reserveDnsZoneActivation: (input) =>
      execute(
        {
          label: "hns.hosts.dns-zone.reserve",
          text: "SELECT * FROM reserve_hns_dns_zone_activation_v1($1, $2, $3, $4, $5::bigint, $6::integer)",
          values: [
            input.operation_id,
            input.idempotency_key,
            input.activation_document_digest,
            input.dns_zone_activation_id,
            input.expected_activation_generation,
            input.lease_seconds,
          ],
          readonly: false,
        },
        decodeReservation,
      ),
    finalizeDnsZoneActivation: ({ reservation, document }) =>
      execute(dnsZoneFinalizationStatement(reservation, document), decodeDnsOutcome),
    changeDnsZoneStatus: (input) =>
      execute(
        {
          label: "hns.hosts.dns-zone.change-status",
          text: "SELECT * FROM change_hns_dns_zone_activation_status_v1($1, $2, $3, $4, $5::bigint, $6, $7)",
          values: [
            input.operation_id,
            input.idempotency_key,
            input.request_hash,
            input.dns_zone_activation_id,
            input.expected_activation_generation,
            input.target_status,
            input.reason_code,
          ],
          readonly: false,
        },
        decodeLifecycle,
      ),
    recordDnsZoneHealth: (input) => execute(dnsHealthStatement(input), decodeHealth),
    activateCommunityAppHost: (input) =>
      execute(
        {
          label: "hns.hosts.community-app.activate",
          text: `SELECT * FROM activate_hns_community_app_host_v1(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11, $12::bigint, $13
          )`,
          values: [
            input.operation_id,
            input.idempotency_key,
            input.request_hash,
            input.app_host_activation_id,
            input.community_id,
            input.canonical_root,
            input.route_binding_id,
            input.route_authority_kind,
            input.route_authority_reference,
            input.route_authority_generation,
            input.dns_zone_activation_id,
            input.dns_zone_activation_generation,
            input.gateway_deployment_reference,
          ],
          readonly: false,
        },
        decodeAppOutcome,
      ),
    changeCommunityAppHostStatus: (input) =>
      execute(appHostTransitionStatement(input), decodeAppOutcome),
  };

  return {
    store,
    readSuccessorGenerationSnapshot: (input) =>
      execute(
        {
          label: "hns.hosts.successor-generations.read",
          text: `SELECT dns.current_generation AS dns_current_generation,
                        app.current_generation AS app_host_current_generation,
                        COALESCE((
                          SELECT max(health.health_generation)
                            FROM hns_dns_zone_health_observations AS health
                           WHERE health.dns_zone_activation_id = dns.dns_zone_activation_id
                             AND health.activation_generation = dns.current_generation + 1
                        ), 0) AS successor_dns_latest_health_generation
                   FROM hns_dns_zone_activation_current AS dns
                   JOIN hns_community_app_host_activation_current AS app ON TRUE
                  WHERE dns.dns_zone_activation_id = $1
                    AND app.app_host_activation_id = $2`,
          values: [input.dns_zone_activation_id, input.app_host_activation_id],
          readonly: true,
        },
        decodeGenerationSnapshot,
      ),
    resolveCommunityAppHost: (normalizedHost) =>
      Effect.provide(runtime)(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "hns.hosts.community-app.resolve-authority",
            text: `SELECT * FROM ${authorityResolver}($1, clock_timestamp())`,
            values: [normalizedHost],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          return decodeAuthority(exactlyOne(result, "hns.hosts.community-app.resolve-authority"));
        }),
      ),
  };
}

export function makeControlPlaneHnsCommunityAppHostAuthoritySource(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: Readonly<{ authority_schema?: "api_next" }> = {},
): HnsForwarderGatewayAuthoritySourceV1 & HnsForwarderWorkerAuthoritySourceV1 {
  const repository = makeControlPlaneHnsFirstPartyHostPersistenceRepository(runtime, options);
  return Object.freeze({ resolve: repository.resolveCommunityAppHost });
}
