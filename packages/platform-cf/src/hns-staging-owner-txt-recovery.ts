import type { Client } from "pg";
import {
  decodeHnsStagingOwnerTxtReview,
  type HnsStagingOwnerTxtRecovery,
  HnsStagingOwnerTxtRefusal,
} from "./hns-staging-owner-txt-review.ts";

/** Read only the current creator recovery and its actual expiry predecessor.
 * Acquire community then route before the caller takes import/DNS and app/sale
 * locks, matching the owner-recovery writer's outer serialization boundary. */
export async function readHnsStagingOwnerTxtRecovery(
  client: Client,
  input: {
    readonly review: unknown;
    readonly root_import_session_id: string;
    readonly lock: boolean;
  },
): Promise<HnsStagingOwnerTxtRecovery> {
  const review = decodeHnsStagingOwnerTxtReview(input.review);
  return readCurrentHnsStagingOwnerRecovery(client, {
    ...review,
    root_import_session_id: input.root_import_session_id,
    lock: input.lock,
  });
}

/** Same immutable creator/provider/expiry lineage as owner-TXT adoption, also
 * available after adoption for a later reviewed staging profile successor. */
export async function readCurrentHnsStagingOwnerRecovery(
  client: Client,
  input: {
    readonly community_id: string;
    readonly route_binding_id: string;
    readonly root_import_session_id: string;
    readonly lock: boolean;
  },
): Promise<HnsStagingOwnerTxtRecovery> {
  const review = input;
  if (input.lock) {
    await client.query("SELECT 1 FROM communities WHERE community_id=$1 FOR UPDATE", [
      review.community_id,
    ]);
    await client.query(
      `SELECT 1 FROM community_canonical_route_bindings
        WHERE community_id=$1 AND route_binding_id=$2 FOR UPDATE`,
      [review.community_id, review.route_binding_id],
    );
  }
  const result = await client.query<HnsStagingOwnerTxtRecovery>(
    `SELECT c.community_id, b.route_binding_id, b.binding_generation,
       e.evidence_ref, attempt.route_revalidation_attempt_id AS recovery_attempt_id,
       activation.dns_zone_activation_id,
       app.app_host_activation_id, app.current_generation AS app_generation,
       sale.sale_namespace_activation_id, sale.current_generation AS sale_generation,
       b.root_label, previous_control.expected_txt_value_sha256 AS previous_txt_sha256,
       control.expected_txt_value_sha256 AS txt_sha256,
       LEAST(e.expires_at, snapshot.expires_at) AS expires_at
     FROM communities c
     JOIN community_canonical_route_bindings b
       ON b.community_id=c.community_id AND b.route_binding_id=c.canonical_route_binding_id
     JOIN community_route_ownership_evidence e
       ON e.evidence_ref=b.verified_evidence_ref AND e.binding_generation=b.binding_generation
       AND e.origin='route_revalidation' AND e.verified_by_actor_id=c.created_by_user_id
       AND e.family=b.family AND e.root_label=b.root_label
       AND e.root_label_display=b.root_label_display AND e.path_segment=b.path_segment
     JOIN community_route_revalidation_completion_attempts attempt
       ON attempt.route_revalidation_attempt_id=e.route_revalidation_attempt_id
       AND attempt.evidence_ref=e.evidence_ref AND attempt.route_binding_id=b.route_binding_id
       AND attempt.expected_binding_generation+1=b.binding_generation
       AND attempt.operation_mode='same_root_recovery'
       AND attempt.state='consumed' AND attempt.consumption_kind='verified'
     JOIN community_route_revalidation_sessions session
       ON session.route_revalidation_id=attempt.route_revalidation_id
       AND session.revalidation_session_id=attempt.revalidation_session_id
       AND session.community_id=c.community_id AND session.route_binding_id=b.route_binding_id
       AND session.expected_binding_generation=attempt.expected_binding_generation
       AND session.operation_mode='same_root_recovery' AND session.status='completed'
       AND session.principal_kind='user' AND session.principal_id=c.created_by_user_id
       AND session.environment='staging' AND session.provider_id='hns.owner.v1'
       AND session.recovery_authority_kind='database_time_expiry_transition'
       AND session.family=b.family AND session.root_label=b.root_label
       AND session.root_label_display=b.root_label_display AND session.path_segment=b.path_segment
     JOIN community_route_revalidation_evidence_snapshots snapshot
       ON snapshot.evidence_ref=e.evidence_ref
       AND snapshot.route_revalidation_attempt_id=attempt.route_revalidation_attempt_id
       AND snapshot.route_revalidation_id=session.route_revalidation_id
       AND snapshot.revalidation_session_id=session.revalidation_session_id
       AND snapshot.community_id=c.community_id AND snapshot.route_binding_id=b.route_binding_id
       AND snapshot.expected_binding_generation=session.expected_binding_generation
       AND snapshot.binding_generation=b.binding_generation
       AND snapshot.operation_mode='same_root_recovery' AND snapshot.environment='staging'
       AND snapshot.recovery_authority_kind=session.recovery_authority_kind
       AND snapshot.recovery_authority_reference=session.recovery_authority_reference
       AND snapshot.principal_kind=session.principal_kind AND snapshot.principal_id=session.principal_id
       AND snapshot.provider_id=e.provider_id AND snapshot.provider_binding_hash=e.provider_binding_hash
       AND snapshot.provider_configuration_version=e.provider_configuration_version
       AND snapshot.provider_identity_digest=e.provider_identity_digest
       AND snapshot.evidence_digest=e.evidence_digest
       AND snapshot.provider_id=session.provider_id AND snapshot.provider_binding_hash=session.provider_binding_hash
       AND snapshot.provider_configuration_kind=session.provider_configuration_kind
       AND snapshot.provider_configuration_reference=session.provider_configuration_reference
       AND snapshot.provider_configuration_version=session.provider_configuration_version
       AND snapshot.provider_configuration_digest=session.provider_configuration_digest
       AND snapshot.family=b.family AND snapshot.root_label=b.root_label
       AND snapshot.root_label_display=b.root_label_display AND snapshot.path_segment=b.path_segment
       AND snapshot.public_start_hash=session.public_start_hash
       AND snapshot.provider_start_hash=session.provider_start_hash
       AND snapshot.challenge_expires_at=session.challenge_expires_at
       AND snapshot.ownership_source='hns_parent_chain_txt'
       AND snapshot.challenge_name=b.root_label
       AND snapshot.root_exists AND snapshot.root_control_verified AND snapshot.expiry_horizon_sufficient
     JOIN community_route_hns_control_identities control
       ON control.evidence_ref=e.evidence_ref AND control.root_label=b.root_label
       AND control.ownership_source=snapshot.ownership_source AND control.txt_name=snapshot.challenge_name
       AND control.expected_txt_value_sha256=snapshot.challenge_value_sha256
       AND control.provider_evidence_ref=snapshot.provider_evidence_ref
     JOIN community_route_lifecycle_transitions transition
       ON transition.route_lifecycle_transition_id=session.recovery_authority_reference
       AND transition.transition_kind='database_time_expired'
       AND transition.community_id=c.community_id AND transition.route_binding_id=b.route_binding_id
       AND transition.resulting_binding_generation=session.expected_binding_generation
       AND transition.family=b.family AND transition.root_label=b.root_label
       AND transition.root_label_display=b.root_label_display AND transition.path_segment=b.path_segment
     JOIN community_route_ownership_evidence previous
       ON previous.evidence_ref=transition.expected_verified_evidence_ref
       AND previous.binding_generation=transition.expected_binding_generation
       AND previous.family=b.family AND previous.root_label=b.root_label
       AND previous.root_label_display=b.root_label_display AND previous.path_segment=b.path_segment
       AND previous.provider_id=e.provider_id AND previous.provider_binding_hash=e.provider_binding_hash
       AND previous.provider_configuration_version=e.provider_configuration_version
       AND previous.expires_at=transition.observed_evidence_expires_at
     JOIN community_route_hns_control_identities previous_control
       ON previous_control.evidence_ref=previous.evidence_ref
       AND previous_control.root_label=b.root_label AND previous_control.txt_name=b.root_label
       AND previous_control.ownership_source='hns_parent_chain_txt'
     JOIN hns_root_import_activation_operations activation ON activation.root_import_session_id=$3
     JOIN hns_community_app_host_activation_current app
       ON app.app_host_activation_id=activation.app_host_activation_id
     JOIN hns_community_app_host_activation_revisions app_revision
       ON app_revision.app_host_activation_id=app.app_host_activation_id
       AND app_revision.app_host_activation_generation=app.current_generation
       AND app_revision.community_id=c.community_id AND app_revision.canonical_root=b.root_label
       AND app_revision.route_binding_id=b.route_binding_id
       AND app_revision.route_authority_kind='verified_namespace_v1'
     JOIN community_handle_sale_namespace_activation_current sale
       ON sale.sale_namespace_activation_id=activation.sale_namespace_activation_id
     JOIN community_handle_sale_namespace_activation_revisions sale_revision
       ON sale_revision.sale_namespace_activation_id=sale.sale_namespace_activation_id
       AND sale_revision.sale_namespace_activation_generation=sale.current_generation
       AND sale_revision.community_id=c.community_id
       AND sale_revision.namespace_authority_kind='verified_namespace_v1'
     WHERE c.community_id=$1 AND b.route_binding_id=$2 AND c.status='active'
       AND b.family='hns' AND b.route_authority_kind='verified_namespace_v1'
       AND b.ownership_status='verified' AND b.route_lifecycle_status='active'
       AND e.verified_at<=clock_timestamp() AND e.expires_at>clock_timestamp()
       AND snapshot.expires_at>clock_timestamp()
       AND (
         (app_revision.route_authority_reference=e.evidence_ref
           AND app_revision.route_authority_generation=b.binding_generation
           AND sale_revision.namespace_authority_reference=e.evidence_ref
           AND sale_revision.namespace_authority_generation=b.binding_generation)
         OR
         (app_revision.route_authority_reference=previous.evidence_ref
           AND app_revision.route_authority_generation=previous.binding_generation
           AND sale_revision.namespace_authority_reference=previous.evidence_ref
           AND sale_revision.namespace_authority_generation=previous.binding_generation
           AND sale_revision.dns_zone_activation_id=app_revision.dns_zone_activation_id
           AND sale_revision.dns_zone_activation_generation=app_revision.dns_zone_activation_generation
           AND EXISTS (
             SELECT 1 FROM hns_dns_zone_activation_current dns
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
             WHERE dns.dns_zone_activation_id=app_revision.dns_zone_activation_id
               AND dns.current_generation=app_revision.dns_zone_activation_generation
               AND dns.canonical_root=b.root_label
               AND LEAST(health.valid_until,inventory.expires_at)<=clock_timestamp()
           ))
       )`,
    [review.community_id, review.route_binding_id, input.root_import_session_id],
  );
  const proof = result.rows[0];
  if (result.rows.length !== 1 || proof === undefined)
    throw new HnsStagingOwnerTxtRefusal(
      "the current staging owner TXT recovery lineage is unavailable",
    );
  return proof;
}
