-- Admit a reviewed seven-day DNS evidence window. The prior one-day ceiling
-- made an otherwise stable authority require a complete successor every day.

CREATE OR REPLACE FUNCTION record_hns_dns_zone_health_v1(
  input_operation_id TEXT,
  input_idempotency_key TEXT,
  input_request_hash TEXT,
  input_dns_zone_activation_id TEXT,
  input_activation_generation BIGINT,
  input_expected_health_generation BIGINT,
  input_delegation_snapshot_reference TEXT,
  input_delegation_snapshot_digest TEXT,
  input_observed_zone_bytes_digest TEXT,
  input_observed_dnssec_keyset_reference TEXT,
  input_observed_dnssec_keyset_version TEXT,
  input_observed_gateway_deployment_reference TEXT,
  input_observed_gateway_certificate_spki_sha256 TEXT,
  input_delegation_matches BOOLEAN,
  input_ds_authenticates_zone BOOLEAN,
  input_retained_zone_digest_matches BOOLEAN,
  input_gateway_healthy BOOLEAN,
  input_valid_for_seconds INTEGER
)
RETURNS TABLE(
  outcome TEXT,
  dns_zone_activation_id TEXT,
  activation_generation BIGINT,
  health_generation BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  replay hns_dns_zone_health_operations%ROWTYPE;
  current_record hns_dns_zone_activation_current%ROWTYPE;
  latest_generation BIGINT;
  database_now TIMESTAMPTZ := clock_timestamp();
  new_generation BIGINT := input_expected_health_generation + 1;
BEGIN
  SELECT * INTO replay FROM hns_dns_zone_health_operations AS operation
   WHERE operation.idempotency_key = input_idempotency_key;
  IF FOUND THEN
    IF replay.operation_id <> input_operation_id OR replay.request_hash <> input_request_hash
      OR replay.dns_zone_activation_id <> input_dns_zone_activation_id
      OR replay.activation_generation <> input_activation_generation
      OR replay.expected_health_generation <> input_expected_health_generation THEN
      RAISE EXCEPTION 'HNS DNS health idempotency conflict';
    END IF;
    RETURN QUERY SELECT 'replayed'::TEXT, replay.dns_zone_activation_id,
      replay.activation_generation, replay.result_health_generation;
    RETURN;
  END IF;
  IF input_valid_for_seconds < 1 OR input_valid_for_seconds > 604800 THEN
    RAISE EXCEPTION 'HNS DNS health lifetime is invalid';
  END IF;
  SELECT * INTO current_record FROM hns_dns_zone_activation_current AS current_authority
   WHERE current_authority.dns_zone_activation_id = input_dns_zone_activation_id FOR SHARE;
  IF NOT FOUND OR current_record.current_generation <> input_activation_generation THEN
    RAISE EXCEPTION 'HNS DNS health activation generation is stale';
  END IF;
  SELECT COALESCE(max(observation.health_generation), 0) INTO latest_generation
    FROM hns_dns_zone_health_observations AS observation
   WHERE observation.dns_zone_activation_id = input_dns_zone_activation_id
     AND observation.activation_generation = input_activation_generation;
  IF latest_generation <> input_expected_health_generation THEN
    RAISE EXCEPTION 'HNS DNS health generation fence does not match';
  END IF;
  INSERT INTO hns_dns_zone_health_observations VALUES (
    input_dns_zone_activation_id, input_activation_generation, new_generation,
    input_delegation_snapshot_reference, input_delegation_snapshot_digest,
    input_observed_zone_bytes_digest, input_observed_dnssec_keyset_reference,
    input_observed_dnssec_keyset_version, input_observed_gateway_deployment_reference,
    input_observed_gateway_certificate_spki_sha256, input_delegation_matches,
    input_ds_authenticates_zone, input_retained_zone_digest_matches,
    input_gateway_healthy, database_now,
    database_now + input_valid_for_seconds * INTERVAL '1 second'
  );
  INSERT INTO hns_dns_zone_health_operations VALUES (
    input_operation_id, input_idempotency_key, input_request_hash,
    input_dns_zone_activation_id, input_activation_generation,
    input_expected_health_generation, new_generation, database_now
  );
  RETURN QUERY SELECT 'recorded'::TEXT, input_dns_zone_activation_id,
    input_activation_generation, new_generation;
END;
$$;
