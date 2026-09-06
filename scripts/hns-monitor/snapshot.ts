import { Schema } from "effect";
import type { Client } from "pg";

const Seconds = Schema.Number.check(Schema.isFinite());
const NullableSeconds = Schema.NullOr(Seconds);
const Root = Schema.Struct({
  root: Schema.String,
  activation_generation: Schema.String,
  pin: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  inventory_hex: Schema.NullOr(
    Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{2}){1,65536}$/u)),
  ),
  imported: Schema.Boolean,
  inventory_remaining: NullableSeconds,
  inventory_age: NullableSeconds,
  health_remaining: NullableSeconds,
  healthy: Schema.Boolean,
  delayed_age: NullableSeconds,
  terminal: Schema.Boolean,
});
const Snapshot = Schema.Struct({
  observed_at: Seconds,
  heartbeat_remaining: NullableSeconds,
  roots: Schema.Array(Root),
});
export type MonitorSnapshot = Schema.Schema.Type<typeof Snapshot>;

/** All current roots, including roots that have no import session or health row. */
export const HNS_MONITOR_SQL = `
WITH instant AS (SELECT transaction_timestamp() AS now), roots AS (
 SELECT current_dns.canonical_root AS root,
        current_dns.current_generation::text AS activation_generation,
        dns.gateway_certificate_spki_sha256 AS pin,
        encode(inventory.inventory_bytes,'hex') AS inventory_hex,
        EXISTS (SELECT 1 FROM hns_root_import_activation_operations operation
          JOIN hns_root_import_sessions session
            ON session.root_import_session_id=operation.root_import_session_id
           AND session.status='activated'
          WHERE operation.dns_zone_activation_id=current_dns.dns_zone_activation_id) AS imported,
        extract(epoch FROM inventory.expires_at-instant.now)::double precision AS inventory_remaining,
        extract(epoch FROM instant.now-inventory.published_at)::double precision AS inventory_age,
        extract(epoch FROM health.valid_until-instant.now)::double precision AS health_remaining,
        COALESCE(health.delegation_matches AND health.ds_authenticates_zone
          AND health.retained_zone_digest_matches AND health.gateway_healthy
          AND health.observed_zone_bytes_digest=dns.zone_bytes_digest
          AND health.observed_dnssec_keyset_reference=dns.dnssec_keyset_reference
          AND health.observed_dnssec_keyset_version=dns.dnssec_keyset_version
          AND health.checked_at<=instant.now
          AND health.observed_gateway_deployment_reference=dns.gateway_deployment_reference
          AND health.observed_gateway_certificate_spki_sha256=dns.gateway_certificate_spki_sha256,
          false) AS healthy,
        CASE WHEN job.state='delayed' THEN
          extract(epoch FROM instant.now-job.created_at)::double precision END AS delayed_age,
        COALESCE(job.state='terminal',false) AS terminal
 FROM hns_dns_zone_activation_current current_dns
 JOIN hns_dns_zone_activation_revisions dns
   ON dns.dns_zone_activation_id=current_dns.dns_zone_activation_id
  AND dns.dns_zone_activation_generation=current_dns.current_generation
 CROSS JOIN instant
 LEFT JOIN hns_authority_inventories inventory
   ON inventory.authority_inventory_reference=dns.pirate_dns_authority_inventory_reference
  AND inventory.authority_inventory_version=dns.pirate_dns_authority_inventory_version
  AND inventory.authority_inventory_digest=dns.pirate_dns_authority_inventory_digest
 LEFT JOIN LATERAL (
   SELECT * FROM hns_dns_zone_health_observations observation
   WHERE observation.dns_zone_activation_id=current_dns.dns_zone_activation_id
     AND observation.activation_generation=current_dns.current_generation
   ORDER BY observation.health_generation DESC LIMIT 1
 ) health ON true
 LEFT JOIN hns_root_health_renewal_jobs job
   ON job.dns_zone_activation_id=current_dns.dns_zone_activation_id
  AND job.activation_generation=current_dns.current_generation
  AND job.expected_health_generation=health.health_generation
 WHERE dns.status='active'
)
SELECT extract(epoch FROM instant.now)::double precision AS observed_at,
       extract(epoch FROM heartbeat.last_successful_tick_at
         + heartbeat.freshness_threshold_seconds*interval '1 second'-instant.now)::double precision
         AS heartbeat_remaining,
       COALESCE((SELECT jsonb_agg(to_jsonb(roots) ORDER BY root) FROM roots),'[]'::jsonb) AS roots
FROM instant LEFT JOIN hns_root_health_renewal_scheduler_heartbeat heartbeat
  ON heartbeat.scheduler_id='hns-root-health-renewal-v1'
`;

export async function readMonitorSnapshot(client: Client): Promise<MonitorSnapshot> {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout='10s'");
    const result = await client.query(HNS_MONITOR_SQL);
    if (result.rows.length !== 1) throw new Error("Invalid HNS monitor snapshot");
    const snapshot = Schema.decodeUnknownSync(Snapshot)(result.rows[0]);
    await client.query("COMMIT");
    return snapshot;
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error("HNS monitor database observation unavailable");
  }
}
