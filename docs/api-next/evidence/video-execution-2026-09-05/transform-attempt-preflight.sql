-- Run with psql ON_ERROR_STOP=1 against the intended environment and schema.
-- This is a read-only preflight, not a numbered migration.
BEGIN TRANSACTION READ ONLY;

SELECT provider_job_phase,
       count(*) AS attempt_count,
       count(*) FILTER (WHERE provider_job_id IS NOT NULL) AS stored_job_count
FROM media_video_transform_attempts
GROUP BY provider_job_phase
ORDER BY provider_job_phase NULLS FIRST;

SELECT indexrelid::regclass AS primary_index,
       indisvalid,
       indisready,
       pg_get_indexdef(indexrelid) AS definition
FROM pg_index
WHERE indrelid = 'media_video_transform_attempts'::regclass
  AND indisprimary;

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM media_video_transform_attempts
    WHERE provider_job_phase = 'allocated' AND provider_job_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'video preflight: allocated attempts with stored jobs require explicit reconciliation before submitting semantics change';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index AS idx
    JOIN pg_attribute AS attr
      ON attr.attrelid = idx.indrelid AND attr.attname = 'request_id'
    WHERE idx.indrelid = 'media_video_transform_attempts'::regclass
      AND idx.indisprimary AND idx.indisvalid AND idx.indisready
      AND idx.indnkeyatts = 1 AND idx.indkey[0] = attr.attnum
  ) THEN
    RAISE EXCEPTION 'video preflight: valid request_id primary index required for replay lookup';
  END IF;
END
$preflight$;

ROLLBACK;
