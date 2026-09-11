-- Reserved by api-song-video-persistence-publication (2026-09-10), for the Spec
-- 013 song-backed interval preflight and the reservation that freezes it.
--
-- Ordinal note: the HNS repair lane also holds local migrations from 0137. The
-- two lanes claimed overlapping ordinals independently, so whichever lands
-- second renumbers against the main it lands on.
--
-- Decisions this relies on were recorded in Spec 013's Gate A section on
-- 2026-09-10: a song-backed video plays 3 000 to 180 000 ms of the canonical
-- song, contained in integer 48 kHz samples, independent of the Spec 021 Dance
-- segment. The canonical duration is the renderer's own probed count, measured
-- once per song post and audio revision; a frame-sum estimate is not
-- substitutable, because it differs from the decoded length by the encoder
-- delay and padding a gapless decoder trims.

-- 1. Canonical song timing. One row per song post and audio revision, bound to
--    the exact canonical bytes it was measured from. Pending until measured; a
--    ready row is a fact and never changes.
CREATE TABLE media_song_canonical_timings (
  song_post_id TEXT NOT NULL CHECK (btrim(song_post_id) <> ''),
  audio_revision BIGINT NOT NULL CHECK (audio_revision >= 1 AND audio_revision <= 9007199254740991),
  song_community_id TEXT NOT NULL CHECK (btrim(song_community_id) <> ''),
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed')),
  sample_rate_hz INTEGER NOT NULL DEFAULT 48000 CHECK (sample_rate_hz = 48000),
  duration_samples BIGINT CHECK (
    duration_samples IS NULL OR (duration_samples > 0 AND duration_samples <= 9007199254740991)
  ),
  prober_identity TEXT CHECK (prober_identity IS NULL OR btrim(prober_identity) <> ''),
  prober_policy_revision INTEGER CHECK (prober_policy_revision IS NULL OR prober_policy_revision >= 1),
  failure_code TEXT CHECK (failure_code IS NULL OR btrim(failure_code) <> ''),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- A claim lease, so concurrent workers do not measure the same revision. A
  -- lapsed lease is simply claimable again; the measurement is deterministic.
  lease_expires_at TIMESTAMPTZ CHECK (lease_expires_at IS NULL OR isfinite(lease_expires_at)),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(requested_at)),
  measured_at TIMESTAMPTZ CHECK (measured_at IS NULL OR isfinite(measured_at)),
  PRIMARY KEY (song_post_id, audio_revision),
  CONSTRAINT song_canonical_timing_ready_shape CHECK (
    (state = 'ready') = (
      duration_samples IS NOT NULL AND prober_identity IS NOT NULL
      AND prober_policy_revision IS NOT NULL AND measured_at IS NOT NULL
    )
  ),
  CONSTRAINT song_canonical_timing_failed_shape CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);
-- Composite target: a frozen plan binds to the exact measured fact, not merely
-- to a row that exists. A pending or failed row has no duration, so it can
-- never satisfy this key, which makes "frozen against a ready measurement" a
-- property of the schema rather than of the caller.
ALTER TABLE media_song_canonical_timings
  ADD CONSTRAINT media_song_canonical_timings_fact_key
  UNIQUE (song_post_id, audio_revision, canonical_audio_sha256, duration_samples);
CREATE INDEX media_song_canonical_timings_pending_idx
  ON media_song_canonical_timings (requested_at) WHERE state = 'pending';

CREATE FUNCTION guard_media_song_canonical_timing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state = 'ready' THEN RAISE EXCEPTION 'a measured canonical song timing is immutable'; END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.song_post_id, NEW.audio_revision, NEW.song_community_id, NEW.canonical_audio_sha256)
     IS DISTINCT FROM
     ROW(OLD.song_post_id, OLD.audio_revision, OLD.song_community_id, OLD.canonical_audio_sha256)
  THEN RAISE EXCEPTION 'canonical song timing identity is immutable'; END IF;
  IF OLD.state = 'ready' THEN RAISE EXCEPTION 'a measured canonical song timing is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_song_canonical_timing_guard
  BEFORE UPDATE OR DELETE ON media_song_canonical_timings
  FOR EACH ROW EXECUTE FUNCTION guard_media_song_canonical_timing();

-- 2. Admit song-reference video reservations. The shape is unchanged except
--    that a video row may now carry either intent.
ALTER TABLE media_upload_reservations DROP CONSTRAINT media_upload_reservations_media_shape;
ALTER TABLE media_upload_reservations ADD CONSTRAINT media_upload_reservations_media_shape CHECK (
  (media_kind = 'song'
    AND video_intent IS NULL AND ingest_policy_revision IS NULL
    AND multipart_upload_id IS NULL AND multipart_part_size_bytes IS NULL
    AND multipart_part_count IS NULL AND multipart_manifest IS NULL
    AND multipart_completed_at IS NULL AND multipart_aborted_at IS NULL
    AND upload_url IS NOT NULL AND btrim(upload_url) <> '')
  OR
  (media_kind = 'video' AND video_intent IN ('original_audio', 'song_reference')
    AND ingest_policy_revision > 0 AND multipart_upload_id IS NOT NULL
    AND btrim(multipart_upload_id) <> '' AND multipart_part_size_bytes > 0
    AND multipart_part_count > 0
    AND (multipart_manifest IS NULL OR jsonb_typeof(multipart_manifest) = 'array')
    AND NOT (multipart_completed_at IS NOT NULL AND multipart_aborted_at IS NOT NULL)
    AND upload_url IS NULL AND upload_headers = '[]'::jsonb)
);
-- Composite target so a plan can bind only to a song-reference reservation in
-- the community it was issued for.
ALTER TABLE media_upload_reservations
  ADD CONSTRAINT media_upload_reservations_intent_key UNIQUE (reservation_id, community_id, video_intent);

-- 3. The render plan, frozen at reservation. It records the author's intent —
--    the canonical song, its audio revision, the selected interval — and the
--    owner policy observed when it was issued. It is a plan, not a result: it
--    asserts nothing about a recording, which does not exist yet.
CREATE TABLE media_video_reservation_song_plans (
  reservation_id TEXT PRIMARY KEY,
  reservation_community_id TEXT NOT NULL,
  reservation_intent TEXT NOT NULL DEFAULT 'song_reference' CHECK (reservation_intent = 'song_reference'),
  song_post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL,
  canonical_audio_sha256 TEXT NOT NULL,
  song_duration_samples BIGINT NOT NULL,
  song_asset_id TEXT NOT NULL CHECK (btrim(song_asset_id) <> ''),
  clip_start_samples BIGINT NOT NULL CHECK (clip_start_samples >= 0),
  -- 3 000 to 180 000 ms at 48 kHz.
  clip_duration_samples BIGINT NOT NULL CHECK (clip_duration_samples BETWEEN 144000 AND 8640000),
  interval_policy_revision INTEGER NOT NULL CHECK (interval_policy_revision >= 1),
  owner_policy_revision BIGINT NOT NULL CHECK (owner_policy_revision >= 1),
  owner_policy_hash TEXT NOT NULL CHECK (owner_policy_hash ~ '^[0-9a-f]{64}$'),
  -- A blocked policy can never be frozen into a plan.
  derivative_video TEXT NOT NULL CHECK (derivative_video IN ('allowed', 'owner_only')),
  selected_from_kind TEXT NOT NULL CHECK (selected_from_kind IN ('library', 'feed')),
  origin_post_id TEXT CHECK (origin_post_id IS NULL OR btrim(origin_post_id) <> ''),
  origin_verified BOOLEAN NOT NULL,
  frozen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(frozen_at)),
  -- D.9 containment, half-open, in integer 48 kHz samples, with no tolerance.
  CONSTRAINT song_video_reservation_plan_containment
    CHECK (clip_start_samples + clip_duration_samples <= song_duration_samples),
  CONSTRAINT song_video_reservation_plan_origin_shape
    CHECK ((selected_from_kind = 'feed') = (origin_post_id IS NOT NULL)),
  CONSTRAINT song_video_reservation_plan_origin_verified
    CHECK (selected_from_kind = 'feed' OR origin_verified = false),
  CONSTRAINT song_video_reservation_plan_reservation_fk
    FOREIGN KEY (reservation_id, reservation_community_id, reservation_intent)
    REFERENCES media_upload_reservations (reservation_id, community_id, video_intent)
    ON DELETE RESTRICT,
  CONSTRAINT song_video_reservation_plan_timing_fk
    FOREIGN KEY (song_post_id, audio_revision, canonical_audio_sha256, song_duration_samples)
    REFERENCES media_song_canonical_timings (song_post_id, audio_revision, canonical_audio_sha256, duration_samples)
    ON DELETE RESTRICT
);

CREATE FUNCTION guard_media_video_reservation_song_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a frozen song-video reservation plan is immutable';
END;
$$;
CREATE TRIGGER media_video_reservation_song_plan_guard
  BEFORE UPDATE OR DELETE ON media_video_reservation_song_plans
  FOR EACH ROW EXECUTE FUNCTION guard_media_video_reservation_song_plan();

-- The other direction: a song-reference reservation cannot commit without its
-- frozen plan. Checked at commit, because the reservation row is written first.
CREATE FUNCTION require_media_video_reservation_song_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.media_kind = 'video' AND NEW.video_intent = 'song_reference' AND NOT EXISTS (
    SELECT 1 FROM media_video_reservation_song_plans p WHERE p.reservation_id = NEW.reservation_id
  ) THEN
    RAISE EXCEPTION 'a song-reference video reservation requires its frozen plan';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER media_video_reservation_song_plan_required
  AFTER INSERT ON media_upload_reservations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.media_kind = 'video' AND NEW.video_intent = 'song_reference')
  EXECUTE FUNCTION require_media_video_reservation_song_plan();
