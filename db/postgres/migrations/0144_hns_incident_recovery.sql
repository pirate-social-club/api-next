-- Incident recovery: recorded findings, explicit authorization, fenced
-- application — spec 012, "Failed/expired imports with retained authority or
-- uncertain chain publication".
--
-- Recovery decides what happens to live authority, so it is split into three
-- steps that cannot be collapsed. A finding records what was actually read and
-- what that evidence supports; an authorization is an operator's explicit
-- decision against one named finding; applying it moves the operation and is
-- refused unless both still hold. Nothing here reads the chain, and nothing
-- here derives permission from elapsed time.
--
-- The binding is exact on purpose. A finding belongs to one authority
-- generation and one evidence reading, an authorization names the same pair
-- and the action it permits, and applying re-checks all of it under the
-- operation's row lock. A supersession that lands in between moves the
-- generation and every authorization recorded against the old one stops
-- applying, because nobody inspected the infrastructure the operation now
-- holds.

CREATE TABLE hns_root_import_recovery_findings (
  recovery_finding_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  root_import_session_id TEXT NOT NULL,
  authority_generation BIGINT NOT NULL CHECK (authority_generation > 0),
  evidence_ref TEXT NOT NULL
    CHECK (btrim(evidence_ref) = evidence_ref AND octet_length(evidence_ref) BETWEEN 1 AND 512),
  classification TEXT NOT NULL CHECK (classification IN (
    'matching_authority_available', 'recoverable_authority_missing',
    'conflicting_publication', 'insufficient_evidence'
  )),
  reason TEXT NOT NULL CHECK (btrim(reason) = reason AND octet_length(reason) BETWEEN 1 AND 128),
  -- Null when the evidence supports no action. A finding that supports nothing
  -- is still recorded: "we looked and may not act" is the useful answer.
  supported_action TEXT CHECK (supported_action IN ('resume', 'adopt', 'restore_authority')),
  inclusion_txid TEXT CHECK (inclusion_txid IS NULL OR inclusion_txid ~ '^[0-9a-f]{64}$'),
  inclusion_block_height BIGINT CHECK (inclusion_block_height IS NULL OR inclusion_block_height > 0),
  covenant_resource_sha256 TEXT
    CHECK (covenant_resource_sha256 IS NULL OR covenant_resource_sha256 ~ '^[0-9a-f]{64}$'),
  plan_encoded_sha256 TEXT
    CHECK (plan_encoded_sha256 IS NULL OR plan_encoded_sha256 ~ '^[0-9a-f]{64}$'),
  current_resource_sha256 TEXT
    CHECK (current_resource_sha256 IS NULL OR current_resource_sha256 ~ '^[0-9a-f]{64}$'),
  safe_resource_sha256 TEXT
    CHECK (safe_resource_sha256 IS NULL OR safe_resource_sha256 ~ '^[0-9a-f]{64}$'),
  zone_present BOOLEAN,
  signing_keys_present BOOLEAN,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_recovery_finding_unique_evidence
    UNIQUE (root_import_session_id, evidence_ref),
  -- An action may only be supported by evidence that could support one. A
  -- conflicting or insufficient finding that named an action would be an
  -- authorization waiting to happen.
  CONSTRAINT hns_recovery_finding_action_shape CHECK (
    supported_action IS NULL
    OR classification IN ('matching_authority_available', 'recoverable_authority_missing')
  ),
  -- A publication that was attributed carries its transaction and the covenant
  -- bytes that attribution rests on; neither is useful without the other.
  CONSTRAINT hns_recovery_finding_inclusion_shape CHECK (
    num_nulls(inclusion_txid, inclusion_block_height, covenant_resource_sha256) IN (0, 3)
  )
);

CREATE INDEX hns_root_import_recovery_findings_session_idx
  ON hns_root_import_recovery_findings(root_import_session_id, recorded_at DESC);

CREATE TABLE hns_root_import_recovery_authorizations (
  recovery_authorization_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recovery_finding_id BIGINT NOT NULL
    REFERENCES hns_root_import_recovery_findings(recovery_finding_id),
  root_import_session_id TEXT NOT NULL,
  authority_generation BIGINT NOT NULL CHECK (authority_generation > 0),
  action TEXT NOT NULL CHECK (action IN ('resume', 'adopt', 'restore_authority')),
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT hns_recovery_authorization_window CHECK (expires_at > authorized_at),
  -- One live authorization per finding. A second one for the same finding is a
  -- replay, not a second permission.
  CONSTRAINT hns_recovery_authorization_unique UNIQUE (recovery_finding_id)
);

-- Findings and authorizations are evidence of a decision that may already have
-- moved live authority. Neither is rewritten.
CREATE OR REPLACE FUNCTION reject_hns_recovery_record_change_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'hns_root_import_recovery_authorizations'
    AND TG_OP = 'UPDATE'
    AND OLD.consumed_at IS NULL
    AND NEW.consumed_at IS NOT NULL
    AND NEW.recovery_finding_id = OLD.recovery_finding_id
    AND NEW.root_import_session_id = OLD.root_import_session_id
    AND NEW.authority_generation = OLD.authority_generation
    AND NEW.action = OLD.action
    AND NEW.authorized_at = OLD.authorized_at
    AND NEW.expires_at = OLD.expires_at
  THEN
    -- Marking an authorization consumed is the one permitted transition, and
    -- only from unconsumed. It is what makes an authorization single use.
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HNS recovery records are append-only';
END;
$$;

CREATE TRIGGER hns_root_import_recovery_findings_change_guard
BEFORE UPDATE OR DELETE ON hns_root_import_recovery_findings
FOR EACH ROW EXECUTE FUNCTION reject_hns_recovery_record_change_v1();

CREATE TRIGGER hns_root_import_recovery_authorizations_change_guard
BEFORE UPDATE OR DELETE ON hns_root_import_recovery_authorizations
FOR EACH ROW EXECUTE FUNCTION reject_hns_recovery_record_change_v1();

-- Records one gathered evidence set against the operation's current
-- generation. Reading is not deciding: this writes no lifecycle state.
CREATE OR REPLACE FUNCTION record_hns_root_import_recovery_finding_v1(
  input_session_id TEXT,
  input_expected_generation BIGINT,
  input_evidence_ref TEXT,
  input_classification TEXT,
  input_reason TEXT,
  input_supported_action TEXT,
  input_inclusion_txid TEXT,
  input_inclusion_block_height BIGINT,
  input_covenant_resource_sha256 TEXT,
  input_plan_encoded_sha256 TEXT,
  input_current_resource_sha256 TEXT,
  input_safe_resource_sha256 TEXT,
  input_zone_present BOOLEAN,
  input_signing_keys_present BOOLEAN
) RETURNS TABLE (outcome TEXT, recovery_finding_id BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  existing BIGINT;
  inserted BIGINT;
BEGIN
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'lifecycle_absent'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF lifecycle.generation <> input_expected_generation THEN
    RETURN QUERY SELECT 'generation_conflict'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  SELECT finding.recovery_finding_id INTO existing
    FROM hns_root_import_recovery_findings AS finding
   WHERE finding.root_import_session_id = input_session_id
     AND finding.evidence_ref = input_evidence_ref;
  IF FOUND THEN
    RETURN QUERY SELECT 'replayed'::TEXT, existing;
    RETURN;
  END IF;
  INSERT INTO hns_root_import_recovery_findings (
    root_import_session_id, authority_generation, evidence_ref,
    classification, reason, supported_action,
    inclusion_txid, inclusion_block_height, covenant_resource_sha256,
    plan_encoded_sha256, current_resource_sha256, safe_resource_sha256,
    zone_present, signing_keys_present
  ) VALUES (
    input_session_id, lifecycle.generation, input_evidence_ref,
    input_classification, input_reason, input_supported_action,
    input_inclusion_txid, input_inclusion_block_height, input_covenant_resource_sha256,
    input_plan_encoded_sha256, input_current_resource_sha256, input_safe_resource_sha256,
    input_zone_present, input_signing_keys_present
  ) RETURNING hns_root_import_recovery_findings.recovery_finding_id INTO inserted;
  RETURN QUERY SELECT 'recorded'::TEXT, inserted;
END;
$$;

-- An operator's explicit decision against one recorded finding. It permits
-- exactly the action that finding's evidence supports, for a bounded window.
CREATE OR REPLACE FUNCTION authorize_hns_root_import_recovery_v1(
  input_session_id TEXT,
  input_evidence_ref TEXT,
  input_action TEXT,
  input_ttl_seconds INTEGER
) RETURNS TABLE (outcome TEXT, recovery_authorization_id BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  finding hns_root_import_recovery_findings%ROWTYPE;
  existing BIGINT;
  inserted BIGINT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_ttl_seconds IS NULL OR input_ttl_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'invalid HNS recovery recovery_grant window';
  END IF;
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'lifecycle_absent'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  SELECT * INTO finding FROM hns_root_import_recovery_findings
   WHERE root_import_session_id = input_session_id AND evidence_ref = input_evidence_ref;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'finding_absent'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF finding.authority_generation <> lifecycle.generation THEN
    -- The evidence describes infrastructure the operation no longer holds.
    RETURN QUERY SELECT 'generation_conflict'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF finding.supported_action IS DISTINCT FROM input_action THEN
    -- An operator may only authorize what the evidence supports. Authorizing
    -- past a conflicting or insufficient finding is the whole failure mode.
    RETURN QUERY SELECT 'action_unsupported'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  SELECT recovery_grant.recovery_authorization_id INTO existing
    FROM hns_root_import_recovery_authorizations AS recovery_grant
   WHERE recovery_grant.recovery_finding_id = finding.recovery_finding_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'replayed'::TEXT, existing;
    RETURN;
  END IF;
  INSERT INTO hns_root_import_recovery_authorizations (
    recovery_finding_id, root_import_session_id, authority_generation,
    action, authorized_at, expires_at
  ) VALUES (
    finding.recovery_finding_id, input_session_id, finding.authority_generation,
    input_action, database_now, database_now + input_ttl_seconds * interval '1 second'
  ) RETURNING hns_root_import_recovery_authorizations.recovery_authorization_id INTO inserted;
  RETURN QUERY SELECT 'recorded'::TEXT, inserted;
END;
$$;

-- Applies an authorized recovery. Every condition is re-checked here, under
-- the operation's row lock, because an authorization is permission to act at
-- the moment it is used, not a standing right.
CREATE OR REPLACE FUNCTION apply_hns_root_import_recovery_v1(
  input_session_id TEXT,
  input_evidence_ref TEXT,
  input_expected_revision BIGINT,
  input_target_phase TEXT,
  input_requested_work JSONB
) RETURNS TABLE (outcome TEXT, revision BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  finding hns_root_import_recovery_findings%ROWTYPE;
  recovery_grant hns_root_import_recovery_authorizations%ROWTYPE;
  committed RECORD;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'lifecycle_absent'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF lifecycle.phase <> 'recovery_required' THEN
    RETURN QUERY SELECT 'phase_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF lifecycle.revision <> input_expected_revision THEN
    RETURN QUERY SELECT 'revision_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  SELECT * INTO finding FROM hns_root_import_recovery_findings
   WHERE root_import_session_id = input_session_id AND evidence_ref = input_evidence_ref;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'finding_absent'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF finding.authority_generation <> lifecycle.generation THEN
    RETURN QUERY SELECT 'generation_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  SELECT * INTO recovery_grant FROM hns_root_import_recovery_authorizations
   WHERE recovery_finding_id = finding.recovery_finding_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'authorization_absent'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF recovery_grant.consumed_at IS NOT NULL THEN
    -- Single use. A second application of the same authorization is refused
    -- rather than replayed, because the first one already moved the operation.
    RETURN QUERY SELECT 'authorization_consumed'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF recovery_grant.expires_at <= database_now THEN
    RETURN QUERY SELECT 'authorization_expired'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF recovery_grant.authority_generation <> lifecycle.generation THEN
    RETURN QUERY SELECT 'generation_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;

  UPDATE hns_root_import_recovery_authorizations
     SET consumed_at = database_now
   WHERE recovery_authorization_id = recovery_grant.recovery_authorization_id;

  SELECT * INTO committed FROM commit_hns_root_import_lifecycle_decision_v1(
    input_session_id,
    lifecycle.revision,
    'recovery:' || input_evidence_ref,
    'recovery_decided',
    'transition',
    'recovery_' || recovery_grant.action || ':' || finding.reason,
    input_target_phase,
    '{}'::jsonb,
    coalesce(input_requested_work, '[]'::jsonb)
  );
  IF committed.outcome IS DISTINCT FROM 'transition' THEN
    RETURN QUERY SELECT committed.outcome::TEXT, committed.revision;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'applied'::TEXT, committed.revision;
END;
$$;

REVOKE ALL ON FUNCTION reject_hns_recovery_record_change_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_hns_root_import_recovery_finding_v1(
  TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION authorize_hns_root_import_recovery_v1(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_hns_root_import_recovery_v1(TEXT, TEXT, BIGINT, TEXT, JSONB) FROM PUBLIC;
ALTER FUNCTION record_hns_root_import_recovery_finding_v1(
  TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN
) SECURITY DEFINER;
ALTER FUNCTION authorize_hns_root_import_recovery_v1(TEXT, TEXT, TEXT, INTEGER) SECURITY DEFINER;
ALTER FUNCTION apply_hns_root_import_recovery_v1(TEXT, TEXT, BIGINT, TEXT, JSONB) SECURITY DEFINER;
DO $pin_recovery_privileges$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION reject_hns_recovery_record_change_v1() SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION record_hns_root_import_recovery_finding_v1(text,bigint,text,text,text,text,text,bigint,text,text,text,text,boolean,boolean) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION authorize_hns_root_import_recovery_v1(text,text,text,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION apply_hns_root_import_recovery_v1(text,text,bigint,text,jsonb) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_recovery_privileges$;
