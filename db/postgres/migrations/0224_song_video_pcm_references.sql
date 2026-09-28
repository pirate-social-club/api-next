-- A song-video reference is admitted once per published song audio revision.
-- The row binds one immutable PCM object to the measured compressed song; a
-- render may use only an excerpt of this admitted object. Admission itself is
-- a later pipeline step, not part of this migration.
CREATE TABLE media_song_video_pcm_references (
  song_post_id TEXT NOT NULL CHECK (btrim(song_post_id) <> ''),
  audio_revision BIGINT NOT NULL CHECK (audio_revision >= 1 AND audio_revision <= 9007199254740991),
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  duration_samples BIGINT NOT NULL CHECK (duration_samples > 0 AND duration_samples <= 9007199254740991),
  pcm_object_key TEXT NOT NULL CHECK (pcm_object_key LIKE 'song-video-pcm/%' AND btrim(pcm_object_key) = pcm_object_key),
  pcm_object_version TEXT NOT NULL CHECK (btrim(pcm_object_version) <> ''),
  pcm_object_etag TEXT NOT NULL CHECK (btrim(pcm_object_etag) <> ''),
  pcm_sha256 TEXT NOT NULL CHECK (pcm_sha256 ~ '^[0-9a-f]{64}$'),
  pcm_byte_length BIGINT NOT NULL CHECK (pcm_byte_length = duration_samples * 4),
  decoder_recipe TEXT NOT NULL CHECK (btrim(decoder_recipe) <> ''),
  sample_rate_hz INTEGER NOT NULL DEFAULT 48000 CHECK (sample_rate_hz = 48000),
  channels INTEGER NOT NULL DEFAULT 2 CHECK (channels = 2),
  sample_format TEXT NOT NULL DEFAULT 's16le' CHECK (sample_format = 's16le'),
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(admitted_at)),
  PRIMARY KEY (song_post_id, audio_revision),
  UNIQUE (pcm_object_key, pcm_object_version),
  CONSTRAINT song_video_pcm_reference_timing_fk
    FOREIGN KEY (song_post_id, audio_revision, canonical_audio_sha256, duration_samples)
    REFERENCES media_song_canonical_timings
      (song_post_id, audio_revision, canonical_audio_sha256, duration_samples)
    ON DELETE RESTRICT
);

CREATE FUNCTION guard_media_song_video_pcm_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'an admitted song-video PCM reference is immutable';
END;
$$;
CREATE TRIGGER media_song_video_pcm_reference_guard
  BEFORE UPDATE OR DELETE ON media_song_video_pcm_references
  FOR EACH ROW EXECUTE FUNCTION guard_media_song_video_pcm_reference();
