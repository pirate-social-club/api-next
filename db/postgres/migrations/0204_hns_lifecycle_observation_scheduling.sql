-- HNS lifecycle observation scheduling.
--
-- After the single-owner readiness cutover (0169) the lifecycle runner owns
-- current and safe observation (spec 012, persisted state, evidence and
-- jobs; operational_backoff_v1 cadence 900 s in checking phases), but no
-- decision requested the first observe_current job. Plan exposure and the
-- owner's acknowledgement recorded next_check_at and requested no work, and
-- begin_hns_root_import_observation_v1 still queued a legacy
-- observe_root_v1 job that no executor claims, so a community import stayed
-- observing after its ownership check.
--
-- The domain reducer now requests observe_current at exposure (due at the
-- cadence) and at acknowledgement (due immediately). This migration makes
-- the decision writer keep one queued job per kind and generation, moving a
-- queued job earlier instead of queuing a duplicate, and records the legacy
-- request already in 0169's named disposition (failed,
-- readiness_single_owner_cutover) instead of queuing it. Existing sessions
-- and jobs are not changed here.

CREATE OR REPLACE FUNCTION commit_hns_root_import_lifecycle_decision_v1(input_session_id text, input_expected_revision bigint, input_event_id text, input_event_name text, input_outcome text, input_decision_reason text, input_new_phase text, input_deadline_patch jsonb, input_requested_work jsonb, input_lifecycle_job_id bigint DEFAULT NULL::bigint, input_lease_fence bigint DEFAULT NULL::bigint, input_scheduled_generation bigint DEFAULT NULL::bigint) RETURNS TABLE(outcome text, revision bigint, replayed boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  work JSONB;
  index_ INTEGER;
  kind TEXT;
  due TIMESTAMPTZ;
  requested_generation BIGINT;
BEGIN
  IF input_session_id IS NULL
    OR length(btrim(input_session_id)) = 0
    OR btrim(input_session_id) IS DISTINCT FROM input_session_id
    OR input_event_id IS NULL
    OR length(btrim(input_event_id)) = 0
    OR btrim(input_event_id) IS DISTINCT FROM input_event_id
    OR input_outcome IS NULL
    OR input_outcome NOT IN ('transition', 'replay', 'pending', 'rejection')
    OR input_decision_reason IS NULL
    OR btrim(input_decision_reason) IS DISTINCT FROM input_decision_reason
    OR octet_length(input_decision_reason) > 512
    -- Provenance is a pair: a job identity without its fence, or the reverse,
    -- cannot describe a claimed job and is refused rather than half-recorded.
    OR ((input_lifecycle_job_id IS NULL) <> (input_lease_fence IS NULL))
    OR (input_lifecycle_job_id IS NOT NULL AND input_lifecycle_job_id <= 0)
    OR (input_lease_fence IS NOT NULL AND input_lease_fence < 0)
    OR (input_scheduled_generation IS NOT NULL AND input_scheduled_generation <= 0)
  THEN
    RAISE EXCEPTION 'invalid HNS lifecycle decision input';
  END IF;

  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
    WHERE root_import_session_id = input_session_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HNS lifecycle operation not found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM hns_root_import_lifecycle_history
    WHERE root_import_session_id = input_session_id AND event_id = input_event_id
  ) THEN
    RETURN QUERY SELECT 'replay'::TEXT, lifecycle.revision, TRUE;
    RETURN;
  END IF;

  IF lifecycle.revision <> input_expected_revision THEN
    RAISE EXCEPTION 'HNS lifecycle revision conflict'
      USING ERRCODE = '40001';
  END IF;

  -- Requested work is stamped with the generation it was scheduled under.
  -- The default is the generation the decision applies to; adoption passes
  -- the post-rebinding generation explicitly, because the jobs it requests
  -- describe the operation after the rebinding, not before it.
  requested_generation := coalesce(input_scheduled_generation, lifecycle.generation);

  IF input_outcome = 'transition' OR input_outcome = 'pending' THEN
    IF input_new_phase IS NULL OR input_new_phase <> lifecycle.phase THEN
      IF input_new_phase IS NULL OR NOT hns_root_import_lifecycle_transition_allowed_v1(
        lifecycle.phase, input_new_phase
      ) THEN
        RAISE EXCEPTION 'HNS lifecycle transition not permitted: % -> %',
          lifecycle.phase, coalesce(input_new_phase, 'NULL');
      END IF;
    END IF;
    UPDATE hns_root_import_lifecycle
      SET phase = input_new_phase,
          publication_deadline_at = COALESCE(
            (input_deadline_patch->>'publication_deadline_at')::TIMESTAMPTZ,
            publication_deadline_at
          ),
          first_current_observation_at = COALESCE(
            (input_deadline_patch->>'first_current_observation_at')::TIMESTAMPTZ,
            first_current_observation_at
          ),
          finality_deadline_at = COALESCE(
            (input_deadline_patch->>'finality_deadline_at')::TIMESTAMPTZ,
            finality_deadline_at
          ),
          readiness_observed_at = CASE
            WHEN input_deadline_patch->>'clear_readiness_observed_at' = 'true' THEN NULL
            ELSE COALESCE(
              (input_deadline_patch->>'readiness_observed_at')::TIMESTAMPTZ,
              readiness_observed_at
            )
          END,
          plan_exposed_at = COALESCE(
            (input_deadline_patch->>'plan_exposed_at')::TIMESTAMPTZ,
            plan_exposed_at
          ),
          pending_reason = input_deadline_patch->>'pending_reason',
          next_check_at = (input_deadline_patch->>'next_check_at')::TIMESTAMPTZ,
          observation_count = COALESCE(
            (input_deadline_patch->>'observation_count')::BIGINT, observation_count),
          consecutive_operational_failures = COALESCE(
            (input_deadline_patch->>'consecutive_operational_failures')::BIGINT,
            consecutive_operational_failures),
          last_useful_error = input_deadline_patch->>'last_useful_error',
          last_useful_error_at = (input_deadline_patch->>'last_useful_error_at')::TIMESTAMPTZ,
          terminal_decided_at = (input_deadline_patch->>'terminal_decided_at')::TIMESTAMPTZ,
          revision = lifecycle.revision + 1,
          updated_at = database_now
      WHERE root_import_session_id = input_session_id;
    FOR index_ IN 0 .. jsonb_array_length(input_requested_work) - 1 LOOP
      work := input_requested_work->index_;
      kind := work->>'kind';
      due := (work->>'due_at')::TIMESTAMPTZ;
      IF kind IS NULL OR due IS NULL THEN
        RAISE EXCEPTION 'invalid HNS lifecycle requested work';
      END IF;
      -- One queued job per kind and generation: a new request moves an
      -- already queued job earlier instead of queuing a duplicate.
      UPDATE hns_root_import_lifecycle_jobs AS pending
         SET due_at = LEAST(pending.due_at, due), updated_at = database_now
       WHERE pending.root_import_session_id = input_session_id
         AND pending.job_kind = kind
         AND pending.generation = requested_generation
         AND pending.state = 'queued';
      IF NOT FOUND THEN
        INSERT INTO hns_root_import_lifecycle_jobs(
          root_import_session_id, job_kind, due_at, generation
        ) VALUES (input_session_id, kind, due, requested_generation);
      END IF;
    END LOOP;
    INSERT INTO hns_root_import_lifecycle_history(
      root_import_session_id, event_id, event_name, outcome,
      prior_phase, new_phase, decision_reason, requested_work, revision_after,
      lifecycle_job_id, lease_fence, generation
    ) VALUES (
      input_session_id, input_event_id, input_event_name, input_outcome,
      lifecycle.phase, input_new_phase, input_decision_reason,
      input_requested_work, lifecycle.revision + 1,
      input_lifecycle_job_id, input_lease_fence, lifecycle.generation
    );
    RETURN QUERY SELECT input_outcome::TEXT, lifecycle.revision + 1, FALSE;
    RETURN;
  END IF;

  INSERT INTO hns_root_import_lifecycle_history(
    root_import_session_id, event_id, event_name, outcome,
    prior_phase, new_phase, decision_reason, requested_work, revision_after,
    lifecycle_job_id, lease_fence, generation
  ) VALUES (
    input_session_id, input_event_id, input_event_name, input_outcome,
    lifecycle.phase, NULL, input_decision_reason, '[]'::jsonb, lifecycle.revision,
    input_lifecycle_job_id, input_lease_fence, lifecycle.generation
  );
  RETURN QUERY SELECT input_outcome::TEXT, lifecycle.revision, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION begin_hns_root_import_observation_v1(input_actor_id text, input_creation_intent_id text, input_root_import_session_id text, input_expected_revision bigint, input_idempotency_key text, input_request_sha256 text, input_ownership_result_sha256 text, input_observation_job_id text, input_observation_request_bytes bytea, input_observation_request_sha256 text) RETURNS TABLE(outcome text, root_import_session_id text, session_revision bigint)
    LANGUAGE plpgsql
    AS $_$
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
  -- Since the single-owner cutover (0169) no executor claims legacy
  -- observe_root_v1 work; the lifecycle runner observes this operation. The
  -- request is still recorded, born in the cutover's named disposition so it
  -- is never queued or claimable.
  INSERT INTO hns_root_import_observation_jobs (
    observation_job_id, root_import_session_id, operation_kind,
    request_bytes, request_sha256, state, failure_code, completed_at,
    created_at, updated_at
  ) VALUES (
    input_observation_job_id, session.root_import_session_id, 'observe_root_v1',
    input_observation_request_bytes, input_observation_request_sha256, 'failed',
    'readiness_single_owner_cutover', database_now, database_now, database_now
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
$_$;

DO $observation_scheduling_search_path$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION commit_hns_root_import_lifecycle_decision_v1(text,bigint,text,text,text,text,text,jsonb,jsonb,bigint,bigint,bigint) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION begin_hns_root_import_observation_v1(text,text,text,bigint,text,text,text,text,bytea,text) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$observation_scheduling_search_path$;
