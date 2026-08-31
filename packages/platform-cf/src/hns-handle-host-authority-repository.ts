import {
  ControlPlaneDb,
  type ControlPlaneError,
  type HnsForwarderGatewayAuthoritySourceV1,
  type HnsForwarderWorkerAuthoritySourceV1,
  type HnsHandlePersonaHostAuthorityStateV1,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const identity = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value === value.trim() ? value : null;

const positiveInteger = (value: unknown): number | null => {
  const normalized =
    typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  return typeof normalized === "number" && Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : null;
};

const boolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const lifecycleStatus = (value: unknown): "pending" | "active" | "suspended" | "revoked" | null =>
  value === "pending" || value === "active" || value === "suspended" || value === "revoked"
    ? value
    : null;

function decodeHandleAuthority(row: Row): HnsHandlePersonaHostAuthorityStateV1 {
  const normalizedHost = identity(row.normalized_host);
  const canonicalRoot = identity(row.canonical_root);
  const canonicalHandleLabel = identity(row.canonical_handle_label);
  const communityId = identity(row.community_id);
  const activationId = identity(row.sale_namespace_activation_id);
  const activationGeneration = positiveInteger(row.sale_namespace_activation_generation);
  const activationStatus = lifecycleStatus(row.sale_namespace_activation_status);
  const activationDnsZoneId = identity(row.sale_namespace_dns_zone_id);
  const activationDnsZoneGeneration = positiveInteger(row.sale_namespace_dns_zone_generation);
  const activationGateway = identity(row.sale_namespace_gateway_deployment_reference);
  const authorityKind = row.namespace_authority_kind;
  const authorityReference = identity(row.namespace_authority_reference);
  const authorityGeneration = positiveInteger(row.namespace_authority_generation);
  const authorityEffective = boolean(row.namespace_authority_effective);
  const grantId = identity(row.handle_grant_id);
  const grantGeneration = positiveInteger(row.handle_grant_generation);
  const grantActive = boolean(row.handle_grant_active);
  const fulfillmentKind = row.fulfillment_kind;
  const personaId = identity(row.owner_persona_id);
  const personaPublic = boolean(row.owner_persona_public);
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
    canonicalHandleLabel === null ||
    communityId === null ||
    activationId === null ||
    activationGeneration === null ||
    activationStatus === null ||
    activationDnsZoneId === null ||
    activationDnsZoneGeneration === null ||
    activationGateway === null ||
    authorityKind !== "verified_namespace_v1" ||
    authorityReference === null ||
    authorityGeneration === null ||
    authorityEffective === null ||
    grantId === null ||
    grantGeneration === null ||
    grantActive === null ||
    (fulfillmentKind !== "hosted_persona_v1" &&
      fulfillmentKind !== "delegated_zone_v1" &&
      fulfillmentKind !== "spaces_native_v1") ||
    personaId === null ||
    personaPublic === null ||
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
    throw new Error("HNS handle-host authority resolver returned an invalid row");
  }
  return {
    variant: "handle_persona_v1",
    normalized_host: normalizedHost,
    canonical_root: canonicalRoot,
    canonical_handle_label: canonicalHandleLabel,
    community_id: communityId,
    sale_namespace_activation_id: activationId,
    sale_namespace_activation_generation: activationGeneration,
    sale_namespace_activation_status: activationStatus,
    sale_namespace_dns_zone_id: activationDnsZoneId,
    sale_namespace_dns_zone_generation: activationDnsZoneGeneration,
    sale_namespace_gateway_deployment_reference: activationGateway,
    namespace_authority_kind: authorityKind,
    namespace_authority_reference: authorityReference,
    namespace_authority_generation: authorityGeneration,
    namespace_authority_effective: authorityEffective,
    handle_grant_id: grantId,
    handle_grant_generation: grantGeneration,
    handle_grant_active: grantActive,
    fulfillment_kind: fulfillmentKind,
    owner_persona_id: personaId,
    owner_persona_public: personaPublic,
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

export function makeControlPlaneHnsHandlePersonaHostAuthoritySource(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HnsForwarderGatewayAuthoritySourceV1 & HnsForwarderWorkerAuthoritySourceV1 {
  return Object.freeze({
    resolve: (normalizedHost: string) =>
      Effect.provide(runtime)(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "hns.hosts.handle-persona.resolve-authority",
            text: `WITH authority_clock AS (
                     SELECT clock_timestamp() AS database_now
                   )
                   SELECT handle_grant.handle_label || '.' || handle_grant.namespace_root
                            AS normalized_host,
                          handle_grant.namespace_root AS canonical_root,
                          handle_grant.handle_label AS canonical_handle_label,
                          handle_grant.community_id,
                          activation.sale_namespace_activation_id,
                          activation.sale_namespace_activation_generation,
                          activation.status AS sale_namespace_activation_status,
                          activation.dns_zone_activation_id AS sale_namespace_dns_zone_id,
                          activation.dns_zone_activation_generation
                            AS sale_namespace_dns_zone_generation,
                          activation_dns.gateway_deployment_reference
                            AS sale_namespace_gateway_deployment_reference,
                          activation.namespace_authority_kind,
                          activation.namespace_authority_reference,
                          activation.namespace_authority_generation,
                          COALESCE(
                            dependency.namespace_authority_current
                            AND dependency.canonical_root=activation.canonical_root,
                            FALSE
                          ) AS namespace_authority_effective,
                          handle_grant.grant_id AS handle_grant_id,
                          handle_grant.grant_generation AS handle_grant_generation,
                          activation.status='active'
                            AND grant_activation.status='active'
                            AND grant_activation.sale_namespace_activation_generation
                                <= activation.sale_namespace_activation_generation
                            AND grant_activation.community_id=activation.community_id
                            AND grant_activation.family=activation.family
                            AND grant_activation.canonical_root=activation.canonical_root
                            AND handle_grant.status='active'
                            AND handle_grant.sale_namespace_activation_generation
                                = grant_activation.sale_namespace_activation_generation
                            AND handle_grant.community_id=activation.community_id
                            AND handle_grant.namespace_root=activation.canonical_root
                            AND handle_grant.family='hns'
                            AS handle_grant_active,
                          handle_grant.fulfillment_kind,
                          handle_grant.owner_persona_id,
                          persona.status='active' AS owner_persona_public,
                          dns.dns_zone_activation_id,
                          dns.dns_zone_activation_generation,
                          dns.status AS dns_zone_status,
                          COALESCE(
                            health.valid_until > authority_clock.database_now
                            AND inventory.published_at <= authority_clock.database_now
                            AND inventory.expires_at > authority_clock.database_now
                            AND health.delegation_matches
                            AND health.stable_chain_delegation_snapshot_reference
                                = dns.stable_chain_delegation_snapshot_reference
                            AND health.stable_chain_delegation_snapshot_digest
                                = dns.stable_chain_delegation_snapshot_digest,
                            FALSE
                          ) AS stable_chain_delegation_matches,
                          COALESCE(
                            health.valid_until > authority_clock.database_now
                            AND health.ds_authenticates_zone
                            AND health.observed_dnssec_keyset_reference=dns.dnssec_keyset_reference
                            AND health.observed_dnssec_keyset_version=dns.dnssec_keyset_version,
                            FALSE
                          ) AS dnssec_ds_authenticates_zone,
                          COALESCE(
                            health.valid_until > authority_clock.database_now
                            AND health.retained_zone_digest_matches
                            AND health.observed_zone_bytes_digest=dns.zone_bytes_digest,
                            FALSE
                          ) AS retained_zone_digest_matches,
                          dns.gateway_deployment_reference,
                          dns.gateway_certificate_spki_sha256,
                          CASE WHEN health.valid_until > authority_clock.database_now
                            AND health.gateway_healthy
                            AND health.observed_gateway_deployment_reference
                                = dns.gateway_deployment_reference
                            AND health.observed_gateway_certificate_spki_sha256
                                = dns.gateway_certificate_spki_sha256
                            THEN 'healthy'::TEXT ELSE 'unavailable'::TEXT END AS gateway_health
                     FROM handle_grants AS handle_grant
                     CROSS JOIN authority_clock
                     JOIN personas AS persona
                       ON persona.persona_id=handle_grant.owner_persona_id
                     JOIN community_handle_sale_namespace_activation_revisions AS grant_activation
                       ON grant_activation.sale_namespace_activation_id
                           = handle_grant.sale_namespace_activation_id
                      AND grant_activation.sale_namespace_activation_generation
                           = handle_grant.sale_namespace_activation_generation
                     JOIN community_handle_sale_namespace_activation_current AS current_activation
                       ON current_activation.sale_namespace_activation_id
                           = handle_grant.sale_namespace_activation_id
                     JOIN community_handle_sale_namespace_activation_revisions AS activation
                       ON activation.sale_namespace_activation_id
                           = current_activation.sale_namespace_activation_id
                      AND activation.sale_namespace_activation_generation
                           = current_activation.current_generation
                     JOIN hns_dns_zone_activation_revisions AS activation_dns
                       ON activation_dns.dns_zone_activation_id=activation.dns_zone_activation_id
                      AND activation_dns.dns_zone_activation_generation
                           = activation.dns_zone_activation_generation
                     LEFT JOIN LATERAL current_hns_sale_namespace_dependency_v1(
                       activation.community_id,
                       activation.namespace_authority_reference,
                       activation.namespace_authority_generation,
                       activation.dns_zone_activation_id,
                       activation.dns_zone_activation_generation,
                       authority_clock.database_now
                     ) AS dependency ON TRUE
                     JOIN hns_dns_zone_activation_current AS current_dns
                       ON current_dns.dns_zone_activation_id=activation.dns_zone_activation_id
                     JOIN hns_dns_zone_activation_revisions AS dns
                       ON dns.dns_zone_activation_id=current_dns.dns_zone_activation_id
                      AND dns.dns_zone_activation_generation=current_dns.current_generation
                     JOIN hns_authority_inventories AS inventory
                       ON inventory.authority_inventory_reference
                           = dns.pirate_dns_authority_inventory_reference
                      AND inventory.authority_inventory_version
                           = dns.pirate_dns_authority_inventory_version
                      AND inventory.authority_inventory_digest
                           = dns.pirate_dns_authority_inventory_digest
                     LEFT JOIN LATERAL (
                       SELECT observation.*
                         FROM hns_dns_zone_health_observations AS observation
                        WHERE observation.dns_zone_activation_id=dns.dns_zone_activation_id
                          AND observation.activation_generation=dns.dns_zone_activation_generation
                        ORDER BY observation.health_generation DESC
                        LIMIT 1
                     ) AS health ON TRUE
                    WHERE handle_grant.family='hns'
                      AND handle_grant.handle_label || '.' || handle_grant.namespace_root=$1`,
            values: [normalizedHost],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          if (result.rows.length !== 1) {
            return yield* Effect.die("duplicate HNS handle-host authority");
          }
          return decodeHandleAuthority(result.rows[0] as Row);
        }),
      ),
  });
}
