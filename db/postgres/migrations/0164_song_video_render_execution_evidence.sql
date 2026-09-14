-- Spec 013 section 5A. A render execution records what it established against
-- its attempt before its output is written: the measured digest and length of
-- the output, or an explicit refusal. Observation resolves an address from this
-- retained evidence, never from an object's presence, so foreign bytes written
-- under a lost acknowledgement cannot be observed as this execution's output
-- and a refusal survives the renderer that produced it. A missing record means
-- no execution is established there, and the address stays unresolved.
ALTER TABLE media_song_video_render_attempts
  ADD COLUMN expected_output_sha256 TEXT CHECK (
    expected_output_sha256 IS NULL OR expected_output_sha256 ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN expected_output_byte_length BIGINT CHECK (
    expected_output_byte_length IS NULL OR expected_output_byte_length > 0
  ),
  ADD COLUMN execution_refusal_reason TEXT CHECK (
    execution_refusal_reason IS NULL OR btrim(execution_refusal_reason) <> ''
  ),
  -- An output record is complete or absent, and one attempt cannot both have
  -- produced output and refused.
  ADD CONSTRAINT media_song_video_render_attempt_outcome_shape CHECK (
    (expected_output_sha256 IS NULL) = (expected_output_byte_length IS NULL)
    AND (execution_refusal_reason IS NULL OR expected_output_sha256 IS NULL)
  );

CREATE OR REPLACE FUNCTION guard_song_video_render_attempt_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_phase IS DISTINCT FROM OLD.execution_phase AND NOT (
    (OLD.execution_phase = 'recorded' AND NEW.execution_phase = 'submitting')
    OR (OLD.execution_phase = 'submitting' AND NEW.execution_phase = 'submitted')
  ) THEN
    RAISE EXCEPTION 'a song-video render execution cannot move backwards';
  END IF;
  IF OLD.execution_started_at IS NOT NULL
    AND NEW.execution_started_at IS DISTINCT FROM OLD.execution_started_at THEN
    RAISE EXCEPTION 'a song-video render execution start is immutable';
  END IF;
  -- Recorded outcomes are evidence: once present, nothing rewrites or clears
  -- them. A later execution at the same address cannot replace another's.
  IF OLD.expected_output_sha256 IS NOT NULL
     AND ROW(NEW.expected_output_sha256,NEW.expected_output_byte_length)
         IS DISTINCT FROM ROW(OLD.expected_output_sha256,OLD.expected_output_byte_length)
  THEN
    RAISE EXCEPTION 'a song-video render output record is immutable';
  END IF;
  IF OLD.execution_refusal_reason IS NOT NULL
     AND NEW.execution_refusal_reason IS DISTINCT FROM OLD.execution_refusal_reason
  THEN
    RAISE EXCEPTION 'a song-video render refusal record is immutable';
  END IF;
  RETURN NEW;
END;
$$;
