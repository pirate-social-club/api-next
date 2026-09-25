-- HNS import separated clocks.
--
-- Spec 012's 2026-09-09 amendment retired the single import/challenge expiry,
-- but session creation still copied the one-hour hns-txt-v1 ownership expiry
-- into hns_root_import_sessions.expires_at, and that value kept governing an
-- import after its publication plan was exposed. Resuming a sessionless
-- preparation more than an hour after its start failed the session time check
-- with an HTTP 500. The approved design is
-- handoffs/HNS-SEPARATED-CLOCKS-DESIGN-2026-09-25.md in the control plane.
--
-- Two clocks now apply to a community root import:
--
--   * Before plan exposure, the session's own expires_at. New sessions take the
--     preparation's expiry; the one-hour challenge only bounds presentation of
--     a challenge that is not yet part of a session. An expired challenge on a
--     sessionless preparation is renewed at the next ceremony generation.
--   * After plan exposure, the lifecycle publication window, read through an
--     immutable publication authorization written in the transaction that
--     exposes the plan. hns-txt-v1 itself is unchanged; imports poll the
--     verifier under the distinct hns-txt-import-v1 contract.
--
-- Creation-intent imports are out of scope and keep their existing clock.
-- Existing community sessions are classified from stored evidence into an
-- append-only inventory before any rule is applied (see the end of the file).

-- Whether a community root import has exposed its publication plan. Exposure
-- is the lifecycle's record, not the session status.
CREATE FUNCTION hns_root_import_plan_exposed_v1(input_session_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT EXISTS (
    SELECT 1
      FROM hns_root_import_sessions AS session
      JOIN hns_root_import_lifecycle AS lifecycle
        ON lifecycle.root_import_session_id = session.root_import_session_id
     WHERE session.root_import_session_id = input_session_id
       AND session.origin_kind = 'community_attachment'
       AND lifecycle.plan_exposed_at IS NOT NULL
  )
$$;

-- Whether a session's governing clock has released it. Before plan exposure
-- that is the session's own bound. Once a community import has exposed its
-- plan, no clock releases it: only a terminal lifecycle decision does, and the
-- retention rules then govern its provider resources.
CREATE FUNCTION hns_root_import_session_clock_passed_v1(
  input_session_id text,
  input_expires_at timestamp with time zone,
  input_now timestamp with time zone
) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE
    WHEN hns_root_import_plan_exposed_v1(input_session_id) THEN EXISTS (
      SELECT 1 FROM hns_root_import_lifecycle AS lifecycle
       WHERE lifecycle.root_import_session_id = input_session_id
         AND lifecycle.phase = 'failed'
    )
    ELSE input_expires_at <= input_now
  END
$$;

-- Immutable authority for polling an exposed plan under hns-txt-import-v1. It
-- is written once, with the plan, and snapshots the publication deadline
-- because the lifecycle column can still be patched by the decision writer.
CREATE TABLE hns_root_import_publication_authorizations (
  root_import_session_id text NOT NULL
    REFERENCES hns_root_import_sessions(root_import_session_id),
  authority_generation bigint NOT NULL CHECK (authority_generation > 0),
  actor_id text NOT NULL,
  community_id text NOT NULL,
  root_label text NOT NULL,
  namespace_session_id text NOT NULL,
  upstream_session_ref text NOT NULL,
  challenge_value_sha256 text NOT NULL CHECK (challenge_value_sha256 ~ '^[0-9a-f]{64}$'),
  publish_plan_sha256 text NOT NULL CHECK (publish_plan_sha256 ~ '^[0-9a-f]{64}$'),
  valid_until timestamp with time zone NOT NULL,
  authorized_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL CHECK (source IN ('plan_exposure', 'migration_backfill')),
  PRIMARY KEY (root_import_session_id, authority_generation),
  CONSTRAINT hns_root_import_publication_authorization_window CHECK (valid_until > authorized_at)
);

CREATE FUNCTION reject_hns_root_import_publication_authorization_change_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'HNS root-import publication authorizations are immutable';
END;
$$;

CREATE TRIGGER hns_root_import_publication_authorizations_change_guard
BEFORE DELETE OR UPDATE ON hns_root_import_publication_authorizations
FOR EACH ROW EXECUTE FUNCTION reject_hns_root_import_publication_authorization_change_v1();

-- Written by the lifecycle write that records exposure, so the authorization
-- exists exactly when an exposed plan does, whichever release performed the
-- write. Any source that is missing or inconsistent writes nothing, and the
-- window functions below then deny.
CREATE FUNCTION record_hns_root_import_publication_authorization_v1() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  ownership community_route_attachment_namespace_sessions%ROWTYPE;
  provision_plan_sha256 text;
BEGIN
  IF OLD.plan_exposed_at IS NOT NULL
    OR NEW.plan_exposed_at IS NULL
    OR NEW.publication_deadline_at IS NULL
    OR NEW.publication_deadline_at <= clock_timestamp()
  THEN
    RETURN NEW;
  END IF;
  SELECT * INTO session FROM hns_root_import_sessions
   WHERE root_import_session_id = NEW.root_import_session_id;
  IF NOT FOUND
    OR session.origin_kind <> 'community_attachment'
    OR session.publish_plan_sha256 IS NULL
  THEN
    RETURN NEW;
  END IF;
  -- A community plan exposed without consistent sources is a defect, not a
  -- state to leave behind: refusing here aborts the exposing commit, so the
  -- provisioner reports it instead of a plan sitting without authority.
  SELECT * INTO ownership FROM community_route_attachment_namespace_sessions
   WHERE namespace_session_id = session.namespace_session_id
     AND actor_id = session.actor_id
     AND community_id = session.community_id
     AND attachment_intent_id = session.attachment_intent_id;
  IF NOT FOUND
    OR session.challenge_txt_value <> 'pirate-verification=' || ownership.upstream_session_ref
  THEN
    RAISE EXCEPTION 'HNS root-import plan exposure has no matching ownership challenge';
  END IF;
  SELECT job.publish_plan_sha256 INTO provision_plan_sha256
    FROM hns_authority_provision_jobs AS job
   WHERE job.provision_job_id = session.provision_job_id;
  IF provision_plan_sha256 IS DISTINCT FROM session.publish_plan_sha256 THEN
    RAISE EXCEPTION 'HNS root-import plan exposure does not match its provision job';
  END IF;
  INSERT INTO hns_root_import_publication_authorizations (
    root_import_session_id, authority_generation, actor_id, community_id, root_label,
    namespace_session_id, upstream_session_ref, challenge_value_sha256,
    publish_plan_sha256, valid_until, source
  ) VALUES (
    session.root_import_session_id, NEW.generation, session.actor_id, session.community_id,
    session.root_label, session.namespace_session_id, ownership.upstream_session_ref,
    encode(sha256(convert_to(session.challenge_txt_value, 'UTF8')), 'hex'),
    session.publish_plan_sha256, NEW.publication_deadline_at, 'plan_exposure'
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hns_root_import_lifecycle_publication_authorization
AFTER UPDATE OF plan_exposed_at ON hns_root_import_lifecycle
FOR EACH ROW
WHEN (OLD.plan_exposed_at IS NULL AND NEW.plan_exposed_at IS NOT NULL)
EXECUTE FUNCTION record_hns_root_import_publication_authorization_v1();

-- The publication window decision for one exposed community import. The
-- phases that permit a publication check include the observation phases,
-- because the lifecycle may observe the chain before the owner's ownership
-- check completes. Validity takes the lower of the snapshot and the current
-- lifecycle deadline.
CREATE FUNCTION hns_root_import_publication_window_decision_v1(input_session_id text)
RETURNS TABLE(exposed boolean, window_open boolean, reason text, valid_until timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
#variable_conflict use_column
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  authorization_row hns_root_import_publication_authorizations%ROWTYPE;
  bound timestamp with time zone;
BEGIN
  SELECT * INTO session FROM hns_root_import_sessions
   WHERE root_import_session_id = input_session_id;
  IF NOT FOUND OR session.origin_kind <> 'community_attachment' THEN
    RETURN QUERY SELECT false, false, 'not_exposed'::text, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id;
  IF NOT FOUND OR lifecycle.plan_exposed_at IS NULL THEN
    RETURN QUERY SELECT false, false, 'not_exposed'::text, NULL::timestamptz;
    RETURN;
  END IF;
  -- The phase answers first: a held or finished import says so, whether or
  -- not an authorization exists for it.
  IF lifecycle.phase = 'recovery_required' THEN
    RETURN QUERY SELECT true, false, 'recovery_required'::text, lifecycle.publication_deadline_at;
    RETURN;
  END IF;
  IF lifecycle.phase NOT IN (
    'awaiting_publication', 'checking_publication', 'waiting_safe_commitment',
    'checking_authority', 'ready'
  ) THEN
    RETURN QUERY SELECT true, false, 'phase_closed'::text, lifecycle.publication_deadline_at;
    RETURN;
  END IF;
  SELECT * INTO authorization_row FROM hns_root_import_publication_authorizations
   WHERE root_import_session_id = input_session_id
     AND authority_generation = lifecycle.generation;
  IF NOT FOUND THEN
    RETURN QUERY SELECT true, false, 'authorization_missing'::text, NULL::timestamptz;
    RETURN;
  END IF;
  bound := LEAST(authorization_row.valid_until, lifecycle.publication_deadline_at);
  IF session.status <> 'awaiting_owner_update' THEN
    RETURN QUERY SELECT true, false, 'session_state'::text, bound;
    RETURN;
  END IF;
  IF authorization_row.actor_id <> session.actor_id
    OR authorization_row.community_id <> session.community_id
    OR authorization_row.root_label <> session.root_label
    OR authorization_row.namespace_session_id <> session.namespace_session_id
    OR authorization_row.publish_plan_sha256 IS DISTINCT FROM session.publish_plan_sha256
    OR authorization_row.challenge_value_sha256
       <> encode(sha256(convert_to(session.challenge_txt_value, 'UTF8')), 'hex')
    OR bound IS NULL
  THEN
    RETURN QUERY SELECT true, false, 'authorization_mismatch'::text, bound;
    RETURN;
  END IF;
  IF clock_timestamp() >= bound THEN
    RETURN QUERY SELECT true, false, 'deadline_passed'::text, bound;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, true, 'open'::text, bound;
END;
$$;

CREATE FUNCTION hns_root_import_publication_window_open_v1(input_session_id text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT COALESCE(
    (SELECT decision.window_open
       FROM hns_root_import_publication_window_decision_v1(input_session_id) AS decision),
    false
  )
$$;

-- For the HTTP completion, acknowledgement and projection paths. No row means
-- the namespace session belongs to no exposed community import, and the
-- unchanged hns-txt-v1 rules apply.
CREATE FUNCTION hns_root_import_publication_window_v1(
  input_actor_id text,
  input_community_id text,
  input_namespace_session_id text
) RETURNS TABLE(
  root_import_session_id text,
  root_label text,
  publish_plan_sha256 text,
  challenge_value_sha256 text,
  window_open boolean,
  reason text,
  valid_until timestamp with time zone
)
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT session.root_import_session_id, session.root_label, session.publish_plan_sha256,
         encode(sha256(convert_to(session.challenge_txt_value, 'UTF8')), 'hex'),
         decision.window_open, decision.reason, decision.valid_until
    FROM hns_root_import_sessions AS session
    CROSS JOIN LATERAL hns_root_import_publication_window_decision_v1(
      session.root_import_session_id
    ) AS decision
   WHERE session.actor_id = input_actor_id
     AND session.community_id = input_community_id
     AND session.namespace_session_id = input_namespace_session_id
     AND session.origin_kind = 'community_attachment'
     AND decision.exposed
$$;

-- For the verifier. Every binding must match the stored authorization and the
-- session, the namespace session must still be pending, and the window must
-- be open. Anything else returns no row, which is a denial.
CREATE FUNCTION authorize_hns_root_import_publication_poll_v1(
  input_actor_id text,
  input_community_id text,
  input_root_label text,
  input_namespace_session_id text,
  input_upstream_session_ref text,
  input_challenge_value_sha256 text,
  input_publish_plan_sha256 text
) RETURNS TABLE(
  root_import_session_id text,
  root_label text,
  valid_until timestamp with time zone
)
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT session.root_import_session_id, session.root_label, decision.valid_until
    FROM hns_root_import_sessions AS session
    JOIN hns_root_import_lifecycle AS lifecycle
      ON lifecycle.root_import_session_id = session.root_import_session_id
    JOIN hns_root_import_publication_authorizations AS authorization_row
      ON authorization_row.root_import_session_id = session.root_import_session_id
     AND authorization_row.authority_generation = lifecycle.generation
    JOIN community_route_attachment_namespace_sessions AS ownership
      ON ownership.namespace_session_id = session.namespace_session_id
     AND ownership.actor_id = session.actor_id
     AND ownership.community_id = session.community_id
     AND ownership.attachment_intent_id = session.attachment_intent_id
    CROSS JOIN LATERAL hns_root_import_publication_window_decision_v1(
      session.root_import_session_id
    ) AS decision
   WHERE session.actor_id = input_actor_id
     AND session.community_id = input_community_id
     AND session.root_label = input_root_label
     AND session.namespace_session_id = input_namespace_session_id
     AND session.origin_kind = 'community_attachment'
     AND ownership.status = 'pending'
     AND ownership.upstream_session_ref = input_upstream_session_ref
     AND authorization_row.upstream_session_ref = input_upstream_session_ref
     AND authorization_row.challenge_value_sha256 = input_challenge_value_sha256
     AND authorization_row.publish_plan_sha256 = input_publish_plan_sha256
     AND decision.window_open
$$;

-- The preparation row pins its generation-1 ceremony and is append-only.
-- Later generations are recorded here instead of loosening that guard.
CREATE TABLE hns_community_root_import_preparation_ceremonies (
  attachment_intent_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 1),
  ceremony_intent_id text NOT NULL UNIQUE
    REFERENCES community_route_attachment_ceremony_attempts(ceremony_intent_id),
  superseded_ceremony_intent_id text NOT NULL
    REFERENCES community_route_attachment_ceremony_attempts(ceremony_intent_id),
  superseded_namespace_session_id text,
  recorded_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (attachment_intent_id, generation)
);

CREATE FUNCTION reject_hns_community_root_import_preparation_ceremony_change_v1()
RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'HNS community root-import preparation ceremonies are append-only';
END;
$$;

CREATE TRIGGER hns_community_root_import_preparation_ceremonies_change_guard
BEFORE DELETE OR UPDATE ON hns_community_root_import_preparation_ceremonies
FOR EACH ROW EXECUTE FUNCTION reject_hns_community_root_import_preparation_ceremony_change_v1();

CREATE FUNCTION hns_community_root_import_current_ceremony_v1(input_attachment_intent_id text)
RETURNS TABLE(ceremony_intent_id text, generation bigint)
    LANGUAGE sql STABLE
    AS $$
  SELECT current_ceremony.ceremony_intent_id, current_ceremony.generation
    FROM (
      SELECT ceremony.ceremony_intent_id, ceremony.generation
        FROM hns_community_root_import_preparation_ceremonies AS ceremony
       WHERE ceremony.attachment_intent_id = input_attachment_intent_id
      UNION ALL
      SELECT preparation.ceremony_intent_id, 1::bigint
        FROM hns_community_root_import_preparations AS preparation
       WHERE preparation.attachment_intent_id = input_attachment_intent_id
    ) AS current_ceremony
   ORDER BY current_ceremony.generation DESC
   LIMIT 1
$$;

-- Renews an expired challenge for a preparation that has no session, under
-- the same fenced preparation. It consumes no admission and creates no
-- reservation. The caller holds the preparation's admission, root and
-- idempotency locks.
--
-- Outcomes: renewed, current (the current challenge is live or not started),
-- preparation_expired, session_exists, not_renewable.
CREATE FUNCTION renew_hns_community_root_import_challenge_v1(
  input_actor_id text,
  input_community_id text,
  input_attachment_intent_id text,
  input_new_ceremony_intent_id text,
  input_reservation_request jsonb,
  input_reservation_request_hash text
) RETURNS TABLE(outcome text, ceremony_intent_id text, generation bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
#variable_conflict use_column
DECLARE
  preparation hns_community_root_import_preparations%ROWTYPE;
  intent community_route_attachment_intents%ROWTYPE;
  requirement community_route_attachment_requirement_states%ROWTYPE;
  current_ceremony_id text;
  current_generation bigint;
  ownership community_route_attachment_namespace_sessions%ROWTYPE;
  prior_attempt community_route_attachment_ceremony_attempts%ROWTYPE;
  database_now timestamp with time zone := clock_timestamp();
BEGIN
  SELECT * INTO preparation FROM hns_community_root_import_preparations
   WHERE attachment_intent_id = input_attachment_intent_id
     AND actor_id = input_actor_id
     AND community_id = input_community_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_renewable'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM hns_root_import_sessions AS session
     WHERE session.root_import_session_id = preparation.root_import_session_id
  ) THEN
    RETURN QUERY SELECT 'session_exists'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  SELECT * INTO intent FROM community_route_attachment_intents
   WHERE attachment_intent_id = input_attachment_intent_id
     AND actor_id = input_actor_id
   FOR UPDATE;
  IF NOT FOUND
    OR preparation.expires_at <= database_now
    OR intent.expires_at <= database_now
    OR intent.status <> 'verification_required'
  THEN
    RETURN QUERY SELECT 'preparation_expired'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  SELECT current_ceremony.ceremony_intent_id, current_ceremony.generation
    INTO current_ceremony_id, current_generation
    FROM hns_community_root_import_current_ceremony_v1(input_attachment_intent_id)
      AS current_ceremony;
  SELECT * INTO requirement FROM community_route_attachment_requirement_states
   WHERE attachment_intent_id = input_attachment_intent_id
     AND requirement_kind = 'namespace_ownership'
   FOR UPDATE;
  IF NOT FOUND
    OR requirement.status <> 'pending'
    OR requirement.generation <> current_generation
    OR requirement.current_ceremony_intent_id IS DISTINCT FROM current_ceremony_id
  THEN
    RETURN QUERY SELECT 'not_renewable'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  SELECT * INTO ownership FROM community_route_attachment_namespace_sessions
   WHERE actor_id = input_actor_id
     AND ceremony_intent_id = current_ceremony_id
   FOR UPDATE;
  IF NOT FOUND OR (ownership.status = 'pending' AND ownership.expires_at > database_now) THEN
    RETURN QUERY SELECT 'current'::text, current_ceremony_id, current_generation;
    RETURN;
  END IF;
  IF ownership.status <> 'pending'
    OR EXISTS (
      SELECT 1 FROM community_route_attachment_completion_observations AS observation
       WHERE observation.namespace_session_id = ownership.namespace_session_id
    )
    OR EXISTS (
      SELECT 1 FROM community_route_attachment_completion_attempts AS attempt
       WHERE attempt.namespace_session_id = ownership.namespace_session_id
         AND attempt.state = 'leased'
         AND attempt.lease_expires_at > database_now
    )
  THEN
    RETURN QUERY SELECT 'not_renewable'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  IF input_new_ceremony_intent_id IS NULL
    OR NOT is_hns_host_persistence_identity(input_new_ceremony_intent_id, 256)
    OR input_reservation_request_hash IS NULL
    OR input_reservation_request_hash !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(input_reservation_request) IS DISTINCT FROM 'object'
    OR input_reservation_request->>'version'
       IS DISTINCT FROM 'pirate-community-route-attachment-ceremony-reservation-v1'
    OR input_reservation_request->>'actor_id' IS DISTINCT FROM input_actor_id
    OR input_reservation_request->>'community_id' IS DISTINCT FROM input_community_id
    OR input_reservation_request->>'attachment_intent_id'
       IS DISTINCT FROM input_attachment_intent_id
    OR input_reservation_request->>'ceremony_intent_id'
       IS DISTINCT FROM input_new_ceremony_intent_id
    OR (input_reservation_request->>'generation')::bigint IS DISTINCT FROM current_generation + 1
    OR input_reservation_request->>'requirement_hash' IS DISTINCT FROM requirement.requirement_hash
    OR input_reservation_request->>'provider_id' IS DISTINCT FROM requirement.provider_id
    OR input_reservation_request->>'provider_binding_hash'
       IS DISTINCT FROM requirement.provider_binding_hash
  THEN
    RAISE EXCEPTION 'invalid HNS root-import challenge renewal input';
  END IF;
  SELECT * INTO prior_attempt FROM community_route_attachment_ceremony_attempts
   WHERE community_route_attachment_ceremony_attempts.ceremony_intent_id = current_ceremony_id;

  -- pending(n) -> expired(n) -> pending(n + 1), with the attempt between,
  -- is the only path guard_community_route_attachment_requirement_state and
  -- validate_community_route_attachment_attempt_insert allow.
  UPDATE community_route_attachment_requirement_states
     SET status = 'expired', updated_at = database_now
   WHERE attachment_intent_id = input_attachment_intent_id
     AND requirement_kind = 'namespace_ownership'
     AND status = 'pending'
     AND current_ceremony_intent_id = current_ceremony_id;
  INSERT INTO community_route_attachment_ceremony_attempts (
    ceremony_intent_id, attachment_intent_id, actor_id, requirement_kind, generation,
    requirement_hash, provider_id, provider_binding_hash, provider_configuration_kind,
    provider_configuration_ref, provider_configuration_version, family, root_label,
    root_label_display, path_segment, reservation_request_hash, reservation_request,
    expires_at
  ) VALUES (
    input_new_ceremony_intent_id, input_attachment_intent_id, input_actor_id,
    'namespace_ownership', current_generation + 1, requirement.requirement_hash,
    requirement.provider_id, requirement.provider_binding_hash,
    requirement.provider_configuration_kind, requirement.provider_configuration_ref,
    requirement.provider_configuration_version, requirement.family, requirement.root_label,
    requirement.root_label_display, requirement.path_segment,
    input_reservation_request_hash, input_reservation_request, intent.expires_at
  );
  UPDATE community_route_attachment_requirement_states
     SET status = 'pending', generation = current_generation + 1,
         current_ceremony_intent_id = input_new_ceremony_intent_id,
         updated_at = database_now
   WHERE attachment_intent_id = input_attachment_intent_id
     AND requirement_kind = 'namespace_ownership'
     AND status = 'expired'
     AND generation = current_generation;
  INSERT INTO hns_community_root_import_preparation_ceremonies (
    attachment_intent_id, generation, ceremony_intent_id, superseded_ceremony_intent_id,
    superseded_namespace_session_id
  ) VALUES (
    input_attachment_intent_id, current_generation + 1, input_new_ceremony_intent_id,
    current_ceremony_id, ownership.namespace_session_id
  );
  RETURN QUERY SELECT 'renewed'::text, input_new_ceremony_intent_id, current_generation + 1;
END;
$$;

-- Holds an exposed community import for operator recovery, with authority
-- retained and no provider action: a recovery finding naming the reason, then
-- the lifecycle transition, through the existing writers. It is the path for
-- pre-repair plans (this migration) and for an exhausted ownership check.
-- Outcomes: held, already_held, not_holdable.
CREATE FUNCTION hold_hns_root_import_for_recovery_v1(
  input_session_id text,
  input_reason text,
  input_evidence_ref text
) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
#variable_conflict use_column
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  finding record;
  decision record;
BEGIN
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  IF NOT FOUND OR lifecycle.plan_exposed_at IS NULL
    OR lifecycle.phase IN ('failed', 'activated', 'preparing')
  THEN
    RETURN 'not_holdable';
  END IF;
  SELECT * INTO finding FROM record_hns_root_import_recovery_finding_v1(
    input_session_id, lifecycle.generation, input_evidence_ref,
    'insufficient_evidence', input_reason, NULL, NULL, NULL, NULL,
    lifecycle.plan_encoded_resource_sha256, NULL, NULL, NULL, NULL
  );
  IF finding.outcome NOT IN ('recorded', 'replayed') THEN
    RAISE EXCEPTION 'HNS recovery finding was refused: %', finding.outcome;
  END IF;
  IF lifecycle.phase = 'recovery_required' THEN
    RETURN 'already_held';
  END IF;
  SELECT * INTO decision FROM commit_hns_root_import_lifecycle_decision_v1(
    input_session_id, lifecycle.revision,
    'recovery_hold:' || input_evidence_ref, 'recovery_hold', 'transition',
    input_reason || '_authority_retained', 'recovery_required',
    jsonb_strip_nulls(jsonb_build_object(
      'pending_reason', input_reason,
      'next_check_at', lifecycle.next_check_at,
      'observation_count', lifecycle.observation_count,
      'consecutive_operational_failures', lifecycle.consecutive_operational_failures,
      'last_useful_error', lifecycle.last_useful_error,
      'last_useful_error_at', lifecycle.last_useful_error_at,
      'terminal_decided_at', lifecycle.terminal_decided_at
    )),
    '[]'::jsonb
  );
  IF decision.outcome NOT IN ('transition', 'replay') THEN
    RAISE EXCEPTION 'HNS recovery hold was refused: %', decision.outcome;
  END IF;
  RETURN 'held';
END;
$$;

-- An ownership check that never reached a verifier able to answer it is
-- recorded as not attempted and does not count toward the three-attempt
-- completion budget.
ALTER TABLE community_route_attachment_completion_attempts
  DROP CONSTRAINT community_route_attachment_completion_attempts_state_check,
  ADD CONSTRAINT community_route_attachment_completion_attempts_state_check
    CHECK (state IN ('leased', 'released', 'consumed', 'not_attempted'));
ALTER TABLE community_route_attachment_completion_attempts
  DROP CONSTRAINT community_route_attachment_completion_shape,
  ADD CONSTRAINT community_route_attachment_completion_shape CHECK (
    is_hns_host_persistence_identity(completion_attempt_id, 256)
    AND is_hns_host_persistence_identity(idempotency_key, 256)
    AND is_hns_host_persistence_identity(evidence_ref, 256)
    AND updated_at >= created_at
    AND (
      (state IN ('leased', 'released', 'not_attempted')
        AND terminal_status IS NULL AND result_hash IS NULL AND terminal_at IS NULL)
      OR (state = 'consumed'
        AND terminal_status IS NOT NULL AND result_hash IS NOT NULL AND terminal_at IS NOT NULL)
    )
  );

-- A root-import session is created only from a live challenge, bound to its
-- preparation's current ceremony, with the preparation's expiry as its
-- pre-exposure bound.
CREATE OR REPLACE FUNCTION guard_hns_root_import_session_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  creation_ownership namespace_ownership_sessions%ROWTYPE;
  attachment_ownership community_route_attachment_namespace_sessions%ROWTYPE;
  attachment_preparation hns_community_root_import_preparations%ROWTYPE;
BEGIN
  IF NEW.origin_kind = 'creation_intent' THEN
    SELECT * INTO creation_ownership
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
     FOR SHARE;
    IF NOT FOUND
      OR creation_ownership.actor_id <> NEW.actor_id
      OR creation_ownership.creation_intent_id <> NEW.creation_intent_id
      OR creation_ownership.ceremony_intent_id <> NEW.ceremony_intent_id
      OR creation_ownership.requirement_kind <> 'namespace_ownership'
      OR creation_ownership.generation <> NEW.ownership_generation
      OR creation_ownership.expected_revision <> NEW.ownership_expected_revision
      OR creation_ownership.route_family <> 'hns'
      OR creation_ownership.route_root_label <> NEW.root_label
      OR creation_ownership.status <> 'pending'
      OR creation_ownership.expires_at <> NEW.expires_at THEN
      RAISE EXCEPTION 'HNS root-import session does not match creation ownership authority';
    END IF;
  ELSIF NEW.origin_kind = 'community_attachment' THEN
    SELECT * INTO attachment_ownership
      FROM community_route_attachment_namespace_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
     FOR SHARE;
    IF NOT FOUND
      OR attachment_ownership.actor_id <> NEW.actor_id
      OR attachment_ownership.community_id <> NEW.community_id
      OR attachment_ownership.attachment_intent_id <> NEW.attachment_intent_id
      OR attachment_ownership.generation <> NEW.ownership_generation
      OR attachment_ownership.expected_revision <> NEW.ownership_expected_revision
      OR attachment_ownership.route_root_label <> NEW.root_label
      OR attachment_ownership.status <> 'pending'
      -- A session is only ever created from a live challenge. An expired one
      -- is renewed at the next ceremony generation first (0206).
      OR attachment_ownership.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'HNS root-import session does not match attachment ownership authority';
    END IF;
    SELECT * INTO attachment_preparation
      FROM hns_community_root_import_preparations
     WHERE root_import_session_id = NEW.root_import_session_id;
    IF FOUND THEN
      -- The session takes the preparation's expiry as its pre-exposure bound.
      -- The challenge expiry is still accepted so a release that predates
      -- 0206 keeps starting sessions during a rollout.
      IF attachment_preparation.attachment_intent_id <> NEW.attachment_intent_id
        OR attachment_ownership.ceremony_intent_id IS DISTINCT FROM (
          SELECT current_ceremony.ceremony_intent_id
            FROM hns_community_root_import_current_ceremony_v1(NEW.attachment_intent_id)
              AS current_ceremony
        )
        OR (
          NEW.expires_at <> attachment_preparation.expires_at
          AND NEW.expires_at <> attachment_ownership.expires_at
        )
      THEN
        RAISE EXCEPTION 'HNS root-import session does not match its preparation';
      END IF;
    ELSIF attachment_ownership.expires_at <> NEW.expires_at THEN
      RAISE EXCEPTION 'HNS root-import session does not match attachment ownership authority';
    END IF;
  ELSE
    RAISE EXCEPTION 'HNS root-import session origin is invalid';
  END IF;
  IF NEW.status <> 'awaiting_ownership' OR NEW.revision <> 1 THEN
    RAISE EXCEPTION 'HNS root-import session must start awaiting ownership';
  END IF;
  RETURN NEW;
END;
$$;

-- Reaping another session on the same root follows the pre-exposure clock. An
-- exposed community import is never expired by a clock.
CREATE OR REPLACE FUNCTION begin_hns_root_import_provision_v1(input_actor_id text, input_creation_intent_id text, input_root_import_session_id text, input_expected_revision bigint, input_idempotency_key text, input_poll_request_sha256 text, input_ownership_result_sha256 text, input_provision_job_id text, input_provision_request_bytes bytea, input_provision_request_sha256 text) RETURNS TABLE(outcome text, root_import_session_id text, session_revision bigint)
    LANGUAGE plpgsql
    AS $_$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  ownership_result community_creation_ceremony_results%ROWTYPE;
  job hns_authority_provision_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE actor_id = input_actor_id
     AND creation_intent_id = input_creation_intent_id
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
    IF session.provision_idempotency_key = input_idempotency_key
      AND session.provision_poll_request_sha256 = input_poll_request_sha256
      AND session.ownership_result_sha256 = input_ownership_result_sha256
      AND session.provision_job_id = input_provision_job_id
      AND job.request_bytes = input_provision_request_bytes
      AND job.request_sha256 = input_provision_request_sha256
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
    OR input_ownership_result_sha256 !~ '^[0-9a-f]{64}$'
    OR input_provision_request_sha256 !~ '^[0-9a-f]{64}$'
    OR encode(sha256(input_provision_request_bytes), 'hex')
       <> input_provision_request_sha256
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
    OR ownership_result.result_hash <> input_ownership_result_sha256
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  -- Unverified sessions deliberately do not reserve a root. Serialize the
  -- proof-to-provision transition so only a verified owner can claim it.
  PERFORM pg_advisory_xact_lock(hashtextextended('hns-root-import:' || session.root_label, 0));
  UPDATE hns_authority_provision_jobs AS stale_job
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'session_expired', completed_at = database_now,
         updated_at = database_now
    FROM hns_root_import_sessions AS stale_session
   WHERE stale_session.root_label = session.root_label
     AND stale_session.root_import_session_id <> session.root_import_session_id
     AND stale_session.status = 'provisioning'
     AND hns_root_import_session_clock_passed_v1(
           stale_session.root_import_session_id, stale_session.expires_at, database_now)
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
     AND hns_root_import_session_clock_passed_v1(
           stale_session.root_import_session_id, stale_session.expires_at, database_now)
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
     AND hns_root_import_session_clock_passed_v1(
           stale_session.root_import_session_id, stale_session.expires_at, database_now)
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
         ownership_result_sha256 = input_ownership_result_sha256,
         updated_at = database_now
   WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
  RETURN QUERY SELECT 'provisioning'::TEXT, session.root_import_session_id, session.revision + 1;
END;
$_$;

CREATE OR REPLACE FUNCTION begin_hns_root_import_provision_v2(input_actor_id text, input_creation_intent_id text, input_root_import_session_id text, input_expected_revision bigint, input_idempotency_key text, input_poll_request_sha256 text, input_authorization_kind text, input_authorization_sha256 text, input_name_proof_result_bytes bytea, input_name_proof_message_sha256 text, input_name_proof_signature_sha256 text, input_provision_job_id text, input_provision_request_bytes bytea, input_provision_request_sha256 text) RETURNS TABLE(outcome text, root_import_session_id text, session_revision bigint)
    LANGUAGE plpgsql
    AS $_$
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
          input_authorization_kind IN ('namespace_ownership', 'community_provisional')
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
    OR input_authorization_kind NOT IN ('namespace_ownership', 'hns_name_signature', 'community_provisional')
    OR input_authorization_sha256 !~ '^[0-9a-f]{64}$'
    OR input_provision_request_sha256 !~ '^[0-9a-f]{64}$'
    OR encode(sha256(input_provision_request_bytes), 'hex')
       <> input_provision_request_sha256
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;

  IF input_authorization_kind = 'community_provisional' THEN
    IF session.origin_kind <> 'community_attachment'
      OR input_name_proof_result_bytes IS NOT NULL
      OR input_name_proof_message_sha256 IS NOT NULL
      OR input_name_proof_signature_sha256 IS NOT NULL
      OR NOT has_community_route_authority(session.community_id, session.actor_id)
      OR NOT EXISTS (
        SELECT 1 FROM hns_community_root_import_preparations AS preparation
        WHERE preparation.root_import_session_id = session.root_import_session_id
          AND preparation.attachment_intent_id = session.attachment_intent_id
          AND preparation.actor_id = session.actor_id
          AND preparation.community_id = session.community_id
          AND preparation.root_label = session.root_label
          AND preparation.provision_job_id = input_provision_job_id
          AND preparation.admission_kind = 'community_provisional'
          AND preparation.start_request_sha256 = input_authorization_sha256
          AND preparation.expires_at > database_now
      )
    THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
  ELSIF input_authorization_kind = 'namespace_ownership' THEN
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
  IF EXISTS (
    SELECT 1 FROM hns_community_root_import_preparations AS preparation
    WHERE preparation.root_label = session.root_label
      AND preparation.root_import_session_id <> session.root_import_session_id
      AND hns_community_root_import_reservation_held_v1(preparation.root_import_session_id)
  ) THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;

  UPDATE hns_authority_provision_jobs AS stale_job
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'session_expired', completed_at = database_now,
         updated_at = database_now
    FROM hns_root_import_sessions AS stale_session
   WHERE stale_session.root_label = session.root_label
     AND stale_session.root_import_session_id <> session.root_import_session_id
     AND stale_session.status = 'provisioning'
     AND hns_root_import_session_clock_passed_v1(
           stale_session.root_import_session_id, stale_session.expires_at, database_now)
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
     AND hns_root_import_session_clock_passed_v1(
           stale_session.root_import_session_id, stale_session.expires_at, database_now)
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
     AND hns_root_import_session_clock_passed_v1(
           stale_session.root_import_session_id, stale_session.expires_at, database_now)
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
$_$;

-- After exposure the ownership check may begin observation only inside the
-- lifecycle publication window.
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
    -- Before plan exposure the session's own bound applies. After exposure
    -- the lifecycle publication window governs (0206, separated clocks).
    OR (CASE WHEN hns_root_import_plan_exposed_v1(session.root_import_session_id)
         THEN NOT hns_root_import_publication_window_open_v1(session.root_import_session_id)
         ELSE session.expires_at <= database_now END)
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

-- Zone mutation follows the same clocks as the claims that lease it.
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
        -- Mirrors the teardown claim (0155, 0169): a lifecycle-owned session
        -- is retired under the retention rules, never by a clock.
        AND NOT EXISTS (
          SELECT 1 FROM hns_root_import_lifecycle AS lifecycle_owner
           WHERE lifecycle_owner.root_import_session_id = retained_session.root_import_session_id
        )
      ));
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

-- Reservation and budget accounting follow lifecycle state after exposure. The
-- rolling 24-hour admission window is unchanged.
CREATE OR REPLACE FUNCTION hns_community_root_import_reservation_held_v1(input_session_id text) RETURNS boolean
    LANGUAGE sql
    AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN session.status = 'activated' THEN FALSE
      WHEN teardown.state = 'completed' THEN FALSE
      WHEN NOT hns_root_import_session_clock_passed_v1(preparation.root_import_session_id,
        COALESCE(session.expires_at, preparation.expires_at), clock_timestamp()) THEN TRUE
      WHEN job.provision_job_id IS NULL OR job.attempt_count = 0 THEN FALSE
      ELSE TRUE
    END
    FROM hns_community_root_import_preparations AS preparation
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

DO $separated_clocks_search_path$
DECLARE
  installed_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'hns_root_import_plan_exposed_v1(text)',
    'hns_root_import_session_clock_passed_v1(text,timestamp with time zone,timestamp with time zone)',
    'reject_hns_root_import_publication_authorization_change_v1()',
    'record_hns_root_import_publication_authorization_v1()',
    'hns_root_import_publication_window_decision_v1(text)',
    'hns_root_import_publication_window_open_v1(text)',
    'hns_root_import_publication_window_v1(text,text,text)',
    'authorize_hns_root_import_publication_poll_v1(text,text,text,text,text,text,text)',
    'reject_hns_community_root_import_preparation_ceremony_change_v1()',
    'hns_community_root_import_current_ceremony_v1(text)',
    'renew_hns_community_root_import_challenge_v1(text,text,text,text,jsonb,text)',
    'hold_hns_root_import_for_recovery_v1(text,text,text)',
    'guard_hns_root_import_session_insert()',
    'begin_hns_root_import_provision_v1(text,text,text,bigint,text,text,text,text,bytea,text)',
    'begin_hns_root_import_provision_v2(text,text,text,bigint,text,text,text,text,bytea,text,text,text,bytea,text)',
    'begin_hns_root_import_observation_v1(text,text,text,bigint,text,text,text,text,bytea,text)',
    'lock_hns_root_zone_mutation_v1(text,text,boolean,text,text,bigint)',
    'hns_community_root_import_reservation_held_v1(text)',
    'hns_community_root_import_consumes_actor_budget_v1(text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I, pg_temp', signature, installed_schema);
  END LOOP;
END;
$separated_clocks_search_path$;

REVOKE ALL ON FUNCTION record_hns_root_import_publication_authorization_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION hns_root_import_publication_window_decision_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION hns_root_import_publication_window_open_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION hns_root_import_publication_window_v1(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION authorize_hns_root_import_publication_poll_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hold_hns_root_import_for_recovery_v1(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION renew_hns_community_root_import_challenge_v1(
  TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
) FROM PUBLIC;

-- The HTTP Worker and the owner verifier connect through the same Hyperdrive
-- in staging and in production, so they share one database role and these
-- grants cannot separate them. The functions are still distinct and narrow;
-- separating the callers needs a dedicated verifier Hyperdrive and role.
DO $separated_clocks_privileges$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_next_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hns_root_import_publication_window_decision_v1(text) TO api_next_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hns_root_import_publication_window_open_v1(text) TO api_next_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hold_hns_root_import_for_recovery_v1(text,text,text) TO api_next_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hns_root_import_publication_window_v1(text,text,text) TO api_next_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION authorize_hns_root_import_publication_poll_v1(text,text,text,text,text,text,text) TO api_next_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION renew_hns_community_root_import_challenge_v1(text,text,text,text,jsonb,text) TO api_next_app';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE hns_root_import_publication_authorizations, hns_community_root_import_preparation_ceremonies FROM api_next_app';
  END IF;
END;
$separated_clocks_privileges$;

-- Existing community sessions, classified from stored evidence before any
-- rule is applied. The inventory is append-only and names each session's
-- class and the reason for it. Terminal and activated sessions, sessions whose
-- plan is not exposed, and creation-intent sessions are left as they are.
CREATE TABLE hns_root_import_separated_clocks_inventory (
  root_import_session_id text PRIMARY KEY
    REFERENCES hns_root_import_sessions(root_import_session_id),
  session_status text NOT NULL,
  lifecycle_phase text,
  lifecycle_generation bigint,
  plan_exposed boolean NOT NULL,
  session_expires_at timestamp with time zone NOT NULL,
  publication_deadline_at timestamp with time zone,
  classification text NOT NULL CHECK (classification IN (
    'terminal', 'activated', 'not_exposed', 'authorization_backfill', 'recovery_required'
  )),
  reason text NOT NULL,
  inventoried_at timestamp with time zone NOT NULL
);

CREATE FUNCTION reject_hns_root_import_separated_clocks_inventory_change_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'HNS separated-clocks inventory is append-only';
END;
$$;

CREATE TRIGGER hns_root_import_separated_clocks_inventory_change_guard
BEFORE DELETE OR UPDATE ON hns_root_import_separated_clocks_inventory
FOR EACH ROW EXECUTE FUNCTION reject_hns_root_import_separated_clocks_inventory_change_v1();

DO $separated_clocks_inventory$
DECLARE
  installed_schema text := current_schema();
  database_now timestamp with time zone := clock_timestamp();
  community_sessions bigint;
  inventoried bigint;
  held record;
BEGIN
  EXECUTE format(
    'ALTER FUNCTION reject_hns_root_import_separated_clocks_inventory_change_v1() SET search_path TO %I, pg_temp',
    installed_schema);

  INSERT INTO hns_root_import_separated_clocks_inventory (
    root_import_session_id, session_status, lifecycle_phase, lifecycle_generation,
    plan_exposed, session_expires_at, publication_deadline_at, classification, reason,
    inventoried_at
  )
  SELECT session.root_import_session_id, session.status, lifecycle.phase, lifecycle.generation,
         lifecycle.plan_exposed_at IS NOT NULL, session.expires_at,
         lifecycle.publication_deadline_at, classified.classification, classified.reason,
         database_now
    FROM hns_root_import_sessions AS session
    LEFT JOIN hns_root_import_lifecycle AS lifecycle
      ON lifecycle.root_import_session_id = session.root_import_session_id
    LEFT JOIN community_route_attachment_namespace_sessions AS ownership
      ON ownership.namespace_session_id = session.namespace_session_id
     AND ownership.actor_id = session.actor_id
     AND ownership.community_id = session.community_id
     AND ownership.attachment_intent_id = session.attachment_intent_id
    LEFT JOIN hns_authority_provision_jobs AS provision
      ON provision.provision_job_id = session.provision_job_id
    CROSS JOIN LATERAL (
      SELECT
        session.publish_plan_sha256 IS NOT NULL
        AND provision.publish_plan_sha256 IS NOT DISTINCT FROM session.publish_plan_sha256
        AND ownership.namespace_session_id IS NOT NULL
        AND session.challenge_txt_value = 'pirate-verification=' || ownership.upstream_session_ref
        AND lifecycle.publication_deadline_at IS NOT NULL
        AS consistent
    ) AS sources
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN session.status IN ('failed', 'expired') THEN 'terminal'
          WHEN session.status = 'activated' THEN 'activated'
          WHEN lifecycle.root_import_session_id IS NULL
            OR lifecycle.plan_exposed_at IS NULL THEN 'not_exposed'
          WHEN lifecycle.phase = 'failed' THEN 'terminal'
          WHEN lifecycle.phase = 'activated' THEN 'activated'
          WHEN sources.consistent
            AND session.expires_at > database_now
            AND lifecycle.phase <> 'recovery_required'
            AND lifecycle.publication_deadline_at > database_now
          THEN 'authorization_backfill'
          ELSE 'recovery_required'
        END AS classification,
        CASE
          WHEN session.status IN ('failed', 'expired') THEN 'session_terminal'
          WHEN session.status = 'activated' THEN 'session_activated'
          WHEN lifecycle.root_import_session_id IS NULL THEN 'lifecycle_absent'
          WHEN lifecycle.plan_exposed_at IS NULL THEN 'plan_not_exposed'
          WHEN lifecycle.phase = 'failed' THEN 'lifecycle_terminal'
          WHEN lifecycle.phase = 'activated' THEN 'lifecycle_activated'
          WHEN NOT sources.consistent THEN 'sources_inconsistent'
          WHEN lifecycle.phase = 'recovery_required' THEN 'already_recovery_required'
          WHEN session.expires_at <= database_now THEN 'pre_separated_clocks_challenge_expiry'
          WHEN lifecycle.publication_deadline_at <= database_now THEN 'publication_deadline_passed'
          ELSE 'challenge_clock_live_sources_consistent'
        END AS reason
    ) AS classified
   WHERE session.origin_kind = 'community_attachment';

  SELECT count(*) INTO community_sessions
    FROM hns_root_import_sessions WHERE origin_kind = 'community_attachment';
  SELECT count(*) INTO inventoried FROM hns_root_import_separated_clocks_inventory;
  IF community_sessions <> inventoried THEN
    RAISE EXCEPTION 'HNS separated-clocks inventory is incomplete: % of % sessions',
      inventoried, community_sessions;
  END IF;

  INSERT INTO hns_root_import_publication_authorizations (
    root_import_session_id, authority_generation, actor_id, community_id, root_label,
    namespace_session_id, upstream_session_ref, challenge_value_sha256,
    publish_plan_sha256, valid_until, authorized_at, source
  )
  SELECT session.root_import_session_id, lifecycle.generation, session.actor_id,
         session.community_id, session.root_label, session.namespace_session_id,
         ownership.upstream_session_ref,
         encode(sha256(convert_to(session.challenge_txt_value, 'UTF8')), 'hex'),
         session.publish_plan_sha256, lifecycle.publication_deadline_at, database_now,
         'migration_backfill'
    FROM hns_root_import_separated_clocks_inventory AS inventory
    JOIN hns_root_import_sessions AS session
      ON session.root_import_session_id = inventory.root_import_session_id
    JOIN hns_root_import_lifecycle AS lifecycle
      ON lifecycle.root_import_session_id = session.root_import_session_id
    JOIN community_route_attachment_namespace_sessions AS ownership
      ON ownership.namespace_session_id = session.namespace_session_id
   WHERE inventory.classification = 'authorization_backfill';

  -- Ambiguous or already expired pre-repair plans are held for recovery with
  -- authority retained and no provider action. The finding carries the
  -- inventoried reason; a plan already held keeps its own finding.
  FOR held IN
    SELECT inventory.root_import_session_id, inventory.reason
      FROM hns_root_import_separated_clocks_inventory AS inventory
     WHERE inventory.classification = 'recovery_required'
       AND inventory.reason <> 'already_recovery_required'
     ORDER BY inventory.root_import_session_id
  LOOP
    IF hold_hns_root_import_for_recovery_v1(
      held.root_import_session_id, held.reason,
      'migration:0206_hns_import_separated_clocks:' || held.root_import_session_id
    ) NOT IN ('held', 'already_held') THEN
      RAISE EXCEPTION 'HNS separated-clocks recovery hold was refused for %',
        held.root_import_session_id;
    END IF;
  END LOOP;
END;
$separated_clocks_inventory$;

DO $separated_clocks_inventory_privileges$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_next_app') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE hns_root_import_separated_clocks_inventory FROM api_next_app';
  END IF;
END;
$separated_clocks_inventory_privileges$;
