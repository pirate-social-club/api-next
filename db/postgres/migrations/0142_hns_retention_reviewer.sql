-- The retention reviewer's writers, and the privileges 0140 never set —
-- spec 012, "Authority retention, quota, and retirement".
--
-- 0140 created the review table and the authorization read, but nothing could
-- write a review, so retirement was unreachable and every retained zone,
-- keyset and reservation kept charging against the admission quota. It also
-- left its functions as SECURITY INVOKER with unpinned search paths and
-- EXECUTE still granted to PUBLIC, which is the opposite of the posture 0138
-- established for the lifecycle functions. Both are fixed here.
--
-- The division of authority is the point of this migration. Two writers exist
-- and they are deliberately unequal:
--
-- * The reviewer's writer can only ever record a retaining review. Its
--   decision is not a parameter. An automated inspection of the chain cannot,
--   by construction, produce an authorization to delete anything — which is
--   what the specification requires and what a decision parameter would have
--   quietly allowed the first time a reviewer had a bug.
-- * The supersession writer records an authorization and takes no chain
--   evidence at all. It is an operator's explicit statement about one
--   authority generation, invoked deliberately, and its EXECUTE grant belongs
--   to an operator role rather than to the provisioner runtime.
--
-- Both are fenced. The reviewer's writer validates the lifecycle job lease —
-- state, holder, fence, expiry — and the operation generation under the row
-- lock before it writes, because a review recorded by a worker that has lost
-- its lease describes an inspection nobody can vouch for. The supersession
-- writer validates the generation it names against the operation's current
-- generation, so an authorization can never be carried forward onto
-- infrastructure nobody inspected.

REVOKE ALL ON FUNCTION authorize_hns_root_import_retirement_v1(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_hns_retention_review_change_v1() FROM PUBLIC;
ALTER FUNCTION authorize_hns_root_import_retirement_v1(TEXT, INTEGER) SECURITY DEFINER;

-- Records one inspection of one authority generation, and schedules the next
-- review. The review row and its successor job commit together: a review whose
-- follow-up was never scheduled would silently end the recurrence.
CREATE OR REPLACE FUNCTION record_hns_root_import_retention_review_v1(
  input_session_id TEXT,
  input_lifecycle_job_id BIGINT,
  input_executor_id TEXT,
  input_lease_fence BIGINT,
  input_expected_generation BIGINT,
  input_reason TEXT,
  input_evidence_ref TEXT,
  input_current_observed_at TIMESTAMPTZ,
  input_safe_observed_at TIMESTAMPTZ,
  input_current_resource_sha256 TEXT,
  input_safe_resource_sha256 TEXT,
  input_next_review_at TIMESTAMPTZ
) RETURNS TABLE (outcome TEXT, retention_review_id BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  job hns_root_import_lifecycle_jobs%ROWTYPE;
  existing BIGINT;
  inserted BIGINT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_reason NOT IN (
    'chain_reference_retained',
    'unavailable_chain_state_retained',
    'unknown_provenance_retained',
    'exposure_horizon_undetermined_retained'
  ) THEN
    -- The retaining reasons are the complete vocabulary this writer accepts.
    -- Anything else is a caller defect, not a review.
    RAISE EXCEPTION 'invalid HNS retention review reason';
  END IF;
  IF input_next_review_at IS NULL OR input_next_review_at <= database_now THEN
    RAISE EXCEPTION 'invalid HNS retention review schedule';
  END IF;

  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'lifecycle_absent'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;

  SELECT * INTO job FROM hns_root_import_lifecycle_jobs
   WHERE lifecycle_job_id = input_lifecycle_job_id
   FOR UPDATE;
  IF NOT FOUND
    OR job.root_import_session_id <> input_session_id
    OR job.job_kind <> 'retention_review'
    OR job.state <> 'leased'
    OR job.leased_by IS DISTINCT FROM input_executor_id
    OR job.lease_fence <> input_lease_fence
    OR job.lease_expires_at <= database_now
  THEN
    RETURN QUERY SELECT 'lease_conflict'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;

  IF lifecycle.generation <> input_expected_generation THEN
    -- The inspection was gathered for one generation. A superseded operation
    -- holds different infrastructure and this evidence does not describe it.
    RETURN QUERY SELECT 'generation_conflict'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;

  SELECT review.retention_review_id INTO existing
    FROM hns_root_import_retention_reviews AS review
   WHERE review.root_import_session_id = input_session_id
     AND review.evidence_ref = input_evidence_ref;
  IF FOUND THEN
    -- A redelivered inspection. The review already exists and reviews are
    -- append-only, so nothing is written and no second job is scheduled. The
    -- claimed job still completes: leaving it leased would have it reclaimed
    -- and re-inspected forever.
    UPDATE hns_root_import_lifecycle_jobs
       SET state = 'completed', leased_by = NULL, lease_expires_at = NULL,
           completed_at = database_now, updated_at = database_now
     WHERE lifecycle_job_id = input_lifecycle_job_id;
    RETURN QUERY SELECT 'replayed'::TEXT, existing;
    RETURN;
  END IF;

  INSERT INTO hns_root_import_retention_reviews (
    root_import_session_id, authority_generation, reviewed_at,
    current_observed_at, safe_observed_at,
    current_resource_sha256, safe_resource_sha256,
    decision, reason, evidence_ref
  ) VALUES (
    input_session_id, lifecycle.generation, database_now,
    input_current_observed_at, input_safe_observed_at,
    input_current_resource_sha256, input_safe_resource_sha256,
    'retain', input_reason, input_evidence_ref
  ) RETURNING hns_root_import_retention_reviews.retention_review_id INTO inserted;

  INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
    VALUES (input_session_id, 'retention_review', input_next_review_at);

  -- The review, its successor job and the claimed job's completion are one
  -- fact. Finalizing separately would let a crash leave a recorded review
  -- whose job is reclaimed and inspected again, or a completed job whose
  -- recurrence was never scheduled.
  UPDATE hns_root_import_lifecycle_jobs
     SET state = 'completed', leased_by = NULL, lease_expires_at = NULL,
         completed_at = database_now, updated_at = database_now
   WHERE lifecycle_job_id = input_lifecycle_job_id;

  RETURN QUERY SELECT 'recorded'::TEXT, inserted;
END;
$$;

-- An operator's explicit supersession of one authority generation. This is the
-- only writer that can produce a retiring authorization, it accepts no chain
-- evidence, and it is invoked deliberately rather than by any executor.
CREATE OR REPLACE FUNCTION record_hns_root_import_authority_supersession_v1(
  input_session_id TEXT,
  input_expected_generation BIGINT,
  input_evidence_ref TEXT,
  input_reason TEXT
) RETURNS TABLE (outcome TEXT, retention_review_id BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  existing BIGINT;
  inserted BIGINT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF btrim(input_evidence_ref) <> input_evidence_ref
    OR octet_length(input_evidence_ref) NOT BETWEEN 1 AND 256
    OR input_evidence_ref ~ '[[:cntrl:]]'
    OR btrim(input_reason) <> input_reason
    OR octet_length(input_reason) NOT BETWEEN 1 AND 256
    OR input_reason ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'invalid HNS authority supersession evidence';
  END IF;

  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'lifecycle_absent'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF lifecycle.generation <> input_expected_generation THEN
    RETURN QUERY SELECT 'generation_conflict'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;

  SELECT review.retention_review_id INTO existing
    FROM hns_root_import_retention_reviews AS review
   WHERE review.root_import_session_id = input_session_id
     AND review.evidence_ref = input_evidence_ref;
  IF FOUND THEN
    RETURN QUERY SELECT 'replayed'::TEXT, existing;
    RETURN;
  END IF;

  INSERT INTO hns_root_import_retention_reviews (
    root_import_session_id, authority_generation, reviewed_at,
    decision, reason, evidence_ref
  ) VALUES (
    input_session_id, lifecycle.generation, database_now,
    'superseded', input_reason, input_evidence_ref
  ) RETURNING hns_root_import_retention_reviews.retention_review_id INTO inserted;

  RETURN QUERY SELECT 'recorded'::TEXT, inserted;
END;
$$;

REVOKE ALL ON FUNCTION record_hns_root_import_retention_review_v1(
  TEXT, BIGINT, TEXT, BIGINT, BIGINT, TEXT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_hns_root_import_authority_supersession_v1(
  TEXT, BIGINT, TEXT, TEXT
) FROM PUBLIC;
ALTER FUNCTION record_hns_root_import_retention_review_v1(
  TEXT, BIGINT, TEXT, BIGINT, BIGINT, TEXT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TIMESTAMPTZ
) SECURITY DEFINER;
ALTER FUNCTION record_hns_root_import_authority_supersession_v1(
  TEXT, BIGINT, TEXT, TEXT
) SECURITY DEFINER;

DO $pin_retention_privileges$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION authorize_hns_root_import_retirement_v1(text,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION reject_hns_retention_review_change_v1() SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION record_hns_root_import_retention_review_v1(text,bigint,text,bigint,bigint,text,text,timestamptz,timestamptz,text,text,timestamptz) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION record_hns_root_import_authority_supersession_v1(text,bigint,text,text) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_retention_privileges$;
