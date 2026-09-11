-- Readiness evidence must be invalidatable.
--
-- The commit function could set readiness_observed_at but never clear it: the
-- patch COALESCEs a null onto the stored value, so an absent field and an
-- intentional clear were indistinguishable. That left the domain able to
-- express an invalidation the store could not persist, and the two would
-- silently disagree.
--
-- A conflicting current observation invalidates the readiness evidence the
-- operation was made ready against. The phase change alone already blocks
-- activation; this keeps stored state equal to the decided state rather than
-- leaving a stale timestamp behind it. Unlike the finality anchor, readiness
-- is deliberately not immutable — it is refreshed on every accepted readiness
-- observation.
--
-- Only the readiness assignment changes; the signature, the transition guard,
-- the revision check, the history append and the job scheduling are identical.

CREATE OR REPLACE FUNCTION commit_hns_root_import_lifecycle_decision_v1(
  input_session_id TEXT,
  input_expected_revision BIGINT,
  input_event_id TEXT,
  input_event_name TEXT,
  input_outcome TEXT,
  input_decision_reason TEXT,
  input_new_phase TEXT,
  input_deadline_patch JSONB,
  input_requested_work JSONB
) RETURNS TABLE (outcome TEXT, revision BIGINT, replayed BOOLEAN)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  work JSONB;
  index_ INTEGER;
  kind TEXT;
  due TIMESTAMPTZ;
BEGIN
  IF btrim(input_session_id) IS NULL OR btrim(input_event_id) IS NULL
    OR input_outcome NOT IN ('transition', 'replay', 'pending', 'rejection')
    OR btrim(input_decision_reason) IS NULL
    OR octet_length(input_decision_reason) > 512 THEN
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
      INSERT INTO hns_root_import_lifecycle_jobs(
        root_import_session_id, job_kind, due_at
      ) VALUES (input_session_id, kind, due);
    END LOOP;
    INSERT INTO hns_root_import_lifecycle_history(
      root_import_session_id, event_id, event_name, outcome,
      prior_phase, new_phase, decision_reason, requested_work, revision_after
    ) VALUES (
      input_session_id, input_event_id, input_event_name, input_outcome,
      lifecycle.phase, input_new_phase, input_decision_reason,
      input_requested_work, lifecycle.revision + 1
    );
    RETURN QUERY SELECT input_outcome::TEXT, lifecycle.revision + 1, FALSE;
    RETURN;
  END IF;

  INSERT INTO hns_root_import_lifecycle_history(
    root_import_session_id, event_id, event_name, outcome,
    prior_phase, new_phase, decision_reason, requested_work, revision_after
  ) VALUES (
    input_session_id, input_event_id, input_event_name, input_outcome,
    lifecycle.phase, NULL, input_decision_reason, '[]'::jsonb, lifecycle.revision
  );
  RETURN QUERY SELECT input_outcome::TEXT, lifecycle.revision, FALSE;
END;
$$;

-- Fair leased claims across roots and job classes by due time. Expired
-- leases are reclaimed with a new fence; the finalize function checks the
-- fence so a lost lease can never finalize stale work.
