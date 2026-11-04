-- Provider intent and deadline precede the first and only create request.
ALTER TABLE media_song_video_render_attempts
  ADD COLUMN provider_wait_deadline TIMESTAMPTZ CHECK (provider_wait_deadline IS NULL OR isfinite(provider_wait_deadline)),
  ADD COLUMN provider_create_started_at TIMESTAMPTZ CHECK (provider_create_started_at IS NULL OR isfinite(provider_create_started_at)),
  ADD COLUMN provider_job_id TEXT CHECK (provider_job_id IS NULL OR provider_job_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$'),
  ADD COLUMN provider_reconciliation_required_at TIMESTAMPTZ CHECK (provider_reconciliation_required_at IS NULL OR isfinite(provider_reconciliation_required_at)),
  ADD COLUMN provider_cleanup_completed_at TIMESTAMPTZ CHECK (provider_cleanup_completed_at IS NULL OR isfinite(provider_cleanup_completed_at)),
  ADD COLUMN provider_pcm_sha256 TEXT CHECK (provider_pcm_sha256 IS NULL OR provider_pcm_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT song_video_provider_create_deadline CHECK (
    provider_create_started_at IS NULL OR
    (provider_wait_deadline IS NOT NULL AND provider_create_started_at < provider_wait_deadline)
  );
CREATE UNIQUE INDEX song_video_provider_job_identity ON media_song_video_render_attempts(provider_job_id)
  WHERE provider_job_id IS NOT NULL;

CREATE FUNCTION guard_song_video_provider_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='sealed' AND OLD.state='started' AND NEW.provider_wait_deadline IS NOT NULL
    AND (clock_timestamp() >= NEW.provider_wait_deadline OR NEW.provider_reconciliation_required_at IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='song-video provider wait deadline expired';
  END IF;
  IF OLD.provider_wait_deadline IS NOT NULL AND NEW.provider_wait_deadline IS DISTINCT FROM OLD.provider_wait_deadline
    OR OLD.provider_create_started_at IS NOT NULL AND NEW.provider_create_started_at IS DISTINCT FROM OLD.provider_create_started_at
    OR OLD.provider_job_id IS NOT NULL AND NEW.provider_job_id IS DISTINCT FROM OLD.provider_job_id
    OR OLD.provider_pcm_sha256 IS NOT NULL AND NEW.provider_pcm_sha256 IS DISTINCT FROM OLD.provider_pcm_sha256
    OR OLD.provider_reconciliation_required_at IS NOT NULL AND NEW.provider_reconciliation_required_at IS DISTINCT FROM OLD.provider_reconciliation_required_at
    OR OLD.provider_cleanup_completed_at IS NOT NULL AND NEW.provider_cleanup_completed_at IS DISTINCT FROM OLD.provider_cleanup_completed_at THEN
    RAISE EXCEPTION 'song-video provider identity and terminal evidence are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER song_video_provider_identity_guard BEFORE UPDATE ON media_song_video_render_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_song_video_provider_identity();

-- Read the database clock at the actual insert, after potentially slow byte
-- verification. A transaction-start timestamp would allow a late seal.
CREATE FUNCTION require_song_video_provider_seal_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt media_song_video_render_attempts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT attempt FROM media_song_video_render_attempts
    WHERE attempt_id=NEW.attempt_id FOR UPDATE;
  IF attempt.provider_wait_deadline IS NOT NULL AND
    (clock_timestamp() >= attempt.provider_wait_deadline OR attempt.provider_reconciliation_required_at IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='song-video provider wait deadline expired';
  END IF;
  IF attempt.dispatch_renderer_identity='cloudconvert-song-video-pcm-v1' AND
    (attempt.provider_wait_deadline IS NULL OR attempt.provider_job_id IS NULL OR
     attempt.provider_pcm_sha256 IS DISTINCT FROM NEW.soundtrack_sha256) THEN
    RAISE EXCEPTION 'song-video provider seal lacks bound verification evidence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER song_video_provider_seal_deadline BEFORE INSERT ON media_song_video_masters
  FOR EACH ROW EXECUTE FUNCTION require_song_video_provider_seal_deadline();

-- These grants authorize only transient excerpts, never a whole-song object.
-- Store a bearer digest, not the bearer itself.
CREATE TABLE media_song_video_excerpt_grants (
  capability_sha256 TEXT PRIMARY KEY CHECK (capability_sha256 ~ '^[0-9a-f]{64}$'),
  attempt_id TEXT NOT NULL REFERENCES media_song_video_render_attempts(attempt_id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE CHECK (object_key LIKE 'song-video-excerpts/%'),
  object_version TEXT NOT NULL CHECK (btrim(object_version) <> ''),
  object_etag TEXT NOT NULL CHECK (btrim(object_etag) <> ''),
  wav_sha256 TEXT NOT NULL CHECK (wav_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length BIGINT NOT NULL CHECK (byte_length BETWEEN 576044 AND 2880044),
  expires_at TIMESTAMPTZ NOT NULL CHECK (isfinite(expires_at)),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX song_video_excerpt_grants_attempt ON media_song_video_excerpt_grants(attempt_id);

ALTER TABLE media_video_source_grants DROP CONSTRAINT media_video_source_grants_consumer_check;
ALTER TABLE media_video_source_grants ADD CONSTRAINT media_video_source_grants_consumer_check
  CHECK (consumer IN ('qencode', 'stream', 'cloudconvert'));

CREATE FUNCTION guard_song_video_excerpt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.capability_sha256,NEW.attempt_id,NEW.object_key,NEW.object_version,NEW.object_etag,
         NEW.wav_sha256,NEW.byte_length,NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.capability_sha256,OLD.attempt_id,OLD.object_key,OLD.object_version,OLD.object_etag,
         OLD.wav_sha256,OLD.byte_length,OLD.expires_at)
     OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'song-video excerpt identity and revocation are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER song_video_excerpt_identity_guard BEFORE UPDATE ON media_song_video_excerpt_grants
  FOR EACH ROW EXECUTE FUNCTION guard_song_video_excerpt_identity();
