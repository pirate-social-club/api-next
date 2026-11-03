/** Longest chain of expired recoveries a verified recovery may walk back through.
 * Generations strictly decrease at each hop, so a cycle is impossible; this bound
 * only keeps the walk finite and makes a longer chain a human review. */
const HNS_EXPIRED_RECOVERY_MAX_HOPS = 8;

/** Lateral subquery yielding the original expiry transition behind the session
 * alias, or no row. A hop is only followed through a real, unused, expired
 * recovery of the same principal, provider and root: its reservation, terminal
 * document and timing all have to match, or the walk stops without an origin. */
export function hnsExpiredRecoveryOriginSql(
  session: string,
  maxHops = HNS_EXPIRED_RECOVERY_MAX_HOPS,
) {
  if (!/^[a-z_]+$/u.test(session) || !Number.isSafeInteger(maxHops) || maxHops < 0)
    throw new Error("invalid expired recovery lineage input");
  return `WITH RECURSIVE lineage(route_revalidation_id,revalidation_session_id,hop) AS (
         SELECT ${session}.route_revalidation_id,${session}.revalidation_session_id,0
         UNION ALL
         SELECT prior.route_revalidation_id,prior.revalidation_session_id,lineage.hop+1
         FROM lineage
         JOIN community_route_revalidation_sessions child
           ON child.route_revalidation_id=lineage.route_revalidation_id
           AND child.revalidation_session_id=lineage.revalidation_session_id
         JOIN community_route_revalidation_completion_attempts expired
           ON expired.route_revalidation_attempt_id=child.recovery_authority_reference
         JOIN community_route_revalidation_sessions prior
           ON prior.route_revalidation_id=expired.route_revalidation_id
           AND prior.revalidation_session_id=expired.revalidation_session_id
           AND prior.route_binding_id=expired.route_binding_id
           AND prior.expected_binding_generation=expired.expected_binding_generation
         JOIN community_route_revalidation_start_reservations reservation
           ON reservation.route_revalidation_id=prior.route_revalidation_id
           AND reservation.revalidation_session_id=prior.revalidation_session_id
           AND reservation.fence_token=prior.start_fence_token
           AND reservation.state='finalized'
           AND ROW(reservation.community_id,reservation.route_binding_id,
             reservation.principal_kind,reservation.principal_id,
             reservation.expected_binding_generation,reservation.requirement_hash,
             reservation.start_request_hash,reservation.provider_id,
             reservation.provider_binding_hash,reservation.provider_configuration_kind,
             reservation.provider_configuration_reference,reservation.provider_configuration_version,
             reservation.protocol_version,reservation.environment,reservation.family,
             reservation.root_label,reservation.root_label_display,reservation.path_segment,
             reservation.operation_mode,reservation.start_idempotency_key,
             reservation.recovery_authority_kind,reservation.recovery_authority_reference,
             reservation.public_start_hash,reservation.provider_start_hash,
             reservation.provider_configuration_digest,reservation.challenge_expires_at)
           = ROW(prior.community_id,prior.route_binding_id,
             prior.principal_kind,prior.principal_id,
             prior.expected_binding_generation,prior.requirement_hash,
             prior.start_request_hash,prior.provider_id,
             prior.provider_binding_hash,prior.provider_configuration_kind,
             prior.provider_configuration_reference,prior.provider_configuration_version,
             prior.protocol_version,prior.environment,prior.family,
             prior.root_label,prior.root_label_display,prior.path_segment,
             prior.operation_mode,prior.start_idempotency_key,
             prior.recovery_authority_kind,prior.recovery_authority_reference,
             prior.public_start_hash,prior.provider_start_hash,
             prior.provider_configuration_digest,prior.challenge_expires_at)
         WHERE lineage.hop<${maxHops}
           AND child.recovery_authority_kind='owner_recovery_terminal'
           AND expired.operation_mode='same_root_recovery'
           AND expired.state='consumed' AND expired.consumption_kind='session_expired'
           AND expired.expected_verified_evidence_ref IS NULL
           AND expired.terminal_at>=prior.challenge_expires_at
           AND expired.terminal_at<=prior.terminal_at
           AND prior.terminal_at<=child.started_at
           AND expired.provider_response_sha256 IS NULL
           AND expired.raw_provider_response_bytes IS NULL
           AND prior.status='expired' AND prior.operation_mode='same_root_recovery'
           AND prior.recovery_authority_kind IN
             ('database_time_expiry_transition','owner_recovery_terminal')
           AND prior.expected_verified_evidence_ref IS NULL
           AND reservation.expected_verified_evidence_ref IS NULL
           AND prior.expected_binding_generation+1=child.expected_binding_generation
           AND prior.expires_at=prior.challenge_expires_at
           AND prior.started_at=prior.challenge_expires_at-INTERVAL '1 hour'
           AND ROW(prior.community_id,prior.route_binding_id,prior.principal_kind,
             prior.principal_id,prior.provider_id,prior.provider_binding_hash,
             prior.provider_configuration_kind,prior.provider_configuration_reference,
             prior.provider_configuration_version,prior.provider_configuration_digest,
             prior.protocol_version,prior.environment,prior.family,prior.root_label,
             prior.root_label_display,prior.path_segment)
           = ROW(child.community_id,child.route_binding_id,child.principal_kind,
             child.principal_id,child.provider_id,child.provider_binding_hash,
             child.provider_configuration_kind,child.provider_configuration_reference,
             child.provider_configuration_version,child.provider_configuration_digest,
             child.protocol_version,child.environment,child.family,child.root_label,
             child.root_label_display,child.path_segment)
           AND validate_hns_owner_recovery_terminal_document(
             expired.terminal_result_document,expired.result_hash,expired.terminal_result_version,
             expired.route_revalidation_id,expired.revalidation_session_id,
             expired.route_revalidation_attempt_id,expired.route_binding_id,
             expired.expected_binding_generation,expired.idempotency_key,
             expired.completion_request_hash,'session_expired')
       )
       SELECT origin.recovery_authority_reference AS transition_id,
         origin.expected_binding_generation AS expiry_generation
       FROM lineage
       JOIN community_route_revalidation_sessions origin
         ON origin.route_revalidation_id=lineage.route_revalidation_id
         AND origin.revalidation_session_id=lineage.revalidation_session_id
       WHERE origin.recovery_authority_kind='database_time_expiry_transition'`;
}
