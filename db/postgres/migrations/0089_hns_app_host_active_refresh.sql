-- Permit a reviewed active app-host generation to refresh its DNS, gateway,
-- and route bindings while retaining the existing lifecycle transitions.
CREATE OR REPLACE FUNCTION change_hns_community_app_host_status_v1(
  input_operation_id TEXT,
  input_idempotency_key TEXT,
  input_request_hash TEXT,
  input_app_host_activation_id TEXT,
  input_expected_activation_generation BIGINT,
  input_target_status TEXT,
  input_reason_code TEXT
)
RETURNS TABLE(
  outcome TEXT,
  app_host_activation_id TEXT,
  app_host_activation_generation BIGINT,
  status TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  replay hns_community_app_host_operations%ROWTYPE;
  current_record hns_community_app_host_activation_current%ROWTYPE;
  prior hns_community_app_host_activation_revisions%ROWTYPE;
  route RECORD;
  dns_current hns_dns_zone_activation_current%ROWTYPE;
  dns_revision hns_dns_zone_activation_revisions%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  new_generation BIGINT := input_expected_activation_generation + 1;
  next_route_kind TEXT;
  next_route_reference TEXT;
  next_route_generation BIGINT;
BEGIN
  SELECT * INTO replay FROM hns_community_app_host_operations AS operation
   WHERE operation.idempotency_key = input_idempotency_key;
  IF FOUND THEN
    IF replay.operation_kind <> 'transition' OR replay.operation_id <> input_operation_id
      OR replay.request_hash <> input_request_hash
      OR replay.app_host_activation_id <> input_app_host_activation_id
      OR replay.expected_activation_generation <> input_expected_activation_generation
      OR replay.target_status <> input_target_status THEN
      RAISE EXCEPTION 'HNS app-host transition idempotency conflict';
    END IF;
    RETURN QUERY SELECT 'replayed'::TEXT, replay.app_host_activation_id,
      replay.result_activation_generation, replay.target_status;
    RETURN;
  END IF;
  SELECT * INTO current_record FROM hns_community_app_host_activation_current AS current_authority
   WHERE current_authority.app_host_activation_id = input_app_host_activation_id FOR UPDATE;
  IF NOT FOUND OR current_record.current_generation <> input_expected_activation_generation THEN
    RAISE EXCEPTION 'HNS app-host generation fence does not match';
  END IF;
  SELECT * INTO prior FROM hns_community_app_host_activation_revisions AS revision
   WHERE revision.app_host_activation_id = input_app_host_activation_id
     AND revision.app_host_activation_generation = input_expected_activation_generation;
  IF prior.status = 'revoked'
    OR NOT ((prior.status = 'active' AND input_target_status IN ('active', 'suspended', 'revoked'))
      OR (prior.status = 'suspended' AND input_target_status IN ('active', 'revoked'))) THEN
    RAISE EXCEPTION 'HNS app-host transition is not allowed';
  END IF;
  next_route_kind := prior.route_authority_kind;
  next_route_reference := prior.route_authority_reference;
  next_route_generation := prior.route_authority_generation;
  IF input_target_status = 'active' THEN
    SELECT * INTO route FROM effective_route_authority_v2(prior.community_id, database_now)
     WHERE route_binding_id = prior.route_binding_id;
    next_route_kind := route.route_authority_kind;
    next_route_reference := CASE WHEN route.route_authority_kind = 'verified_namespace_v1'
      THEN route.verified_evidence_ref ELSE route.authority_reference END;
    next_route_generation := CASE WHEN route.route_authority_kind = 'verified_namespace_v1'
      THEN route.binding_generation ELSE route.authority_generation END;
    SELECT * INTO dns_current FROM hns_dns_zone_activation_current AS current_authority
     WHERE current_authority.canonical_root = prior.canonical_root FOR SHARE;
    SELECT * INTO dns_revision FROM hns_dns_zone_activation_revisions AS revision
     WHERE revision.dns_zone_activation_id = dns_current.dns_zone_activation_id
       AND revision.dns_zone_activation_generation = dns_current.current_generation;
    IF route.community_id IS NULL OR dns_current.dns_zone_activation_id IS NULL
      OR dns_revision.status <> 'active' THEN
      RAISE EXCEPTION 'HNS app-host restoration authority is unavailable';
    END IF;
  ELSE
    dns_current.dns_zone_activation_id := prior.dns_zone_activation_id;
    dns_current.current_generation := prior.dns_zone_activation_generation;
    dns_revision.gateway_deployment_reference := prior.gateway_deployment_reference;
  END IF;
  INSERT INTO hns_community_app_host_activation_revisions (
    app_host_activation_id, app_host_activation_generation, normalized_host,
    canonical_root, community_id, route_binding_id, route_authority_kind,
    route_authority_reference, route_authority_generation, dns_zone_activation_id,
    dns_zone_activation_generation, gateway_deployment_reference, status,
    reason_code, activated_at, suspended_at, revoked_at
  ) VALUES (
    prior.app_host_activation_id, new_generation, prior.normalized_host,
    prior.canonical_root, prior.community_id, prior.route_binding_id,
    next_route_kind, next_route_reference, next_route_generation,
    dns_current.dns_zone_activation_id, dns_current.current_generation,
    dns_revision.gateway_deployment_reference, input_target_status,
    CASE WHEN input_target_status = 'active' THEN NULL ELSE input_reason_code END,
    prior.activated_at,
    CASE WHEN input_target_status = 'suspended' THEN database_now ELSE NULL END,
    CASE WHEN input_target_status = 'revoked' THEN database_now ELSE NULL END
  );
  UPDATE hns_community_app_host_activation_current AS current_authority
     SET current_generation = new_generation, updated_at = database_now
   WHERE current_authority.app_host_activation_id = input_app_host_activation_id;
  INSERT INTO hns_community_app_host_operations VALUES (
    input_operation_id, 'transition', input_idempotency_key, input_request_hash,
    input_app_host_activation_id, input_expected_activation_generation,
    input_target_status, new_generation, database_now
  );
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN QUERY SELECT 'changed'::TEXT, input_app_host_activation_id,
    new_generation, input_target_status;
END;
$$;
