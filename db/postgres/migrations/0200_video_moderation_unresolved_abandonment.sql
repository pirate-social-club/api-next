-- An author may abandon a video whose image-moderation dispatch is unresolved.
-- The immutable source and provider-call claim remain retained for operator
-- reconciliation; abandonment never clears the claim or authorizes a retry.

ALTER TABLE media_post_submissions
  DROP CONSTRAINT media_post_submissions_abandonment_reason_check;

ALTER TABLE media_post_submissions
  ADD CONSTRAINT media_post_submissions_abandonment_reason_check CHECK (
    abandonment_reason IS NULL OR abandonment_reason IN (
      'author_cancelled',
      'reservation_expired',
      'action_deadline_elapsed',
      'upload_expectation_mismatch',
      'upload_source_changed_before_finalize',
      'author_abandoned_unresolved_provider'
    )
  );
