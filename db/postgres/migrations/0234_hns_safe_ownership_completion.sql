-- Safe-chain control admits the existing namespace-completion continuation.
-- It is evidence, never provisional admission relabeled as ownership.
CREATE TABLE hns_root_import_safe_ownership_proofs (
  root_import_session_id text NOT NULL REFERENCES hns_root_import_sessions(root_import_session_id),
  generation bigint NOT NULL CHECK (generation > 0),
  proof_bytes bytea NOT NULL CHECK (octet_length(proof_bytes) BETWEEN 1 AND 1048576),
  proof_sha256 text NOT NULL CHECK (proof_sha256 ~ '^[0-9a-f]{64}$'),
  lifecycle_job_id bigint NOT NULL REFERENCES hns_root_import_lifecycle_jobs(lifecycle_job_id),
  lease_fence bigint NOT NULL,
  retained_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (root_import_session_id, generation),
  CHECK (encode(sha256(proof_bytes), 'hex') = proof_sha256)
);
CREATE TRIGGER hns_safe_ownership_proof_append_only
  BEFORE UPDATE OR DELETE ON hns_root_import_safe_ownership_proofs
  FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();
REVOKE ALL ON hns_root_import_safe_ownership_proofs FROM PUBLIC;

CREATE FUNCTION enqueue_hns_safe_ownership_completion_v1(
  input_session_id text, input_job_id bigint, input_executor_id text,
  input_lease_fence bigint, input_proof_bytes bytea, input_proof_sha256 text
) RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
#variable_conflict use_column
DECLARE
  job hns_root_import_lifecycle_jobs%ROWTYPE;
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  provision hns_authority_provision_jobs%ROWTYPE;
  queued hns_community_publication_jobs%ROWTYPE;
  proof jsonb;
  database_now timestamptz;
  observed_ms double precision;
  first_proof boolean;
BEGIN
  IF input_proof_bytes IS NULL OR octet_length(input_proof_bytes) NOT BETWEEN 1 AND 1048576
    OR input_proof_sha256 IS NULL OR input_proof_sha256 !~ '^[0-9a-f]{64}$'
    OR encode(sha256(input_proof_bytes),'hex') IS DISTINCT FROM input_proof_sha256 THEN
    RETURN QUERY SELECT 'invalid_proof'::text; RETURN;
  END IF;
  SELECT * INTO job FROM hns_root_import_lifecycle_jobs WHERE lifecycle_job_id=input_job_id FOR UPDATE;
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle WHERE root_import_session_id=input_session_id FOR UPDATE;
  SELECT * INTO session FROM hns_root_import_sessions WHERE root_import_session_id=input_session_id FOR UPDATE;
  database_now := clock_timestamp();
  IF job.root_import_session_id IS DISTINCT FROM input_session_id
    OR lifecycle.root_import_session_id IS NULL OR session.root_import_session_id IS NULL
    OR job.state IS DISTINCT FROM 'leased' OR job.job_kind IS DISTINCT FROM 'observe_readiness'
    OR job.leased_by IS DISTINCT FROM input_executor_id
    OR job.lease_fence IS DISTINCT FROM input_lease_fence
    OR job.lease_expires_at IS NULL OR job.lease_expires_at<=database_now
    OR job.generation IS DISTINCT FROM lifecycle.generation THEN
    RETURN QUERY SELECT 'lease_conflict'::text; RETURN;
  END IF;
  IF lifecycle.phase NOT IN ('checking_authority','ready') THEN
    RETURN QUERY SELECT 'phase_conflict'::text; RETURN;
  END IF;
  IF lifecycle.plan_encoded_resource_sha256 IS NULL THEN
    RETURN QUERY SELECT 'plan_absent'::text; RETURN;
  END IF;
  IF session.ownership_result_sha256 IS NOT NULL AND session.status IN ('observing','ready') THEN
    RETURN QUERY SELECT 'ownership_ready'::text; RETURN;
  END IF;
  SELECT * INTO provision FROM hns_authority_provision_jobs WHERE provision_job_id=session.provision_job_id FOR SHARE;
  IF session.origin_kind IS DISTINCT FROM 'community_attachment'
    OR session.status IS DISTINCT FROM 'awaiting_owner_update'
    OR session.provision_authorization_kind IS NULL
    OR session.provision_authorization_kind NOT IN ('community_provisional','hns_name_signature')
    OR session.ownership_result_sha256 IS NOT NULL
    OR provision.state IS DISTINCT FROM 'completed'
    OR provision.publish_plan_sha256 IS DISTINCT FROM session.publish_plan_sha256
    OR NOT hns_root_import_publication_window_open_v1(input_session_id)
    OR NOT has_community_route_authority(session.community_id, session.actor_id)
    OR NOT EXISTS (SELECT 1 FROM communities WHERE community_id=session.community_id AND status='active')
    OR NOT EXISTS (SELECT 1 FROM users WHERE user_id=session.actor_id AND status='active') THEN
    RETURN QUERY SELECT 'session_conflict'::text; RETURN;
  END IF;
  BEGIN
    proof := convert_from(input_proof_bytes,'UTF8')::jsonb;
    observed_ms := (proof#>>'{observation,observed_at_epoch_ms}')::double precision;
    IF jsonb_typeof(proof) IS DISTINCT FROM 'object'
      OR proof->>'version' IS DISTINCT FROM 'pirate-hns-provisional-safe-ownership-v1'
      OR proof->>'root_import_session_id' IS DISTINCT FROM input_session_id
      OR proof->>'namespace_session_id' IS DISTINCT FROM session.namespace_session_id
      OR proof->>'root_label' IS DISTINCT FROM session.root_label
      OR jsonb_typeof(proof->'lifecycle_revision') IS DISTINCT FROM 'number'
      OR (proof->>'generation')::bigint IS DISTINCT FROM lifecycle.generation
      OR proof->>'publish_plan_sha256' IS DISTINCT FROM session.publish_plan_sha256
      OR proof->>'plan_encoded_resource_sha256' IS DISTINCT FROM lifecycle.plan_encoded_resource_sha256
      OR proof->>'challenge_value_sha256' IS DISTINCT FROM encode(sha256(convert_to(session.challenge_txt_value,'UTF8')),'hex')
      OR proof#>>'{observation,view}' IS DISTINCT FROM 'safe'
      OR jsonb_typeof(proof#>'{observation,commitment}') IS DISTINCT FROM 'object'
      OR jsonb_typeof(proof#>'{observation,records}') IS DISTINCT FROM 'array'
      OR observed_ms IS NULL OR observed_ms='NaN'::double precision
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(proof#>'{observation,records}') record
        WHERE record->>'type'='TXT' AND
          (SELECT string_agg(chunk#>>'{}','' ORDER BY ordinal)
             FROM jsonb_array_elements(record->'txt') WITH ORDINALITY AS chunks(chunk,ordinal))
            =session.challenge_txt_value
      ) THEN
      RETURN QUERY SELECT 'invalid_proof'::text; RETURN;
    END IF;
    IF (proof->>'lifecycle_revision')::bigint IS DISTINCT FROM lifecycle.revision THEN
      RETURN QUERY SELECT 'revision_conflict'::text; RETURN;
    END IF;
    IF observed_ms > extract(epoch FROM database_now)*1000
      OR observed_ms < extract(epoch FROM database_now)*1000-900000 THEN
      RETURN QUERY SELECT 'stale_proof'::text; RETURN;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range
    OR invalid_parameter_value OR character_not_in_repertoire OR untranslatable_character THEN
    RETURN QUERY SELECT 'invalid_proof'::text; RETURN;
  END;
  SELECT * INTO queued FROM hns_community_publication_jobs WHERE root_import_session_id=input_session_id FOR UPDATE;
  IF FOUND AND (queued.actor_id IS DISTINCT FROM session.actor_id
    OR queued.community_id IS DISTINCT FROM session.community_id
    OR queued.expected_revision IS DISTINCT FROM session.revision
    OR queued.state NOT IN ('pending','leased')) THEN
    RETURN QUERY SELECT 'queue_conflict'::text; RETURN;
  END IF;
  INSERT INTO hns_root_import_safe_ownership_proofs
    (root_import_session_id,generation,proof_bytes,proof_sha256,lifecycle_job_id,lease_fence)
    VALUES (input_session_id,lifecycle.generation,input_proof_bytes,input_proof_sha256,input_job_id,input_lease_fence)
    ON CONFLICT DO NOTHING;
  first_proof := FOUND;
  INSERT INTO hns_community_publication_jobs
    (root_import_session_id,actor_id,community_id,expected_revision,idempotency_key)
    VALUES (input_session_id,session.actor_id,session.community_id,session.revision,
      'safe-ownership:'||encode(sha256(convert_to(input_session_id||':'||lifecycle.generation::text,'UTF8')),'hex'))
    ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT CASE WHEN first_proof THEN 'queued' ELSE 'replayed' END::text;
END;
$$;
REVOKE ALL ON FUNCTION enqueue_hns_safe_ownership_completion_v1(text,bigint,text,bigint,bytea,text) FROM PUBLIC;

DO $safe_ownership_search_path$
DECLARE installed_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION enqueue_hns_safe_ownership_completion_v1(text,bigint,text,bigint,bytea,text) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$safe_ownership_search_path$;

-- Match the provisioner's executor identity already admitted by migration 0225.
-- The HTTP role does not call this preparatory routine.
DO $safe_ownership_executor_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hns_root_import_executor_login_v1') THEN
    GRANT EXECUTE ON FUNCTION enqueue_hns_safe_ownership_completion_v1(text,bigint,text,bigint,bytea,text)
      TO hns_root_import_executor_login_v1;
  END IF;
END;
$safe_ownership_executor_grant$;
