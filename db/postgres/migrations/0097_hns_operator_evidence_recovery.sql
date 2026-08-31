-- Permit recovery of an expired HNS route whose accepted authority came from
-- the append-only operator-control promotion receipt. Ordinary ownership
-- evidence continues to require a registered observer configuration.

CREATE OR REPLACE FUNCTION guard_hns_owner_recovery_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ := date_trunc('milliseconds', clock_timestamp());
  community_record communities%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  transition_record community_route_lifecycle_transitions%ROWTYPE;
  prior_attempt community_route_revalidation_completion_attempts%ROWTYPE;
  prior_session community_route_revalidation_sessions%ROWTYPE;
  renewal_attempt community_route_active_lease_renewal_attempts%ROWTYPE;
  renewal_record community_route_active_lease_renewals%ROWTYPE;
  provider_authority_exists BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'owner recovery start reservations cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
    NEW.challenge_expires_at := db_now + INTERVAL '1 hour';
    SELECT * INTO community_record FROM communities
     WHERE community_id = NEW.community_id FOR UPDATE;
    SELECT * INTO binding_record FROM community_canonical_route_bindings
     WHERE route_binding_id = NEW.route_binding_id
       AND community_id = NEW.community_id FOR UPDATE;
    SELECT (
      EXISTS (
        SELECT 1 FROM hns_control_observer_configurations
         WHERE provider_configuration_reference = NEW.provider_configuration_reference
           AND provider_configuration_version = NEW.provider_configuration_version
           AND provider_configuration_digest = NEW.provider_configuration_digest
      )
      OR EXISTS (
        SELECT 1
          FROM community_route_lifecycle_transitions AS transition
          JOIN community_route_ownership_evidence AS evidence
            ON evidence.evidence_ref = transition.expected_verified_evidence_ref
          JOIN hns_operator_control_promotion_receipts AS receipt
            ON receipt.receipt_id = evidence.operator_control_promotion_receipt_id
           AND receipt.evidence_ref = evidence.evidence_ref
          JOIN LATERAL (
            SELECT artifact,
                   convert_from(
                     decode(artifact ->> 'bytes_hex', 'hex'),
                     'UTF8'
                   )::jsonb AS value
              FROM jsonb_array_elements(
                     convert_from(receipt.candidate_bytes, 'UTF8')::jsonb -> 'artifacts'
                   ) AS artifact
             WHERE artifact ->> 'name' = 'observer_evidence'
          ) AS observer ON TRUE
         WHERE NEW.recovery_authority_kind = 'database_time_expiry_transition'
           AND transition.route_lifecycle_transition_id = NEW.recovery_authority_reference
           AND transition.community_id = NEW.community_id
           AND transition.route_binding_id = NEW.route_binding_id
           AND transition.resulting_binding_generation = NEW.expected_binding_generation
           AND evidence.origin = 'operator_control_observation'
           AND evidence.family = NEW.family
           AND evidence.root_label = NEW.root_label
           AND evidence.provider_id = NEW.provider_id
           AND evidence.provider_binding_hash = NEW.provider_binding_hash
           AND receipt.observer_evidence_sha256 = observer.artifact ->> 'sha256'
           AND receipt.observer_evidence_reference = observer.value ->> 'evidence_reference'
           AND observer.value ->> 'status' = 'verified'
           AND NEW.provider_configuration_kind = 'managed'
           AND observer.value ->> 'provider_configuration_reference'
                 = NEW.provider_configuration_reference
           AND observer.value ->> 'provider_configuration_version'
                 = NEW.provider_configuration_version
           AND observer.value ->> 'provider_configuration_digest'
                 = NEW.provider_configuration_digest
           AND observer.value ->> 'environment' = NEW.environment
      )
    ) INTO provider_authority_exists;
    IF community_record.community_id IS NULL
      OR community_record.status <> 'active'
      OR community_record.created_by_user_id IS DISTINCT FROM NEW.principal_id
      OR community_record.canonical_route_binding_id IS DISTINCT FROM NEW.route_binding_id
      OR binding_record.route_binding_id IS NULL
      OR binding_record.binding_generation IS DISTINCT FROM NEW.expected_binding_generation
      OR binding_record.verified_evidence_ref IS NOT NULL
      OR binding_record.route_lifecycle_status <> 'suspended'
      OR binding_record.family IS DISTINCT FROM NEW.family
      OR binding_record.root_label IS DISTINCT FROM NEW.root_label
      OR binding_record.root_label_display IS DISTINCT FROM NEW.root_label_display
      OR binding_record.path_segment IS DISTINCT FROM NEW.path_segment
      OR NEW.provider_id <> 'hns.owner.v1'
      OR NOT provider_authority_exists
      OR NEW.state <> 'acquired'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= db_now
    THEN
      RAISE EXCEPTION 'owner recovery reservation does not match creator and route authority';
    END IF;
    NEW.lease_expires_at := db_now + INTERVAL '8 seconds';

    IF NEW.recovery_authority_kind = 'database_time_expiry_transition' THEN
      SELECT * INTO transition_record FROM community_route_lifecycle_transitions
       WHERE route_lifecycle_transition_id = NEW.recovery_authority_reference
       FOR SHARE;
      IF transition_record.route_lifecycle_transition_id IS NULL
        OR transition_record.transition_kind <> 'database_time_expired'
        OR transition_record.community_id IS DISTINCT FROM NEW.community_id
        OR transition_record.route_binding_id IS DISTINCT FROM NEW.route_binding_id
        OR transition_record.resulting_binding_generation
             IS DISTINCT FROM NEW.expected_binding_generation
      THEN RAISE EXCEPTION 'owner recovery lacks its database-expiry authority'; END IF;
    ELSIF NEW.recovery_authority_kind IN (
      'route_revalidation_terminal', 'owner_recovery_terminal'
    ) THEN
      SELECT * INTO prior_attempt FROM community_route_revalidation_completion_attempts
       WHERE route_revalidation_attempt_id = NEW.recovery_authority_reference
       FOR SHARE;
      SELECT * INTO prior_session FROM community_route_revalidation_sessions
       WHERE route_revalidation_id = prior_attempt.route_revalidation_id
         AND revalidation_session_id = prior_attempt.revalidation_session_id
       FOR SHARE;
      IF prior_attempt.route_revalidation_attempt_id IS NULL
        OR prior_attempt.state <> 'consumed'
        OR prior_attempt.route_binding_id IS DISTINCT FROM NEW.route_binding_id
        OR prior_attempt.expected_binding_generation + 1
             IS DISTINCT FROM NEW.expected_binding_generation
        OR prior_session.community_id IS DISTINCT FROM NEW.community_id
        OR prior_session.provider_id IS DISTINCT FROM NEW.provider_id
        OR prior_session.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
        OR prior_session.provider_configuration_kind
             IS DISTINCT FROM NEW.provider_configuration_kind
        OR prior_session.provider_configuration_reference
             IS DISTINCT FROM NEW.provider_configuration_reference
        OR prior_session.provider_configuration_version
             IS DISTINCT FROM NEW.provider_configuration_version
        OR prior_session.environment IS DISTINCT FROM NEW.environment
        OR (
          NEW.recovery_authority_kind = 'owner_recovery_terminal'
          AND prior_session.operation_mode <> 'same_root_recovery'
        )
        OR (
          NEW.recovery_authority_kind = 'route_revalidation_terminal'
          AND prior_session.operation_mode <> 'system_revalidation'
        )
      THEN RAISE EXCEPTION 'owner recovery lacks its revalidation authority'; END IF;
    ELSE
      SELECT * INTO renewal_attempt FROM community_route_active_lease_renewal_attempts
       WHERE active_lease_renewal_attempt_id = NEW.recovery_authority_reference
       FOR SHARE;
      SELECT * INTO renewal_record FROM community_route_active_lease_renewals
       WHERE active_lease_renewal_id = renewal_attempt.active_lease_renewal_id
       FOR SHARE;
      IF renewal_attempt.active_lease_renewal_attempt_id IS NULL
        OR renewal_attempt.state <> 'consumed'
        OR renewal_attempt.route_binding_id IS DISTINCT FROM NEW.route_binding_id
        OR renewal_attempt.expected_binding_generation + 1
             IS DISTINCT FROM NEW.expected_binding_generation
        OR renewal_record.community_id IS DISTINCT FROM NEW.community_id
        OR renewal_record.provider_id IS DISTINCT FROM NEW.provider_id
        OR renewal_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
        OR renewal_record.provider_configuration_kind
             IS DISTINCT FROM NEW.provider_configuration_kind
        OR renewal_record.provider_configuration_reference
             IS DISTINCT FROM NEW.provider_configuration_reference
        OR renewal_record.provider_configuration_version
             IS DISTINCT FROM NEW.provider_configuration_version
        OR renewal_record.provider_configuration_digest
             IS DISTINCT FROM NEW.provider_configuration_digest
        OR renewal_record.environment IS DISTINCT FROM NEW.environment
      THEN RAISE EXCEPTION 'owner recovery lacks its active-renewal authority'; END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.route_revalidation_id, NEW.revalidation_session_id, NEW.community_id,
    NEW.route_binding_id, NEW.principal_kind, NEW.principal_id,
    NEW.expected_binding_generation, NEW.expected_verified_evidence_ref,
    NEW.requirement_hash, NEW.provider_id, NEW.provider_binding_hash,
    NEW.provider_configuration_kind, NEW.provider_configuration_reference,
    NEW.provider_configuration_version, NEW.protocol_version, NEW.environment,
    NEW.family, NEW.root_label, NEW.root_label_display, NEW.path_segment,
    NEW.start_request_hash, NEW.operation_mode, NEW.start_reservation_id,
    NEW.start_idempotency_key, NEW.recovery_authority_kind,
    NEW.recovery_authority_reference, NEW.public_start_hash,
    NEW.provider_configuration_digest, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.route_revalidation_id, OLD.revalidation_session_id, OLD.community_id,
    OLD.route_binding_id, OLD.principal_kind, OLD.principal_id,
    OLD.expected_binding_generation, OLD.expected_verified_evidence_ref,
    OLD.requirement_hash, OLD.provider_id, OLD.provider_binding_hash,
    OLD.provider_configuration_kind, OLD.provider_configuration_reference,
    OLD.provider_configuration_version, OLD.protocol_version, OLD.environment,
    OLD.family, OLD.root_label, OLD.root_label_display, OLD.path_segment,
    OLD.start_request_hash, OLD.operation_mode, OLD.start_reservation_id,
    OLD.start_idempotency_key, OLD.recovery_authority_kind,
    OLD.recovery_authority_reference, OLD.public_start_hash,
    OLD.provider_configuration_digest, OLD.created_at
  ) THEN RAISE EXCEPTION 'owner recovery start authority is immutable'; END IF;

  IF OLD.state = 'acquired' AND NEW.state = 'released'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.challenge_expires_at = OLD.challenge_expires_at
    AND NEW.provider_start_hash IS NULL
  THEN NEW.updated_at := db_now; RETURN NEW; END IF;
  IF OLD.state IN ('released', 'acquired') AND NEW.state = 'acquired'
    AND NEW.fence_token = OLD.fence_token + 1
    AND (OLD.state = 'released' OR OLD.lease_expires_at <= db_now)
    AND NEW.lease_expires_at > db_now
    AND NEW.provider_start_hash IS NULL
  THEN
    NEW.challenge_expires_at := db_now + INTERVAL '1 hour';
    NEW.lease_expires_at := db_now + INTERVAL '8 seconds';
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  IF OLD.state = 'acquired' AND NEW.state = 'finalized'
    AND OLD.lease_expires_at > db_now
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.challenge_expires_at = OLD.challenge_expires_at
    AND NEW.provider_start_hash ~ '^[0-9a-f]{64}$'
  THEN NEW.updated_at := db_now; RETURN NEW; END IF;
  RAISE EXCEPTION 'owner recovery start transition is not allowed';
END;
$$;
