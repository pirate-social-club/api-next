-- Sanitized provider failure evidence for retryable attempt failures. Only the
-- status class, the provider outcome and the provider reason are allowed; the
-- shape check rejects any other key, so response bodies, headers, credentials
-- and keys cannot be persisted. Terminal failures already carry the same
-- evidence inside the attempt result.

ALTER TABLE media_processing_attempts
  ADD COLUMN failure_evidence JSONB,
  ADD CONSTRAINT media_processing_attempts_failure_evidence_shape CHECK (
    failure_evidence IS NULL OR (
      jsonb_typeof(failure_evidence) = 'object'
      AND failure_evidence ? 'providerStatusClass'
      AND failure_evidence ? 'outcome'
      AND failure_evidence ? 'reason'
      AND failure_evidence - ARRAY['providerStatusClass','outcome','reason'] = '{}'::jsonb
    )
  );
