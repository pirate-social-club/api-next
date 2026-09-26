-- HNS readiness zone-mutation admission.
--
-- A lifecycle observe_readiness job reconciles the root's zone before it
-- inspects it (apps/hns-authority-provisioner/src/lifecycle-readiness.ts),
-- passing its lifecycle job lease to lock_hns_root_zone_mutation_v1. Through
-- 0208 that function admitted only teardown, provision and observe_root_v1
-- observation jobs, so every readiness reconciliation was refused and the
-- import stayed in checking_authority, retrying readiness_authority_unavailable
-- (staging journey, 2026-09-26).
--
-- This admits exactly one more lease shape: a leased observe_readiness
-- lifecycle job for the selected session, held by the calling executor with
-- the given fence, unexpired, of the lifecycle's current generation, while the
-- lifecycle phase is checking_authority or ready. Every existing branch is
-- unchanged.

CREATE OR REPLACE FUNCTION lock_hns_root_zone_mutation_v1(input_root_label text, input_challenge_txt_value text, input_teardown boolean, input_job_id text, input_executor_id text, input_lease_fence bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  retained_session hns_root_import_sessions%ROWTYPE;
  selected_session_id TEXT;
  admitted_kind TEXT;
BEGIN
  SELECT root_import_session_id INTO selected_session_id
    FROM hns_root_import_sessions
    WHERE root_label=input_root_label AND challenge_txt_value=input_challenge_txt_value;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  IF input_teardown THEN
    PERFORM 1 FROM hns_root_import_teardown_jobs
      WHERE root_import_session_id=selected_session_id AND state='leased'
        AND teardown_job_id=input_job_id AND leased_by=input_executor_id AND lease_fence=input_lease_fence
        AND lease_expires_at>clock_timestamp() FOR UPDATE;
    admitted_kind := 'teardown';
  ELSE
    PERFORM 1 FROM hns_authority_provision_jobs
      WHERE root_import_session_id=selected_session_id AND state='leased'
        AND provision_job_id=input_job_id AND leased_by=input_executor_id AND lease_fence=input_lease_fence
        AND lease_expires_at>clock_timestamp() FOR UPDATE;
    IF FOUND THEN
      admitted_kind := 'provision';
    ELSE
      PERFORM 1 FROM hns_root_import_observation_jobs
        WHERE root_import_session_id=selected_session_id AND state='leased'
          AND operation_kind='observe_root_v1'
          AND observation_job_id=input_job_id AND leased_by=input_executor_id
          AND lease_fence=input_lease_fence AND lease_expires_at>clock_timestamp()
        FOR UPDATE;
      IF FOUND THEN
        admitted_kind := 'observation';
      ELSE
        -- A lifecycle readiness job reconciles the zone through its own lease.
        -- Only the exact leased observe_readiness job of the current lifecycle
        -- generation is admitted; any other lifecycle job kind is refused.
        PERFORM 1 FROM hns_root_import_lifecycle_jobs AS job
          JOIN hns_root_import_lifecycle AS lifecycle
            ON lifecycle.root_import_session_id = job.root_import_session_id
          WHERE job.root_import_session_id=selected_session_id AND job.state='leased'
            AND job.job_kind='observe_readiness'
            AND job.lifecycle_job_id::text=input_job_id AND job.leased_by=input_executor_id
            AND job.lease_fence=input_lease_fence AND job.lease_expires_at>clock_timestamp()
            AND job.generation=lifecycle.generation
          FOR UPDATE OF job;
        admitted_kind := 'readiness';
      END IF;
    END IF;
  END IF;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  SELECT * INTO retained_session FROM hns_root_import_sessions
    WHERE root_import_session_id=selected_session_id FOR UPDATE;
  IF admitted_kind = 'teardown' THEN
    RETURN retained_session.provision_authorization_kind='community_provisional'
      AND (retained_session.status IN ('failed','expired') OR (
        retained_session.status IN ('awaiting_owner_update','observing','ready')
        AND retained_session.expires_at<=clock_timestamp()
        -- Mirrors the teardown claim (0155, 0169): a lifecycle-owned session
        -- is retired under the retention rules, never by a clock.
        AND NOT EXISTS (
          SELECT 1 FROM hns_root_import_lifecycle AS lifecycle_owner
           WHERE lifecycle_owner.root_import_session_id = retained_session.root_import_session_id
        )
      ));
  END IF;
  IF admitted_kind = 'readiness' THEN
    -- The lifecycle phase, not the retired session expiry, governs readiness
    -- (separated clocks, 0208). Readiness is observed while checking authority
    -- and refreshed once ready.
    RETURN EXISTS (
      SELECT 1 FROM hns_root_import_lifecycle AS lifecycle
       WHERE lifecycle.root_import_session_id = retained_session.root_import_session_id
         AND lifecycle.phase IN ('checking_authority','ready')
    );
  END IF;
  IF admitted_kind = 'observation' THEN
    RETURN retained_session.status='observing'
      AND retained_session.observation_job_id=input_job_id
      AND NOT hns_root_import_session_clock_passed_v1(
        retained_session.root_import_session_id, retained_session.expires_at, clock_timestamp());
  END IF;
  RETURN retained_session.status='provisioning'
    AND retained_session.expires_at>clock_timestamp();
END;
$$;

-- CREATE OR REPLACE resets function-level settings. Restore the SECURITY
-- DEFINER search_path pin to the installing schema, exactly as 0136 and 0208 do.
DO $readiness_zone_mutation_search_path$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION lock_hns_root_zone_mutation_v1(text,text,boolean,text,text,bigint) SET search_path TO %I, pg_temp',
    installed_schema
  );
END;
$readiness_zone_mutation_search_path$;

REVOKE ALL ON FUNCTION lock_hns_root_zone_mutation_v1(TEXT,TEXT,BOOLEAN,TEXT,TEXT,BIGINT) FROM PUBLIC;
