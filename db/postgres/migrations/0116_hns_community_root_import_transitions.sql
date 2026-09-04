CREATE OR REPLACE FUNCTION begin_hns_root_import_provision_v2(
  input_actor_id TEXT,
  input_creation_intent_id TEXT,
  input_root_import_session_id TEXT,
  input_expected_revision BIGINT,
  input_idempotency_key TEXT,
  input_poll_request_sha256 TEXT,
  input_authorization_kind TEXT,
  input_authorization_sha256 TEXT,
  input_name_proof_result_bytes BYTEA,
  input_name_proof_message_sha256 TEXT,
  input_name_proof_signature_sha256 TEXT,
  input_provision_job_id TEXT,
  input_provision_request_bytes BYTEA,
  input_provision_request_sha256 TEXT
)
RETURNS TABLE (
  outcome TEXT,
  root_import_session_id TEXT,
  session_revision BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  ownership_result community_creation_ceremony_results%ROWTYPE;
  proof hns_root_import_name_proof_observations%ROWTYPE;
  proof_document JSONB;
  job hns_authority_provision_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE actor_id = input_actor_id
     AND (
       (origin_kind = 'creation_intent' AND creation_intent_id = input_creation_intent_id)
       OR (origin_kind = 'community_attachment' AND community_id = input_creation_intent_id)
     )
     AND hns_root_import_sessions.root_import_session_id = input_root_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF session.status = 'provisioning' THEN
    SELECT * INTO job
      FROM hns_authority_provision_jobs
     WHERE provision_job_id = session.provision_job_id
     FOR SHARE;
    SELECT * INTO proof
      FROM hns_root_import_name_proof_observations
     WHERE hns_root_import_name_proof_observations.root_import_session_id =
           session.root_import_session_id
     FOR SHARE;
    IF session.provision_idempotency_key = input_idempotency_key
      AND session.provision_poll_request_sha256 = input_poll_request_sha256
      AND session.provision_authorization_kind = input_authorization_kind
      AND session.provision_authorization_sha256 = input_authorization_sha256
      AND session.provision_job_id = input_provision_job_id
      AND job.request_bytes = input_provision_request_bytes
      AND job.request_sha256 = input_provision_request_sha256
      AND (
        (
          input_authorization_kind = 'namespace_ownership'
          AND input_name_proof_result_bytes IS NULL
          AND input_name_proof_message_sha256 IS NULL
          AND input_name_proof_signature_sha256 IS NULL
        )
        OR (
          input_authorization_kind = 'hns_name_signature'
          AND proof.proof_result_sha256 = input_authorization_sha256
          AND proof.message_sha256 = input_name_proof_message_sha256
          AND proof.signature_sha256 = input_name_proof_signature_sha256
          AND proof.result_bytes = input_name_proof_result_bytes
        )
      )
    THEN
      RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
    ELSE
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF session.status <> 'awaiting_ownership'
    OR session.revision <> input_expected_revision
    OR session.expires_at <= database_now
    OR session.provision_job_id IS DISTINCT FROM input_provision_job_id
    OR input_poll_request_sha256 !~ '^[0-9a-f]{64}$'
    OR input_authorization_kind NOT IN ('namespace_ownership', 'hns_name_signature')
    OR input_authorization_sha256 !~ '^[0-9a-f]{64}$'
    OR input_provision_request_sha256 !~ '^[0-9a-f]{64}$'
    OR encode(sha256(input_provision_request_bytes), 'hex')
       <> input_provision_request_sha256
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;

  IF input_authorization_kind = 'namespace_ownership' THEN
    IF input_name_proof_result_bytes IS NOT NULL
      OR input_name_proof_message_sha256 IS NOT NULL
      OR input_name_proof_signature_sha256 IS NOT NULL
    THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
    SELECT * INTO ownership_result
      FROM community_creation_ceremony_results
     WHERE ceremony_intent_id = session.ceremony_intent_id
       AND namespace_session_id = session.namespace_session_id
     FOR SHARE;
    IF NOT FOUND
      OR ownership_result.outcome_status <> 'satisfied'
      OR ownership_result.result_hash <> input_authorization_sha256
    THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
  ELSE
    IF input_name_proof_result_bytes IS NULL
      OR octet_length(input_name_proof_result_bytes) NOT BETWEEN 1 AND 1024
      OR encode(sha256(input_name_proof_result_bytes), 'hex')
           <> input_authorization_sha256
      OR input_name_proof_message_sha256 !~ '^[0-9a-f]{64}$'
      OR input_name_proof_signature_sha256 !~ '^[0-9a-f]{64}$'
      OR NOT (
        (session.origin_kind = 'creation_intent' AND EXISTS (
          SELECT 1 FROM namespace_ownership_sessions AS ownership_session
           WHERE ownership_session.namespace_session_id = session.namespace_session_id
             AND ownership_session.actor_id = session.actor_id
             AND ownership_session.creation_intent_id = session.creation_intent_id
             AND ownership_session.status = 'pending'
             AND ownership_session.expires_at > database_now
        ))
        OR (session.origin_kind = 'community_attachment' AND EXISTS (
          SELECT 1 FROM community_route_attachment_namespace_sessions AS ownership_session
           WHERE ownership_session.namespace_session_id = session.namespace_session_id
             AND ownership_session.actor_id = session.actor_id
             AND ownership_session.community_id = session.community_id
             AND ownership_session.attachment_intent_id = session.attachment_intent_id
             AND ownership_session.status = 'pending'
             AND ownership_session.expires_at > database_now
        ))
      )
    THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
    BEGIN
      proof_document := convert_from(input_name_proof_result_bytes, 'UTF8')::JSONB;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END;
    IF jsonb_typeof(proof_document) <> 'object' THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(proof_document)) <> 6
      OR proof_document ->> 'version' <> 'pirate-hns-root-import-name-proof-result-v1'
      OR proof_document ->> 'root_label' <> session.root_label
      OR proof_document ->> 'message_sha256' <> input_name_proof_message_sha256
      OR proof_document ->> 'signature_sha256' <> input_name_proof_signature_sha256
      OR proof_document -> 'safe' <> 'true'::JSONB
      OR proof_document -> 'verified' <> 'true'::JSONB
    THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
  END IF;

  -- Root reservation starts only after either durable namespace ownership or
  -- an exact safe name-signature result has been verified.
  PERFORM pg_advisory_xact_lock(hashtextextended('hns-root-import:' || session.root_label, 0));
  UPDATE hns_authority_provision_jobs AS stale_job
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'session_expired', completed_at = database_now,
         updated_at = database_now
    FROM hns_root_import_sessions AS stale_session
   WHERE stale_session.root_label = session.root_label
     AND stale_session.root_import_session_id <> session.root_import_session_id
     AND stale_session.status = 'provisioning'
     AND stale_session.expires_at <= database_now
     AND stale_job.root_import_session_id = stale_session.root_import_session_id
     AND (
       stale_job.state = 'queued'
       OR (stale_job.state = 'leased' AND stale_job.lease_expires_at <= database_now)
     );
  UPDATE hns_root_import_observation_jobs AS stale_job
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'session_expired', completed_at = database_now,
         updated_at = database_now
    FROM hns_root_import_sessions AS stale_session
   WHERE stale_session.root_label = session.root_label
     AND stale_session.root_import_session_id <> session.root_import_session_id
     AND stale_session.status = 'observing'
     AND stale_session.expires_at <= database_now
     AND stale_job.root_import_session_id = stale_session.root_import_session_id
     AND (
       stale_job.state = 'queued'
       OR (stale_job.state = 'leased' AND stale_job.lease_expires_at <= database_now)
     );
  UPDATE hns_root_import_sessions AS stale_session
     SET status = 'expired', revision = stale_session.revision + 1,
         updated_at = database_now
   WHERE stale_session.root_label = session.root_label
     AND stale_session.root_import_session_id <> session.root_import_session_id
     AND stale_session.expires_at <= database_now
     AND (
       stale_session.status IN ('awaiting_owner_update', 'ready')
       OR (
         stale_session.status = 'provisioning'
         AND EXISTS (
           SELECT 1 FROM hns_authority_provision_jobs AS stale_job
            WHERE stale_job.root_import_session_id = stale_session.root_import_session_id
              AND stale_job.state = 'failed'
              AND stale_job.failure_code = 'session_expired'
         )
       )
       OR (
         stale_session.status = 'observing'
         AND EXISTS (
           SELECT 1 FROM hns_root_import_observation_jobs AS stale_job
            WHERE stale_job.root_import_session_id = stale_session.root_import_session_id
              AND stale_job.state = 'failed'
              AND stale_job.failure_code = 'session_expired'
         )
       )
     );
  IF EXISTS (
       SELECT 1
         FROM hns_root_import_sessions AS other
        WHERE other.root_label = session.root_label
          AND other.root_import_session_id <> session.root_import_session_id
          AND other.status IN (
            'provisioning', 'awaiting_owner_update', 'observing', 'ready', 'activated'
          )
     )
    OR EXISTS (
       SELECT 1 FROM hns_dns_zone_activation_current
        WHERE canonical_root = session.root_label
     )
    OR EXISTS (
       SELECT 1 FROM community_canonical_route_bindings
        WHERE family = 'hns' AND root_label = session.root_label
          AND route_lifecycle_status = 'active'
     )
    OR EXISTS (
       SELECT 1 FROM community_handle_sale_namespace_activation_current
        WHERE family = 'hns' AND canonical_root = session.root_label
     )
    OR EXISTS (
       SELECT 1
         FROM operator_managed_root_registry_current AS current_registry
        WHERE operator_managed_registry_has_active_root(
          current_registry.registry_reference,
          current_registry.registry_version,
          current_registry.registry_digest,
          session.root_label
        )
     )
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;

  IF input_authorization_kind = 'hns_name_signature' THEN
    INSERT INTO hns_root_import_name_proof_observations (
      proof_result_sha256, root_import_session_id, actor_id, root_label,
      message_sha256, signature_sha256, result_bytes, safe, verified, verified_at
    ) VALUES (
      input_authorization_sha256, session.root_import_session_id, session.actor_id,
      session.root_label, input_name_proof_message_sha256,
      input_name_proof_signature_sha256, input_name_proof_result_bytes,
      TRUE, TRUE, database_now
    );
  END IF;
  INSERT INTO hns_authority_provision_jobs (
    provision_job_id, root_import_session_id, operation_kind,
    request_bytes, request_sha256, state
  ) VALUES (
    input_provision_job_id, session.root_import_session_id, 'provision_root_v1',
    input_provision_request_bytes, input_provision_request_sha256, 'queued'
  );
  UPDATE hns_root_import_sessions
     SET status = 'provisioning', revision = session.revision + 1,
         provision_idempotency_key = input_idempotency_key,
         provision_poll_request_sha256 = input_poll_request_sha256,
         provision_authorization_kind = input_authorization_kind,
         provision_authorization_sha256 = input_authorization_sha256,
         ownership_result_sha256 = CASE input_authorization_kind
           WHEN 'namespace_ownership' THEN input_authorization_sha256
           ELSE NULL
         END,
         updated_at = database_now
   WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
  RETURN QUERY SELECT 'provisioning'::TEXT, session.root_import_session_id, session.revision + 1;
END;
$$;

CREATE OR REPLACE FUNCTION begin_hns_root_import_observation_v1(
  input_actor_id TEXT,
  input_creation_intent_id TEXT,
  input_root_import_session_id TEXT,
  input_expected_revision BIGINT,
  input_idempotency_key TEXT,
  input_request_sha256 TEXT,
  input_ownership_result_sha256 TEXT,
  input_observation_job_id TEXT,
  input_observation_request_bytes BYTEA,
  input_observation_request_sha256 TEXT
)
RETURNS TABLE (
  outcome TEXT,
  root_import_session_id TEXT,
  session_revision BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  ownership_ceremony_intent_id TEXT;
  ownership_outcome_status TEXT;
  ownership_result_hash TEXT;
  proof hns_root_import_name_proof_observations%ROWTYPE;
  provision hns_authority_provision_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE actor_id = input_actor_id
     AND (
       (origin_kind = 'creation_intent' AND creation_intent_id = input_creation_intent_id)
       OR (origin_kind = 'community_attachment' AND community_id = input_creation_intent_id)
     )
     AND hns_root_import_sessions.root_import_session_id = input_root_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF session.observation_idempotency_key IS NOT NULL THEN
    IF session.observation_idempotency_key = input_idempotency_key
      AND session.observation_request_sha256 = input_request_sha256
      AND session.ownership_result_sha256 = input_ownership_result_sha256
      AND session.observation_job_id = input_observation_job_id
    THEN
      RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
    ELSE
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF session.status <> 'awaiting_owner_update'
    OR session.revision <> input_expected_revision
    OR session.expires_at <= database_now
    OR (
      session.ownership_result_sha256 IS NOT NULL
      AND session.ownership_result_sha256 <> input_ownership_result_sha256
    )
    OR session.provision_authorization_kind IS NULL
    OR session.provision_authorization_sha256 IS NULL
    OR input_request_sha256 !~ '^[0-9a-f]{64}$'
    OR input_ownership_result_sha256 !~ '^[0-9a-f]{64}$'
    OR input_observation_request_sha256 !~ '^[0-9a-f]{64}$'
    OR encode(sha256(input_observation_request_bytes), 'hex')
       <> input_observation_request_sha256
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  SELECT result.ceremony_intent_id, result.outcome_status, result.result_hash
    INTO ownership_ceremony_intent_id, ownership_outcome_status, ownership_result_hash
    FROM (
      SELECT creation_result.ceremony_intent_id,
             creation_result.outcome_status,
             creation_result.result_hash
        FROM community_creation_ceremony_results AS creation_result
       WHERE session.origin_kind = 'creation_intent'
         AND creation_result.ceremony_intent_id = session.ceremony_intent_id
         AND creation_result.namespace_session_id = session.namespace_session_id
      UNION ALL
      SELECT attachment_result.ceremony_intent_id,
             attachment_result.outcome_status,
             attachment_result.result_hash
        FROM community_route_attachment_namespace_sessions AS ownership_session
        JOIN community_route_attachment_ceremony_results AS attachment_result
          ON attachment_result.ceremony_intent_id = ownership_session.ceremony_intent_id
       WHERE session.origin_kind = 'community_attachment'
         AND ownership_session.namespace_session_id = session.namespace_session_id
         AND ownership_session.actor_id = session.actor_id
         AND ownership_session.community_id = session.community_id
         AND ownership_session.attachment_intent_id = session.attachment_intent_id
    ) AS result;
  SELECT * INTO provision
    FROM hns_authority_provision_jobs
   WHERE provision_job_id = session.provision_job_id
   FOR SHARE;
  SELECT * INTO proof
    FROM hns_root_import_name_proof_observations
   WHERE hns_root_import_name_proof_observations.root_import_session_id =
         session.root_import_session_id
   FOR SHARE;
  IF ownership_ceremony_intent_id IS NULL
    OR provision.provision_job_id IS NULL
    OR ownership_outcome_status <> 'satisfied'
    OR ownership_result_hash <> input_ownership_result_sha256
    OR provision.state <> 'completed'
    OR provision.publish_plan_sha256 <> session.publish_plan_sha256
    OR (
      session.provision_authorization_kind = 'namespace_ownership'
      AND session.provision_authorization_sha256 <> input_ownership_result_sha256
    )
    OR (
      session.provision_authorization_kind = 'hns_name_signature'
      AND proof.proof_result_sha256 IS DISTINCT FROM session.provision_authorization_sha256
    )
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  INSERT INTO hns_root_import_observation_jobs (
    observation_job_id, root_import_session_id, operation_kind,
    request_bytes, request_sha256, state
  ) VALUES (
    input_observation_job_id, session.root_import_session_id, 'observe_root_v1',
    input_observation_request_bytes, input_observation_request_sha256, 'queued'
  );
  UPDATE hns_root_import_sessions
     SET status = 'observing', revision = session.revision + 1,
         ownership_result_sha256 = input_ownership_result_sha256,
         observation_job_id = input_observation_job_id,
         observation_idempotency_key = input_idempotency_key,
         observation_request_sha256 = input_request_sha256,
         updated_at = database_now
   WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
  RETURN QUERY SELECT 'observing'::TEXT, session.root_import_session_id, session.revision + 1;
END;
$$;

DO $$
DECLARE
  installed_schema TEXT := current_schema();
  function_signature TEXT;
BEGIN
  IF installed_schema IS NULL THEN
    RAISE EXCEPTION 'HNS community import transitions require a current schema';
  END IF;
  FOREACH function_signature IN ARRAY ARRAY[
    'begin_hns_root_import_provision_v2(text,text,text,bigint,text,text,text,text,bytea,text,text,text,bytea,text)',
    'begin_hns_root_import_observation_v1(text,text,text,bigint,text,text,text,text,bytea,text)'
  ]
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%s SET search_path TO %I, pg_temp',
      installed_schema,
      function_signature,
      installed_schema
    );
  END LOOP;
END;
$$;
