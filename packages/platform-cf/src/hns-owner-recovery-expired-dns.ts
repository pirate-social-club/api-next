import type { ControlPlaneTransaction } from "@pirate/application";
import { Effect } from "effect";
import { hnsExpiredRecoveryOriginSql } from "./hns-owner-recovery-expired-lineage.ts";

/** Fresh staging ownership can be retained while its expired hosts remain
 * unavailable. Only the exact expired predecessor, reached directly or through
 * unused expired recoveries of the same principal and root, may wait for the
 * separately reviewed full DNS/health successor; this never restores serving. */
export const deferExpiredHnsRecoveryHosts = Effect.fn("deferExpiredHnsRecoveryHosts")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    community_id: string;
    route_binding_id: string;
    expected_binding_generation: number;
    evidence_ref: string;
    recovery_id: string;
  }>,
) {
  const result = yield* transaction.execute<{ defer: boolean }>({
    label: "hns-owner-recovery.expired-dns-predecessor",
    text: `SELECT TRUE AS defer
        FROM community_route_revalidation_sessions session
        JOIN LATERAL (
          ${hnsExpiredRecoveryOriginSql("session")}
        ) expiry_origin ON TRUE
        JOIN community_route_lifecycle_transitions transition
          ON transition.route_lifecycle_transition_id=expiry_origin.transition_id
          AND transition.transition_kind='database_time_expired'
          AND transition.community_id=session.community_id
          AND transition.route_binding_id=session.route_binding_id
          AND transition.resulting_binding_generation=expiry_origin.expiry_generation
        JOIN community_route_ownership_evidence previous
          ON previous.evidence_ref=transition.expected_verified_evidence_ref
          AND previous.binding_generation=transition.expected_binding_generation
          AND previous.family='hns' AND previous.root_label=session.root_label
        JOIN community_canonical_route_bindings binding
          ON binding.community_id=session.community_id AND binding.route_binding_id=session.route_binding_id
          AND binding.binding_generation=session.expected_binding_generation+1
          AND binding.verified_evidence_ref=$4 AND binding.ownership_status='verified'
          AND binding.route_lifecycle_status='active'
        JOIN hns_community_app_host_activation_revisions app
          ON app.community_id=session.community_id AND app.route_binding_id=session.route_binding_id
          AND app.canonical_root=session.root_label AND app.status='active'
          AND app.route_authority_kind='verified_namespace_v1'
          AND app.route_authority_reference=previous.evidence_ref
          AND app.route_authority_generation=previous.binding_generation
        JOIN hns_community_app_host_activation_current app_current
          ON app_current.app_host_activation_id=app.app_host_activation_id
          AND app_current.current_generation=app.app_host_activation_generation
        JOIN community_handle_sale_namespace_activation_revisions sale
          ON sale.community_id=session.community_id AND sale.family='hns'
          AND sale.canonical_root=session.root_label AND sale.status='active'
          AND sale.namespace_authority_kind='verified_namespace_v1'
          AND sale.namespace_authority_reference=previous.evidence_ref
          AND sale.namespace_authority_generation=previous.binding_generation
          AND sale.dns_zone_activation_id=app.dns_zone_activation_id
          AND sale.dns_zone_activation_generation=app.dns_zone_activation_generation
        JOIN community_handle_sale_namespace_activation_current sale_current
          ON sale_current.sale_namespace_activation_id=sale.sale_namespace_activation_id
          AND sale_current.current_generation=sale.sale_namespace_activation_generation
        JOIN hns_dns_zone_activation_current dns
          ON dns.dns_zone_activation_id=app.dns_zone_activation_id
          AND dns.current_generation=app.dns_zone_activation_generation
          AND dns.canonical_root=session.root_label
        JOIN hns_dns_zone_activation_revisions revision
          ON revision.dns_zone_activation_id=dns.dns_zone_activation_id
          AND revision.dns_zone_activation_generation=dns.current_generation
          AND revision.status='active'
        JOIN hns_authority_inventories inventory
          ON inventory.authority_inventory_reference=revision.pirate_dns_authority_inventory_reference
          AND inventory.authority_inventory_version=revision.pirate_dns_authority_inventory_version
          AND inventory.authority_inventory_digest=revision.pirate_dns_authority_inventory_digest
          AND inventory.environment='staging'
        JOIN LATERAL (
          SELECT health.valid_until FROM hns_dns_zone_health_observations health
          WHERE health.dns_zone_activation_id=dns.dns_zone_activation_id
            AND health.activation_generation=dns.current_generation
          ORDER BY health.health_generation DESC LIMIT 1
        ) health ON TRUE
        WHERE session.community_id=$1 AND session.route_binding_id=$2
          AND session.expected_binding_generation=$3
          AND session.route_revalidation_id=$5 AND session.status='completed'
          AND session.operation_mode='same_root_recovery' AND session.environment='staging'
          AND LEAST(health.valid_until,inventory.expires_at)<=clock_timestamp()`,
    values: [
      input.community_id,
      input.route_binding_id,
      input.expected_binding_generation,
      input.evidence_ref,
      input.recovery_id,
    ],
    readonly: false,
  });
  return result.rows.length === 1 && result.rows[0]?.defer === true;
});
