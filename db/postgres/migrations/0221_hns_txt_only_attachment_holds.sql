-- HNS TXT-only attachment holds and quota.
--
-- A TXT-only attachment reuses the community import preparation but never
-- creates a root-import session. Through 0208 a sessionless preparation held
-- its community and root until the preparation expired, even after the
-- attachment was committed or had failed, and a preparation counted against
-- the actor's daily quota even when no ownership challenge was ever issued.
--
-- Two narrow changes, both limited to sessionless preparations:
--
-- 1. The reservation is released once the attachment intent is committed,
--    failed or expired.
-- 2. A preparation that never issued an ownership challenge stops counting
--    against the daily quota ten minutes after it was created. The grace
--    period keeps an in-flight start counted, so concurrent starts cannot
--    exceed the limit. An issued challenge keeps counting even if abandoned.
--
-- Every branch for preparations with a root-import session is unchanged.

CREATE OR REPLACE FUNCTION hns_community_root_import_reservation_held_v1(input_session_id text) RETURNS boolean
    LANGUAGE sql
    AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN session.status = 'activated' THEN FALSE
      WHEN teardown.state = 'completed' THEN FALSE
      WHEN session.root_import_session_id IS NULL
        AND attachment.status IN ('committed', 'failed', 'expired') THEN FALSE
      WHEN NOT hns_root_import_session_clock_passed_v1(preparation.root_import_session_id,
        COALESCE(session.expires_at, preparation.expires_at), clock_timestamp()) THEN TRUE
      WHEN job.provision_job_id IS NULL OR job.attempt_count = 0 THEN FALSE
      ELSE TRUE
    END
    FROM hns_community_root_import_preparations AS preparation
    LEFT JOIN community_route_attachment_intents AS attachment
      ON attachment.attachment_intent_id = preparation.attachment_intent_id
    LEFT JOIN hns_root_import_sessions AS session
      ON session.root_import_session_id = preparation.root_import_session_id
    LEFT JOIN hns_authority_provision_jobs AS job
      ON job.provision_job_id = preparation.provision_job_id
    LEFT JOIN hns_root_import_teardown_jobs AS teardown
      ON teardown.root_import_session_id = preparation.root_import_session_id
    WHERE preparation.root_import_session_id = input_session_id
  ), FALSE)
$$;

CREATE OR REPLACE FUNCTION hns_community_root_import_consumes_actor_budget_v1(input_session_id text) RETURNS boolean
    LANGUAGE sql
    AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN preparation.admission_kind <> 'community_provisional' THEN FALSE
      WHEN provision.state = 'completed'
        AND convert_from(provision.result_bytes, 'UTF8')::jsonb @> '{"zone_created":false}'::jsonb
      THEN FALSE
      WHEN session.root_import_session_id IS NULL
        AND preparation.created_at <= clock_timestamp() - interval '10 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM community_route_attachment_namespace_sessions AS ownership
           WHERE ownership.attachment_intent_id = preparation.attachment_intent_id
        )
      THEN FALSE
      WHEN hns_root_import_session_clock_passed_v1(preparation.root_import_session_id,
        COALESCE(session.expires_at, preparation.expires_at), clock_timestamp())
        AND NOT hns_community_root_import_reservation_held_v1(preparation.root_import_session_id)
      THEN FALSE
      ELSE TRUE
    END
    FROM hns_community_root_import_preparations AS preparation
    LEFT JOIN hns_root_import_sessions AS session
      ON session.root_import_session_id = preparation.root_import_session_id
    LEFT JOIN hns_authority_provision_jobs AS provision
      ON provision.provision_job_id = preparation.provision_job_id
    WHERE preparation.root_import_session_id = input_session_id
  ), FALSE)
$$;

DO $txt_only_attachment_search_path$
DECLARE
  installed_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'hns_community_root_import_reservation_held_v1(text)',
    'hns_community_root_import_consumes_actor_budget_v1(text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I, pg_temp', signature, installed_schema);
  END LOOP;
END;
$txt_only_attachment_search_path$;
