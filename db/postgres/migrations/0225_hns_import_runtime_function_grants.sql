-- Production uses a provider-managed API role instead of api_next_app, and a
-- separate provisioner executor role. Grant only the fenced routines those
-- two runtimes call. Keep operator recovery and teardown functions excluded.
-- The provisioner reads lifecycle rows directly. Its two row locks run through
-- these SECURITY DEFINER routines, so the login needs no UPDATE on the
-- lifecycle ledgers merely to hold a transaction lock.
CREATE FUNCTION lock_hns_root_import_lifecycle_v1(input_session_id text)
RETURNS SETOF hns_root_import_lifecycle
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT lifecycle.*
  FROM hns_root_import_lifecycle AS lifecycle
  WHERE lifecycle.root_import_session_id = input_session_id
  FOR UPDATE
$$;

CREATE FUNCTION lock_hns_root_import_lifecycle_job_v1(
  input_job_id bigint,
  input_session_id text,
  input_job_kind text,
  input_executor_id text,
  input_lease_fence bigint
) RETURNS TABLE(lifecycle_job_id bigint, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT job.lifecycle_job_id, job.created_at
  FROM hns_root_import_lifecycle_jobs AS job
  WHERE job.lifecycle_job_id = input_job_id
    AND job.root_import_session_id = input_session_id
    AND job.job_kind = input_job_kind
    AND job.state = 'leased'
    AND job.leased_by = input_executor_id
    AND job.lease_fence = input_lease_fence
    AND job.lease_expires_at > clock_timestamp()
  FOR UPDATE
$$;

REVOKE ALL ON FUNCTION lock_hns_root_import_lifecycle_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_hns_root_import_lifecycle_job_v1(bigint,text,text,text,bigint) FROM PUBLIC;
DO $pin_hns_runtime_locks$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION lock_hns_root_import_lifecycle_v1(text) SET search_path TO %I, pg_temp',
    current_schema()
  );
  EXECUTE format(
    'ALTER FUNCTION lock_hns_root_import_lifecycle_job_v1(bigint,text,text,text,bigint) SET search_path TO %I, pg_temp',
    current_schema()
  );
END;
$pin_hns_runtime_locks$;

DO $hns_import_runtime_function_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pscale_api_gfbytfmpuetx') THEN
    GRANT EXECUTE ON FUNCTION claim_hns_root_import_lifecycle_job_v1(text,integer) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION finalize_hns_root_import_lifecycle_job_v1(bigint,text,bigint,text,text) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION renew_hns_community_root_import_challenge_v1(text,text,text,text,jsonb,text) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION hns_root_import_publication_window_decision_v1(text) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION hns_root_import_publication_window_open_v1(text) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION hold_hns_root_import_for_recovery_v1(text,text,text) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION authorize_hns_root_import_publication_poll_v1(text,text,text,text,text,text,text) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION commit_hns_root_import_lifecycle_decision_v1(text,bigint,text,text,text,text,text,jsonb,jsonb,bigint,bigint,bigint) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION record_hns_root_import_lifecycle_observation_v1(text,bigint,text,bigint,text,text,bigint,bigint,bigint,timestamptz,text,integer) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION claim_hns_root_import_observation_job_v1(text,integer) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION finalize_hns_root_import_observation_job_v1(text,text,bigint,text,text,bytea,text,text) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION record_hns_root_import_retention_review_v1(text,bigint,text,bigint,bigint,text,text,timestamptz,timestamptz,text,text,timestamptz) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION authorize_hns_root_import_retirement_v1(text,integer) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION commit_hns_root_import_readiness_v1(text,bigint,text,bigint,bigint,bytea,text) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION hns_lifecycle_schema_compatibility_v1(text,text) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION run_hns_lifecycle_readiness_cutover_probe_v1(text,text,text,text,text,timestamptz) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION commit_hns_root_import_activation_v1(text,bigint,bigint,bigint,text,text,text,timestamptz,text,boolean) TO pscale_api_gfbytfmpuetx;
    GRANT EXECUTE ON FUNCTION authorize_hns_root_import_activation_v1(text,bigint,bigint,bigint,text,text,text,timestamptz,text,boolean) TO pscale_api_gfbytfmpuetx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hns_root_import_executor_login_v1') THEN
    GRANT SELECT ON
      hns_authority_provision_jobs,
      hns_lifecycle_schema_cutover,
      hns_root_health_renewal_jobs,
      hns_root_import_lifecycle,
      hns_root_import_lifecycle_history,
      hns_root_import_lifecycle_jobs,
      hns_root_import_sessions
    TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION lock_hns_root_import_lifecycle_v1(text) TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION lock_hns_root_import_lifecycle_job_v1(bigint,text,text,text,bigint) TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION authorize_hns_root_import_retirement_v1(text,integer) TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION claim_hns_root_import_lifecycle_job_v1(text,integer) TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION commit_hns_root_import_lifecycle_decision_v1(text,bigint,text,text,text,text,text,jsonb,jsonb,bigint,bigint,bigint) TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION commit_hns_root_import_readiness_v1(text,bigint,text,bigint,bigint,bytea,text) TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION finalize_hns_root_import_lifecycle_job_v1(bigint,text,bigint,text,text) TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION finalize_hns_root_import_observation_job_v1(text,text,bigint,text,text,bytea,text,text) TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION record_hns_root_import_lifecycle_observation_v1(text,bigint,text,bigint,text,text,bigint,bigint,bigint,timestamptz,text,integer) TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION record_hns_root_import_retention_review_v1(text,bigint,text,bigint,bigint,text,text,timestamptz,timestamptz,text,text,timestamptz) TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION run_hns_lifecycle_readiness_cutover_probe_v1(text,text,text,text,text,timestamptz) TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION set_hns_root_import_lifecycle_plan_digest_v1(text,text) TO hns_root_import_executor_login_v1;
  END IF;
END;
$hns_import_runtime_function_grants$;
