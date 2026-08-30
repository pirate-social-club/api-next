-- Promote an operator-managed HNS route from one exact reviewed authority
-- candidate. This is an exceptional bridge for roots already under platform
-- custody; self-service roots continue to use the ownership ceremony.

CREATE TABLE hns_operator_control_promotion_receipts (
  receipt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  operator_principal_id TEXT NOT NULL,
  operator_authority_grant_id TEXT NOT NULL
    REFERENCES platform_operator_route_authority_grants (grant_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  route_binding_id TEXT NOT NULL,
  operator_route_activation_id TEXT NOT NULL
    REFERENCES operator_managed_route_activations (operator_route_activation_id),
  canonical_root TEXT NOT NULL,
  candidate_sha256 TEXT NOT NULL CHECK (candidate_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_bytes BYTEA NOT NULL,
  observer_evidence_sha256 TEXT NOT NULL
    CHECK (observer_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  observer_evidence_reference TEXT NOT NULL,
  dns_zone_activation_id TEXT NOT NULL,
  dns_zone_activation_generation BIGINT NOT NULL,
  app_host_activation_id TEXT NOT NULL,
  prior_app_host_activation_generation BIGINT NOT NULL,
  promoted_app_host_activation_generation BIGINT NOT NULL,
  promoted_binding_generation BIGINT NOT NULL,
  evidence_ref TEXT NOT NULL UNIQUE,
  verified_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (operator_principal_id, idempotency_key),
  CONSTRAINT hns_operator_control_promotion_receipt_identity_check CHECK (
    is_hns_host_persistence_identity(receipt_id, 256)
    AND is_hns_host_persistence_identity(operation_id, 256)
    AND is_hns_host_persistence_identity(operator_principal_id, 512)
    AND is_hns_host_persistence_identity(idempotency_key, 512)
    AND is_community_route_root_label('hns', canonical_root)
    AND is_hns_host_persistence_identity(observer_evidence_reference, 424)
    AND is_hns_host_persistence_identity(dns_zone_activation_id, 256)
    AND is_hns_host_persistence_identity(app_host_activation_id, 256)
    AND is_hns_host_persistence_identity(evidence_ref, 512)
  ),
  CONSTRAINT hns_operator_control_promotion_receipt_generation_check CHECK (
    dns_zone_activation_generation BETWEEN 1 AND 9007199254740991
    AND prior_app_host_activation_generation BETWEEN 1 AND 9007199254740990
    AND promoted_app_host_activation_generation = prior_app_host_activation_generation + 1
    AND promoted_binding_generation BETWEEN 2 AND 9007199254740991
  ),
  -- Preserve the explicit size-range grouping so pg_get_constraintdef output
  -- remains stable when the generated baseline is loaded into PostgreSQL 17.
  CONSTRAINT hns_operator_control_promotion_receipt_bytes_check CHECK (
    (
      octet_length(candidate_bytes) >= 1
      AND octet_length(candidate_bytes) <= 1048576
    )
    AND encode(sha256(candidate_bytes), 'hex') = candidate_sha256
  ),
  CONSTRAINT hns_operator_control_promotion_receipt_time_check CHECK (
    verified_at <= committed_at
    AND expires_at > committed_at
  )
);

CREATE FUNCTION reject_hns_operator_control_promotion_receipt_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HNS operator control promotion receipts are append-only';
END;
$$;

CREATE TRIGGER hns_operator_control_promotion_receipts_change_guard
BEFORE UPDATE OR DELETE ON hns_operator_control_promotion_receipts
FOR EACH ROW EXECUTE FUNCTION reject_hns_operator_control_promotion_receipt_change();

ALTER TABLE community_route_ownership_evidence
  ADD COLUMN operator_control_promotion_receipt_id TEXT;

ALTER TABLE community_route_ownership_evidence
  DROP CONSTRAINT community_route_ownership_evidence_origin_shape,
  ADD CONSTRAINT community_route_ownership_evidence_origin_shape CHECK (
    (
      origin = 'creation_ceremony'
      AND creation_ceremony_intent_id IS NOT NULL
      AND route_revalidation_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND verified_by_actor_id IS NOT NULL
    )
    OR (
      origin = 'route_revalidation'
      AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NOT NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND verified_by_actor_id IS NULL
    )
    OR (
      origin = 'route_attachment'
      AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NOT NULL
      AND operator_control_promotion_receipt_id IS NULL
      AND verified_by_actor_id IS NOT NULL
    )
    OR (
      origin = 'operator_control_observation'
      AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND operator_control_promotion_receipt_id IS NOT NULL
      AND verified_by_actor_id IS NULL
      AND family = 'hns'
    )
  ),
  ADD CONSTRAINT community_route_ownership_evidence_operator_control_receipt_fk
    FOREIGN KEY (operator_control_promotion_receipt_id)
    REFERENCES hns_operator_control_promotion_receipts (receipt_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX community_route_ownership_evidence_operator_control_receipt_uidx
  ON community_route_ownership_evidence (operator_control_promotion_receipt_id)
  WHERE origin = 'operator_control_observation';

ALTER TABLE community_route_operator_override_audit
  DROP CONSTRAINT community_route_operator_override_audit_action_kind_check,
  ADD CONSTRAINT community_route_operator_override_audit_action_kind_check CHECK (
    action_kind IN (
      'attachment_intent_created',
      'attachment_committed',
      'operator_route_activated',
      'operator_route_revoked',
      'operator_route_promoted'
    )
  );

CREATE OR REPLACE FUNCTION guard_community_canonical_route_binding_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authority_changed BOOLEAN;
  operator_promotion BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'community canonical route binding is immutable';
  END IF;

  IF ROW(
    NEW.route_binding_id,
    NEW.community_id,
    NEW.family,
    NEW.root_label,
    NEW.root_label_display,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.route_binding_id,
    OLD.community_id,
    OLD.family,
    OLD.root_label,
    OLD.root_label_display,
    OLD.created_at
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

  IF ROW(
    NEW.route_authority_kind,
    NEW.authority_reference
  ) IS DISTINCT FROM ROW(
    OLD.route_authority_kind,
    OLD.authority_reference
  ) AND NOT operator_promotion THEN
    RAISE EXCEPTION 'community canonical route identity is immutable';
  END IF;

  authority_changed := ROW(
    NEW.ownership_status,
    NEW.route_lifecycle_status,
    NEW.verified_evidence_ref,
    NEW.route_authority_kind,
    NEW.authority_reference,
    NEW.authority_generation
  ) IS DISTINCT FROM ROW(
    OLD.ownership_status,
    OLD.route_lifecycle_status,
    OLD.verified_evidence_ref,
    OLD.route_authority_kind,
    OLD.authority_reference,
    OLD.authority_generation
  );

  IF authority_changed AND NEW.binding_generation <> OLD.binding_generation + 1 THEN
    RAISE EXCEPTION 'community canonical route generation must advance exactly once';
  END IF;
  IF NOT authority_changed AND NEW.binding_generation <> OLD.binding_generation THEN
    RAISE EXCEPTION 'community canonical route generation cannot advance without authority change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION promote_operator_managed_route_from_hns_candidate_v1(
  input_receipt_id TEXT,
  input_operation_id TEXT,
  input_operator_principal_id TEXT,
  input_operator_authority_grant_id TEXT,
  input_idempotency_key TEXT,
  input_request_hash TEXT,
  input_community_id TEXT,
  input_route_binding_id TEXT,
  input_operator_route_activation_id TEXT,
  input_evidence_ref TEXT,
  input_candidate_bytes BYTEA
)
RETURNS TABLE (
  outcome TEXT,
  receipt_id TEXT,
  evidence_ref TEXT,
  route_binding_id TEXT,
  binding_generation BIGINT,
  app_host_activation_generation BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  database_now TIMESTAMPTZ := clock_timestamp();
  candidate JSONB;
  dns_artifact JSONB;
  app_artifact JSONB;
  health_artifact JSONB;
  inventory_artifact JSONB;
  evidence_artifact JSONB;
  dns_document JSONB;
  app_document JSONB;
  health_document JSONB;
  observer_evidence JSONB;
  dns_artifact_bytes BYTEA;
  app_artifact_bytes BYTEA;
  health_artifact_bytes BYTEA;
  inventory_artifact_bytes BYTEA;
  evidence_artifact_bytes BYTEA;
  candidate_digest TEXT;
  evidence_digest TEXT;
  candidate_root TEXT;
  candidate_dns_generation BIGINT;
  candidate_app_generation BIGINT;
  candidate_health_generation BIGINT;
  evidence_expiry TIMESTAMPTZ;
  retained_receipt hns_operator_control_promotion_receipts%ROWTYPE;
  authority_grant platform_operator_route_authority_grants%ROWTYPE;
  activation operator_managed_route_activations%ROWTYPE;
  binding community_canonical_route_bindings%ROWTYPE;
  dns_current hns_dns_zone_activation_current%ROWTYPE;
  dns_revision hns_dns_zone_activation_revisions%ROWTYPE;
  app_current hns_community_app_host_activation_current%ROWTYPE;
  app_revision hns_community_app_host_activation_revisions%ROWTYPE;
  health hns_dns_zone_health_observations%ROWTYPE;
  inventory hns_authority_inventories%ROWTYPE;
  app_refresh RECORD;
BEGIN
  SELECT * INTO retained_receipt
    FROM hns_operator_control_promotion_receipts
   WHERE operator_principal_id = input_operator_principal_id
     AND idempotency_key = input_idempotency_key;
  IF retained_receipt.receipt_id IS NOT NULL THEN
    IF retained_receipt.receipt_id <> input_receipt_id
      OR retained_receipt.operation_id <> input_operation_id
      OR retained_receipt.operator_authority_grant_id <> input_operator_authority_grant_id
      OR retained_receipt.request_hash <> input_request_hash
      OR retained_receipt.community_id <> input_community_id
      OR retained_receipt.route_binding_id <> input_route_binding_id
      OR retained_receipt.operator_route_activation_id <> input_operator_route_activation_id
      OR retained_receipt.evidence_ref <> input_evidence_ref
      OR retained_receipt.candidate_bytes <> input_candidate_bytes THEN
      RAISE EXCEPTION 'HNS operator control promotion idempotency conflict';
    END IF;
    RETURN QUERY SELECT
      'replayed'::TEXT,
      retained_receipt.receipt_id,
      retained_receipt.evidence_ref,
      retained_receipt.route_binding_id,
      retained_receipt.promoted_binding_generation,
      retained_receipt.promoted_app_host_activation_generation;
    RETURN;
  END IF;

  IF NOT is_hns_host_persistence_identity(input_receipt_id, 256)
    OR NOT is_hns_host_persistence_identity(input_operation_id, 256)
    OR NOT is_hns_host_persistence_identity(input_operator_principal_id, 512)
    OR NOT is_hns_host_persistence_identity(input_idempotency_key, 512)
    OR input_request_hash !~ '^[0-9a-f]{64}$'
    OR NOT is_hns_host_persistence_identity(input_evidence_ref, 512)
    OR input_candidate_bytes IS NULL
    OR octet_length(input_candidate_bytes) NOT BETWEEN 1 AND 1048576 THEN
    RAISE EXCEPTION 'HNS operator control promotion input is invalid';
  END IF;

  candidate_digest := encode(sha256(input_candidate_bytes), 'hex');
  BEGIN
    candidate := convert_from(input_candidate_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'HNS operator control promotion candidate is invalid';
  END;
  IF jsonb_typeof(candidate) <> 'object'
    OR candidate ->> 'version' <> 'pirate-hns-authority-successor-candidate-v1'
    OR candidate ->> 'source_commit' !~ '^[0-9a-f]{40}$'
    OR candidate ->> 'root_label' IS NULL
    OR candidate ->> 'observed_at' IS NULL
    OR (candidate ->> 'observed_at')::TIMESTAMPTZ > database_now
    OR jsonb_typeof(candidate -> 'generations') <> 'object'
    OR (candidate -> 'generations' ->> 'dns_activation_generation') !~ '^[1-9][0-9]*$'
    OR (candidate -> 'generations' ->> 'app_host_activation_generation') !~ '^[1-9][0-9]*$'
    OR (candidate -> 'generations' ->> 'health_generation') !~ '^[1-9][0-9]*$'
    OR jsonb_typeof(candidate -> 'artifacts') <> 'array'
    OR jsonb_array_length(candidate -> 'artifacts') <> 5
    OR (SELECT count(DISTINCT artifact ->> 'name')
          FROM jsonb_array_elements(candidate -> 'artifacts') AS artifact) <> 5
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(candidate -> 'artifacts') AS artifact
       WHERE artifact ->> 'name' NOT IN (
         'authority_inventory',
         'dns_zone_activation',
         'app_host_activation',
         'health_observation',
         'observer_evidence'
       )
          OR artifact ->> 'sha256' !~ '^[0-9a-f]{64}$'
          OR artifact ->> 'bytes_hex' !~ '^([0-9a-f]{2})+$'
          OR encode(sha256(decode(artifact ->> 'bytes_hex', 'hex')), 'hex')
             <> artifact ->> 'sha256'
    ) THEN
    RAISE EXCEPTION 'HNS operator control promotion candidate is invalid';
  END IF;

  SELECT artifact INTO inventory_artifact
    FROM jsonb_array_elements(candidate -> 'artifacts') AS artifact
   WHERE artifact ->> 'name' = 'authority_inventory';
  SELECT artifact INTO dns_artifact
    FROM jsonb_array_elements(candidate -> 'artifacts') AS artifact
   WHERE artifact ->> 'name' = 'dns_zone_activation';
  SELECT artifact INTO app_artifact
    FROM jsonb_array_elements(candidate -> 'artifacts') AS artifact
   WHERE artifact ->> 'name' = 'app_host_activation';
  SELECT artifact INTO health_artifact
    FROM jsonb_array_elements(candidate -> 'artifacts') AS artifact
   WHERE artifact ->> 'name' = 'health_observation';
  SELECT artifact INTO evidence_artifact
    FROM jsonb_array_elements(candidate -> 'artifacts') AS artifact
   WHERE artifact ->> 'name' = 'observer_evidence';
  inventory_artifact_bytes := decode(inventory_artifact ->> 'bytes_hex', 'hex');
  dns_artifact_bytes := decode(dns_artifact ->> 'bytes_hex', 'hex');
  app_artifact_bytes := decode(app_artifact ->> 'bytes_hex', 'hex');
  health_artifact_bytes := decode(health_artifact ->> 'bytes_hex', 'hex');
  evidence_artifact_bytes := decode(evidence_artifact ->> 'bytes_hex', 'hex');
  evidence_digest := evidence_artifact ->> 'sha256';
  BEGIN
    dns_document := convert_from(dns_artifact_bytes, 'UTF8')::jsonb;
    app_document := convert_from(app_artifact_bytes, 'UTF8')::jsonb;
    health_document := convert_from(health_artifact_bytes, 'UTF8')::jsonb;
    observer_evidence := convert_from(evidence_artifact_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'HNS operator control promotion artifact is invalid';
  END;

  candidate_root := candidate ->> 'root_label';
  candidate_dns_generation :=
    (candidate -> 'generations' ->> 'dns_activation_generation')::BIGINT;
  candidate_app_generation :=
    (candidate -> 'generations' ->> 'app_host_activation_generation')::BIGINT;
  candidate_health_generation :=
    (candidate -> 'generations' ->> 'health_generation')::BIGINT;

  IF dns_document ->> 'version' <> 'pirate-hns-dns-zone-persistence-document-v1'
    OR app_document ->> 'version' <> 'pirate-hns-app-host-transition-document-v1'
    OR health_document ->> 'version' <> 'pirate-hns-dns-health-document-v1'
    OR observer_evidence ->> 'version'
       <> 'pirate-hns-authority-detached-observer-evidence-v1'
    OR observer_evidence ->> 'status' <> 'verified'
    OR observer_evidence ->> 'root_label' <> candidate_root
    OR observer_evidence ->> 'root_exists' <> 'true'
    OR observer_evidence ->> 'root_control_verified' <> 'true'
    OR observer_evidence ->> 'expiry_horizon_sufficient' <> 'true'
    OR observer_evidence ->> 'chain_authority_digest'
       <> candidate ->> 'chain_authority_digest'
    OR observer_evidence ->> 'chain_anchor_height' <> candidate ->> 'chain_height'
    OR dns_document ->> 'canonical_root' <> candidate_root
    OR dns_document ->> 'stable_chain_delegation_snapshot_reference'
       <> observer_evidence ->> 'evidence_reference'
    OR dns_document ->> 'stable_chain_delegation_snapshot_digest'
       <> observer_evidence ->> 'chain_authority_digest'
    OR (dns_document ->> 'dns_authority_generation')::BIGINT
       <> candidate_dns_generation
    OR (app_document ->> 'expected_activation_generation')::BIGINT + 1
       <> candidate_app_generation
    OR app_document ->> 'target_status' <> 'active'
    OR (health_document ->> 'activation_generation')::BIGINT
       <> candidate_dns_generation
    OR (health_document ->> 'expected_health_generation')::BIGINT + 1
       <> candidate_health_generation
    OR health_document ->> 'delegation_matches' <> 'true'
    OR health_document ->> 'ds_authenticates_zone' <> 'true'
    OR health_document ->> 'retained_zone_digest_matches' <> 'true'
    OR health_document ->> 'gateway_healthy' <> 'true' THEN
    RAISE EXCEPTION 'HNS operator control promotion artifact semantics mismatch';
  END IF;

  SELECT * INTO authority_grant
    FROM platform_operator_route_authority_grants
   WHERE grant_id = input_operator_authority_grant_id
   FOR SHARE;
  IF authority_grant.grant_id IS NULL
    OR authority_grant.operator_principal_id <> input_operator_principal_id
    OR authority_grant.authority <> 'manage_operator_routes'
    OR authority_grant.status <> 'active' THEN
    RAISE EXCEPTION 'HNS operator control promotion authority is unavailable';
  END IF;

  SELECT * INTO activation
    FROM operator_managed_route_activations
   WHERE operator_route_activation_id = input_operator_route_activation_id
   FOR UPDATE;
  SELECT * INTO binding
    FROM community_canonical_route_bindings AS selected_binding
   WHERE selected_binding.route_binding_id = input_route_binding_id
   FOR UPDATE;
  IF activation.operator_route_activation_id IS NULL
    OR activation.status <> 'active'
    OR activation.operator_principal_id <> input_operator_principal_id
    OR activation.operator_authority_grant_id <> input_operator_authority_grant_id
    OR activation.community_id <> input_community_id
    OR activation.route_binding_id <> input_route_binding_id
    OR activation.canonical_root <> candidate_root
    OR binding.route_binding_id IS NULL
    OR binding.community_id <> input_community_id
    OR binding.family <> 'hns'
    OR binding.root_label <> candidate_root
    OR binding.route_authority_kind <> 'operator_managed_route_v1'
    OR binding.authority_reference <> input_operator_route_activation_id
    OR binding.authority_generation <> activation.operator_route_activation_generation
    OR binding.route_lifecycle_status <> 'active'
    OR binding.verified_evidence_ref IS NOT NULL THEN
    RAISE EXCEPTION 'HNS operator control promotion route fence does not match';
  END IF;

  SELECT * INTO dns_current
    FROM hns_dns_zone_activation_current
   WHERE dns_zone_activation_id = dns_document ->> 'dns_zone_activation_id'
     AND canonical_root = candidate_root
   FOR SHARE;
  SELECT * INTO dns_revision
    FROM hns_dns_zone_activation_revisions
   WHERE dns_zone_activation_id = dns_current.dns_zone_activation_id
     AND dns_zone_activation_generation = dns_current.current_generation
   FOR SHARE;
  SELECT * INTO inventory
    FROM hns_authority_inventories
   WHERE authority_inventory_reference =
         dns_revision.pirate_dns_authority_inventory_reference
     AND authority_inventory_version =
         dns_revision.pirate_dns_authority_inventory_version
     AND authority_inventory_digest =
         dns_revision.pirate_dns_authority_inventory_digest
   FOR SHARE;
  SELECT * INTO health
    FROM hns_dns_zone_health_observations
   WHERE dns_zone_activation_id = dns_current.dns_zone_activation_id
     AND activation_generation = dns_current.current_generation
   ORDER BY health_generation DESC
   LIMIT 1
   FOR SHARE;
  SELECT * INTO app_current
    FROM hns_community_app_host_activation_current
   WHERE normalized_host = 'app.' || candidate_root
     AND community_id = input_community_id
   FOR UPDATE;
  SELECT * INTO app_revision
    FROM hns_community_app_host_activation_revisions AS selected_app_revision
   WHERE selected_app_revision.app_host_activation_id = app_current.app_host_activation_id
     AND selected_app_revision.app_host_activation_generation = app_current.current_generation
   FOR SHARE;

  IF dns_current.dns_zone_activation_id IS NULL
    OR dns_current.current_generation <> candidate_dns_generation
    OR dns_revision.status <> 'active'
    OR dns_revision.activation_document_bytes
       <> decode(dns_document ->> 'activation_document_bytes_hex', 'hex')
    OR dns_revision.zone_bytes <> decode(dns_document ->> 'zone_bytes_hex', 'hex')
    OR dns_revision.zone_bytes_digest <> dns_document ->> 'zone_bytes_digest'
    OR dns_revision.stable_chain_delegation_snapshot_reference
       <> observer_evidence ->> 'evidence_reference'
    OR dns_revision.stable_chain_delegation_snapshot_digest
       <> observer_evidence ->> 'chain_authority_digest'
    OR inventory.inventory_bytes <> inventory_artifact_bytes
    OR inventory.expires_at <= database_now
    OR health.health_generation <> candidate_health_generation
    OR health.valid_until <= database_now
    OR health.observed_zone_bytes_digest <> dns_revision.zone_bytes_digest
    OR health.observed_dnssec_keyset_reference <> dns_revision.dnssec_keyset_reference
    OR health.observed_dnssec_keyset_version <> dns_revision.dnssec_keyset_version
    OR health.observed_gateway_deployment_reference
       <> dns_revision.gateway_deployment_reference
    OR health.observed_gateway_certificate_spki_sha256
       <> dns_revision.gateway_certificate_spki_sha256
    OR NOT health.delegation_matches
    OR NOT health.ds_authenticates_zone
    OR NOT health.retained_zone_digest_matches
    OR NOT health.gateway_healthy
    OR app_current.app_host_activation_id IS NULL
    OR app_current.current_generation <> candidate_app_generation
    OR app_revision.status <> 'active'
    OR app_revision.dns_zone_activation_id <> dns_current.dns_zone_activation_id
    OR app_revision.dns_zone_activation_generation <> dns_current.current_generation
    OR app_revision.gateway_deployment_reference <> dns_revision.gateway_deployment_reference THEN
    RAISE EXCEPTION 'HNS operator control promotion current authority mismatch';
  END IF;

  evidence_expiry := LEAST(inventory.expires_at, health.valid_until);
  IF evidence_expiry <= database_now THEN
    RAISE EXCEPTION 'HNS operator control promotion evidence is expired';
  END IF;

  INSERT INTO hns_operator_control_promotion_receipts (
    receipt_id,
    operation_id,
    operator_principal_id,
    operator_authority_grant_id,
    idempotency_key,
    request_hash,
    community_id,
    route_binding_id,
    operator_route_activation_id,
    canonical_root,
    candidate_sha256,
    candidate_bytes,
    observer_evidence_sha256,
    observer_evidence_reference,
    dns_zone_activation_id,
    dns_zone_activation_generation,
    app_host_activation_id,
    prior_app_host_activation_generation,
    promoted_app_host_activation_generation,
    promoted_binding_generation,
    evidence_ref,
    verified_at,
    expires_at,
    committed_at
  ) VALUES (
    input_receipt_id,
    input_operation_id,
    input_operator_principal_id,
    input_operator_authority_grant_id,
    input_idempotency_key,
    input_request_hash,
    input_community_id,
    input_route_binding_id,
    input_operator_route_activation_id,
    candidate_root,
    candidate_digest,
    input_candidate_bytes,
    evidence_digest,
    observer_evidence ->> 'evidence_reference',
    dns_current.dns_zone_activation_id,
    dns_current.current_generation,
    app_current.app_host_activation_id,
    app_current.current_generation,
    app_current.current_generation + 1,
    binding.binding_generation + 1,
    input_evidence_ref,
    database_now,
    evidence_expiry,
    database_now
  );

  INSERT INTO community_route_ownership_evidence (
    evidence_ref,
    creation_ceremony_intent_id,
    verified_by_actor_id,
    family,
    root_label,
    root_label_display,
    path_segment,
    requirement_hash,
    provider_id,
    provider_binding_hash,
    provider_configuration_version,
    provider_identity_digest,
    evidence_digest,
    evidence_receipt_id,
    binding_generation,
    verified_at,
    expires_at,
    created_at,
    origin,
    route_revalidation_attempt_id,
    route_attachment_ceremony_intent_id,
    operator_control_promotion_receipt_id
  ) VALUES (
    input_evidence_ref,
    NULL,
    NULL,
    'hns',
    candidate_root,
    binding.root_label_display,
    binding.path_segment,
    observer_evidence ->> 'expected_txt_value_sha256',
    observer_evidence ->> 'provider_id',
    observer_evidence ->> 'provider_configuration_digest',
    observer_evidence ->> 'provider_configuration_version',
    observer_evidence ->> 'control_identity_digest',
    evidence_digest,
    NULL,
    binding.binding_generation + 1,
    database_now,
    evidence_expiry,
    database_now,
    'operator_control_observation',
    NULL,
    NULL,
    input_receipt_id
  );

  UPDATE operator_managed_route_activations
     SET status = 'revoked',
         reason_code = 'promoted-to-verified',
         revoked_at = database_now,
         operator_route_activation_generation = operator_route_activation_generation + 1
   WHERE operator_route_activation_id = input_operator_route_activation_id;

  UPDATE community_canonical_route_bindings AS promoted_binding
     SET route_authority_kind = 'verified_namespace_v1',
         authority_reference = NULL,
         authority_generation = NULL,
         ownership_status = 'verified',
         verified_evidence_ref = input_evidence_ref,
         binding_generation = promoted_binding.binding_generation + 1,
         updated_at = database_now
   WHERE promoted_binding.route_binding_id = input_route_binding_id;

  SELECT * INTO app_refresh
    FROM change_hns_community_app_host_status_v1(
      'hns-root-promotion:app:' || candidate_digest,
      'hns-root-promotion:app:' || candidate_digest,
      candidate_digest,
      app_current.app_host_activation_id,
      app_current.current_generation,
      'active',
      'verified-authority-promotion'
    );
  IF app_refresh.outcome NOT IN ('changed', 'replayed')
    OR app_refresh.app_host_activation_generation <> app_current.current_generation + 1 THEN
    RAISE EXCEPTION 'HNS operator control promotion app-host refresh failed';
  END IF;

  INSERT INTO community_route_operator_override_audit (
    override_audit_id,
    community_id,
    operator_principal_id,
    action_kind,
    reason,
    request_hash,
    occurred_at
  ) VALUES (
    input_operation_id,
    input_community_id,
    input_operator_principal_id,
    'operator_route_promoted',
    'reviewed-authority-candidate',
    input_request_hash,
    database_now
  );

  RETURN QUERY SELECT
    'promoted'::TEXT,
    input_receipt_id,
    input_evidence_ref,
    input_route_binding_id,
    binding.binding_generation + 1,
    app_current.current_generation + 1;
END;
$$;

COMMENT ON FUNCTION promote_operator_managed_route_from_hns_candidate_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BYTEA
) IS
  'Atomically promotes one operator-managed HNS route from exact reviewed candidate bytes and refreshes its active app-host authority.';
