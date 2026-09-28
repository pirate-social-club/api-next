-- Production uses a provider-managed runtime role instead of api_next_app.
-- The full HNS import needs the same fenced HNS routines granted in
-- roles.sql.example. Keep operator recovery and teardown functions excluded.
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
END;
$hns_import_runtime_function_grants$;
