-- Forward-only switch from Queue execution to Workflow launch delivery.
-- The runner supplies the surrounding transaction. Lock before inspecting so
-- a concurrent old writer cannot insert between the refusal guard and DDL.
LOCK TABLE media_video_transform_attempts, media_video_analysis_outbox IN ACCESS EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM media_video_transform_attempts) THEN
    RAISE EXCEPTION '0122 aborted: transform attempts require explicit reconciliation; creation revision cannot be inferred';
  END IF;
  IF EXISTS (
    SELECT 1 FROM media_video_analysis_outbox
    WHERE state = 'poll_wait' OR (state = 'running' AND lease_expires_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION '0122 aborted: old provider waits or running leases require explicit reconciliation';
  END IF;
  -- Only untouched intents have an unambiguous launch-only interpretation.
  -- Historical completion/failure cannot establish a Workflow launch fact.
  IF EXISTS (SELECT 1 FROM media_video_analysis_outbox WHERE state <> 'pending') THEN
    RAISE EXCEPTION '0122 aborted: historical outbox outcomes require explicit reconciliation';
  END IF;
END
$preflight$;

-- The video failure writer already persists this private evidence reference;
-- 0114 omitted its storage column. It is never projected into the wire shape.
ALTER TABLE media_post_submissions
  ADD COLUMN failure_evidence_ref TEXT
    CHECK (failure_evidence_ref IS NULL OR btrim(failure_evidence_ref) <> '');

ALTER TABLE media_video_transform_attempts
  ADD COLUMN creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  DROP CONSTRAINT media_video_transform_attempt_submission_id_video_revision__key,
  ADD CONSTRAINT media_video_transform_attempt_creation_key
    UNIQUE (submission_id, video_revision, creation_revision, analysis_revision, capability),
  DROP CONSTRAINT media_video_transform_attempts_provider_job_phase_check,
  ADD CONSTRAINT media_video_transform_attempts_provider_job_phase_check
    CHECK (provider_job_phase IS NULL OR provider_job_phase IN ('allocated', 'submitting', 'started'));

-- Historical video snapshots predate the flag; absence is false because this
-- migration refuses historical provider attempts. New true flags must agree
-- with the stored non-retryable author outcome.
ALTER TABLE media_post_submissions
  ADD CONSTRAINT media_video_submission_reconciliation_shape CHECK (
    media_kind <> 'video' OR (
      (NOT video_state_snapshot ? 'reconciliationRequired'
        OR jsonb_typeof(video_state_snapshot->'reconciliationRequired') = 'boolean')
      AND (video_state_snapshot->>'reconciliationRequired' IS DISTINCT FROM 'true'
        OR (status = 'processing_failed' AND retryable IS FALSE))
    )
  );

-- Reconciliation stays on the attempt identity. The submission snapshot carries
-- the retry prohibition; entering reconciliation must write both in one transaction.
ALTER TABLE media_video_transform_attempts
  ADD COLUMN reconciliation_state TEXT NOT NULL DEFAULT 'none'
    CHECK (reconciliation_state IN ('none', 'pending', 'required', 'resolved')),
  ADD COLUMN first_uncertainty_at TIMESTAMPTZ,
  ADD COLUMN last_observation JSONB,
  ADD COLUMN reconciliation_evidence_ref TEXT,
  ADD CONSTRAINT media_video_transform_attempt_reconciliation_shape CHECK (
    (reconciliation_state = 'none' AND first_uncertainty_at IS NULL
      AND last_observation IS NULL AND reconciliation_evidence_ref IS NULL)
    OR (reconciliation_state IN ('pending', 'required', 'resolved')
      AND ((provider_job_id IS NOT NULL AND provider_job_phase IN ('submitting', 'started'))
        OR (reconciliation_state='required' AND last_observation->>'status'='workflow_terminal'))
      AND first_uncertainty_at IS NOT NULL
      AND last_observation IS NOT NULL
      AND jsonb_typeof(last_observation) = 'object'
      AND last_observation ? 'status' AND last_observation ? 'observedAt'
      AND jsonb_typeof(last_observation->'observedAt') = 'string'
      AND btrim(last_observation->>'observedAt') <> ''
      AND jsonb_typeof(last_observation->'status') = 'string'
      AND last_observation->>'status' IN
        ('not_found', 'processing', 'completed', 'failed', 'unavailable', 'workflow_terminal')
      AND reconciliation_evidence_ref IS NOT NULL
      AND btrim(reconciliation_evidence_ref) <> '')
  );
CREATE INDEX media_video_transform_attempt_reconciliation_idx
  ON media_video_transform_attempts (submission_id, video_revision, creation_revision)
  WHERE reconciliation_state IN ('pending', 'required');

-- Accepted stage results outlive Workflow history and temporary provider outputs.
-- The application validates each stage's closed snapshot before writing. SQL
-- additionally fences identity, object shape, size and immutable first-winner storage.
CREATE TABLE media_video_stage_facts (
  submission_id TEXT NOT NULL,
  video_revision BIGINT NOT NULL CHECK (video_revision > 0),
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  stage TEXT NOT NULL CHECK (stage IN ('probe', 'audio', 'frames', 'recognition', 'safety')),
  analysis_revision BIGINT NOT NULL CHECK (analysis_revision > 0),
  adapter_revision TEXT NOT NULL CHECK (btrim(adapter_revision) <> ''),
  fact_snapshot JSONB NOT NULL CHECK (
    jsonb_typeof(fact_snapshot) = 'object' AND octet_length(fact_snapshot::text) <= 262144
  ),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, video_revision, creation_revision, stage),
  FOREIGN KEY (submission_id, video_revision)
    REFERENCES media_video_revisions (submission_id, video_revision)
);
CREATE FUNCTION media_video_stage_fact_immutable() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'video stage fact is immutable';
END
$function$;
CREATE TRIGGER media_video_stage_fact_immutable
  BEFORE UPDATE ON media_video_stage_facts
  FOR EACH ROW EXECUTE FUNCTION media_video_stage_fact_immutable();

-- request_id's primary key is deliberately unchanged: replay selects that one
-- candidate and verifies all binding columns, including creation revision.
DROP INDEX media_video_analysis_outbox_eligible_idx;
ALTER TABLE media_video_analysis_outbox
  DROP CONSTRAINT media_video_analysis_outbox_state_shape,
  DROP CONSTRAINT media_video_analysis_outbox_state_check,
  DROP CONSTRAINT media_video_analysis_outbox_delivery_attempts_check,
  DROP COLUMN delivered_at;
ALTER TABLE media_video_analysis_outbox RENAME COLUMN delivery_attempts TO launch_attempts;
ALTER TABLE media_video_analysis_outbox
  ADD COLUMN continuation INTEGER NOT NULL DEFAULT 0 CHECK (continuation BETWEEN 0 AND 2),
  ADD COLUMN workflow_instance_id TEXT,
  ADD COLUMN launched_at TIMESTAMPTZ,
  ADD COLUMN instance_missing_at TIMESTAMPTZ,
  ADD CONSTRAINT media_video_analysis_outbox_launch_attempts_check
    CHECK (launch_attempts BETWEEN 0 AND 3),
  ADD CONSTRAINT media_video_analysis_outbox_state_check
    CHECK (state IN ('pending', 'launching', 'launched', 'retry_wait', 'exhausted')),
  ADD CONSTRAINT media_video_analysis_outbox_workflow_identity CHECK (
    workflow_instance_id IS NULL OR workflow_instance_id ~ '^vaw-[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT media_video_analysis_outbox_state_shape CHECK (
    (state = 'pending' AND continuation BETWEEN 0 AND 2 AND launch_attempts = 0 AND claim_owner IS NULL
      AND lease_expires_at IS NULL AND next_eligible_at IS NULL
      AND launched_at IS NULL AND workflow_instance_id IS NULL
      AND instance_missing_at IS NULL AND failure_code IS NULL)
    OR (state = 'launching' AND launch_attempts BETWEEN 1 AND 3
      AND claim_owner IS NOT NULL AND btrim(claim_owner) <> ''
      AND lease_expires_at IS NOT NULL AND next_eligible_at IS NULL
      AND failure_code IS NULL)
    OR (state = 'launched' AND launch_attempts BETWEEN 1 AND 3
      AND claim_owner IS NULL AND lease_expires_at IS NULL
      AND next_eligible_at IS NULL AND launched_at IS NOT NULL
      AND workflow_instance_id IS NOT NULL AND failure_code IS NULL)
    OR (state = 'retry_wait' AND launch_attempts BETWEEN 1 AND 2
      AND claim_owner IS NULL AND lease_expires_at IS NULL
      AND next_eligible_at IS NOT NULL AND failure_code IS NOT NULL)
    OR (state = 'exhausted' AND launch_attempts = 3
      AND claim_owner IS NULL AND lease_expires_at IS NULL
      AND next_eligible_at IS NULL AND failure_code IS NOT NULL)
  );

CREATE INDEX media_video_analysis_outbox_eligible_idx
  ON media_video_analysis_outbox (created_at, effect_identity)
  WHERE state IN ('pending', 'retry_wait')
    OR (state = 'launched' AND instance_missing_at IS NOT NULL);

-- Publication wakeups are durable events, not a second analysis outbox kind.
CREATE TABLE media_video_publication_wakeups (
  wakeup_identity TEXT PRIMARY KEY CHECK (btrim(wakeup_identity) <> ''),
  effect_identity TEXT NOT NULL REFERENCES media_video_analysis_outbox(effect_identity),
  action_id TEXT NOT NULL CHECK (btrim(action_id) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  UNIQUE (effect_identity, action_id)
);
CREATE INDEX media_video_publication_wakeups_pending_idx
  ON media_video_publication_wakeups (last_attempt_at NULLS FIRST, created_at, wakeup_identity)
  WHERE delivered_at IS NULL;
