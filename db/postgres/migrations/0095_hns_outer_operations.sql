-- HNS outer-operation persistence. Product bindings and HNS feature flags
-- remain disabled; this migration adds only durable operation authority.

ALTER TABLE community_creation_ceremony_results
  ADD COLUMN target_observation_contract_version TEXT,
  ADD COLUMN target_response_status TEXT,
  ADD COLUMN provider_response_sha256 TEXT,
  ADD COLUMN raw_provider_response_bytes BYTEA;

ALTER TABLE community_creation_ceremony_results
  ADD CONSTRAINT community_creation_ceremony_results_target_response_shape CHECK (
    (
      target_observation_contract_version IS NULL
      AND target_response_status IS NULL
      AND provider_response_sha256 IS NULL
      AND raw_provider_response_bytes IS NULL
    )
    OR (
      requirement_kind = 'namespace_ownership'
      AND outcome_status = 'failed'
      AND target_observation_contract_version = 'pirate-hns-target-observation-v3'
      AND target_response_status IN ('rejected', 'ineligible')
      AND provider_response_sha256 ~ '^[0-9a-f]{64}$'
      AND octet_length(raw_provider_response_bytes) BETWEEN 1 AND 1048576
      AND encode(sha256(raw_provider_response_bytes), 'hex') = provider_response_sha256
    )
  );

CREATE OR REPLACE FUNCTION validate_community_creation_ceremony_result_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
  completion_record namespace_ownership_completion_attempts%ROWTYPE;
  proof_record proof_sessions%ROWTYPE;
  receipt_record evidence_receipts%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_creation_ceremony_attempts
   WHERE ceremony_intent_id = NEW.ceremony_intent_id
   FOR SHARE;

  IF NOT FOUND
    OR NEW.actor_id <> attempt_record.actor_id
    OR NEW.intent_id <> attempt_record.intent_id
    OR NEW.requirement_kind <> attempt_record.requirement_kind
    OR NEW.generation <> attempt_record.generation
    OR NEW.requirement_hash <> attempt_record.requirement_hash
    OR NEW.provider_id <> attempt_record.provider_id
    OR NEW.provider_binding_hash <> attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version <> attempt_record.provider_configuration_version
  THEN
    RAISE EXCEPTION 'ceremony result does not match its immutable attempt';
  END IF;

  IF NEW.requirement_kind = 'namespace_ownership' THEN
    IF NEW.proof_session_id IS NOT NULL
      OR NEW.namespace_session_id IS NULL
      OR NEW.submission_channel <> 'poll_result'
      OR NEW.evidence_receipt_id IS NOT NULL
      OR (NEW.outcome_status <> 'expired' AND NEW.completion_attempt_id IS NULL)
    THEN
      RAISE EXCEPTION 'namespace ceremony result must use its poll completion authority';
    END IF;

    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
     FOR SHARE;
    IF NEW.completion_attempt_id IS NOT NULL THEN
      SELECT * INTO completion_record
        FROM namespace_ownership_completion_attempts
       WHERE completion_attempt_id = NEW.completion_attempt_id
       FOR SHARE;
    END IF;
    IF session_record.namespace_session_id IS NULL
      OR session_record.actor_id <> NEW.actor_id
      OR session_record.creation_intent_id <> NEW.intent_id
      OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
      OR session_record.generation <> NEW.generation
      OR session_record.requirement_hash <> NEW.requirement_hash
      OR session_record.provider_id <> NEW.provider_id
      OR session_record.provider_binding_hash <> NEW.provider_binding_hash
      OR session_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR (
        NEW.completion_attempt_id IS NOT NULL
        AND (
          completion_record.completion_attempt_id IS NULL
          OR completion_record.namespace_session_id <> session_record.namespace_session_id
          OR completion_record.actor_id <> NEW.actor_id
          OR completion_record.submission_channel <> 'poll_result'
          OR completion_record.state <> 'consumed'
          OR completion_record.consumption_kind IS DISTINCT FROM CASE NEW.outcome_status
            WHEN 'satisfied' THEN 'verified'
            WHEN 'failed' THEN 'rejected'
            WHEN 'expired' THEN 'expired'
            ELSE NULL
          END
          OR NEW.callback_idempotency_key <> completion_record.idempotency_key
          OR NEW.callback_request_hash <> completion_record.completion_request_hash
        )
      )
    THEN
      RAISE EXCEPTION 'namespace ceremony result does not match its session and attempt';
    END IF;

    IF NEW.target_observation_contract_version IS NOT NULL THEN
      IF session_record.provider_configuration_version <> 'hns-observer-config-v2'
        OR NEW.target_observation_contract_version <> 'pirate-hns-target-observation-v3'
        OR NEW.target_response_status NOT IN ('rejected', 'ineligible')
        OR NEW.outcome_status <> 'failed'
      THEN
        RAISE EXCEPTION 'namespace target response does not match its versioned session authority';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.target_observation_contract_version IS NOT NULL
    OR NEW.target_response_status IS NOT NULL
    OR NEW.provider_response_sha256 IS NOT NULL
    OR NEW.raw_provider_response_bytes IS NOT NULL
  THEN
    RAISE EXCEPTION 'human ceremony result cannot retain an HNS target response';
  END IF;

  IF NEW.namespace_session_id IS NOT NULL
    OR NEW.completion_attempt_id IS NOT NULL
    OR NEW.submission_channel IS NOT NULL
  THEN
    RAISE EXCEPTION 'human ceremony result cannot use namespace ownership columns';
  END IF;

  IF NEW.requirement_kind = 'human_identity'
    AND NEW.outcome_status = 'satisfied'
    AND NEW.proof_session_id IS NULL
  THEN
    RAISE EXCEPTION 'satisfied human ceremony requires its proof session';
  END IF;

  IF NEW.proof_session_id IS NOT NULL THEN
    SELECT * INTO proof_record
      FROM proof_sessions
     WHERE proof_session_id = NEW.proof_session_id;
    IF NOT FOUND
      OR proof_record.actor_id <> NEW.actor_id
      OR proof_record.creation_ceremony_intent_id <> NEW.ceremony_intent_id
      OR proof_record.provider_id <> NEW.provider_id
      OR proof_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR proof_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR proof_record.provider_configuration_version <> attempt_record.provider_configuration_version
    THEN
      RAISE EXCEPTION 'ceremony result proof session does not match its attempt';
    END IF;
  END IF;

  IF NEW.evidence_receipt_id IS NOT NULL THEN
    SELECT * INTO receipt_record
      FROM evidence_receipts
     WHERE evidence_receipt_id = NEW.evidence_receipt_id;
    IF NOT FOUND
      OR NEW.proof_session_id IS NULL
      OR receipt_record.proof_session_id <> NEW.proof_session_id
      OR receipt_record.user_id <> NEW.actor_id
      OR receipt_record.provider_id <> NEW.provider_id
      OR receipt_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR receipt_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR receipt_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR receipt_record.evidence_hash <> NEW.evidence_digest
    THEN
      RAISE EXCEPTION 'ceremony result evidence receipt does not match its attempt';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TABLE community_route_hns_control_identities (
  evidence_ref TEXT PRIMARY KEY,
  ownership_source TEXT NOT NULL CHECK (
    ownership_source IN ('hns_parent_chain_txt', 'owner_authoritative_dns_txt')
  ),
  root_label TEXT NOT NULL,
  txt_name TEXT NOT NULL,
  expected_txt_value_sha256 TEXT NOT NULL CHECK (
    expected_txt_value_sha256 ~ '^[0-9a-f]{64}$'
  ),
  control_identity_digest TEXT NOT NULL CHECK (
    control_identity_digest ~ '^[0-9a-f]{64}$'
  ),
  chain_authority_digest TEXT NOT NULL CHECK (
    chain_authority_digest ~ '^[0-9a-f]{64}$'
  ),
  provider_evidence_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_hns_control_identities_evidence_fk
    FOREIGN KEY (evidence_ref)
    REFERENCES community_route_ownership_evidence (evidence_ref)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT community_route_hns_control_identities_identifiers CHECK (
    is_community_route_root_label('hns', root_label) IS TRUE
    AND btrim(txt_name) = txt_name
    AND octet_length(txt_name) BETWEEN 1 AND 255
    AND txt_name !~ '[[:cntrl:]]'
    AND btrim(provider_evidence_ref) = provider_evidence_ref
    AND octet_length(provider_evidence_ref) BETWEEN 1 AND 512
  ),
  CONSTRAINT community_route_hns_control_identities_name_shape CHECK (
    (ownership_source = 'hns_parent_chain_txt' AND txt_name = root_label)
    OR (
      ownership_source = 'owner_authoritative_dns_txt'
      AND txt_name = '_pirate.' || root_label
    )
  )
);

CREATE OR REPLACE FUNCTION validate_community_route_hns_control_identity_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  creation_snapshot namespace_ownership_evidence_snapshots%ROWTYPE;
  recovery_snapshot community_route_revalidation_evidence_snapshots%ROWTYPE;
  matching_snapshots INTEGER := 0;
BEGIN
  SELECT * INTO creation_snapshot
    FROM namespace_ownership_evidence_snapshots
   WHERE evidence_ref = NEW.evidence_ref
   FOR SHARE;
  IF FOUND THEN
    matching_snapshots := matching_snapshots + 1;
    IF creation_snapshot.root_label <> NEW.root_label
      OR creation_snapshot.ownership_source <> NEW.ownership_source
      OR creation_snapshot.challenge_name <> NEW.txt_name
      OR creation_snapshot.challenge_value_sha256 <> NEW.expected_txt_value_sha256
      OR creation_snapshot.provider_evidence_ref <> NEW.provider_evidence_ref
      OR creation_snapshot.observation ->> 'control_identity_digest'
           IS DISTINCT FROM NEW.control_identity_digest
      OR creation_snapshot.observation ->> 'chain_authority_digest'
           IS DISTINCT FROM NEW.chain_authority_digest
    THEN
      RAISE EXCEPTION 'HNS control identity does not match creation evidence';
    END IF;
  END IF;

  SELECT * INTO recovery_snapshot
    FROM community_route_revalidation_evidence_snapshots
   WHERE evidence_ref = NEW.evidence_ref
   FOR SHARE;
  IF FOUND THEN
    matching_snapshots := matching_snapshots + 1;
    IF recovery_snapshot.root_label <> NEW.root_label
      OR recovery_snapshot.ownership_source <> NEW.ownership_source
      OR recovery_snapshot.challenge_name <> NEW.txt_name
      OR recovery_snapshot.challenge_value_sha256 <> NEW.expected_txt_value_sha256
      OR recovery_snapshot.provider_evidence_ref <> NEW.provider_evidence_ref
      OR recovery_snapshot.observation ->> 'control_identity_digest'
           IS DISTINCT FROM NEW.control_identity_digest
      OR recovery_snapshot.observation ->> 'chain_authority_digest'
           IS DISTINCT FROM NEW.chain_authority_digest
    THEN
      RAISE EXCEPTION 'HNS control identity does not match recovery evidence';
    END IF;
  END IF;

  IF matching_snapshots <> 1 THEN
    RAISE EXCEPTION 'HNS control identity requires exactly one immutable evidence snapshot';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_hns_control_identity_insert_guard
BEFORE INSERT ON community_route_hns_control_identities
FOR EACH ROW
EXECUTE FUNCTION validate_community_route_hns_control_identity_insert();

CREATE TRIGGER community_route_hns_control_identities_immutable
BEFORE UPDATE OR DELETE ON community_route_hns_control_identities
FOR EACH ROW
EXECUTE FUNCTION reject_community_creation_immutable_change();

-- Challenge-shaped system revalidation remains byte-for-byte historical. The
-- owner branch adds explicit authority instead of reinterpreting those rows.
ALTER TABLE community_route_revalidation_start_reservations
  ADD COLUMN operation_mode TEXT NOT NULL DEFAULT 'system_revalidation',
  ADD COLUMN start_reservation_id TEXT,
  ADD COLUMN start_idempotency_key TEXT,
  ADD COLUMN recovery_authority_kind TEXT,
  ADD COLUMN recovery_authority_reference TEXT,
  ADD COLUMN public_start_hash TEXT,
  ADD COLUMN provider_start_hash TEXT,
  ADD COLUMN provider_configuration_digest TEXT,
  ADD COLUMN challenge_expires_at TIMESTAMPTZ;

ALTER TABLE community_route_revalidation_sessions
  ADD COLUMN operation_mode TEXT NOT NULL DEFAULT 'system_revalidation',
  ADD COLUMN start_idempotency_key TEXT,
  ADD COLUMN recovery_authority_kind TEXT,
  ADD COLUMN recovery_authority_reference TEXT,
  ADD COLUMN public_start_hash TEXT,
  ADD COLUMN provider_start_hash TEXT,
  ADD COLUMN provider_configuration_digest TEXT,
  ADD COLUMN challenge_expires_at TIMESTAMPTZ;

ALTER TABLE community_route_revalidation_completion_attempts
  ADD COLUMN operation_mode TEXT NOT NULL DEFAULT 'system_revalidation',
  ADD COLUMN observation_id TEXT,
  ADD COLUMN terminal_result_version TEXT,
  ADD COLUMN target_observation_contract_version TEXT,
  ADD COLUMN target_response_status TEXT,
  ADD COLUMN provider_response_sha256 TEXT,
  ADD COLUMN raw_provider_response_bytes BYTEA;

ALTER TABLE community_route_revalidation_evidence_snapshots
  ADD COLUMN operation_mode TEXT NOT NULL DEFAULT 'system_revalidation',
  ADD COLUMN recovery_authority_kind TEXT,
  ADD COLUMN recovery_authority_reference TEXT,
  ADD COLUMN public_start_hash TEXT,
  ADD COLUMN provider_start_hash TEXT,
  ADD COLUMN poll_hash TEXT,
  ADD COLUMN provider_configuration_digest TEXT,
  ADD COLUMN challenge_expires_at TIMESTAMPTZ,
  ADD COLUMN observation_contract_version TEXT;

ALTER TABLE community_route_revalidation_start_reservations
  DROP CONSTRAINT community_route_revalidation_start_reserva_principal_kind_check,
  DROP CONSTRAINT community_route_revalidation_start_reser_protocol_version_check,
  ADD CONSTRAINT community_route_revalidation_start_authority_branch CHECK (
    (
      operation_mode = 'system_revalidation'
      AND principal_kind = 'system'
      AND protocol_version = 'hns-txt-v1'
      AND start_reservation_id IS NULL
      AND start_idempotency_key IS NULL
      AND recovery_authority_kind IS NULL
      AND recovery_authority_reference IS NULL
      AND public_start_hash IS NULL
      AND provider_start_hash IS NULL
      AND provider_configuration_digest IS NULL
      AND challenge_expires_at IS NULL
    )
    OR (
      operation_mode = 'same_root_recovery'
      AND principal_kind = 'user'
      AND provider_id = 'hns.owner.v1'
      AND protocol_version = 'hns-owner-recovery-v1'
      AND expected_verified_evidence_ref IS NULL
      AND btrim(start_reservation_id) = start_reservation_id
      AND octet_length(start_reservation_id) BETWEEN 1 AND 256
      AND btrim(start_idempotency_key) = start_idempotency_key
      AND octet_length(start_idempotency_key) BETWEEN 1 AND 256
      AND recovery_authority_kind IN (
        'database_time_expiry_transition', 'route_revalidation_terminal',
        'active_lease_renewal_terminal', 'owner_recovery_terminal'
      )
      AND btrim(recovery_authority_reference) = recovery_authority_reference
      AND octet_length(recovery_authority_reference) BETWEEN 1 AND 512
      AND public_start_hash ~ '^[0-9a-f]{64}$'
      AND (
        (state IN ('acquired', 'released') AND provider_start_hash IS NULL)
        OR (state = 'finalized' AND provider_start_hash ~ '^[0-9a-f]{64}$')
      )
      AND provider_configuration_digest ~ '^[0-9a-f]{64}$'
      AND challenge_expires_at > created_at
    )
  );

-- A terminal owner recovery is an authority operation even when the newly
-- observed negative state is byte-for-byte equal to the already suspended
-- route. The consumed attempt is the one-shot proof permitting that exact
-- generation refresh; its expected generation prevents replay at the next
-- generation.
CREATE OR REPLACE FUNCTION guard_community_canonical_route_binding_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authority_changed BOOLEAN;
  operator_promotion BOOLEAN;
  owner_recovery_refresh BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'community canonical route binding is immutable';
  END IF;

  IF ROW(
    NEW.route_binding_id, NEW.community_id, NEW.family, NEW.root_label,
    NEW.root_label_display, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.route_binding_id, OLD.community_id, OLD.family, OLD.root_label,
    OLD.root_label_display, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'community canonical route identity is immutable';
  END IF;

  operator_promotion :=
    OLD.route_authority_kind = 'operator_managed_route_v1'
    AND OLD.authority_reference IS NOT NULL
    AND OLD.authority_generation IS NOT NULL
    AND NEW.route_authority_kind = 'verified_namespace_v1'
    AND NEW.authority_reference IS NULL
    AND NEW.authority_generation IS NULL
    AND OLD.route_lifecycle_status = 'active'
    AND NEW.route_lifecycle_status = 'active'
    AND OLD.ownership_status <> 'verified'
    AND OLD.verified_evidence_ref IS NULL
    AND NEW.ownership_status = 'verified'
    AND NEW.verified_evidence_ref IS NOT NULL;

  IF ROW(NEW.route_authority_kind, NEW.authority_reference)
       IS DISTINCT FROM ROW(OLD.route_authority_kind, OLD.authority_reference)
    AND NOT operator_promotion
  THEN
    RAISE EXCEPTION 'community canonical route identity is immutable';
  END IF;

  authority_changed := ROW(
    NEW.ownership_status, NEW.route_lifecycle_status, NEW.verified_evidence_ref,
    NEW.route_authority_kind, NEW.authority_reference, NEW.authority_generation
  ) IS DISTINCT FROM ROW(
    OLD.ownership_status, OLD.route_lifecycle_status, OLD.verified_evidence_ref,
    OLD.route_authority_kind, OLD.authority_reference, OLD.authority_generation
  );

  IF NOT authority_changed AND NEW.binding_generation = OLD.binding_generation + 1 THEN
    SELECT EXISTS (
      SELECT 1
        FROM community_route_revalidation_completion_attempts AS attempt
       WHERE attempt.operation_mode = 'same_root_recovery'
         AND attempt.route_binding_id = OLD.route_binding_id
         AND attempt.expected_binding_generation = OLD.binding_generation
         AND attempt.state = 'consumed'
         AND attempt.consumption_kind <> 'stale_cas'
         AND attempt.terminal_at IS NOT NULL
    ) INTO owner_recovery_refresh;
  END IF;

  IF authority_changed AND NEW.binding_generation <> OLD.binding_generation + 1 THEN
    RAISE EXCEPTION 'community canonical route generation must advance exactly once';
  END IF;
  IF NOT authority_changed
    AND NEW.binding_generation <> OLD.binding_generation
    AND NOT owner_recovery_refresh
  THEN
    RAISE EXCEPTION 'community canonical route generation cannot advance without authority change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE community_route_active_lease_renewals (
  active_lease_renewal_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  route_binding_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL DEFAULT 'system' CHECK (principal_kind = 'system'),
  principal_id TEXT NOT NULL,
  expected_binding_generation BIGINT NOT NULL CHECK (expected_binding_generation > 0),
  expected_verified_evidence_ref TEXT NOT NULL
    REFERENCES community_route_ownership_evidence (evidence_ref),
  expected_evidence_digest TEXT NOT NULL CHECK (expected_evidence_digest ~ '^[0-9a-f]{64}$'),
  expected_control_identity_digest TEXT NOT NULL CHECK (
    expected_control_identity_digest ~ '^[0-9a-f]{64}$'
  ),
  expected_chain_authority_digest TEXT NOT NULL CHECK (
    expected_chain_authority_digest ~ '^[0-9a-f]{64}$'
  ),
  prior_provider_evidence_ref TEXT NOT NULL,
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL CHECK (
    provider_configuration_kind IN ('managed', 'dynamic')
  ),
  provider_configuration_reference TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  provider_configuration_digest TEXT NOT NULL CHECK (
    provider_configuration_digest ~ '^[0-9a-f]{64}$'
  ),
  protocol_version TEXT NOT NULL DEFAULT 'hns-active-lease-renewal-v1' CHECK (
    protocol_version = 'hns-active-lease-renewal-v1'
  ),
  environment TEXT NOT NULL,
  family TEXT NOT NULL DEFAULT 'hns' CHECK (family = 'hns'),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'completed', 'failed')
  ),
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_active_lease_renewals_binding_fk
    FOREIGN KEY (route_binding_id, community_id)
    REFERENCES community_canonical_route_bindings (route_binding_id, community_id),
  CONSTRAINT community_route_active_lease_renewals_identity_shape CHECK (
    btrim(active_lease_renewal_id) = active_lease_renewal_id
    AND octet_length(active_lease_renewal_id) BETWEEN 1 AND 256
    AND btrim(principal_id) = principal_id
    AND octet_length(principal_id) BETWEEN 1 AND 256
    AND btrim(provider_id) = provider_id
    AND octet_length(provider_id) BETWEEN 1 AND 256
    AND btrim(provider_configuration_reference) = provider_configuration_reference
    AND octet_length(provider_configuration_reference) BETWEEN 1 AND 512
    AND btrim(provider_configuration_version) = provider_configuration_version
    AND octet_length(provider_configuration_version) BETWEEN 1 AND 128
    AND btrim(prior_provider_evidence_ref) = prior_provider_evidence_ref
    AND octet_length(prior_provider_evidence_ref) BETWEEN 1 AND 512
  ),
  CONSTRAINT community_route_active_lease_renewals_route_shape CHECK (
    is_community_route_root_label('hns', root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = 'app.' || root_label
  ),
  CONSTRAINT community_route_active_lease_renewals_lifecycle_shape CHECK (
    (status = 'pending' AND terminal_at IS NULL)
    OR (status IN ('completed', 'failed') AND terminal_at IS NOT NULL)
  ),
  CONSTRAINT community_route_active_lease_renewals_time_order CHECK (
    updated_at >= created_at AND (terminal_at IS NULL OR terminal_at >= created_at)
  ),
  UNIQUE (route_binding_id, expected_binding_generation),
  UNIQUE (active_lease_renewal_id, route_binding_id, expected_binding_generation)
);

CREATE TABLE community_route_active_lease_renewal_attempts (
  active_lease_renewal_attempt_id TEXT PRIMARY KEY,
  active_lease_renewal_id TEXT NOT NULL,
  route_binding_id TEXT NOT NULL,
  expected_binding_generation BIGINT NOT NULL CHECK (expected_binding_generation > 0),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  evidence_ref TEXT NOT NULL UNIQUE,
  observation_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'leased' CHECK (state IN ('leased', 'released', 'consumed')),
  fence_token BIGINT NOT NULL DEFAULT 1 CHECK (fence_token > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  consumption_kind TEXT CHECK (
    consumption_kind IN (
      'verified', 'root_absent', 'root_inactive', 'txt_absent',
      'txt_value_mismatch', 'control_identity_changed', 'chain_authority_changed',
      'expiry_horizon_insufficient', 'renewal_evidence_ineligible',
      'owner_authoritative_source_ineligible', 'lease_expired_before_commit', 'stale_cas'
    )
  ),
  terminal_result_version TEXT,
  terminal_result_document TEXT,
  result_hash TEXT CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  target_observation_contract_version TEXT,
  target_response_status TEXT,
  provider_response_sha256 TEXT CHECK (provider_response_sha256 ~ '^[0-9a-f]{64}$'),
  raw_provider_response_bytes BYTEA,
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_active_lease_renewal_attempts_operation_fk
    FOREIGN KEY (
      active_lease_renewal_id, route_binding_id, expected_binding_generation
    ) REFERENCES community_route_active_lease_renewals (
      active_lease_renewal_id, route_binding_id, expected_binding_generation
    ),
  CONSTRAINT community_route_active_lease_renewal_attempts_identity_shape CHECK (
    btrim(active_lease_renewal_attempt_id) = active_lease_renewal_attempt_id
    AND octet_length(active_lease_renewal_attempt_id) BETWEEN 1 AND 256
    AND btrim(idempotency_key) = idempotency_key
    AND octet_length(idempotency_key) BETWEEN 1 AND 256
    AND btrim(evidence_ref) = evidence_ref
    AND octet_length(evidence_ref) BETWEEN 1 AND 512
    AND btrim(observation_id) = observation_id
    AND octet_length(observation_id) BETWEEN 1 AND 256
  ),
  CONSTRAINT community_route_active_lease_renewal_attempts_result_shape CHECK (
    (
      state IN ('leased', 'released')
      AND consumption_kind IS NULL
      AND terminal_result_version IS NULL
      AND terminal_result_document IS NULL
      AND result_hash IS NULL
      AND target_observation_contract_version IS NULL
      AND target_response_status IS NULL
      AND provider_response_sha256 IS NULL
      AND raw_provider_response_bytes IS NULL
      AND terminal_at IS NULL
    )
    OR (
      state = 'consumed'
      AND consumption_kind IS NOT NULL
      AND terminal_result_version IN (
        'pirate-hns-active-lease-renewal-result-v2',
        'pirate-hns-active-lease-renewal-result-v3'
      )
      AND terminal_result_document IS NOT NULL
      AND result_hash IS NOT NULL
      AND terminal_at IS NOT NULL
      AND (
        (
          provider_response_sha256 IS NULL
          AND raw_provider_response_bytes IS NULL
          AND target_observation_contract_version IS NULL
          AND target_response_status IS NULL
        )
        OR (
          provider_response_sha256 IS NOT NULL
          AND octet_length(raw_provider_response_bytes) BETWEEN 1 AND 1048576
          AND encode(sha256(raw_provider_response_bytes), 'hex') = provider_response_sha256
          AND target_observation_contract_version IN (
            'pirate-hns-active-lease-renewal-response-v1',
            'pirate-hns-active-lease-renewal-response-v2'
          )
          AND target_response_status IN ('verified', 'rejected', 'ineligible')
        )
      )
    )
  ),
  CONSTRAINT community_route_active_lease_renewal_attempts_time_order CHECK (
    updated_at >= created_at AND (terminal_at IS NULL OR terminal_at >= created_at)
  ),
  UNIQUE (active_lease_renewal_id, idempotency_key),
  UNIQUE (active_lease_renewal_id, attempt_number)
);

CREATE INDEX community_route_active_lease_renewal_attempts_lease_idx
  ON community_route_active_lease_renewal_attempts (state, lease_expires_at);

CREATE TABLE community_route_active_lease_renewal_evidence_snapshots (
  evidence_ref TEXT PRIMARY KEY,
  active_lease_renewal_id TEXT NOT NULL,
  active_lease_renewal_attempt_id TEXT NOT NULL UNIQUE,
  community_id TEXT NOT NULL,
  route_binding_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL DEFAULT 'system' CHECK (principal_kind = 'system'),
  principal_id TEXT NOT NULL,
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  expected_binding_generation BIGINT NOT NULL CHECK (expected_binding_generation > 0),
  binding_generation BIGINT NOT NULL,
  expected_verified_evidence_ref TEXT NOT NULL,
  expected_evidence_digest TEXT NOT NULL CHECK (expected_evidence_digest ~ '^[0-9a-f]{64}$'),
  expected_control_identity_digest TEXT NOT NULL CHECK (
    expected_control_identity_digest ~ '^[0-9a-f]{64}$'
  ),
  expected_chain_authority_digest TEXT NOT NULL CHECK (
    expected_chain_authority_digest ~ '^[0-9a-f]{64}$'
  ),
  prior_provider_evidence_ref TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL CHECK (
    provider_configuration_kind IN ('managed', 'dynamic')
  ),
  provider_configuration_reference TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  provider_configuration_digest TEXT NOT NULL CHECK (
    provider_configuration_digest ~ '^[0-9a-f]{64}$'
  ),
  protocol_version TEXT NOT NULL DEFAULT 'hns-active-lease-renewal-v1' CHECK (
    protocol_version = 'hns-active-lease-renewal-v1'
  ),
  environment TEXT NOT NULL,
  family TEXT NOT NULL DEFAULT 'hns' CHECK (family = 'hns'),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  ownership_source TEXT NOT NULL CHECK (
    ownership_source IN ('hns_parent_chain_txt', 'owner_authoritative_dns_txt')
  ),
  txt_name TEXT NOT NULL,
  expected_txt_value_sha256 TEXT NOT NULL CHECK (
    expected_txt_value_sha256 ~ '^[0-9a-f]{64}$'
  ),
  control_identity_digest TEXT NOT NULL CHECK (control_identity_digest ~ '^[0-9a-f]{64}$'),
  chain_authority_digest TEXT NOT NULL CHECK (chain_authority_digest ~ '^[0-9a-f]{64}$'),
  root_exists BOOLEAN NOT NULL CHECK (root_exists IS TRUE),
  root_control_verified BOOLEAN NOT NULL CHECK (root_control_verified IS TRUE),
  expiry_horizon_sufficient BOOLEAN NOT NULL CHECK (expiry_horizon_sufficient IS TRUE),
  chain_network TEXT NOT NULL,
  chain_anchor_height BIGINT NOT NULL CHECK (chain_anchor_height >= 0),
  chain_anchor_block_hash TEXT NOT NULL CHECK (chain_anchor_block_hash ~ '^[0-9a-f]{64}$'),
  chain_anchor_median_time BIGINT NOT NULL CHECK (chain_anchor_median_time >= 0),
  expiry_height BIGINT NOT NULL CHECK (expiry_height >= 0),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  provider_evidence_ref TEXT NOT NULL,
  observer_result_sha256 TEXT NOT NULL CHECK (observer_result_sha256 ~ '^[0-9a-f]{64}$'),
  provider_response_sha256 TEXT NOT NULL CHECK (provider_response_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  response_document JSONB NOT NULL,
  raw_response_bytes BYTEA NOT NULL CHECK (
    octet_length(raw_response_bytes) BETWEEN 1 AND 1048576
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_active_lease_renewal_snapshots_attempt_fk
    FOREIGN KEY (active_lease_renewal_attempt_id)
    REFERENCES community_route_active_lease_renewal_attempts (
      active_lease_renewal_attempt_id
    ),
  CONSTRAINT community_route_active_lease_renewal_snapshots_operation_fk
    FOREIGN KEY (
      active_lease_renewal_id, route_binding_id, expected_binding_generation
    ) REFERENCES community_route_active_lease_renewals (
      active_lease_renewal_id, route_binding_id, expected_binding_generation
    ),
  CONSTRAINT community_route_active_lease_renewal_snapshots_generation CHECK (
    binding_generation = expected_binding_generation + 1
  ),
  CONSTRAINT community_route_active_lease_renewal_snapshots_route_shape CHECK (
    is_community_route_root_label('hns', root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = 'app.' || root_label
    AND (
      (ownership_source = 'hns_parent_chain_txt' AND txt_name = root_label)
      OR (
        ownership_source = 'owner_authoritative_dns_txt'
        AND txt_name = '_pirate.' || root_label
      )
    )
  ),
  CONSTRAINT community_route_active_lease_renewal_snapshots_response_shape CHECK (
    jsonb_typeof(response_document) = 'object'
    AND response_document ->> 'status' = 'verified'
    AND encode(sha256(raw_response_bytes), 'hex') = provider_response_sha256
  ),
  CONSTRAINT community_route_active_lease_renewal_snapshots_time_order CHECK (
    expires_at > observed_at AND created_at >= observed_at
  )
);

CREATE TRIGGER community_route_active_lease_renewals_immutable
BEFORE DELETE ON community_route_active_lease_renewals
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_route_active_lease_renewal_snapshots_immutable
BEFORE UPDATE OR DELETE ON community_route_active_lease_renewal_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

ALTER TABLE community_route_ownership_evidence
  ADD COLUMN active_lease_renewal_attempt_id TEXT;

ALTER TABLE community_route_ownership_evidence
  DROP CONSTRAINT community_route_ownership_evidence_origin_shape,
  ADD CONSTRAINT community_route_ownership_evidence_origin_shape_v2 CHECK (
    (
      origin = 'creation_ceremony'
      AND creation_ceremony_intent_id IS NOT NULL
      AND route_revalidation_attempt_id IS NULL
      AND active_lease_renewal_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND verified_by_actor_id IS NOT NULL
    )
    OR (
      origin = 'route_revalidation'
      AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NOT NULL
      AND active_lease_renewal_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NULL
    )
    OR (
      origin = 'active_lease_renewal'
      AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NULL
      AND active_lease_renewal_attempt_id IS NOT NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND verified_by_actor_id IS NULL
      AND family = 'hns'
    )
    OR (
      origin = 'route_attachment'
      AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NULL
      AND active_lease_renewal_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NOT NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND verified_by_actor_id IS NOT NULL
    )
    OR (
      origin = 'operator_control_observation'
      AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NULL
      AND active_lease_renewal_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NOT NULL
      AND verified_by_actor_id IS NULL
      AND family = 'hns'
    )
  ),
  ADD CONSTRAINT community_route_ownership_evidence_renewal_attempt_fk
    FOREIGN KEY (active_lease_renewal_attempt_id)
    REFERENCES community_route_active_lease_renewal_attempts (
      active_lease_renewal_attempt_id
    ) DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX community_route_ownership_evidence_renewal_attempt_uidx
  ON community_route_ownership_evidence (active_lease_renewal_attempt_id)
  WHERE active_lease_renewal_attempt_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_community_route_hns_control_identity_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  creation_snapshot namespace_ownership_evidence_snapshots%ROWTYPE;
  recovery_snapshot community_route_revalidation_evidence_snapshots%ROWTYPE;
  renewal_snapshot community_route_active_lease_renewal_evidence_snapshots%ROWTYPE;
  matching_snapshots INTEGER := 0;
BEGIN
  SELECT * INTO creation_snapshot
    FROM namespace_ownership_evidence_snapshots
   WHERE evidence_ref = NEW.evidence_ref
   FOR SHARE;
  IF FOUND THEN
    matching_snapshots := matching_snapshots + 1;
    IF creation_snapshot.root_label <> NEW.root_label
      OR creation_snapshot.ownership_source <> NEW.ownership_source
      OR creation_snapshot.challenge_name <> NEW.txt_name
      OR creation_snapshot.challenge_value_sha256 <> NEW.expected_txt_value_sha256
      OR creation_snapshot.provider_evidence_ref <> NEW.provider_evidence_ref
      OR creation_snapshot.observation ->> 'control_identity_digest'
           IS DISTINCT FROM NEW.control_identity_digest
      OR creation_snapshot.observation ->> 'chain_authority_digest'
           IS DISTINCT FROM NEW.chain_authority_digest
    THEN
      RAISE EXCEPTION 'HNS control identity does not match creation evidence';
    END IF;
  END IF;

  SELECT * INTO recovery_snapshot
    FROM community_route_revalidation_evidence_snapshots
   WHERE evidence_ref = NEW.evidence_ref
   FOR SHARE;
  IF FOUND THEN
    matching_snapshots := matching_snapshots + 1;
    IF recovery_snapshot.root_label <> NEW.root_label
      OR recovery_snapshot.ownership_source <> NEW.ownership_source
      OR recovery_snapshot.challenge_name <> NEW.txt_name
      OR recovery_snapshot.challenge_value_sha256 <> NEW.expected_txt_value_sha256
      OR recovery_snapshot.provider_evidence_ref <> NEW.provider_evidence_ref
      OR recovery_snapshot.observation ->> 'control_identity_digest'
           IS DISTINCT FROM NEW.control_identity_digest
      OR recovery_snapshot.observation ->> 'chain_authority_digest'
           IS DISTINCT FROM NEW.chain_authority_digest
    THEN
      RAISE EXCEPTION 'HNS control identity does not match recovery evidence';
    END IF;
  END IF;

  SELECT * INTO renewal_snapshot
    FROM community_route_active_lease_renewal_evidence_snapshots
   WHERE evidence_ref = NEW.evidence_ref
   FOR SHARE;
  IF FOUND THEN
    matching_snapshots := matching_snapshots + 1;
    IF renewal_snapshot.root_label <> NEW.root_label
      OR renewal_snapshot.ownership_source <> NEW.ownership_source
      OR renewal_snapshot.txt_name <> NEW.txt_name
      OR renewal_snapshot.expected_txt_value_sha256 <> NEW.expected_txt_value_sha256
      OR renewal_snapshot.provider_evidence_ref <> NEW.provider_evidence_ref
      OR renewal_snapshot.control_identity_digest <> NEW.control_identity_digest
      OR renewal_snapshot.chain_authority_digest <> NEW.chain_authority_digest
    THEN
      RAISE EXCEPTION 'HNS control identity does not match renewal evidence';
    END IF;
  END IF;

  IF matching_snapshots <> 1 THEN
    RAISE EXCEPTION 'HNS control identity requires exactly one immutable evidence snapshot';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION require_community_route_hns_control_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  identity_record community_route_hns_control_identities%ROWTYPE;
  creation_snapshot namespace_ownership_evidence_snapshots%ROWTYPE;
  revalidation_attempt community_route_revalidation_completion_attempts%ROWTYPE;
  revalidation_session community_route_revalidation_sessions%ROWTYPE;
BEGIN
  IF NEW.origin = 'creation_ceremony' THEN
    SELECT * INTO creation_snapshot
      FROM namespace_ownership_evidence_snapshots
     WHERE evidence_ref = NEW.evidence_ref;
  ELSIF NEW.origin = 'route_revalidation' THEN
    SELECT * INTO revalidation_attempt
      FROM community_route_revalidation_completion_attempts
     WHERE route_revalidation_attempt_id = NEW.route_revalidation_attempt_id;
    SELECT * INTO revalidation_session
      FROM community_route_revalidation_sessions
     WHERE route_revalidation_id = revalidation_attempt.route_revalidation_id
       AND revalidation_session_id = revalidation_attempt.revalidation_session_id;
  END IF;

  SELECT * INTO identity_record
    FROM community_route_hns_control_identities
   WHERE evidence_ref = NEW.evidence_ref
   FOR SHARE;
  IF identity_record.evidence_ref IS NULL THEN
    IF NEW.origin = 'active_lease_renewal'
      OR (
        NEW.origin = 'creation_ceremony'
        AND creation_snapshot.provider_configuration_version = 'hns-observer-config-v2'
      )
      OR (
        NEW.origin = 'route_revalidation'
        AND revalidation_session.operation_mode = 'same_root_recovery'
      )
    THEN
      RAISE EXCEPTION 'new HNS route evidence requires immutable control identity authority';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.origin = 'route_revalidation' THEN
    IF revalidation_session.operation_mode = 'same_root_recovery' THEN
      IF NEW.verified_by_actor_id IS DISTINCT FROM revalidation_session.principal_id THEN
        RAISE EXCEPTION 'owner recovery evidence must name the creator principal';
      END IF;
    ELSIF NEW.verified_by_actor_id IS NOT NULL THEN
      RAISE EXCEPTION 'system revalidation evidence cannot name an owner principal';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_ownership_evidence_hns_identity_guard
BEFORE INSERT ON community_route_ownership_evidence
FOR EACH ROW
WHEN (
  NEW.family = 'hns'
  AND NEW.origin IN ('creation_ceremony', 'route_revalidation', 'active_lease_renewal')
)
EXECUTE FUNCTION require_community_route_hns_control_identity();

CREATE OR REPLACE FUNCTION validate_hns_active_lease_renewal_terminal_document(
  document_text TEXT,
  expected_hash TEXT,
  expected_version TEXT,
  expected_renewal_id TEXT,
  expected_attempt_id TEXT,
  expected_binding_id TEXT,
  expected_generation BIGINT,
  expected_idempotency_key TEXT,
  expected_request_hash TEXT,
  expected_outcome TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  document JSONB;
  canonical_document TEXT;
  evidence_ref JSONB;
  evidence_digest JSONB;
  provider_hash JSONB;
  ownership JSONB;
  lifecycle JSONB;
BEGIN
  IF document_text IS NULL OR octet_length(document_text) NOT BETWEEN 1 AND 8192 THEN
    RETURN FALSE;
  END IF;
  document := document_text::jsonb;
  IF jsonb_typeof(document) <> 'array' OR jsonb_array_length(document) <> 13 THEN
    RETURN FALSE;
  END IF;
  SELECT '[' || string_agg(value::TEXT, ',' ORDER BY ordinal) || ']'
    INTO canonical_document
    FROM jsonb_array_elements(document) WITH ORDINALITY AS item(value, ordinal);
  IF canonical_document IS DISTINCT FROM document_text
    OR encode(sha256(convert_to(document_text, 'UTF8')), 'hex') IS DISTINCT FROM expected_hash
    OR document ->> 0 IS DISTINCT FROM expected_version
    OR document ->> 1 IS DISTINCT FROM expected_renewal_id
    OR document ->> 2 IS DISTINCT FROM expected_attempt_id
    OR document ->> 3 IS DISTINCT FROM expected_binding_id
    OR jsonb_typeof(document -> 4) <> 'number'
    OR (document ->> 4)::bigint IS DISTINCT FROM expected_generation
    OR document ->> 5 IS DISTINCT FROM expected_idempotency_key
    OR document ->> 6 IS DISTINCT FROM expected_request_hash
    OR document ->> 7 IS DISTINCT FROM expected_outcome
  THEN
    RETURN FALSE;
  END IF;

  evidence_ref := document -> 8;
  evidence_digest := document -> 9;
  provider_hash := document -> 10;
  ownership := document -> 11;
  lifecycle := document -> 12;

  IF expected_version = 'pirate-hns-active-lease-renewal-result-v3'
    AND expected_outcome <> 'owner_authoritative_source_ineligible'
  THEN RETURN FALSE; END IF;
  IF expected_version = 'pirate-hns-active-lease-renewal-result-v2'
    AND expected_outcome = 'owner_authoritative_source_ineligible'
  THEN RETURN FALSE; END IF;

  IF expected_outcome = 'verified' THEN
    RETURN jsonb_typeof(evidence_ref) = 'string'
      AND jsonb_typeof(evidence_digest) = 'string'
      AND evidence_digest #>> '{}' ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(provider_hash) = 'string'
      AND provider_hash #>> '{}' ~ '^[0-9a-f]{64}$'
      AND ownership #>> '{}' = 'verified'
      AND lifecycle #>> '{}' = 'active';
  END IF;
  IF expected_outcome IN ('root_absent', 'root_inactive') THEN
    RETURN jsonb_typeof(evidence_ref) = 'null'
      AND jsonb_typeof(evidence_digest) = 'null'
      AND jsonb_typeof(provider_hash) = 'string'
      AND ownership #>> '{}' = 'revoked'
      AND lifecycle #>> '{}' = 'suspended';
  END IF;
  IF expected_outcome IN (
    'txt_absent', 'txt_value_mismatch', 'control_identity_changed',
    'chain_authority_changed', 'owner_authoritative_source_ineligible'
  ) THEN
    RETURN jsonb_typeof(evidence_ref) = 'null'
      AND jsonb_typeof(evidence_digest) = 'null'
      AND jsonb_typeof(provider_hash) = 'string'
      AND ownership #>> '{}' = 'disputed'
      AND lifecycle #>> '{}' = 'suspended';
  END IF;
  IF expected_outcome = 'expiry_horizon_insufficient' THEN
    RETURN jsonb_typeof(evidence_ref) = 'null'
      AND jsonb_typeof(evidence_digest) = 'null'
      AND jsonb_typeof(provider_hash) = 'string'
      AND ownership #>> '{}' = 'expired'
      AND lifecycle #>> '{}' = 'suspended';
  END IF;
  IF expected_outcome = 'renewal_evidence_ineligible' THEN
    RETURN jsonb_typeof(evidence_ref) = 'null'
      AND jsonb_typeof(evidence_digest) = 'null'
      AND jsonb_typeof(provider_hash) = 'null'
      AND jsonb_typeof(ownership) = 'null'
      AND jsonb_typeof(lifecycle) = 'null';
  END IF;
  IF expected_outcome IN ('lease_expired_before_commit', 'stale_cas') THEN
    RETURN jsonb_typeof(evidence_ref) = 'null'
      AND jsonb_typeof(evidence_digest) = 'null'
      AND jsonb_typeof(provider_hash) IN ('null', 'string')
      AND jsonb_typeof(ownership) = 'null'
      AND jsonb_typeof(lifecycle) = 'null';
  END IF;
  RETURN FALSE;
EXCEPTION WHEN others THEN
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION guard_community_route_active_lease_renewal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ := clock_timestamp();
  community_record communities%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  identity_record community_route_hns_control_identities%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'active lease renewals cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
    SELECT * INTO community_record FROM communities
     WHERE community_id = NEW.community_id FOR UPDATE;
    SELECT * INTO binding_record FROM community_canonical_route_bindings
     WHERE route_binding_id = NEW.route_binding_id
       AND community_id = NEW.community_id FOR UPDATE;
    SELECT * INTO evidence_record FROM community_route_ownership_evidence
     WHERE evidence_ref = NEW.expected_verified_evidence_ref FOR SHARE;
    SELECT * INTO identity_record FROM community_route_hns_control_identities
     WHERE evidence_ref = NEW.expected_verified_evidence_ref FOR SHARE;
    IF community_record.community_id IS NULL
      OR community_record.status <> 'active'
      OR community_record.canonical_route_binding_id IS DISTINCT FROM NEW.route_binding_id
      OR binding_record.route_binding_id IS NULL
      OR binding_record.binding_generation IS DISTINCT FROM NEW.expected_binding_generation
      OR binding_record.verified_evidence_ref IS DISTINCT FROM NEW.expected_verified_evidence_ref
      OR binding_record.ownership_status <> 'verified'
      OR binding_record.route_lifecycle_status <> 'active'
      OR evidence_record.evidence_ref IS NULL
      OR evidence_record.binding_generation IS DISTINCT FROM NEW.expected_binding_generation
      OR evidence_record.evidence_digest IS DISTINCT FROM NEW.expected_evidence_digest
      OR evidence_record.expires_at IS NULL OR evidence_record.expires_at <= db_now
      OR evidence_record.family IS DISTINCT FROM NEW.family
      OR evidence_record.root_label IS DISTINCT FROM NEW.root_label
      OR evidence_record.root_label_display IS DISTINCT FROM NEW.root_label_display
      OR evidence_record.path_segment IS DISTINCT FROM NEW.path_segment
      OR evidence_record.provider_id IS DISTINCT FROM NEW.provider_id
      OR evidence_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
      OR evidence_record.provider_configuration_version
           IS DISTINCT FROM NEW.provider_configuration_version
      OR identity_record.evidence_ref IS NULL
      OR identity_record.control_identity_digest
           IS DISTINCT FROM NEW.expected_control_identity_digest
      OR identity_record.chain_authority_digest
           IS DISTINCT FROM NEW.expected_chain_authority_digest
      OR identity_record.provider_evidence_ref
           IS DISTINCT FROM NEW.prior_provider_evidence_ref
      OR NEW.status <> 'pending'
    THEN
      RAISE EXCEPTION 'active lease renewal does not match effective route authority';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.active_lease_renewal_id, NEW.community_id, NEW.route_binding_id,
    NEW.principal_kind, NEW.principal_id, NEW.expected_binding_generation,
    NEW.expected_verified_evidence_ref, NEW.expected_evidence_digest,
    NEW.expected_control_identity_digest, NEW.expected_chain_authority_digest,
    NEW.prior_provider_evidence_ref, NEW.requirement_hash, NEW.provider_id,
    NEW.provider_binding_hash, NEW.provider_configuration_kind,
    NEW.provider_configuration_reference, NEW.provider_configuration_version,
    NEW.provider_configuration_digest, NEW.protocol_version, NEW.environment,
    NEW.family, NEW.root_label, NEW.root_label_display, NEW.path_segment, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.active_lease_renewal_id, OLD.community_id, OLD.route_binding_id,
    OLD.principal_kind, OLD.principal_id, OLD.expected_binding_generation,
    OLD.expected_verified_evidence_ref, OLD.expected_evidence_digest,
    OLD.expected_control_identity_digest, OLD.expected_chain_authority_digest,
    OLD.prior_provider_evidence_ref, OLD.requirement_hash, OLD.provider_id,
    OLD.provider_binding_hash, OLD.provider_configuration_kind,
    OLD.provider_configuration_reference, OLD.provider_configuration_version,
    OLD.provider_configuration_digest, OLD.protocol_version, OLD.environment,
    OLD.family, OLD.root_label, OLD.root_label_display, OLD.path_segment, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'active lease renewal authority is immutable';
  END IF;
  IF OLD.status = 'pending'
    AND NEW.status IN ('completed', 'failed')
    AND NEW.terminal_at IS NOT NULL
    AND NEW.terminal_at <= db_now
  THEN
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'active lease renewal transition is not allowed';
END;
$$;

DROP TRIGGER community_route_active_lease_renewals_immutable
  ON community_route_active_lease_renewals;
CREATE TRIGGER community_route_active_lease_renewal_guard
BEFORE INSERT OR UPDATE OR DELETE ON community_route_active_lease_renewals
FOR EACH ROW EXECUTE FUNCTION guard_community_route_active_lease_renewal();

CREATE OR REPLACE FUNCTION guard_community_route_active_lease_renewal_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ := date_trunc('milliseconds', clock_timestamp());
  renewal_record community_route_active_lease_renewals%ROWTYPE;
  consumed_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'active lease renewal attempts cannot be deleted';
  END IF;
  SELECT * INTO renewal_record
    FROM community_route_active_lease_renewals
   WHERE active_lease_renewal_id = COALESCE(
     NEW.active_lease_renewal_id, OLD.active_lease_renewal_id
   ) FOR UPDATE;
  IF renewal_record.active_lease_renewal_id IS NULL THEN
    RAISE EXCEPTION 'active lease renewal attempt lacks its operation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
    SELECT count(*)::integer INTO consumed_count
      FROM community_route_active_lease_renewal_attempts
     WHERE active_lease_renewal_id = NEW.active_lease_renewal_id
       AND state = 'consumed';
    IF renewal_record.status <> 'pending'
      OR NEW.route_binding_id IS DISTINCT FROM renewal_record.route_binding_id
      OR NEW.expected_binding_generation
           IS DISTINCT FROM renewal_record.expected_binding_generation
      OR NEW.attempt_number IS DISTINCT FROM consumed_count + 1
      OR consumed_count >= 3
      OR NEW.state <> 'leased'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= db_now
    THEN
      RAISE EXCEPTION 'active lease renewal attempt is not admissible';
    END IF;
    NEW.lease_expires_at := db_now + INTERVAL '16 seconds';
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.active_lease_renewal_attempt_id, NEW.active_lease_renewal_id,
    NEW.route_binding_id, NEW.expected_binding_generation, NEW.attempt_number,
    NEW.idempotency_key, NEW.request_hash, NEW.evidence_ref, NEW.observation_id,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.active_lease_renewal_attempt_id, OLD.active_lease_renewal_id,
    OLD.route_binding_id, OLD.expected_binding_generation, OLD.attempt_number,
    OLD.idempotency_key, OLD.request_hash, OLD.evidence_ref, OLD.observation_id,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'active lease renewal attempt authority is immutable';
  END IF;

  IF OLD.state = 'leased' AND NEW.state = 'released'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.consumption_kind IS NULL
  THEN
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('released', 'leased') AND NEW.state = 'leased'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at > db_now
    AND (OLD.state = 'released' OR OLD.lease_expires_at <= db_now)
    AND NEW.consumption_kind IS NULL
  THEN
    NEW.lease_expires_at := db_now + INTERVAL '16 seconds';
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  IF OLD.state = 'leased' AND NEW.state = 'consumed'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.terminal_at IS NOT NULL
    AND NEW.terminal_at <= db_now
    AND (
      OLD.lease_expires_at > db_now
      OR NEW.consumption_kind IN ('lease_expired_before_commit', 'stale_cas')
    )
    AND validate_hns_active_lease_renewal_terminal_document(
      NEW.terminal_result_document, NEW.result_hash, NEW.terminal_result_version,
      NEW.active_lease_renewal_id, NEW.active_lease_renewal_attempt_id,
      NEW.route_binding_id, NEW.expected_binding_generation, NEW.idempotency_key,
      NEW.request_hash, NEW.consumption_kind
    )
  THEN
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'active lease renewal attempt transition is not allowed';
END;
$$;

CREATE TRIGGER community_route_active_lease_renewal_attempt_guard
BEFORE INSERT OR UPDATE OR DELETE ON community_route_active_lease_renewal_attempts
FOR EACH ROW EXECUTE FUNCTION guard_community_route_active_lease_renewal_attempt();

CREATE OR REPLACE FUNCTION validate_community_route_active_lease_renewal_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  renewal_record community_route_active_lease_renewals%ROWTYPE;
  terminal_count INTEGER;
  leased_count INTEGER;
BEGIN
  SELECT * INTO renewal_record
    FROM community_route_active_lease_renewals
   WHERE active_lease_renewal_id = NEW.active_lease_renewal_id;
  SELECT count(*) FILTER (WHERE state = 'consumed')::integer,
         count(*) FILTER (WHERE state = 'leased')::integer
    INTO terminal_count, leased_count
    FROM community_route_active_lease_renewal_attempts
   WHERE active_lease_renewal_id = NEW.active_lease_renewal_id;
  IF renewal_record.status = 'pending' AND terminal_count <> 0 THEN
    RAISE EXCEPTION 'pending active lease renewal cannot have a consumed attempt';
  END IF;
  IF renewal_record.status IN ('completed', 'failed')
    AND (terminal_count <> 1 OR leased_count <> 0)
  THEN
    RAISE EXCEPTION 'terminal active lease renewal requires one consumed attempt';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_route_active_lease_renewal_attempt_coherence
AFTER INSERT OR UPDATE ON community_route_active_lease_renewal_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_route_active_lease_renewal_coherence();

CREATE CONSTRAINT TRIGGER community_route_active_lease_renewal_operation_coherence
AFTER UPDATE ON community_route_active_lease_renewals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_route_active_lease_renewal_coherence();

CREATE OR REPLACE FUNCTION validate_community_route_active_lease_renewal_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ := clock_timestamp();
  renewal_record community_route_active_lease_renewals%ROWTYPE;
  attempt_record community_route_active_lease_renewal_attempts%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
BEGIN
  NEW.created_at := db_now;
  SELECT * INTO renewal_record
    FROM community_route_active_lease_renewals
   WHERE active_lease_renewal_id = NEW.active_lease_renewal_id FOR SHARE;
  SELECT * INTO attempt_record
    FROM community_route_active_lease_renewal_attempts
   WHERE active_lease_renewal_attempt_id = NEW.active_lease_renewal_attempt_id FOR SHARE;
  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = NEW.route_binding_id
     AND community_id = NEW.community_id FOR UPDATE;
  IF renewal_record.active_lease_renewal_id IS NULL
    OR attempt_record.active_lease_renewal_attempt_id IS NULL
    OR binding_record.route_binding_id IS NULL
    OR renewal_record.status <> 'completed'
    OR attempt_record.state <> 'consumed'
    OR attempt_record.consumption_kind <> 'verified'
    OR attempt_record.active_lease_renewal_id IS DISTINCT FROM NEW.active_lease_renewal_id
    OR attempt_record.evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR attempt_record.request_hash IS DISTINCT FROM NEW.request_hash
    OR attempt_record.provider_response_sha256 IS DISTINCT FROM NEW.provider_response_sha256
    OR renewal_record.community_id IS DISTINCT FROM NEW.community_id
    OR renewal_record.route_binding_id IS DISTINCT FROM NEW.route_binding_id
    OR renewal_record.principal_id IS DISTINCT FROM NEW.principal_id
    OR renewal_record.requirement_hash IS DISTINCT FROM NEW.requirement_hash
    OR renewal_record.expected_binding_generation
         IS DISTINCT FROM NEW.expected_binding_generation
    OR renewal_record.expected_verified_evidence_ref
         IS DISTINCT FROM NEW.expected_verified_evidence_ref
    OR renewal_record.expected_evidence_digest IS DISTINCT FROM NEW.expected_evidence_digest
    OR renewal_record.expected_control_identity_digest
         IS DISTINCT FROM NEW.expected_control_identity_digest
    OR renewal_record.expected_chain_authority_digest
         IS DISTINCT FROM NEW.expected_chain_authority_digest
    OR renewal_record.prior_provider_evidence_ref
         IS DISTINCT FROM NEW.prior_provider_evidence_ref
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
    OR renewal_record.protocol_version IS DISTINCT FROM NEW.protocol_version
    OR renewal_record.environment IS DISTINCT FROM NEW.environment
    OR renewal_record.family IS DISTINCT FROM NEW.family
    OR renewal_record.root_label IS DISTINCT FROM NEW.root_label
    OR renewal_record.root_label_display IS DISTINCT FROM NEW.root_label_display
    OR renewal_record.path_segment IS DISTINCT FROM NEW.path_segment
    OR binding_record.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR binding_record.verified_evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR binding_record.ownership_status <> 'verified'
    OR binding_record.route_lifecycle_status <> 'active'
    OR NEW.observed_at > db_now OR NEW.expires_at <= db_now
    OR NEW.response_document ->> 'status' <> 'verified'
    OR NEW.response_document #>> '{observation,ownership_source}'
         IS DISTINCT FROM NEW.ownership_source
    OR NEW.response_document #>> '{observation,txt_name}'
         IS DISTINCT FROM NEW.txt_name
    OR NEW.response_document #>> '{observation,expected_txt_value_sha256}'
         IS DISTINCT FROM NEW.expected_txt_value_sha256
    OR NEW.response_document #>> '{observation,control_identity_digest}'
         IS DISTINCT FROM NEW.control_identity_digest
    OR NEW.response_document #>> '{observation,chain_authority_digest}'
         IS DISTINCT FROM NEW.chain_authority_digest
    OR NEW.response_document #>> '{observation,provider_evidence_ref}'
         IS DISTINCT FROM NEW.provider_evidence_ref
    OR NEW.response_document #>> '{observation,observer_result_sha256}'
         IS DISTINCT FROM NEW.observer_result_sha256
  THEN
    RAISE EXCEPTION 'active lease renewal snapshot does not match committed authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_active_lease_renewal_snapshot_insert_guard
BEFORE INSERT ON community_route_active_lease_renewal_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION validate_community_route_active_lease_renewal_snapshot_insert();

CREATE OR REPLACE FUNCTION validate_community_route_active_renewal_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot_record community_route_active_lease_renewal_evidence_snapshots%ROWTYPE;
  attempt_record community_route_active_lease_renewal_attempts%ROWTYPE;
  renewal_record community_route_active_lease_renewals%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_route_active_lease_renewal_attempts
   WHERE active_lease_renewal_attempt_id = NEW.active_lease_renewal_attempt_id
   FOR SHARE;
  SELECT * INTO renewal_record
    FROM community_route_active_lease_renewals
   WHERE active_lease_renewal_id = attempt_record.active_lease_renewal_id
   FOR SHARE;
  SELECT * INTO snapshot_record
    FROM community_route_active_lease_renewal_evidence_snapshots
   WHERE evidence_ref = NEW.evidence_ref
     AND active_lease_renewal_attempt_id = NEW.active_lease_renewal_attempt_id
   FOR SHARE;
  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = renewal_record.route_binding_id
     AND community_id = renewal_record.community_id FOR UPDATE;
  IF attempt_record.active_lease_renewal_attempt_id IS NULL
    OR renewal_record.active_lease_renewal_id IS NULL
    OR snapshot_record.evidence_ref IS NULL
    OR attempt_record.state <> 'consumed'
    OR attempt_record.consumption_kind <> 'verified'
    OR renewal_record.status <> 'completed'
    OR NEW.family IS DISTINCT FROM snapshot_record.family
    OR NEW.root_label IS DISTINCT FROM snapshot_record.root_label
    OR NEW.root_label_display IS DISTINCT FROM snapshot_record.root_label_display
    OR NEW.path_segment IS DISTINCT FROM snapshot_record.path_segment
    OR NEW.requirement_hash IS DISTINCT FROM snapshot_record.requirement_hash
    OR NEW.provider_id IS DISTINCT FROM snapshot_record.provider_id
    OR NEW.provider_binding_hash IS DISTINCT FROM snapshot_record.provider_binding_hash
    OR NEW.provider_configuration_version
         IS DISTINCT FROM snapshot_record.provider_configuration_version
    OR NEW.provider_identity_digest IS DISTINCT FROM (
      SELECT provider_identity_digest
        FROM community_route_ownership_evidence
       WHERE evidence_ref = snapshot_record.expected_verified_evidence_ref
    )
    OR NEW.evidence_digest IS DISTINCT FROM snapshot_record.evidence_digest
    OR NEW.evidence_receipt_id IS NOT NULL
    OR NEW.binding_generation IS DISTINCT FROM snapshot_record.binding_generation
    OR NEW.verified_at IS DISTINCT FROM snapshot_record.observed_at
    OR NEW.expires_at IS DISTINCT FROM snapshot_record.expires_at
    OR binding_record.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR binding_record.verified_evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR binding_record.ownership_status <> 'verified'
    OR binding_record.route_lifecycle_status <> 'active'
  THEN
    RAISE EXCEPTION 'route ownership evidence does not match active renewal authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_active_renewal_evidence_insert_guard
BEFORE INSERT ON community_route_ownership_evidence
FOR EACH ROW
WHEN (NEW.origin = 'active_lease_renewal')
EXECUTE FUNCTION validate_community_route_active_renewal_evidence_insert();

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
  configuration_exists BOOLEAN;
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
    SELECT EXISTS (
      SELECT 1 FROM hns_control_observer_configurations
       WHERE provider_configuration_reference = NEW.provider_configuration_reference
         AND provider_configuration_version = NEW.provider_configuration_version
         AND provider_configuration_digest = NEW.provider_configuration_digest
    ) INTO configuration_exists;
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
      OR NOT configuration_exists
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

CREATE OR REPLACE FUNCTION validate_hns_owner_recovery_session_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ := clock_timestamp();
  reservation_record community_route_revalidation_start_reservations%ROWTYPE;
  payload JSONB;
BEGIN
  NEW.created_at := db_now;
  NEW.updated_at := db_now;
  SELECT * INTO reservation_record
    FROM community_route_revalidation_start_reservations
   WHERE route_revalidation_id = NEW.route_revalidation_id
     AND revalidation_session_id = NEW.revalidation_session_id
     AND fence_token = NEW.start_fence_token FOR UPDATE;
  payload := NEW.start_presentation -> 'payload';
  IF reservation_record.route_revalidation_id IS NULL
    OR reservation_record.state NOT IN ('acquired', 'finalized')
    OR reservation_record.lease_expires_at <= db_now
    OR reservation_record.operation_mode <> 'same_root_recovery'
    OR reservation_record.community_id IS DISTINCT FROM NEW.community_id
    OR reservation_record.route_binding_id IS DISTINCT FROM NEW.route_binding_id
    OR reservation_record.principal_id IS DISTINCT FROM NEW.principal_id
    OR reservation_record.expected_binding_generation
         IS DISTINCT FROM NEW.expected_binding_generation
    OR reservation_record.requirement_hash IS DISTINCT FROM NEW.requirement_hash
    OR reservation_record.start_request_hash IS DISTINCT FROM NEW.start_request_hash
    OR reservation_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR reservation_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
    OR reservation_record.provider_configuration_kind
         IS DISTINCT FROM NEW.provider_configuration_kind
    OR reservation_record.provider_configuration_reference
         IS DISTINCT FROM NEW.provider_configuration_reference
    OR reservation_record.provider_configuration_version
         IS DISTINCT FROM NEW.provider_configuration_version
    OR reservation_record.environment IS DISTINCT FROM NEW.environment
    OR reservation_record.family IS DISTINCT FROM NEW.family
    OR reservation_record.root_label IS DISTINCT FROM NEW.root_label
    OR reservation_record.root_label_display IS DISTINCT FROM NEW.root_label_display
    OR reservation_record.path_segment IS DISTINCT FROM NEW.path_segment
    OR reservation_record.start_idempotency_key IS DISTINCT FROM NEW.start_idempotency_key
    OR reservation_record.recovery_authority_kind
         IS DISTINCT FROM NEW.recovery_authority_kind
    OR reservation_record.recovery_authority_reference
         IS DISTINCT FROM NEW.recovery_authority_reference
    OR reservation_record.public_start_hash IS DISTINCT FROM NEW.public_start_hash
    OR reservation_record.provider_start_hash IS DISTINCT FROM NEW.provider_start_hash
    OR reservation_record.provider_configuration_digest
         IS DISTINCT FROM NEW.provider_configuration_digest
    OR reservation_record.challenge_expires_at IS DISTINCT FROM NEW.challenge_expires_at
    OR NEW.status <> 'pending'
    OR NEW.started_at IS DISTINCT FROM NEW.challenge_expires_at - INTERVAL '1 hour'
    OR NEW.expires_at IS DISTINCT FROM NEW.challenge_expires_at
    OR NEW.start_presentation ->> 'kind' <> 'embedded_sdk'
    OR (NEW.start_presentation ->> 'session_id') IS DISTINCT FROM NEW.upstream_session_ref
    OR NEW.start_presentation ->> 'protocol' <> 'hns-txt-challenge'
    OR NEW.start_presentation ->> 'version' <> '1'
    OR payload ->> 'ownership_source' NOT IN (
      'hns_parent_chain_txt', 'owner_authoritative_dns_txt'
    )
    OR (payload ->> 'challenge_name') IS DISTINCT FROM (
      CASE
        WHEN payload ->> 'ownership_source' = 'hns_parent_chain_txt'
          THEN NEW.root_label
        ELSE '_pirate.' || NEW.root_label
      END
    )
    OR (payload ->> 'challenge_value')
         IS DISTINCT FROM ('pirate-verification=' || NEW.upstream_session_ref)
    OR ((payload ->> 'expires_at')::timestamptz) IS DISTINCT FROM NEW.challenge_expires_at
  THEN
    RAISE EXCEPTION 'owner recovery session does not match its fenced reservation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_hns_owner_recovery_session_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'owner recovery sessions cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'terminal_at' - 'updated_at')
       IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'terminal_at' - 'updated_at')
  THEN RAISE EXCEPTION 'owner recovery session authority is immutable'; END IF;
  IF OLD.status = 'pending'
    AND NEW.status IN ('completed', 'failed', 'expired')
    AND NEW.terminal_at IS NOT NULL
    AND NEW.terminal_at <= clock_timestamp()
    AND (NEW.status <> 'expired' OR NEW.terminal_at >= NEW.expires_at)
  THEN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'owner recovery session transition is not allowed';
END;
$$;

CREATE OR REPLACE FUNCTION validate_hns_owner_recovery_terminal_document(
  document_text TEXT,
  expected_hash TEXT,
  expected_version TEXT,
  expected_recovery_id TEXT,
  expected_session_id TEXT,
  expected_attempt_id TEXT,
  expected_binding_id TEXT,
  expected_generation BIGINT,
  expected_idempotency_key TEXT,
  expected_poll_hash TEXT,
  expected_outcome TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  document JSONB;
  canonical_document TEXT;
BEGIN
  IF document_text IS NULL OR octet_length(document_text) NOT BETWEEN 1 AND 8192 THEN
    RETURN FALSE;
  END IF;
  document := document_text::jsonb;
  IF jsonb_typeof(document) <> 'array' OR jsonb_array_length(document) <> 14 THEN
    RETURN FALSE;
  END IF;
  SELECT '[' || string_agg(value::TEXT, ',' ORDER BY ordinal) || ']'
    INTO canonical_document
    FROM jsonb_array_elements(document) WITH ORDINALITY AS item(value, ordinal);
  IF canonical_document IS DISTINCT FROM document_text
    OR encode(sha256(convert_to(document_text, 'UTF8')), 'hex') IS DISTINCT FROM expected_hash
    OR document ->> 0 IS DISTINCT FROM expected_version
    OR document ->> 1 IS DISTINCT FROM expected_recovery_id
    OR document ->> 2 IS DISTINCT FROM expected_session_id
    OR document ->> 3 IS DISTINCT FROM expected_attempt_id
    OR document ->> 4 IS DISTINCT FROM expected_binding_id
    OR jsonb_typeof(document -> 5) <> 'number'
    OR (document ->> 5)::bigint IS DISTINCT FROM expected_generation
    OR document ->> 6 IS DISTINCT FROM expected_idempotency_key
    OR document ->> 7 IS DISTINCT FROM expected_poll_hash
    OR document ->> 8 IS DISTINCT FROM expected_outcome
  THEN RETURN FALSE; END IF;

  IF expected_version = 'pirate-hns-owner-recovery-result-v2'
    AND expected_outcome <> 'owner_authoritative_source_ineligible'
  THEN RETURN FALSE; END IF;
  IF expected_version = 'pirate-hns-owner-recovery-result-v1'
    AND expected_outcome = 'owner_authoritative_source_ineligible'
  THEN RETURN FALSE; END IF;

  IF expected_outcome = 'verified' THEN
    RETURN jsonb_typeof(document -> 9) = 'string'
      AND jsonb_typeof(document -> 10) = 'string'
      AND document ->> 10 ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(document -> 11) = 'string'
      AND document ->> 11 ~ '^[0-9a-f]{64}$'
      AND document ->> 12 = 'verified' AND document ->> 13 = 'active';
  END IF;
  IF expected_outcome IN ('root_absent', 'root_inactive') THEN
    RETURN jsonb_typeof(document -> 9) = 'null'
      AND jsonb_typeof(document -> 10) = 'null'
      AND jsonb_typeof(document -> 11) = 'string'
      AND document ->> 12 = 'revoked' AND document ->> 13 = 'suspended';
  END IF;
  IF expected_outcome = 'expiry_horizon_insufficient' THEN
    RETURN jsonb_typeof(document -> 9) = 'null'
      AND jsonb_typeof(document -> 10) = 'null'
      AND jsonb_typeof(document -> 11) = 'string'
      AND document ->> 12 = 'expired' AND document ->> 13 = 'suspended';
  END IF;
  IF expected_outcome = 'owner_authoritative_source_ineligible' THEN
    RETURN jsonb_typeof(document -> 9) = 'null'
      AND jsonb_typeof(document -> 10) = 'null'
      AND jsonb_typeof(document -> 11) = 'string'
      AND document ->> 12 = 'disputed' AND document ->> 13 = 'suspended';
  END IF;
  IF expected_outcome = 'session_expired' THEN
    RETURN jsonb_typeof(document -> 9) = 'null'
      AND jsonb_typeof(document -> 10) = 'null'
      AND jsonb_typeof(document -> 11) = 'null'
      AND document ->> 12 = 'expired' AND document ->> 13 = 'suspended';
  END IF;
  IF expected_outcome = 'stale_cas' THEN
    RETURN jsonb_typeof(document -> 9) = 'null'
      AND jsonb_typeof(document -> 10) = 'null'
      AND jsonb_typeof(document -> 11) IN ('null', 'string')
      AND jsonb_typeof(document -> 12) = 'null'
      AND jsonb_typeof(document -> 13) = 'null';
  END IF;
  RETURN FALSE;
EXCEPTION WHEN others THEN
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION guard_hns_owner_recovery_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ := date_trunc('milliseconds', clock_timestamp());
  session_record community_route_revalidation_sessions%ROWTYPE;
  consumed_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'owner recovery attempts cannot be deleted';
  END IF;
  SELECT * INTO session_record FROM community_route_revalidation_sessions
   WHERE route_revalidation_id = COALESCE(NEW.route_revalidation_id, OLD.route_revalidation_id)
     AND revalidation_session_id = COALESCE(
       NEW.revalidation_session_id, OLD.revalidation_session_id
     ) FOR UPDATE;
  IF session_record.revalidation_session_id IS NULL
    OR session_record.operation_mode <> 'same_root_recovery'
  THEN RAISE EXCEPTION 'owner recovery attempt lacks its session'; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
    SELECT count(*)::integer INTO consumed_count
      FROM community_route_revalidation_completion_attempts
     WHERE route_revalidation_id = NEW.route_revalidation_id
       AND operation_mode = 'same_root_recovery' AND state = 'consumed';
    IF session_record.status <> 'pending'
      OR NEW.route_binding_id IS DISTINCT FROM session_record.route_binding_id
      OR NEW.expected_binding_generation
           IS DISTINCT FROM session_record.expected_binding_generation
      OR NEW.expected_verified_evidence_ref IS NOT NULL
      OR NEW.attempt_number IS DISTINCT FROM consumed_count + 1
      OR consumed_count >= 3
      OR NEW.state <> 'leased' OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= db_now
      OR (
        session_record.expires_at > db_now
        AND db_now + INTERVAL '16 seconds' > session_record.expires_at
      )
    THEN RAISE EXCEPTION 'owner recovery attempt is not admissible'; END IF;
    NEW.lease_expires_at := db_now + INTERVAL '16 seconds';
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)
        - 'state' - 'fence_token' - 'lease_expires_at' - 'consumption_kind'
        - 'result_hash' - 'terminal_result_document' - 'terminal_result_version'
        - 'target_observation_contract_version' - 'target_response_status'
        - 'provider_response_sha256' - 'raw_provider_response_bytes'
        - 'terminal_observed_expires_at' - 'terminal_at' - 'updated_at')
       IS DISTINCT FROM
     (to_jsonb(OLD)
        - 'state' - 'fence_token' - 'lease_expires_at' - 'consumption_kind'
        - 'result_hash' - 'terminal_result_document' - 'terminal_result_version'
        - 'target_observation_contract_version' - 'target_response_status'
        - 'provider_response_sha256' - 'raw_provider_response_bytes'
        - 'terminal_observed_expires_at' - 'terminal_at' - 'updated_at')
  THEN RAISE EXCEPTION 'owner recovery attempt authority is immutable'; END IF;
  IF OLD.state = 'leased' AND NEW.state = 'released'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
  THEN NEW.updated_at := db_now; RETURN NEW; END IF;
  IF OLD.state IN ('released', 'leased') AND NEW.state = 'leased'
    AND NEW.fence_token = OLD.fence_token + 1
    AND (OLD.state = 'released' OR OLD.lease_expires_at <= db_now)
    AND NEW.lease_expires_at > db_now
    AND (
      session_record.expires_at <= db_now
      OR db_now + INTERVAL '16 seconds' <= session_record.expires_at
    )
  THEN
    NEW.lease_expires_at := db_now + INTERVAL '16 seconds';
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  IF OLD.state = 'leased' AND NEW.state = 'consumed'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.terminal_at IS NOT NULL AND NEW.terminal_at <= db_now
    AND (
      (NEW.consumption_kind = 'session_expired' AND session_record.expires_at <= db_now)
      OR (NEW.consumption_kind <> 'session_expired'
          AND OLD.lease_expires_at > db_now AND session_record.expires_at > db_now)
    )
    AND validate_hns_owner_recovery_terminal_document(
      NEW.terminal_result_document, NEW.result_hash, NEW.terminal_result_version,
      NEW.route_revalidation_id, NEW.revalidation_session_id,
      NEW.route_revalidation_attempt_id, NEW.route_binding_id,
      NEW.expected_binding_generation, NEW.idempotency_key,
      NEW.completion_request_hash, NEW.consumption_kind
    )
  THEN NEW.updated_at := db_now; RETURN NEW; END IF;
  RAISE EXCEPTION 'owner recovery attempt transition is not allowed';
END;
$$;

CREATE OR REPLACE FUNCTION validate_hns_owner_recovery_attempt_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record community_route_revalidation_sessions%ROWTYPE;
  attempt_record community_route_revalidation_completion_attempts%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  consumed_count INTEGER;
  leased_count INTEGER;
BEGIN
  SELECT * INTO session_record FROM community_route_revalidation_sessions
   WHERE revalidation_session_id = NEW.revalidation_session_id;
  SELECT count(*) FILTER (WHERE state = 'consumed')::integer,
         count(*) FILTER (WHERE state = 'leased')::integer
    INTO consumed_count, leased_count
    FROM community_route_revalidation_completion_attempts
   WHERE revalidation_session_id = NEW.revalidation_session_id
     AND operation_mode = 'same_root_recovery';
  IF session_record.status = 'pending' AND consumed_count <> 0 THEN
    RAISE EXCEPTION 'pending owner recovery cannot have a consumed attempt';
  END IF;
  IF session_record.status IN ('completed', 'failed', 'expired')
    AND (consumed_count <> 1 OR leased_count <> 0)
  THEN RAISE EXCEPTION 'terminal owner recovery requires one consumed attempt'; END IF;
  IF session_record.status IN ('completed', 'failed', 'expired') THEN
    SELECT * INTO attempt_record
      FROM community_route_revalidation_completion_attempts
     WHERE revalidation_session_id = NEW.revalidation_session_id
       AND operation_mode = 'same_root_recovery'
       AND state = 'consumed';
    SELECT * INTO binding_record
      FROM community_canonical_route_bindings
     WHERE route_binding_id = session_record.route_binding_id
       AND community_id = session_record.community_id;
    IF attempt_record.route_revalidation_attempt_id IS NULL
      OR (
        attempt_record.consumption_kind = 'verified'
        AND session_record.status <> 'completed'
      )
      OR (
        attempt_record.consumption_kind = 'session_expired'
        AND session_record.status <> 'expired'
      )
      OR (
        attempt_record.consumption_kind NOT IN ('verified', 'session_expired')
        AND session_record.status <> 'failed'
      )
    THEN
      RAISE EXCEPTION 'terminal owner recovery status does not match its consumed attempt';
    END IF;
    IF attempt_record.consumption_kind <> 'stale_cas'
      AND (
        binding_record.route_binding_id IS NULL
        OR binding_record.binding_generation
             IS DISTINCT FROM session_record.expected_binding_generation + 1
        OR (
          attempt_record.consumption_kind = 'verified'
          AND (
            binding_record.verified_evidence_ref
                 IS DISTINCT FROM attempt_record.evidence_ref
            OR binding_record.ownership_status <> 'verified'
            OR binding_record.route_lifecycle_status <> 'active'
          )
        )
        OR (
          attempt_record.consumption_kind IN ('root_absent', 'root_inactive')
          AND (
            binding_record.verified_evidence_ref IS NOT NULL
            OR binding_record.ownership_status <> 'revoked'
            OR binding_record.route_lifecycle_status <> 'suspended'
          )
        )
        OR (
          attempt_record.consumption_kind IN (
            'expiry_horizon_insufficient', 'session_expired'
          )
          AND (
            binding_record.verified_evidence_ref IS NOT NULL
            OR binding_record.ownership_status <> 'expired'
            OR binding_record.route_lifecycle_status <> 'suspended'
          )
        )
        OR (
          attempt_record.consumption_kind = 'owner_authoritative_source_ineligible'
          AND (
            binding_record.verified_evidence_ref IS NOT NULL
            OR binding_record.ownership_status <> 'disputed'
            OR binding_record.route_lifecycle_status <> 'suspended'
          )
        )
      )
    THEN
      RAISE EXCEPTION 'terminal owner recovery binding does not match its consumed attempt';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_hns_owner_recovery_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ := clock_timestamp();
  session_record community_route_revalidation_sessions%ROWTYPE;
  attempt_record community_route_revalidation_completion_attempts%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
BEGIN
  NEW.created_at := db_now;
  SELECT * INTO session_record FROM community_route_revalidation_sessions
   WHERE route_revalidation_id = NEW.route_revalidation_id
     AND revalidation_session_id = NEW.revalidation_session_id FOR SHARE;
  SELECT * INTO attempt_record FROM community_route_revalidation_completion_attempts
   WHERE route_revalidation_attempt_id = NEW.route_revalidation_attempt_id FOR SHARE;
  SELECT * INTO binding_record FROM community_canonical_route_bindings
   WHERE route_binding_id = NEW.route_binding_id
     AND community_id = NEW.community_id FOR UPDATE;
  IF session_record.revalidation_session_id IS NULL
    OR session_record.operation_mode <> 'same_root_recovery'
    OR session_record.status <> 'completed'
    OR attempt_record.route_revalidation_attempt_id IS NULL
    OR attempt_record.operation_mode <> 'same_root_recovery'
    OR attempt_record.state <> 'consumed'
    OR attempt_record.consumption_kind <> 'verified'
    OR attempt_record.evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR attempt_record.fence_token IS DISTINCT FROM NEW.fence_token
    OR attempt_record.provider_response_sha256 IS DISTINCT FROM NEW.observation_sha256
    OR attempt_record.target_observation_contract_version
         IS DISTINCT FROM NEW.observation_contract_version
    OR attempt_record.target_response_status <> 'verified'
    OR session_record.community_id IS DISTINCT FROM NEW.community_id
    OR session_record.route_binding_id IS DISTINCT FROM NEW.route_binding_id
    OR session_record.principal_id IS DISTINCT FROM NEW.principal_id
    OR session_record.requirement_hash IS DISTINCT FROM NEW.requirement_hash
    OR session_record.expected_binding_generation
         IS DISTINCT FROM NEW.expected_binding_generation
    OR session_record.expected_verified_evidence_ref IS NOT NULL
    OR session_record.start_request_hash IS DISTINCT FROM NEW.start_request_hash
    OR session_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR session_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
    OR session_record.provider_configuration_kind
         IS DISTINCT FROM NEW.provider_configuration_kind
    OR session_record.provider_configuration_reference
         IS DISTINCT FROM NEW.provider_configuration_reference
    OR session_record.provider_configuration_version
         IS DISTINCT FROM NEW.provider_configuration_version
    OR session_record.provider_configuration_digest
         IS DISTINCT FROM NEW.provider_configuration_digest
    OR session_record.protocol_version IS DISTINCT FROM NEW.protocol_version
    OR session_record.environment IS DISTINCT FROM NEW.environment
    OR session_record.family IS DISTINCT FROM NEW.family
    OR session_record.root_label IS DISTINCT FROM NEW.root_label
    OR session_record.root_label_display IS DISTINCT FROM NEW.root_label_display
    OR session_record.path_segment IS DISTINCT FROM NEW.path_segment
    OR session_record.upstream_session_ref IS DISTINCT FROM NEW.upstream_session_ref
    OR session_record.recovery_authority_kind IS DISTINCT FROM NEW.recovery_authority_kind
    OR session_record.recovery_authority_reference
         IS DISTINCT FROM NEW.recovery_authority_reference
    OR session_record.public_start_hash IS DISTINCT FROM NEW.public_start_hash
    OR session_record.provider_start_hash IS DISTINCT FROM NEW.provider_start_hash
    OR session_record.challenge_expires_at IS DISTINCT FROM NEW.challenge_expires_at
    OR NEW.poll_hash IS DISTINCT FROM attempt_record.completion_request_hash
    OR binding_record.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR binding_record.verified_evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR binding_record.ownership_status <> 'verified'
    OR binding_record.route_lifecycle_status <> 'active'
    OR NEW.observed_at > db_now OR NEW.expires_at <= db_now
    OR encode(sha256(NEW.raw_response_bytes), 'hex') IS DISTINCT FROM NEW.observation_sha256
    OR NEW.observation ->> 'status' <> 'verified'
    OR NEW.observation ->> 'observation_contract_version'
         IS DISTINCT FROM NEW.observation_contract_version
    OR NEW.observation ->> 'ownership_source' IS DISTINCT FROM NEW.ownership_source
    OR NEW.observation ->> 'challenge_name' IS DISTINCT FROM NEW.challenge_name
    OR NEW.observation ->> 'expected_txt_value_sha256'
         IS DISTINCT FROM NEW.challenge_value_sha256
    OR NEW.observation ->> 'provider_evidence_ref'
         IS DISTINCT FROM NEW.provider_evidence_ref
  THEN
    RAISE EXCEPTION 'owner recovery snapshot does not match its committed authority';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER community_route_revalidation_start_guard
  ON community_route_revalidation_start_reservations;
CREATE TRIGGER community_route_revalidation_start_guard_legacy_change
BEFORE INSERT OR UPDATE ON community_route_revalidation_start_reservations
FOR EACH ROW WHEN (NEW.operation_mode = 'system_revalidation')
EXECUTE FUNCTION guard_community_route_revalidation_start();
CREATE TRIGGER community_route_revalidation_start_guard_legacy_delete
BEFORE DELETE ON community_route_revalidation_start_reservations
FOR EACH ROW WHEN (OLD.operation_mode = 'system_revalidation')
EXECUTE FUNCTION guard_community_route_revalidation_start();
CREATE TRIGGER community_route_revalidation_start_guard_owner_change
BEFORE INSERT OR UPDATE ON community_route_revalidation_start_reservations
FOR EACH ROW WHEN (NEW.operation_mode = 'same_root_recovery')
EXECUTE FUNCTION guard_hns_owner_recovery_start();
CREATE TRIGGER community_route_revalidation_start_guard_owner_delete
BEFORE DELETE ON community_route_revalidation_start_reservations
FOR EACH ROW WHEN (OLD.operation_mode = 'same_root_recovery')
EXECUTE FUNCTION guard_hns_owner_recovery_start();

DROP TRIGGER community_route_revalidation_session_insert_guard
  ON community_route_revalidation_sessions;
CREATE TRIGGER community_route_revalidation_session_insert_guard_legacy
BEFORE INSERT ON community_route_revalidation_sessions
FOR EACH ROW WHEN (NEW.operation_mode = 'system_revalidation')
EXECUTE FUNCTION validate_community_route_revalidation_session_insert();
CREATE TRIGGER community_route_revalidation_session_insert_guard_owner
BEFORE INSERT ON community_route_revalidation_sessions
FOR EACH ROW WHEN (NEW.operation_mode = 'same_root_recovery')
EXECUTE FUNCTION validate_hns_owner_recovery_session_insert();

DROP TRIGGER community_route_revalidation_session_change_guard
  ON community_route_revalidation_sessions;
CREATE TRIGGER community_route_revalidation_session_change_guard_legacy_update
BEFORE UPDATE ON community_route_revalidation_sessions
FOR EACH ROW WHEN (NEW.operation_mode = 'system_revalidation')
EXECUTE FUNCTION guard_community_route_revalidation_session_change();
CREATE TRIGGER community_route_revalidation_session_change_guard_legacy_delete
BEFORE DELETE ON community_route_revalidation_sessions
FOR EACH ROW WHEN (OLD.operation_mode = 'system_revalidation')
EXECUTE FUNCTION guard_community_route_revalidation_session_change();
CREATE TRIGGER community_route_revalidation_session_change_guard_owner_update
BEFORE UPDATE ON community_route_revalidation_sessions
FOR EACH ROW WHEN (NEW.operation_mode = 'same_root_recovery')
EXECUTE FUNCTION guard_hns_owner_recovery_session_change();
CREATE TRIGGER community_route_revalidation_session_change_guard_owner_delete
BEFORE DELETE ON community_route_revalidation_sessions
FOR EACH ROW WHEN (OLD.operation_mode = 'same_root_recovery')
EXECUTE FUNCTION guard_hns_owner_recovery_session_change();

DROP TRIGGER community_route_revalidation_attempt_guard
  ON community_route_revalidation_completion_attempts;
CREATE TRIGGER community_route_revalidation_attempt_guard_legacy_change
BEFORE INSERT OR UPDATE ON community_route_revalidation_completion_attempts
FOR EACH ROW WHEN (NEW.operation_mode = 'system_revalidation')
EXECUTE FUNCTION guard_community_route_revalidation_attempt();
CREATE TRIGGER community_route_revalidation_attempt_guard_legacy_delete
BEFORE DELETE ON community_route_revalidation_completion_attempts
FOR EACH ROW WHEN (OLD.operation_mode = 'system_revalidation')
EXECUTE FUNCTION guard_community_route_revalidation_attempt();
CREATE TRIGGER community_route_revalidation_attempt_guard_owner_change
BEFORE INSERT OR UPDATE ON community_route_revalidation_completion_attempts
FOR EACH ROW WHEN (NEW.operation_mode = 'same_root_recovery')
EXECUTE FUNCTION guard_hns_owner_recovery_attempt();
CREATE TRIGGER community_route_revalidation_attempt_guard_owner_delete
BEFORE DELETE ON community_route_revalidation_completion_attempts
FOR EACH ROW WHEN (OLD.operation_mode = 'same_root_recovery')
EXECUTE FUNCTION guard_hns_owner_recovery_attempt();

DROP TRIGGER community_route_revalidation_snapshot_insert_guard
  ON community_route_revalidation_evidence_snapshots;
CREATE TRIGGER community_route_revalidation_snapshot_insert_guard_legacy
BEFORE INSERT ON community_route_revalidation_evidence_snapshots
FOR EACH ROW WHEN (NEW.operation_mode = 'system_revalidation')
EXECUTE FUNCTION validate_community_route_revalidation_snapshot_insert();
CREATE TRIGGER community_route_revalidation_snapshot_insert_guard_owner
BEFORE INSERT ON community_route_revalidation_evidence_snapshots
FOR EACH ROW WHEN (NEW.operation_mode = 'same_root_recovery')
EXECUTE FUNCTION validate_hns_owner_recovery_snapshot_insert();

DROP TRIGGER community_route_revalidation_attempt_session_guard
  ON community_route_revalidation_completion_attempts;
DROP TRIGGER community_route_revalidation_session_attempt_guard
  ON community_route_revalidation_sessions;
CREATE CONSTRAINT TRIGGER community_route_revalidation_attempt_session_guard_legacy
AFTER INSERT OR UPDATE ON community_route_revalidation_completion_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.operation_mode = 'system_revalidation')
EXECUTE FUNCTION validate_community_route_revalidation_attempt_session();
CREATE CONSTRAINT TRIGGER community_route_revalidation_attempt_session_guard_owner
AFTER INSERT OR UPDATE ON community_route_revalidation_completion_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.operation_mode = 'same_root_recovery')
EXECUTE FUNCTION validate_hns_owner_recovery_attempt_coherence();
CREATE CONSTRAINT TRIGGER community_route_revalidation_session_attempt_guard_legacy
AFTER UPDATE ON community_route_revalidation_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.operation_mode = 'system_revalidation')
EXECUTE FUNCTION validate_community_route_revalidation_attempt_session();
CREATE CONSTRAINT TRIGGER community_route_revalidation_session_attempt_guard_owner
AFTER UPDATE ON community_route_revalidation_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.operation_mode = 'same_root_recovery')
EXECUTE FUNCTION validate_hns_owner_recovery_attempt_coherence();

CREATE UNIQUE INDEX community_route_revalidation_owner_reservation_id_uidx
  ON community_route_revalidation_start_reservations (start_reservation_id)
  WHERE operation_mode = 'same_root_recovery';

CREATE INDEX community_route_revalidation_owner_authority_idx
  ON community_route_revalidation_start_reservations (
    recovery_authority_kind, recovery_authority_reference
  )
  WHERE operation_mode = 'same_root_recovery';

ALTER TABLE community_route_revalidation_sessions
  DROP CONSTRAINT community_route_revalidation_sessions_principal_kind_check,
  DROP CONSTRAINT community_route_revalidation_sessions_protocol_version_check,
  ADD CONSTRAINT community_route_revalidation_sessions_authority_branch CHECK (
    (
      operation_mode = 'system_revalidation'
      AND principal_kind = 'system'
      AND protocol_version = 'hns-txt-v1'
      AND start_idempotency_key IS NULL
      AND recovery_authority_kind IS NULL
      AND recovery_authority_reference IS NULL
      AND public_start_hash IS NULL
      AND provider_start_hash IS NULL
      AND provider_configuration_digest IS NULL
      AND challenge_expires_at IS NULL
    )
    OR (
      operation_mode = 'same_root_recovery'
      AND principal_kind = 'user'
      AND provider_id = 'hns.owner.v1'
      AND protocol_version = 'hns-owner-recovery-v1'
      AND expected_verified_evidence_ref IS NULL
      AND btrim(start_idempotency_key) = start_idempotency_key
      AND octet_length(start_idempotency_key) BETWEEN 1 AND 256
      AND recovery_authority_kind IN (
        'database_time_expiry_transition', 'route_revalidation_terminal',
        'active_lease_renewal_terminal', 'owner_recovery_terminal'
      )
      AND btrim(recovery_authority_reference) = recovery_authority_reference
      AND octet_length(recovery_authority_reference) BETWEEN 1 AND 512
      AND public_start_hash ~ '^[0-9a-f]{64}$'
      AND provider_start_hash ~ '^[0-9a-f]{64}$'
      AND provider_configuration_digest ~ '^[0-9a-f]{64}$'
      AND challenge_expires_at = expires_at
    )
  );

CREATE INDEX community_route_revalidation_owner_open_sessions_idx
  ON community_route_revalidation_sessions (status, challenge_expires_at, route_binding_id)
  WHERE operation_mode = 'same_root_recovery' AND status = 'pending';

ALTER TABLE community_route_revalidation_completion_attempts
  DROP CONSTRAINT community_route_revalidation_completion__consumption_kind_check,
  DROP CONSTRAINT community_route_revalidation_attempts_result_shape,
  ADD CONSTRAINT community_route_revalidation_completion_consumption_kind_check CHECK (
    consumption_kind IN (
      'verified', 'missing_root', 'control_failed', 'challenge_mismatch',
      'insufficient_expiry', 'disputed', 'revoked', 'database_time_expired',
      'root_absent', 'root_inactive', 'expiry_horizon_insufficient',
      'session_expired', 'stale_cas', 'owner_authoritative_source_ineligible'
    )
  ),
  ADD CONSTRAINT community_route_revalidation_attempts_result_shape_v2 CHECK (
    (
      state IN ('leased', 'released')
      AND consumption_kind IS NULL
      AND result_hash IS NULL
      AND terminal_result_document IS NULL
      AND terminal_result_version IS NULL
      AND terminal_observed_expires_at IS NULL
      AND terminal_at IS NULL
      AND target_observation_contract_version IS NULL
      AND target_response_status IS NULL
      AND provider_response_sha256 IS NULL
      AND raw_provider_response_bytes IS NULL
    )
    OR (
      state = 'consumed'
      AND consumption_kind IS NOT NULL
      AND terminal_at IS NOT NULL
      AND (
        (
          consumption_kind = 'challenge_mismatch'
          AND operation_mode = 'system_revalidation'
          AND result_hash IS NULL
          AND terminal_result_document IS NULL
          AND terminal_result_version IS NULL
          AND terminal_observed_expires_at IS NULL
          AND target_observation_contract_version IS NULL
          AND target_response_status IS NULL
          AND provider_response_sha256 IS NULL
          AND raw_provider_response_bytes IS NULL
        )
        OR (
          result_hash ~ '^[0-9a-f]{64}$'
          AND terminal_result_document IS NOT NULL
          AND (
            (
              operation_mode = 'system_revalidation'
              AND terminal_result_version IS NULL
            )
            OR (
              operation_mode = 'same_root_recovery'
              AND terminal_result_version IS NOT NULL
            )
          )
          AND (
            (consumption_kind = 'database_time_expired' AND terminal_observed_expires_at IS NOT NULL)
            OR (consumption_kind <> 'database_time_expired' AND terminal_observed_expires_at IS NULL)
          )
          AND (
            (
              target_observation_contract_version IS NULL
              AND target_response_status IS NULL
              AND provider_response_sha256 IS NULL
              AND raw_provider_response_bytes IS NULL
            )
            OR (
              operation_mode = 'same_root_recovery'
              AND target_observation_contract_version IN (
                'pirate-hns-target-observation-v2',
                'pirate-hns-target-observation-v3'
              )
              AND target_response_status IN ('verified', 'rejected', 'ineligible')
              AND provider_response_sha256 ~ '^[0-9a-f]{64}$'
              AND octet_length(raw_provider_response_bytes) BETWEEN 1 AND 1048576
              AND encode(sha256(raw_provider_response_bytes), 'hex') = provider_response_sha256
            )
          )
        )
      )
    )
  ),
  ADD CONSTRAINT community_route_revalidation_attempts_operation_branch CHECK (
    (
      operation_mode = 'system_revalidation'
      AND observation_id IS NULL
      AND (
        terminal_result_version IS NULL
        OR terminal_result_version = 'pirate-hns-route-revalidation-result-v1'
      )
    )
    OR (
      operation_mode = 'same_root_recovery'
      AND btrim(observation_id) = observation_id
      AND octet_length(observation_id) BETWEEN 1 AND 256
      AND (
        terminal_result_version IS NULL
        OR terminal_result_version IN (
          'pirate-hns-owner-recovery-result-v1',
          'pirate-hns-owner-recovery-result-v2'
        )
      )
    )
  );

ALTER TABLE community_route_revalidation_evidence_snapshots
  DROP CONSTRAINT community_route_revalidation_evidence_snap_principal_kind_check,
  DROP CONSTRAINT community_route_revalidation_evidence_sn_protocol_version_check,
  DROP CONSTRAINT community_route_revalidation_evidence_snapsho_abi_version_check,
  ADD CONSTRAINT community_route_revalidation_snapshot_authority_branch CHECK (
    (
      operation_mode = 'system_revalidation'
      AND principal_kind = 'system'
      AND protocol_version = 'hns-txt-v1'
      AND abi_version = 'pirate-hns-route-revalidation-evidence-v1'
      AND recovery_authority_kind IS NULL
      AND recovery_authority_reference IS NULL
      AND public_start_hash IS NULL
      AND provider_start_hash IS NULL
      AND poll_hash IS NULL
      AND provider_configuration_digest IS NULL
      AND challenge_expires_at IS NULL
      AND observation_contract_version IS NULL
    )
    OR (
      operation_mode = 'same_root_recovery'
      AND principal_kind = 'user'
      AND provider_id = 'hns.owner.v1'
      AND protocol_version = 'hns-owner-recovery-v1'
      AND expected_verified_evidence_ref IS NULL
      AND abi_version = 'pirate-hns-owner-recovery-evidence-v1'
      AND recovery_authority_kind IN (
        'database_time_expiry_transition', 'route_revalidation_terminal',
        'active_lease_renewal_terminal', 'owner_recovery_terminal'
      )
      AND btrim(recovery_authority_reference) = recovery_authority_reference
      AND public_start_hash ~ '^[0-9a-f]{64}$'
      AND provider_start_hash ~ '^[0-9a-f]{64}$'
      AND poll_hash ~ '^[0-9a-f]{64}$'
      AND provider_configuration_digest ~ '^[0-9a-f]{64}$'
      AND challenge_expires_at > observed_at
      AND observation_contract_version IN (
        'pirate-hns-target-observation-v2', 'pirate-hns-target-observation-v3'
      )
    )
  );
