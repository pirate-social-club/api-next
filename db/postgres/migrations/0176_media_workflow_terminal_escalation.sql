-- Owner-authorized 2026-09-13: a terminal Workflow observation without durable
-- completion escalates the submission as an explicit, non-retryable failure.
-- Every existing song and video code is preserved.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM media_post_submissions
    WHERE failure_code IS NOT NULL AND failure_code NOT IN (
      'invalid_media', 'unsupported_media', 'probe_failed', 'hash_failed',
      'transform_failed', 'publication_failed', 'upload_seal_conflict',
      'poster_undecodable', 'poster_timestamp_out_of_range',
      'workflow_terminal_unconverged'
    )
  ) THEN
    RAISE EXCEPTION 'terminal escalation failure reasons preflight: unexpected existing failure code';
  END IF;
END $$;

ALTER TABLE media_post_submissions
  DROP CONSTRAINT media_post_submissions_failure_code_check;
ALTER TABLE media_post_submissions
  ADD CONSTRAINT media_post_submissions_failure_code_check CHECK (
    failure_code IS NULL OR failure_code IN (
      'invalid_media', 'unsupported_media', 'probe_failed', 'hash_failed',
      'transform_failed', 'publication_failed', 'upload_seal_conflict',
      'poster_undecodable', 'poster_timestamp_out_of_range',
      'workflow_terminal_unconverged'
    ) OR (
      media_kind = 'video' AND failure_code IN (
        'membership_required', 'provider_submission_unconfirmed'
      )
    )
  );
