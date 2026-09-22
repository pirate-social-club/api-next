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
