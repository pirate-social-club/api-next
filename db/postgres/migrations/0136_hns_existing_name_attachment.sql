-- Existing Pirate-hosted roots reuse their retained authority, and abandoned
-- preparations stop consuming an actor budget once cleanup proves no live
-- reservation remains.

CREATE FUNCTION hns_community_root_import_consumes_actor_budget_v1(input_session_id TEXT)
RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN preparation.admission_kind <> 'community_provisional' THEN FALSE
      WHEN provision.state = 'completed'
        AND convert_from(provision.result_bytes, 'UTF8')::jsonb @> '{"zone_created":false}'::jsonb
      THEN FALSE
      WHEN COALESCE(session.expires_at, preparation.expires_at) <= clock_timestamp()
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

CREATE OR REPLACE FUNCTION admit_hns_community_root_import_v1(
  input_actor_id TEXT, input_community_id TEXT, input_root_label TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  database_now TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hns-community-provisional-admission-v1', 0));
  database_now := clock_timestamp();
  IF NOT EXISTS (
    SELECT 1 FROM communities AS community
    WHERE community.community_id = input_community_id AND community.status = 'active'
      AND community.route_authority_version = 'optional_route_v2'
      AND community.canonical_route_binding_id IS NULL
      AND has_community_route_authority(input_community_id, input_actor_id)
  ) THEN RETURN FALSE; END IF;
  IF (SELECT count(*) FROM hns_community_root_import_preparations AS preparation
      WHERE preparation.actor_id = input_actor_id
        AND preparation.admission_kind = 'community_provisional'
        AND preparation.created_at > database_now - interval '24 hours'
        AND hns_community_root_import_consumes_actor_budget_v1(
          preparation.root_import_session_id
        )) >= 3
  THEN RETURN FALSE; END IF;
  IF EXISTS (
    SELECT 1 FROM hns_community_root_import_preparations AS preparation
    WHERE (community_id = input_community_id OR root_label = input_root_label)
      AND hns_community_root_import_reservation_held_v1(preparation.root_import_session_id)
  ) THEN RETURN FALSE; END IF;
  IF (SELECT count(*) FROM hns_community_root_import_preparations AS preparation
      WHERE hns_community_root_import_reservation_held_v1(preparation.root_import_session_id)) >= 32
  THEN RETURN FALSE; END IF;
  RETURN TRUE;
END;
$$;

DO $pin$
DECLARE
  installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION hns_community_root_import_consumes_actor_budget_v1(text) SET search_path TO %I, pg_temp',
    installed_schema
  );
  EXECUTE format(
    'ALTER FUNCTION admit_hns_community_root_import_v1(text,text,text) SET search_path TO %I, pg_temp',
    installed_schema
  );
END;
$pin$;

REVOKE ALL ON FUNCTION hns_community_root_import_consumes_actor_budget_v1(TEXT) FROM PUBLIC;

-- Reconciliation happens only after the owner has published the exact plan.
-- Admit that bounded PowerDNS mutation under the leased observation job while
-- retaining the existing provision and teardown fencing rules.
CREATE OR REPLACE FUNCTION lock_hns_root_zone_mutation_v1(
  input_root_label TEXT, input_challenge_txt_value TEXT, input_teardown BOOLEAN,
  input_job_id TEXT, input_executor_id TEXT, input_lease_fence BIGINT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
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
      admitted_kind := 'observation';
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
      ));
  END IF;
  IF admitted_kind = 'observation' THEN
    RETURN retained_session.status='observing'
      AND retained_session.observation_job_id=input_job_id
      AND retained_session.expires_at>clock_timestamp();
  END IF;
  RETURN retained_session.status='provisioning'
    AND retained_session.expires_at>clock_timestamp();
END;
$$;

DO $pin_mutation$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION lock_hns_root_zone_mutation_v1(text,text,boolean,text,text,bigint) SET search_path TO %I, pg_temp',
    installed_schema
  );
END;
$pin_mutation$;

REVOKE ALL ON FUNCTION lock_hns_root_zone_mutation_v1(TEXT,TEXT,BOOLEAN,TEXT,TEXT,BIGINT) FROM PUBLIC;
