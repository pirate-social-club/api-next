-- HNS root-import lifecycle, finality, and authority retention — spec 012
-- (2026-09-09 amendment). Persists the operation phase/revision, deadline
-- fields, evidence references, pending reason, and next-check time; every
-- accepted transition and its requested jobs commit in one transaction
-- using expected revisions and event idempotency identities; transition
-- history retains event identity, prior/new phase, decision reason,
-- evidence references, and database time, and is never rewritten.
--
-- Migration sequencing (old/new executable compatibility):
-- * The new tables and functions are additive. Old provisioner envelopes
--   keep executing unchanged; this migration does not alter the existing
--   claim/finalize functions or job envelopes (envelope version stays v1).
-- * Backfill is conservative per the migration matrix: unknown exposure
--   receives retention, missing observations require fresh reads.
-- * Required EXECUTE grants for the lifecycle commit/claim functions are
--   issued in the follow-up privilege migration for the runtime roles.

CREATE TABLE hns_root_import_lifecycle (
  root_import_session_id TEXT PRIMARY KEY,
  root_label TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'preparing', 'awaiting_publication', 'checking_publication',
    'waiting_safe_commitment', 'checking_authority', 'ready',
    'activated', 'recovery_required', 'failed'
  )),
  revision BIGINT NOT NULL CHECK (revision > 0),
  generation BIGINT NOT NULL CHECK (generation > 0),
  plan_exposed_at TIMESTAMPTZ,
  publication_deadline_at TIMESTAMPTZ,
  first_current_observation_at TIMESTAMPTZ,
  finality_deadline_at TIMESTAMPTZ,
  readiness_observed_at TIMESTAMPTZ,
  pending_reason TEXT,
  next_check_at TIMESTAMPTZ,
  observation_count BIGINT NOT NULL DEFAULT 0 CHECK (observation_count >= 0),
  consecutive_operational_failures BIGINT NOT NULL DEFAULT 0
    CHECK (consecutive_operational_failures >= 0),
  last_useful_error TEXT,
  last_useful_error_at TIMESTAMPTZ,
  terminal_decided_at TIMESTAMPTZ,
  policy_name TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- The finality anchor and its deadline are persisted once and never
  -- reset by later observations, acknowledgements, reorgs, or replays.
  CONSTRAINT hns_root_import_lifecycle_phase_deadline_shape CHECK (
    (phase = 'awaiting_publication' AND plan_exposed_at IS NOT NULL
      AND publication_deadline_at IS NOT NULL
      AND first_current_observation_at IS NULL
      AND finality_deadline_at IS NULL)
    OR (phase = 'checking_publication' AND plan_exposed_at IS NOT NULL
      AND publication_deadline_at IS NOT NULL)
    OR (phase IN ('waiting_safe_commitment', 'checking_authority')
      AND first_current_observation_at IS NOT NULL
      AND finality_deadline_at IS NOT NULL)
    OR (phase = 'ready' AND readiness_observed_at IS NOT NULL)
    OR (phase = 'activated' AND readiness_observed_at IS NOT NULL)
    OR (phase IN ('preparing', 'recovery_required', 'failed'))
  )
);

CREATE INDEX hns_root_import_lifecycle_phase_next_check_idx
  ON hns_root_import_lifecycle(phase, next_check_at)
  WHERE next_check_at IS NOT NULL;

CREATE INDEX hns_root_import_lifecycle_root_label_idx
  ON hns_root_import_lifecycle(root_label);

CREATE OR REPLACE FUNCTION guard_hns_root_import_lifecycle_anchor_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.first_current_observation_at IS DISTINCT FROM OLD.first_current_observation_at
    AND OLD.first_current_observation_at IS NOT NULL THEN
    RAISE EXCEPTION 'HNS lifecycle finality anchor is immutable';
  END IF;
  IF NEW.finality_deadline_at IS DISTINCT FROM OLD.finality_deadline_at
    AND OLD.finality_deadline_at IS NOT NULL THEN
    RAISE EXCEPTION 'HNS lifecycle finality deadline is immutable';
  END IF;
  IF OLD.phase = 'failed' AND NEW.phase <> 'failed' THEN
    RAISE EXCEPTION 'HNS lifecycle terminal decisions allow no further transitions';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hns_root_import_lifecycle_anchor_guard
BEFORE UPDATE ON hns_root_import_lifecycle
FOR EACH ROW EXECUTE FUNCTION guard_hns_root_import_lifecycle_anchor_v1();

-- Transition history is append-only: event identity idempotency is
-- enforced by the unique key and rows are never rewritten.
CREATE TABLE hns_root_import_lifecycle_history (
  history_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  root_import_session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('transition', 'replay', 'pending', 'rejection')),
  prior_phase TEXT NOT NULL,
  new_phase TEXT,
  decision_reason TEXT NOT NULL,
  requested_work JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision_after BIGINT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_root_import_lifecycle_history_session_fk
    FOREIGN KEY (root_import_session_id)
    REFERENCES hns_root_import_lifecycle(root_import_session_id)
);

CREATE UNIQUE INDEX hns_root_import_lifecycle_history_identity_idx
  ON hns_root_import_lifecycle_history(root_import_session_id, event_id);

CREATE INDEX hns_root_import_lifecycle_history_order_idx
  ON hns_root_import_lifecycle_history(root_import_session_id, recorded_at, history_id);

REVOKE INSERT, UPDATE, DELETE ON hns_root_import_lifecycle_history FROM PUBLIC;

-- Durable work requested by accepted transitions. Scheduling is by
-- persisted per-job due times; fairness across roots and job classes comes
-- from the due-ordered claim in this same migration.
CREATE TABLE hns_root_import_lifecycle_jobs (
  lifecycle_job_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  root_import_session_id TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK (job_kind IN (
    'observe_current', 'observe_safe', 'observe_readiness',
    'reconcile_provider', 'schedule_activation_window', 'retention_review'
  )),
  due_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'leased', 'completed', 'failed')),
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  leased_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_fence BIGINT NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  failure_code TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_root_import_lifecycle_jobs_session_fk
    FOREIGN KEY (root_import_session_id)
    REFERENCES hns_root_import_lifecycle(root_import_session_id)
);

-- Fair due ordering across roots and job classes: one index serves claims.
CREATE INDEX hns_root_import_lifecycle_jobs_due_idx
  ON hns_root_import_lifecycle_jobs(state, due_at, lifecycle_job_id);

-- Permitted phase successors of the pure transition table. Pending holds
-- keep the phase; this constraint governs phase changes only.
CREATE OR REPLACE FUNCTION hns_root_import_lifecycle_transition_allowed_v1(
  input_from TEXT, input_to TEXT
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT input_from = input_to OR (
    input_from = 'preparing' AND input_to IN ('awaiting_publication', 'recovery_required')
  ) OR (
    input_from = 'awaiting_publication' AND input_to IN
      ('checking_publication', 'waiting_safe_commitment', 'recovery_required')
  ) OR (
    input_from = 'checking_publication' AND input_to IN
      ('waiting_safe_commitment', 'checking_authority', 'recovery_required')
  ) OR (
    input_from = 'waiting_safe_commitment' AND input_to IN
      ('checking_authority', 'checking_publication', 'recovery_required')
  ) OR (
    input_from = 'checking_authority' AND input_to IN
      ('ready', 'waiting_safe_commitment', 'checking_publication', 'recovery_required')
  ) OR (
    input_from = 'ready' AND input_to IN
      ('activated', 'waiting_safe_commitment', 'checking_publication', 'recovery_required')
  ) OR (
    input_from = 'recovery_required' AND input_to IN
      ('checking_publication', 'waiting_safe_commitment', 'checking_authority', 'ready', 'failed')
  );
$$;

-- Commits one lifecycle decision atomically: state update, history row,
-- and requested jobs commit together under an expected revision and the
-- event identity. A replayed identity is recorded in history and changes
-- nothing; a stale revision is a serialization-style conflict.
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
          readiness_observed_at = COALESCE(
            (input_deadline_patch->>'readiness_observed_at')::TIMESTAMPTZ,
            readiness_observed_at
          ),
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
CREATE OR REPLACE FUNCTION claim_hns_root_import_lifecycle_job_v1(
  input_executor_id TEXT,
  input_lease_seconds INTEGER
) RETURNS TABLE (
  lifecycle_job_id BIGINT,
  root_import_session_id TEXT,
  job_kind TEXT,
  due_at TIMESTAMPTZ,
  lease_fence BIGINT,
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
DECLARE
  candidate hns_root_import_lifecycle_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF btrim(input_executor_id) <> input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR input_lease_seconds NOT BETWEEN 4 AND 120 THEN
    RAISE EXCEPTION 'invalid HNS lifecycle job claim';
  END IF;
  SELECT job.* INTO candidate
    FROM hns_root_import_lifecycle_jobs AS job
   WHERE (job.state = 'queued' AND job.due_at <= database_now)
      OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
   ORDER BY job.due_at, job.lifecycle_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE hns_root_import_lifecycle_jobs AS job
     SET state = 'leased',
         attempt_count = candidate.attempt_count + 1,
         lease_fence = candidate.lease_fence + 1,
         leased_by = input_executor_id,
         lease_expires_at = database_now + input_lease_seconds * interval '1 second',
         failure_code = NULL,
         updated_at = database_now
   WHERE job.lifecycle_job_id = candidate.lifecycle_job_id;
  RETURN QUERY SELECT
    candidate.lifecycle_job_id, candidate.root_import_session_id,
    candidate.job_kind, candidate.due_at,
    candidate.lease_fence + 1,
    database_now + input_lease_seconds * interval '1 second';
END;
$$;

CREATE OR REPLACE FUNCTION finalize_hns_root_import_lifecycle_job_v1(
  input_lifecycle_job_id BIGINT,
  input_executor_id TEXT,
  input_lease_fence BIGINT,
  input_outcome TEXT,
  input_failure_code TEXT
) RETURNS TABLE (outcome TEXT, lease_state TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  job hns_root_import_lifecycle_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_outcome NOT IN ('completed', 'failed', 'retry') THEN
    RAISE EXCEPTION 'invalid HNS lifecycle job finalize outcome';
  END IF;
  SELECT * INTO job FROM hns_root_import_lifecycle_jobs
    WHERE lifecycle_job_id = input_lifecycle_job_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  -- Fence check on finalize: a lost lease can never finalize.
  IF job.state <> 'leased' OR job.leased_by IS DISTINCT FROM input_executor_id
    OR job.lease_fence <> input_lease_fence THEN
    RETURN QUERY SELECT 'conflict'::TEXT, job.state;
    RETURN;
  END IF;
  IF input_outcome = 'completed' THEN
    UPDATE hns_root_import_lifecycle_jobs
      SET state = 'completed', leased_by = NULL, lease_expires_at = NULL,
          completed_at = database_now, updated_at = database_now
      WHERE lifecycle_job_id = input_lifecycle_job_id;
    RETURN QUERY SELECT 'completed'::TEXT, 'leased'::TEXT;
    RETURN;
  END IF;
  IF input_outcome = 'failed' THEN
    UPDATE hns_root_import_lifecycle_jobs
      SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
          failure_code = coalesce(input_failure_code, 'failed'),
          completed_at = database_now, updated_at = database_now
      WHERE lifecycle_job_id = input_lifecycle_job_id;
    RETURN QUERY SELECT 'failed'::TEXT, 'leased'::TEXT;
    RETURN;
  END IF;
  UPDATE hns_root_import_lifecycle_jobs
    SET state = 'queued', leased_by = NULL, lease_expires_at = NULL,
        due_at = database_now + interval '60 seconds',
        failure_code = coalesce(input_failure_code, 'retry'),
        updated_at = database_now
    WHERE lifecycle_job_id = input_lifecycle_job_id;
  RETURN QUERY SELECT 'retry'::TEXT, 'leased'::TEXT;
END;
$$;

DO $pin_lifecycle$
DECLARE installed_schema TEXT := current_schema();
DECLARE signature TEXT;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'guard_hns_root_import_lifecycle_anchor_v1()',
    'hns_root_import_lifecycle_transition_allowed_v1(text,text)',
    'commit_hns_root_import_lifecycle_decision_v1(text,bigint,text,text,text,text,text,jsonb,jsonb)',
    'claim_hns_root_import_lifecycle_job_v1(text,integer)',
    'finalize_hns_root_import_lifecycle_job_v1(bigint,text,bigint,text,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I, pg_temp', signature, installed_schema);
  END LOOP;
END;
$pin_lifecycle$;

REVOKE ALL ON FUNCTION guard_hns_root_import_lifecycle_anchor_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION hns_root_import_lifecycle_transition_allowed_v1(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION commit_hns_root_import_lifecycle_decision_v1(
  TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_hns_root_import_lifecycle_job_v1(
  BIGINT, TEXT, BIGINT, TEXT, TEXT
) FROM PUBLIC;

-- Existing-session migration matrix (conservative backfill). Unknown
-- exposure receives retention; missing observations require fresh reads;
-- interrupted preparation retains authority; leased jobs keep executing
-- under their existing envelopes; activated imports keep their generation
-- continuity with no import clock introduced retroactively.
INSERT INTO hns_root_import_lifecycle (
  root_import_session_id, root_label, phase, revision, generation,
  plan_exposed_at, publication_deadline_at,
  first_current_observation_at, finality_deadline_at, readiness_observed_at,
  pending_reason, next_check_at,
  policy_name, policy_digest
)
SELECT
  session.root_import_session_id,
  session.root_label,
  CASE
    WHEN session.status IN ('awaiting_ownership', 'provisioning') THEN 'preparing'
    WHEN session.status = 'awaiting_owner_update' THEN 'awaiting_publication'
    WHEN session.status = 'observing' THEN 'checking_publication'
    WHEN session.status = 'ready' THEN 'ready'
    WHEN session.status = 'activated' THEN 'activated'
    ELSE 'recovery_required'
  END,
  session.revision,
  1,
  CASE WHEN session.status IN ('awaiting_owner_update', 'observing', 'ready', 'activated')
    THEN provision.completed_at ELSE NULL END,
  CASE WHEN session.status IN ('awaiting_owner_update', 'observing', 'ready', 'activated')
    THEN provision.completed_at + interval '1209600 seconds' ELSE NULL END,
  NULL,
  NULL,
  CASE WHEN session.status IN ('ready', 'activated') THEN session.updated_at ELSE NULL END,
  CASE
    WHEN session.status IN ('awaiting_ownership', 'provisioning')
      THEN 'preparing_retained_authority'
    WHEN session.status = 'observing' THEN 'migration_fresh_current_read_required'
    WHEN session.status IN ('failed', 'expired')
      THEN 'recovery_required_retained_authority'
    ELSE NULL
  END,
  CASE WHEN session.status = 'observing' THEN provision.completed_at ELSE NULL END,
  'hns_root_import_policy_v1',
  -- FNV-1a of the canonical frozen policy document, computed by the
  -- domain layer; the constant mirrors hnsRootImportPolicyDigestV1.
  'hns_root_import_policy_v1:0388a3cc'
FROM hns_root_import_sessions AS session
LEFT JOIN hns_authority_provision_jobs AS provision
  ON provision.provision_job_id = session.provision_job_id
ON CONFLICT (root_import_session_id) DO NOTHING;
