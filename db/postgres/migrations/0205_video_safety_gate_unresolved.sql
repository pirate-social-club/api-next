-- Spec 013 v1 automatic video publication amendment (2026-09-25): a video the
-- sampled-frame OpenAI gate could not allow fails privately with a terminal,
-- non-retryable `safety_gate_unresolved` instead of waiting for a moderator.
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
        'membership_required', 'provider_submission_unconfirmed',
        'safety_gate_unresolved'
      )
    )
  );
