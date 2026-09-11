-- One execution owner per HNS root-import operation, and the operation's own
-- plan digest — spec 012.
--
-- Three things are fixed here.
--
-- First, a privilege regression. 0138 made the lifecycle commit function
-- SECURITY DEFINER with a pinned search path so the runtime roles need only
-- EXECUTE and never table writes. 0139 replaced that function to add readiness
-- invalidation, and CREATE OR REPLACE FUNCTION resets both properties: after
-- 0139 the function ran as its invoker with an unpinned search path. Verified
-- on PostgreSQL 17.11 by applying the migration set and reading pg_proc, which
-- reported prosecdef false and proconfig null. Both are restored below, and
-- every function this migration replaces re-applies them explicitly.
--
-- Second, execution ownership. The older readiness-observation path and the
-- lifecycle runner could each claim work for the same operation: both read the
-- same chain and both drive the same authority, with no lock spanning claim,
-- observation and finalization. Ownership is settled in SQL rather than by
-- timing. A lifecycle row means the lifecycle runner owns the operation and
-- the older path yields it; the older path's already-queued rows are left
-- untouched rather than rewritten, because rewriting another owner's job state
-- is exactly the kind of inference this lane exists to remove. The reciprocal
-- keeps the lifecycle runner off an operation whose legacy lease is still in
-- flight, which is bounded by that lease.
--
-- Third, the operation's plan digest. Qualification compares an observation
-- against the retained plan's encoded-resource digest, and until now the
-- runner had nowhere to read it from: the digest lives inside the publish plan
-- document held by the legacy session tables. The lifecycle row now carries it
-- directly, written once when the plan is exposed, so the runner never reaches
-- across into the older tables to decide what its own operation asserts. It is
-- write-once for the same reason the finality anchor is: a plan digest that
-- could be rewritten would let a later write redefine what "qualifying" meant
-- for evidence already recorded.

ALTER FUNCTION commit_hns_root_import_lifecycle_decision_v1(
  TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB
) SECURITY DEFINER;
DO $restore_commit_privileges$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION commit_hns_root_import_lifecycle_decision_v1(text,bigint,text,text,text,text,text,jsonb,jsonb) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$restore_commit_privileges$;
REVOKE ALL ON FUNCTION commit_hns_root_import_lifecycle_decision_v1(
  TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB
) FROM PUBLIC;

ALTER TABLE hns_root_import_lifecycle
  ADD COLUMN plan_encoded_resource_sha256 TEXT;
ALTER TABLE hns_root_import_lifecycle
  ADD CONSTRAINT hns_root_import_lifecycle_plan_digest_shape CHECK (
    plan_encoded_resource_sha256 IS NULL
    OR plan_encoded_resource_sha256 ~ '^[0-9a-f]{64}$'
  );

-- Conservative backfill: only where a validated publish plan is already
-- persisted and its document carries the encoded-resource digest in the
-- expected shape. Anything else stays null, and a null digest makes
-- observations non-qualifying rather than wrongly qualifying.
UPDATE hns_root_import_lifecycle AS lifecycle
   SET plan_encoded_resource_sha256 = extracted.digest
  FROM (
    SELECT session.root_import_session_id,
           convert_from(session.publish_plan_bytes, 'UTF8')::jsonb ->> 'encoded_resource_sha256'
             AS digest
      FROM hns_root_import_sessions AS session
     WHERE session.publish_plan_bytes IS NOT NULL
  ) AS extracted
 WHERE extracted.root_import_session_id = lifecycle.root_import_session_id
   AND extracted.digest ~ '^[0-9a-f]{64}$';

-- The anchor guard, extended. The finality anchor, the finality deadline and
-- the terminal decision were already immutable; the plan digest joins them.
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
  IF NEW.plan_encoded_resource_sha256 IS DISTINCT FROM OLD.plan_encoded_resource_sha256
    AND OLD.plan_encoded_resource_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'HNS lifecycle plan digest is immutable';
  END IF;
  IF OLD.phase = 'failed' AND NEW.phase <> 'failed' THEN
    RAISE EXCEPTION 'HNS lifecycle terminal decisions allow no further transitions';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_hns_root_import_lifecycle_anchor_v1() FROM PUBLIC;

-- Records the exposed plan's encoded-resource digest against the operation.
-- Write-once: the same digest is a replay, a different one is refused, and an
-- absent lifecycle is reported rather than created.
CREATE OR REPLACE FUNCTION set_hns_root_import_lifecycle_plan_digest_v1(
  input_session_id TEXT,
  input_digest TEXT
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  stored TEXT;
BEGIN
  IF input_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid HNS lifecycle plan digest';
  END IF;
  SELECT plan_encoded_resource_sha256 INTO stored
    FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lifecycle_absent'; END IF;
  IF stored IS NOT NULL THEN
    IF stored = input_digest THEN RETURN 'replayed'; END IF;
    RAISE EXCEPTION 'HNS lifecycle plan digest is immutable';
  END IF;
  UPDATE hns_root_import_lifecycle
     SET plan_encoded_resource_sha256 = input_digest,
         updated_at = clock_timestamp()
   WHERE root_import_session_id = input_session_id;
  RETURN 'set';
END;
$$;
REVOKE ALL ON FUNCTION set_hns_root_import_lifecycle_plan_digest_v1(TEXT, TEXT) FROM PUBLIC;
ALTER FUNCTION set_hns_root_import_lifecycle_plan_digest_v1(TEXT, TEXT) SECURITY DEFINER;

CREATE OR REPLACE FUNCTION claim_hns_root_import_observation_job_v1(
  input_executor_id TEXT,
  input_lease_seconds INTEGER
)
RETURNS TABLE (
  observation_job_id TEXT,
  root_import_session_id TEXT,
  operation_kind TEXT,
  request_bytes BYTEA,
  request_sha256 TEXT,
  publish_plan_bytes BYTEA,
  publish_plan_sha256 TEXT,
  provision_result_bytes BYTEA,
  provision_result_sha256 TEXT,
  lease_fence BIGINT,
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  candidate hns_root_import_observation_jobs%ROWTYPE;
  teardown hns_root_import_teardown_jobs%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  provision hns_authority_provision_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF btrim(input_executor_id) <> input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR input_lease_seconds NOT BETWEEN 4 AND 60
  THEN
    RAISE EXCEPTION 'invalid HNS root observation claim';
  END IF;

  SELECT job.* INTO teardown
    FROM hns_root_import_teardown_jobs AS job
    JOIN hns_root_import_sessions AS cleanup_session
      ON cleanup_session.root_import_session_id = job.root_import_session_id
   WHERE job.attempt_count < 20
     AND (
       job.state = 'waiting'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND (
       cleanup_session.status IN ('failed', 'expired')
       OR (
         cleanup_session.status IN ('awaiting_owner_update', 'observing', 'ready')
         AND cleanup_session.expires_at <= database_now
       )
     )
     AND EXISTS (
       SELECT 1 FROM hns_authority_provision_jobs AS retained_job
       WHERE retained_job.provision_job_id = cleanup_session.provision_job_id
         AND (retained_job.state = 'completed' OR (
           retained_job.state = 'failed'
           AND cleanup_session.provision_authorization_kind = 'community_provisional'
           AND retained_job.updated_at <= database_now - interval '2 minutes'
         ))
     )
   ORDER BY job.created_at, job.teardown_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF FOUND THEN
    SELECT * INTO session
      FROM hns_root_import_sessions
     WHERE hns_root_import_sessions.root_import_session_id = teardown.root_import_session_id
     FOR UPDATE;
    SELECT * INTO provision
      FROM hns_authority_provision_jobs
     WHERE provision_job_id = session.provision_job_id;
    IF provision.state <> 'completed' AND NOT (
      provision.state = 'failed' AND session.provision_authorization_kind = 'community_provisional'
    ) THEN
      RAISE EXCEPTION 'HNS root teardown provision authority is unavailable';
    END IF;
    UPDATE hns_root_import_teardown_jobs AS job
       SET state = 'leased', attempt_count = teardown.attempt_count + 1,
           lease_fence = teardown.lease_fence + 1, leased_by = input_executor_id,
           lease_expires_at = database_now + input_lease_seconds * interval '1 second',
           failure_code = NULL, updated_at = database_now
     WHERE job.teardown_job_id = teardown.teardown_job_id;
    RETURN QUERY SELECT
      teardown.teardown_job_id, teardown.root_import_session_id,
      CASE WHEN session.provision_authorization_kind = 'community_provisional'
        THEN 'teardown_provisional_root_v1' ELSE 'teardown_root_v1' END,
      provision.request_bytes, provision.request_sha256,
      provision.publish_plan_bytes, provision.publish_plan_sha256,
      provision.result_bytes, provision.result_sha256,
      teardown.lease_fence + 1,
      database_now + input_lease_seconds * interval '1 second';
    RETURN;
  END IF;

  SELECT job.* INTO teardown
    FROM hns_root_import_teardown_jobs AS job
    JOIN hns_root_import_sessions AS cleanup_session
      ON cleanup_session.root_import_session_id = job.root_import_session_id
   WHERE job.attempt_count >= 20
     AND (
       job.state = 'waiting'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND (
       cleanup_session.status IN ('failed', 'expired')
       OR (
         cleanup_session.status IN ('awaiting_owner_update', 'observing', 'ready')
         AND cleanup_session.expires_at <= database_now
       )
     )
     AND EXISTS (
       SELECT 1 FROM hns_authority_provision_jobs AS retained_job
       WHERE retained_job.provision_job_id = cleanup_session.provision_job_id
         AND (retained_job.state = 'completed' OR (
           retained_job.state = 'failed'
           AND cleanup_session.provision_authorization_kind = 'community_provisional'
           AND retained_job.updated_at <= database_now - interval '2 minutes'
         ))
     )
   ORDER BY job.created_at, job.teardown_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF FOUND THEN
    SELECT * INTO session
      FROM hns_root_import_sessions
     WHERE hns_root_import_sessions.root_import_session_id = teardown.root_import_session_id
     FOR UPDATE;
    UPDATE hns_root_import_teardown_jobs AS job
       SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
           failure_code = 'zone_teardown_attempts_exhausted', completed_at = database_now,
           updated_at = database_now
     WHERE job.teardown_job_id = teardown.teardown_job_id;
    IF session.status NOT IN ('failed', 'expired') THEN
      UPDATE hns_root_import_sessions AS exhausted_session
         SET status = 'expired', revision = session.revision + 1,
             updated_at = database_now
       WHERE exhausted_session.root_import_session_id = session.root_import_session_id;
    END IF;
  END IF;

  SELECT job.* INTO candidate
    FROM hns_root_import_observation_jobs AS job
    JOIN hns_root_import_sessions AS selected_session
      ON selected_session.root_import_session_id = job.root_import_session_id
   WHERE job.attempt_count >= 20
     AND (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND selected_session.status = 'observing'
     AND selected_session.expires_at > database_now
     -- Execution ownership: a lifecycle-managed operation is observed by
     -- the lifecycle runner alone. Two owners reading the same chain and
     -- driving the same authority is what let an outage look like a lost
     -- name; the older readiness path yields the whole operation, and its
     -- queued rows stay inert rather than being rewritten.
     AND NOT EXISTS (
       SELECT 1 FROM hns_root_import_lifecycle AS lifecycle_owner
        WHERE lifecycle_owner.root_import_session_id = job.root_import_session_id
     )
   ORDER BY job.created_at, job.observation_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF FOUND THEN
    SELECT * INTO session
      FROM hns_root_import_sessions
     WHERE hns_root_import_sessions.root_import_session_id = candidate.root_import_session_id
     FOR UPDATE;
    UPDATE hns_root_import_observation_jobs AS job
       SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
           failure_code = 'observation_attempts_exhausted', completed_at = database_now,
           updated_at = database_now
     WHERE job.observation_job_id = candidate.observation_job_id;
    UPDATE hns_root_import_sessions AS exhausted_session
       SET status = 'failed', revision = session.revision + 1,
           updated_at = database_now
     WHERE exhausted_session.root_import_session_id = session.root_import_session_id;
  END IF;

  SELECT job.* INTO candidate
    FROM hns_root_import_observation_jobs AS job
    JOIN hns_root_import_sessions AS selected_session
      ON selected_session.root_import_session_id = job.root_import_session_id
   WHERE job.attempt_count < 20
     AND (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND selected_session.status = 'observing'
     AND selected_session.expires_at > database_now
     -- Execution ownership: a lifecycle-managed operation is observed by
     -- the lifecycle runner alone. Two owners reading the same chain and
     -- driving the same authority is what let an outage look like a lost
     -- name; the older readiness path yields the whole operation, and its
     -- queued rows stay inert rather than being rewritten.
     AND NOT EXISTS (
       SELECT 1 FROM hns_root_import_lifecycle AS lifecycle_owner
        WHERE lifecycle_owner.root_import_session_id = job.root_import_session_id
     )
   ORDER BY job.created_at, job.observation_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE hns_root_import_sessions.root_import_session_id = candidate.root_import_session_id;
  SELECT * INTO provision
    FROM hns_authority_provision_jobs
   WHERE provision_job_id = session.provision_job_id;
  IF provision.state <> 'completed' THEN
    RAISE EXCEPTION 'HNS root observation provision authority is unavailable';
  END IF;
  UPDATE hns_root_import_observation_jobs AS job
     SET state = 'leased', attempt_count = candidate.attempt_count + 1,
         lease_fence = candidate.lease_fence + 1,
         leased_by = input_executor_id,
         lease_expires_at = database_now + input_lease_seconds * interval '1 second',
         failure_code = NULL, updated_at = database_now
   WHERE job.observation_job_id = candidate.observation_job_id;
  RETURN QUERY SELECT
    candidate.observation_job_id, candidate.root_import_session_id,
    candidate.operation_kind, candidate.request_bytes, candidate.request_sha256,
    provision.publish_plan_bytes, provision.publish_plan_sha256,
    provision.result_bytes, provision.result_sha256,
    candidate.lease_fence + 1,
    database_now + input_lease_seconds * interval '1 second';
END;
$$;
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
   WHERE ((job.state = 'queued' AND job.due_at <= database_now)
      OR (job.state = 'leased' AND job.lease_expires_at <= database_now))
     -- The reciprocal of the observation exclusion. A legacy readiness lease
     -- taken before the lifecycle row existed is still in flight, so the
     -- lifecycle runner waits for it to drain rather than observing the same
     -- operation alongside it. The wait is bounded by that lease.
     AND NOT EXISTS (
       SELECT 1 FROM hns_root_import_observation_jobs AS legacy
        WHERE legacy.root_import_session_id = job.root_import_session_id
          AND legacy.state = 'leased'
          AND legacy.lease_expires_at > database_now
     )
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
-- Both claim functions were SECURITY DEFINER with pinned search paths before
-- this migration replaced them; CREATE OR REPLACE resets both, so they are
-- re-applied here rather than left to the next deployment to notice.
ALTER FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER) SECURITY DEFINER;
ALTER FUNCTION claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER) SECURITY DEFINER;
REVOKE ALL ON FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER) FROM PUBLIC;
DO $pin_ownership_privileges$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION claim_hns_root_import_observation_job_v1(text,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION claim_hns_root_import_lifecycle_job_v1(text,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION set_hns_root_import_lifecycle_plan_digest_v1(text,text) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_ownership_privileges$;
