-- Forward-only switch from Queue execution to Workflow launch delivery.
-- The runner supplies the surrounding transaction. Lock before inspecting so
-- a concurrent old writer cannot insert between the refusal guard and DDL.
LOCK TABLE media_video_transform_attempts, media_video_analysis_outbox IN ACCESS EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM media_video_transform_attempts) THEN
    RAISE EXCEPTION '0120 aborted: transform attempts require explicit reconciliation; creation revision cannot be inferred';
  END IF;
  IF EXISTS (
    SELECT 1 FROM media_video_analysis_outbox
    WHERE state = 'poll_wait' OR (state = 'running' AND lease_expires_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION '0120 aborted: old provider waits or running leases require explicit reconciliation';
  END IF;
  -- Only untouched intents have an unambiguous launch-only interpretation.
  -- Historical completion/failure cannot establish a Workflow launch fact.
  IF EXISTS (SELECT 1 FROM media_video_analysis_outbox WHERE state <> 'pending') THEN
    RAISE EXCEPTION '0120 aborted: historical outbox outcomes require explicit reconciliation';
  END IF;
END
$preflight$;

ALTER TABLE media_video_transform_attempts
  ADD COLUMN creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  DROP CONSTRAINT media_video_transform_attempt_submission_id_video_revision__key,
  ADD CONSTRAINT media_video_transform_attempt_creation_key
    UNIQUE (submission_id, video_revision, creation_revision, analysis_revision, capability),
  DROP CONSTRAINT media_video_transform_attempts_provider_job_phase_check,
  ADD CONSTRAINT media_video_transform_attempts_provider_job_phase_check
    CHECK (provider_job_phase IS NULL OR provider_job_phase IN ('allocated', 'submitting', 'started'));

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
    (state = 'pending' AND launch_attempts = 0 AND claim_owner IS NULL
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
