-- Publication records admission intent in the same transaction. Provider
-- effects remain disabled until the separate runtime switch is enabled.
CREATE TABLE media_song_video_pcm_admission_policy (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO media_song_video_pcm_admission_policy (singleton,enabled) VALUES (true,false);

CREATE TABLE media_song_video_pcm_admissions (
  admission_id TEXT PRIMARY KEY CHECK (admission_id ~ '^song-pcm-[0-9a-f]{64}$'),
  song_post_id TEXT NOT NULL CHECK (btrim(song_post_id) <> ''),
  song_community_id TEXT NOT NULL CHECK (btrim(song_community_id) <> ''),
  audio_revision BIGINT NOT NULL CHECK (audio_revision BETWEEN 1 AND 9007199254740991),
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  audio_asset_ref TEXT NOT NULL CHECK (audio_asset_ref LIKE 'media://immutable/%'),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','processing','admitted','refused','reconciliation')),
  provider_create_started_at TIMESTAMPTZ CHECK (isfinite(provider_create_started_at)),
  provider_wait_deadline TIMESTAMPTZ CHECK (isfinite(provider_wait_deadline)),
  provider_job_id TEXT UNIQUE CHECK (btrim(provider_job_id) <> ''),
  cleanup_completed_at TIMESTAMPTZ CHECK (isfinite(cleanup_completed_at)),
  claim_owner TEXT CHECK (btrim(claim_owner) <> ''),
  claim_fence BIGINT NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  claim_until TIMESTAMPTZ CHECK (isfinite(claim_until)),
  failure_code TEXT CHECK (btrim(failure_code) <> ''),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(requested_at)),
  UNIQUE (song_post_id,audio_revision),
  CHECK ((claim_owner IS NULL) = (claim_until IS NULL)),
  CHECK ((provider_create_started_at IS NULL) = (provider_wait_deadline IS NULL)),
  CHECK (provider_wait_deadline > provider_create_started_at),
  CHECK (provider_job_id IS NULL OR provider_create_started_at IS NOT NULL),
  CHECK (state NOT IN ('processing','admitted') OR provider_create_started_at IS NOT NULL),
  CHECK (state <> 'admitted' OR provider_job_id IS NOT NULL),
  CHECK (cleanup_completed_at IS NULL OR state IN ('admitted','refused','reconciliation')),
  CHECK ((state IN ('refused','reconciliation')) = (failure_code IS NOT NULL))
);
CREATE INDEX media_song_video_pcm_admissions_due ON media_song_video_pcm_admissions (requested_at)
  WHERE cleanup_completed_at IS NULL;

CREATE FUNCTION guard_media_song_video_pcm_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.provider_create_started_at IS NOT NULL
       OR NEW.provider_job_id IS NOT NULL OR NEW.cleanup_completed_at IS NOT NULL
    THEN RAISE EXCEPTION 'song PCM admission must begin pending'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'song PCM admission evidence is retained'; END IF;
  IF ROW(NEW.admission_id,NEW.song_post_id,NEW.song_community_id,NEW.audio_revision,
         NEW.canonical_audio_sha256,NEW.audio_asset_ref,NEW.requested_at)
     IS DISTINCT FROM
     ROW(OLD.admission_id,OLD.song_post_id,OLD.song_community_id,OLD.audio_revision,
         OLD.canonical_audio_sha256,OLD.audio_asset_ref,OLD.requested_at)
     OR (OLD.provider_create_started_at IS NOT NULL AND ROW(NEW.provider_create_started_at,NEW.provider_wait_deadline)
         IS DISTINCT FROM ROW(OLD.provider_create_started_at,OLD.provider_wait_deadline))
     OR (OLD.provider_job_id IS NOT NULL AND NEW.provider_job_id IS DISTINCT FROM OLD.provider_job_id)
     OR (OLD.cleanup_completed_at IS NOT NULL AND NEW.cleanup_completed_at IS DISTINCT FROM OLD.cleanup_completed_at)
     OR (OLD.state = 'admitted' AND NEW.state <> 'admitted')
     OR (OLD.state IN ('refused','reconciliation') AND NEW.state NOT IN ('refused','reconciliation'))
  THEN RAISE EXCEPTION 'song PCM admission identity and provider evidence are immutable'; END IF;
  IF NEW.state = 'admitted' AND OLD.state <> 'admitted' AND
     (OLD.state <> 'processing' OR NEW.provider_wait_deadline <= clock_timestamp())
  THEN RAISE EXCEPTION 'song PCM admission expired or inactive'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_song_video_pcm_admission_guard BEFORE INSERT OR UPDATE OR DELETE
  ON media_song_video_pcm_admissions FOR EACH ROW EXECUTE FUNCTION guard_media_song_video_pcm_admission();

CREATE FUNCTION request_media_song_video_pcm_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM media_song_video_pcm_admission_policy WHERE enabled)
     OR NEW.media_kind <> 'song' OR NEW.visibility <> 'public' OR EXISTS (
    SELECT 1 FROM media_song_video_pcm_references r
     WHERE r.song_post_id=NEW.post_id AND r.audio_revision=NEW.audio_revision
       AND r.canonical_audio_sha256=NEW.canonical_audio_sha256
  ) THEN RETURN NULL; END IF;
  INSERT INTO media_song_video_pcm_admissions
    (admission_id,song_post_id,song_community_id,audio_revision,canonical_audio_sha256,audio_asset_ref)
  VALUES ('song-pcm-' || encode(sha256(convert_to(NEW.post_id || ':' || NEW.audio_revision::text,'UTF8')),'hex'),
    NEW.post_id,NEW.community_id,NEW.audio_revision,NEW.canonical_audio_sha256,NEW.audio_asset_ref)
  ON CONFLICT (song_post_id,audio_revision) DO NOTHING;
  INSERT INTO media_song_canonical_timings
    (song_post_id,song_community_id,audio_revision,canonical_audio_sha256,state)
  VALUES (NEW.post_id,NEW.community_id,NEW.audio_revision,NEW.canonical_audio_sha256,'pending')
  ON CONFLICT (song_post_id,audio_revision) DO NOTHING;
  RETURN NULL;
END;
$$;
CREATE TRIGGER media_publication_song_pcm_admission AFTER INSERT OR UPDATE
  ON media_publication_projections FOR EACH ROW EXECUTE FUNCTION request_media_song_video_pcm_admission();

-- The existing workstation may still claim timing leases. It cannot commit
-- a measured timing for a revision owned by automatic PCM admission.
CREATE FUNCTION require_media_song_pcm_atomic_timing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target media_song_video_pcm_admissions;
BEGIN
  SELECT * INTO target FROM media_song_video_pcm_admissions
    WHERE song_post_id=NEW.song_post_id AND audio_revision=NEW.audio_revision;
  IF target.admission_id IS NULL THEN RETURN NULL; END IF;
  IF target.state <> 'admitted' OR NEW.prober_identity <> 'cloudconvert-song-pcm-s16le-48000-stereo-v1'
     OR NEW.canonical_audio_sha256 <> target.canonical_audio_sha256 OR NOT EXISTS (
       SELECT 1 FROM media_song_video_pcm_references r
        WHERE r.song_post_id=NEW.song_post_id AND r.audio_revision=NEW.audio_revision
          AND r.canonical_audio_sha256=NEW.canonical_audio_sha256 AND r.duration_samples=NEW.duration_samples
          AND r.decoder_recipe=NEW.prober_identity
     ) THEN RAISE EXCEPTION 'automatic song timing and PCM must be admitted atomically'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER media_song_pcm_atomic_timing AFTER INSERT OR UPDATE
  ON media_song_canonical_timings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.state='ready') EXECUTE FUNCTION require_media_song_pcm_atomic_timing();

CREATE FUNCTION require_media_song_pcm_atomic_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM media_song_canonical_timings t JOIN media_song_video_pcm_references r
      USING (song_post_id,audio_revision,canonical_audio_sha256,duration_samples)
     WHERE t.song_post_id=NEW.song_post_id AND t.audio_revision=NEW.audio_revision
       AND t.canonical_audio_sha256=NEW.canonical_audio_sha256 AND t.state='ready'
       AND t.prober_identity='cloudconvert-song-pcm-s16le-48000-stereo-v1'
       AND r.decoder_recipe=t.prober_identity AND r.duration_samples <= 11520000
  ) THEN RAISE EXCEPTION 'song PCM admission requires matching timing and reference'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER media_song_pcm_atomic_admission AFTER INSERT OR UPDATE
  ON media_song_video_pcm_admissions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.state='admitted') EXECUTE FUNCTION require_media_song_pcm_atomic_admission();

CREATE TABLE media_song_video_pcm_source_grants (
  capability_sha256 TEXT PRIMARY KEY CHECK (capability_sha256 ~ '^[0-9a-f]{64}$'),
  admission_id TEXT NOT NULL REFERENCES media_song_video_pcm_admissions (admission_id),
  object_key TEXT NOT NULL CHECK (object_key LIKE 'immutable/%'),
  object_version TEXT NOT NULL CHECK (btrim(object_version) <> ''),
  object_etag TEXT NOT NULL CHECK (btrim(object_etag) <> ''),
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length BIGINT NOT NULL CHECK (byte_length BETWEEN 1 AND 67108864),
  content_type TEXT NOT NULL CHECK (content_type='audio/mpeg'),
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('upload_version','content_etag')),
  expires_at TIMESTAMPTZ NOT NULL CHECK (isfinite(expires_at)),
  revoked_at TIMESTAMPTZ CHECK (isfinite(revoked_at)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE FUNCTION guard_media_song_pcm_source_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'song PCM source grants are retained'; END IF;
  IF ROW(NEW.capability_sha256,NEW.admission_id,NEW.object_key,NEW.object_version,NEW.object_etag,
         NEW.source_sha256,NEW.byte_length,NEW.content_type,NEW.identity_kind,NEW.expires_at,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.capability_sha256,OLD.admission_id,OLD.object_key,OLD.object_version,OLD.object_etag,
         OLD.source_sha256,OLD.byte_length,OLD.content_type,OLD.identity_kind,OLD.expires_at,OLD.created_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN RAISE EXCEPTION 'song PCM source authority is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_song_pcm_source_grant_guard BEFORE UPDATE OR DELETE
  ON media_song_video_pcm_source_grants FOR EACH ROW EXECUTE FUNCTION guard_media_song_pcm_source_grant();
