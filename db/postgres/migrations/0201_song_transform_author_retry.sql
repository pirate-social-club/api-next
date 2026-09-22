-- An explicit author retry may re-run a rejected transform, without replacing
-- immutable attempt evidence or re-running a completed transform.
ALTER TABLE media_processing_attempts
  ADD COLUMN author_retry_count INTEGER NOT NULL DEFAULT 0
    CHECK (author_retry_count BETWEEN 0 AND 3),
  ADD CONSTRAINT media_attempt_author_retry_stage CHECK (
    author_retry_count = 0 OR stage IN ('probe', 'sample_primary', 'sample_alternate')
  ),
  DROP CONSTRAINT media_processing_attempts_submission_id_audio_revision_anal_key,
  ADD CONSTRAINT media_attempt_author_retry_identity UNIQUE (
    submission_id, audio_revision, analysis_revision, stage, author_retry_count, attempt_number
  );

CREATE FUNCTION guard_media_attempt_author_retry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  submission_retry_count INTEGER;
  submission_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.author_retry_count IS DISTINCT FROM OLD.author_retry_count THEN
      RAISE EXCEPTION 'media processing attempt author retry is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.author_retry_count > 0 THEN
    SELECT retry_count, status INTO submission_retry_count, submission_status
      FROM media_post_submissions
      WHERE submission_id=NEW.submission_id AND operation_id=NEW.operation_id
      FOR SHARE;
    IF submission_retry_count IS DISTINCT FROM NEW.author_retry_count
      OR submission_status IS DISTINCT FROM 'processing' THEN
      RAISE EXCEPTION 'media processing attempt author retry is not authorized';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_attempt_author_retry_guard
  BEFORE INSERT OR UPDATE ON media_processing_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_media_attempt_author_retry();

-- A terminal Workflow cannot receive a retry. Advance its identity atomically
-- with the authorized retry, retaining all other transition fences.
DO $migration$
DECLARE
  function_name TEXT;
  definition TEXT;
  old_predicate TEXT := E'AND NEW.retry_count = OLD.retry_count + 1 AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision\n      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.workflow_revision = OLD.workflow_revision)';
  old_guard TEXT := 'NEW.retry_count <> OLD.retry_count + 1 OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.phase';
BEGIN
  FOREACH function_name IN ARRAY ARRAY['guard_media_submission_update', 'guard_media_submission_update_rating_v2'] LOOP
    definition := pg_get_functiondef((function_name || '()')::regprocedure);
    IF (length(definition)-length(replace(definition,old_predicate,''))) <> length(old_predicate)
       OR (length(definition)-length(replace(definition,old_guard,''))) <> length(old_guard) THEN
      RAISE EXCEPTION 'author retry guard source is not recognized exactly once: %', function_name;
    END IF;
    definition := replace(definition,old_predicate,
      replace(old_predicate,'NEW.workflow_revision = OLD.workflow_revision)',
        'NEW.workflow_revision = OLD.workflow_revision + CASE WHEN OLD.audio_revision>0 THEN 1 ELSE 0 END)'));
    definition := replace(definition,old_guard,
      replace(old_guard,'NEW.workflow_revision <> OLD.workflow_revision OR',
        'NEW.workflow_revision <> OLD.workflow_revision + CASE WHEN OLD.audio_revision>0 THEN 1 ELSE 0 END OR'));
    EXECUTE definition;
  END LOOP;
END;
$migration$;

CREATE FUNCTION validate_media_author_retry_launch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM media_submission_outbox
    WHERE submission_id=NEW.submission_id AND operation_id=NEW.operation_id
      AND creation_revision=NEW.creation_revision AND workflow_revision=NEW.workflow_revision
      AND event_type='analysis_launch'
  ) THEN
    RAISE EXCEPTION 'author retry requires its fresh Workflow launch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER media_author_retry_launch
  AFTER UPDATE ON media_post_submissions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status='processing_failed' AND NEW.status='processing'
    AND NEW.retry_count=OLD.retry_count+1 AND NEW.audio_revision>0)
  EXECUTE FUNCTION validate_media_author_retry_launch();
