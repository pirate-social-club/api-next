-- One permanent display grant per sealed terminal video, independent of devices.
-- No release, expiry, response replay, or recovery of an acknowledged claim.
CREATE TABLE media_video_outcome_claims (
  submission_id TEXT PRIMARY KEY REFERENCES media_post_submissions (submission_id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('processing_failure','policy_block')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION guard_media_video_outcome_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'video outcome claims are permanent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM media_post_submissions s
     WHERE s.submission_id=NEW.submission_id AND s.actor_user_id=NEW.actor_user_id
       AND s.media_kind='video' AND s.video_revision>0 AND s.current_immutable_ref IS NOT NULL
       AND ((NEW.kind='policy_block' AND s.status='blocked') OR
         (NEW.kind='processing_failure' AND s.status='processing_failed'
           AND s.retryable IS FALSE
           AND s.video_state_snapshot->>'reconciliationRequired' IS DISTINCT FROM 'true'))
       AND NOT EXISTS (SELECT 1 FROM media_publication_projections p
         WHERE p.submission_id=s.submission_id)
     FOR UPDATE OF s
  ) THEN
    RAISE EXCEPTION 'video outcome claim requires exact sealed terminal author authority';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_video_outcome_claim_guard
  BEFORE INSERT OR UPDATE OR DELETE ON media_video_outcome_claims
  FOR EACH ROW EXECUTE FUNCTION guard_media_video_outcome_claim();

CREATE INDEX media_video_terminal_outcome_candidates
  ON media_post_submissions (actor_user_id, updated_at, submission_id)
  WHERE media_kind='video' AND status IN ('processing_failed','blocked')
    AND video_revision>0 AND current_immutable_ref IS NOT NULL;
