import {
  ControlPlaneDb,
  type ControlPlaneError,
  HnsEdgeStatusFailed,
  type HnsRootHealthRenewalStatusStore,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

function count(value: unknown): number | null {
  const parsed = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function unixSeconds(value: unknown): number | null {
  if (value === null) return null;
  const instant =
    value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  const milliseconds = instant?.getTime();
  return milliseconds !== undefined && Number.isFinite(milliseconds)
    ? Math.floor(milliseconds / 1_000)
    : null;
}

export function makeControlPlaneHnsRootHealthRenewalStatusStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HnsRootHealthRenewalStatusStore {
  return {
    load: () =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "hns.root-health-renewal.status",
          text: `WITH imported_roots AS (
                   SELECT activation.dns_zone_activation_id,
                          current_dns.current_generation AS activation_generation,
                          inventory.expires_at AS inventory_expires_at
                     FROM hns_root_import_activation_operations AS activation
                     JOIN hns_root_import_sessions AS session
                       ON session.root_import_session_id=activation.root_import_session_id
                      AND session.status='activated'
                     JOIN hns_dns_zone_activation_current AS current_dns
                       ON current_dns.dns_zone_activation_id=activation.dns_zone_activation_id
                     JOIN hns_dns_zone_activation_revisions AS dns
                       ON dns.dns_zone_activation_id=current_dns.dns_zone_activation_id
                      AND dns.dns_zone_activation_generation=current_dns.current_generation
                     JOIN hns_authority_inventories AS inventory
                       ON inventory.authority_inventory_reference=dns.pirate_dns_authority_inventory_reference
                      AND inventory.authority_inventory_version=dns.pirate_dns_authority_inventory_version
                      AND inventory.authority_inventory_digest=dns.pirate_dns_authority_inventory_digest
                 ), latest_health AS (
                   SELECT DISTINCT ON (health.dns_zone_activation_id,health.activation_generation)
                          health.dns_zone_activation_id,health.activation_generation,
                          health.health_generation,health.valid_until,health.delegation_matches,
                          health.ds_authenticates_zone,health.retained_zone_digest_matches,
                          health.gateway_healthy
                     FROM hns_dns_zone_health_observations AS health
                    ORDER BY health.dns_zone_activation_id,health.activation_generation,
                             health.health_generation DESC
                 )
                 SELECT heartbeat.last_successful_tick_at,
                        heartbeat.freshness_threshold_seconds,
                        count(imported.dns_zone_activation_id)::integer AS active_root_count,
                        count(imported.dns_zone_activation_id) FILTER (
                          WHERE health.valid_until > clock_timestamp()
                            AND imported.inventory_expires_at > clock_timestamp()
                            AND health.delegation_matches AND health.ds_authenticates_zone
                            AND health.retained_zone_digest_matches AND health.gateway_healthy
                        )::integer AS healthy_root_count,
                        min(health.valid_until) AS earliest_health_valid_until,
                        count(job.renewal_job_id) FILTER (WHERE job.state='delayed')::integer AS delayed_job_count,
                        count(job.renewal_job_id) FILTER (WHERE job.state='terminal')::integer AS terminal_job_count,
                        min(CASE WHEN health.valid_until IS NOT NULL
                          THEN LEAST(health.valid_until, imported.inventory_expires_at) END)
                          AS earliest_serving_valid_until,
                        CASE WHEN count(health.valid_until)=0 THEN NULL ELSE
                          GREATEST(0, floor(extract(epoch FROM (min(LEAST(health.valid_until,
                            imported.inventory_expires_at))-clock_timestamp()))))::integer END
                          AS serving_remaining_seconds
                   FROM (SELECT 1 AS singleton) AS anchor
                   LEFT JOIN hns_root_health_renewal_scheduler_heartbeat AS heartbeat
                     ON heartbeat.scheduler_id='hns-root-health-renewal-v1'
                   LEFT JOIN imported_roots AS imported ON TRUE
                   LEFT JOIN latest_health AS health
                     ON health.dns_zone_activation_id=imported.dns_zone_activation_id
                    AND health.activation_generation=imported.activation_generation
                   LEFT JOIN hns_root_health_renewal_jobs AS job
                     ON job.dns_zone_activation_id=imported.dns_zone_activation_id
                    AND job.activation_generation=imported.activation_generation
                    AND job.expected_health_generation=health.health_generation
                  GROUP BY heartbeat.last_successful_tick_at,
                           heartbeat.freshness_threshold_seconds`,
          values: [],
          readonly: true,
        });
        const row = result.rows[0];
        const activeRootCount = count(row?.active_root_count);
        const healthyRootCount = count(row?.healthy_root_count);
        const delayedJobCount = count(row?.delayed_job_count);
        const terminalJobCount = count(row?.terminal_job_count);
        const servingExpiry = unixSeconds(row?.earliest_serving_valid_until ?? null);
        const servingRemaining =
          row?.serving_remaining_seconds === null ? null : count(row?.serving_remaining_seconds);
        const threshold =
          row?.freshness_threshold_seconds === null
            ? null
            : count(row?.freshness_threshold_seconds);
        const lastTick = unixSeconds(row?.last_successful_tick_at ?? null);
        const earliest = unixSeconds(row?.earliest_health_valid_until ?? null);
        if (
          result.rows.length !== 1 ||
          activeRootCount === null ||
          healthyRootCount === null ||
          delayedJobCount === null ||
          terminalJobCount === null ||
          (row?.earliest_serving_valid_until !== null && servingExpiry === null) ||
          (row?.serving_remaining_seconds !== null && servingRemaining === null) ||
          healthyRootCount > activeRootCount ||
          (row?.freshness_threshold_seconds !== null && threshold === null) ||
          (row?.last_successful_tick_at !== null && lastTick === null) ||
          (row?.earliest_health_valid_until !== null && earliest === null)
        ) {
          return yield* new HnsEdgeStatusFailed({ reason: "storage-unavailable" });
        }
        return {
          last_successful_tick_unix_seconds: lastTick,
          freshness_threshold_seconds: threshold,
          active_root_count: activeRootCount,
          healthy_root_count: healthyRootCount,
          delayed_job_count: delayedJobCount,
          terminal_job_count: terminalJobCount,
          earliest_serving_valid_until_unix_seconds: servingExpiry,
          serving_remaining_seconds: servingRemaining,
          earliest_health_valid_until_unix_seconds: earliest,
        };
      }).pipe(
        Effect.provide(runtime),
        Effect.mapError(() => new HnsEdgeStatusFailed({ reason: "storage-unavailable" })),
      ),
  };
}
