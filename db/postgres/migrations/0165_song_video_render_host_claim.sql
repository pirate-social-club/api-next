-- Spec 013 section 5A. Host execution is claimed before FFmpeg runs. Selecting
-- a `submitting` attempt is not a claim: two hosts, or one host restarted,
-- could select the same row and both execute it. The claim below is a
-- compare-and-set taken in the same statement that reads the work, and it is
-- never released, so a crashed execution stays claimed and pending instead of
-- being handed out again.
ALTER TABLE media_song_video_render_attempts
  ADD COLUMN execution_claim_id TEXT CHECK (
    execution_claim_id IS NULL
    OR (length(execution_claim_id) BETWEEN 1 AND 128 AND btrim(execution_claim_id) = execution_claim_id)
  ),
  ADD COLUMN execution_claimed_at TIMESTAMPTZ CHECK (
    execution_claimed_at IS NULL OR isfinite(execution_claimed_at)
  ),
  ADD CONSTRAINT media_song_video_render_attempt_claim_shape CHECK (
    (execution_claim_id IS NULL) = (execution_claimed_at IS NULL)
  );

CREATE INDEX media_song_video_render_attempt_dispatch_idx
  ON media_song_video_render_attempts (plan_id)
  WHERE state = 'started' AND execution_claim_id IS NULL;

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
  -- A host claim is taken once and never moved or cleared. The attempt it
  -- names can only be re-rendered through a new generation, never by handing
  -- the same execution to another host.
  IF OLD.execution_claim_id IS NOT NULL
     AND ROW(NEW.execution_claim_id,NEW.execution_claimed_at)
         IS DISTINCT FROM ROW(OLD.execution_claim_id,OLD.execution_claimed_at)
  THEN
    RAISE EXCEPTION 'a song-video render host claim is immutable';
  END IF;
  RETURN NEW;
END;
$$;
