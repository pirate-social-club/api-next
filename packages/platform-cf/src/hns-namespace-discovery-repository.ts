import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { HnsNamespaceDiscoveryStore } from "@pirate/application/use-cases/hns-namespace-discovery";
import { HnsNamespaceEntryV1, HnsNamespaceInstantV1, InternalError } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

const instantText = (value: string) =>
  `to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * The zone conditions of `resolve_hns_community_app_host_authority_v1` plus the
 * zone part of `dnsZoneHealthy`, without any app host or route. The clock is
 * read once and truncated to milliseconds, and each expiry is truncated before
 * it is compared, so no listed root can serialize as expiring at
 * `generated_at`. Health is the latest observation of the current generation.
 */
export const HNS_SERVED_ROOTS_SQL = `WITH db_clock AS (
  SELECT date_trunc('milliseconds', clock_timestamp()) AS database_time
),
served AS (
  SELECT dns.canonical_root AS root,
         date_trunc('milliseconds', LEAST(health.valid_until, inventory.expires_at)) AS expires_at
    FROM db_clock
   CROSS JOIN hns_dns_zone_activation_current AS current_dns
    JOIN hns_dns_zone_activation_revisions AS dns
      ON dns.dns_zone_activation_id = current_dns.dns_zone_activation_id
     AND dns.dns_zone_activation_generation = current_dns.current_generation
    JOIN hns_authority_inventories AS inventory
      ON inventory.authority_inventory_reference = dns.pirate_dns_authority_inventory_reference
     AND inventory.authority_inventory_version = dns.pirate_dns_authority_inventory_version
     AND inventory.authority_inventory_digest = dns.pirate_dns_authority_inventory_digest
    JOIN LATERAL (
      SELECT observation.*
        FROM hns_dns_zone_health_observations AS observation
       WHERE observation.dns_zone_activation_id = dns.dns_zone_activation_id
         AND observation.activation_generation = dns.dns_zone_activation_generation
       ORDER BY observation.health_generation DESC
       LIMIT 1
    ) AS health ON TRUE
   WHERE dns.status = 'active'
     AND inventory.published_at <= db_clock.database_time
     AND date_trunc('milliseconds', LEAST(health.valid_until, inventory.expires_at))
         > db_clock.database_time
     AND health.delegation_matches
     AND health.ds_authenticates_zone
     AND health.retained_zone_digest_matches
     AND health.gateway_healthy
     AND health.stable_chain_delegation_snapshot_reference
         = dns.stable_chain_delegation_snapshot_reference
     AND health.stable_chain_delegation_snapshot_digest
         = dns.stable_chain_delegation_snapshot_digest
     AND health.observed_dnssec_keyset_reference = dns.dnssec_keyset_reference
     AND health.observed_dnssec_keyset_version = dns.dnssec_keyset_version
     AND health.observed_zone_bytes_digest = dns.zone_bytes_digest
     AND health.observed_gateway_deployment_reference = dns.gateway_deployment_reference
     AND health.observed_gateway_certificate_spki_sha256 = dns.gateway_certificate_spki_sha256
     AND dns.dns_zone_activation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     AND dns.gateway_deployment_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     AND dns.gateway_certificate_spki_sha256 ~ '^[0-9a-f]{64}$'
     AND dns.canonical_root ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
)
SELECT ${instantText("db_clock.database_time")} AS generated_at,
       COALESCE((
         SELECT jsonb_agg(
                  jsonb_build_object('root', served.root,
                                     'expires_at', ${instantText("served.expires_at")})
                  ORDER BY served.root COLLATE "C")
           FROM served
       ), '[]'::jsonb) AS roots
  FROM db_clock`;

const ServedRootsRows = Schema.Tuple([
  Schema.Struct({
    generated_at: HnsNamespaceInstantV1,
    roots: Schema.Array(HnsNamespaceEntryV1),
  }),
]);

const failure = (cause: unknown) =>
  new InternalError({ message: "HNS namespace discovery could not be loaded", cause });

export function makeControlPlaneHnsNamespaceDiscoveryStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): HnsNamespaceDiscoveryStore {
  return {
    servedRoots: () =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "hns.namespace-discovery.served-roots",
          text: HNS_SERVED_ROOTS_SQL,
          values: [],
          readonly: true,
        });
        const [served] = yield* Schema.decodeUnknownEffect(ServedRootsRows)(result.rows);
        return served;
      }).pipe(Effect.provide(runtime), Effect.mapError(failure)),
  };
}
