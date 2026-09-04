-- Migration 0114: Spec 013 phase-one original-audio video publication.
-- Existing song rows retain their exact constraints and trigger path. Video
-- rows share the creation identities while using video-specific evidence.

ALTER TABLE media_upload_reservations
  ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'song',
  ADD COLUMN video_intent TEXT,
  ADD COLUMN ingest_policy_revision BIGINT,
  ADD COLUMN multipart_upload_id TEXT,
  ADD COLUMN multipart_part_size_bytes BIGINT,
  ADD COLUMN multipart_part_count INTEGER,
  ADD COLUMN multipart_manifest JSONB;

ALTER TABLE media_upload_reservations ALTER COLUMN upload_url DROP NOT NULL;
ALTER TABLE media_upload_reservations DROP CONSTRAINT media_upload_reservations_upload_url_check;
ALTER TABLE media_upload_reservations ADD CONSTRAINT media_upload_reservations_media_shape CHECK (
  (media_kind = 'song'
    AND video_intent IS NULL AND ingest_policy_revision IS NULL
    AND multipart_upload_id IS NULL AND multipart_part_size_bytes IS NULL
    AND multipart_part_count IS NULL AND multipart_manifest IS NULL
    AND upload_url IS NOT NULL AND btrim(upload_url) <> '')
  OR
  (media_kind = 'video' AND video_intent = 'original_audio'
    AND ingest_policy_revision > 0 AND multipart_upload_id IS NOT NULL
    AND btrim(multipart_upload_id) <> '' AND multipart_part_size_bytes > 0
    AND multipart_part_count > 0
    AND (multipart_manifest IS NULL OR jsonb_typeof(multipart_manifest) = 'array')
    AND upload_url IS NULL AND upload_headers = '[]'::jsonb)
);
ALTER TABLE media_upload_reservations ADD CONSTRAINT media_upload_reservations_video_limits CHECK (
  media_kind <> 'video'
  OR (expected_content_type IN ('video/mp4', 'video/quicktime')
      AND expected_size_bytes BETWEEN 1 AND 524288000)
);

CREATE TABLE media_video_upload_parts (
  reservation_id TEXT NOT NULL REFERENCES media_upload_reservations (reservation_id),
  part_number INTEGER NOT NULL CHECK (part_number > 0),
  presigned_url TEXT NOT NULL CHECK (btrim(presigned_url) <> ''),
  expires_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ,
  PRIMARY KEY (reservation_id, part_number)
);

ALTER TABLE media_post_submissions
  ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'song',
  ADD COLUMN video_intent TEXT,
  ADD COLUMN caption TEXT,
  ADD COLUMN video_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN poster_timestamp_ms BIGINT;
ALTER TABLE media_post_submissions ALTER COLUMN title DROP NOT NULL;
ALTER TABLE media_post_submissions ALTER COLUMN song_type DROP NOT NULL;
ALTER TABLE media_post_submissions DROP CONSTRAINT media_post_submissions_title_check;
ALTER TABLE media_post_submissions DROP CONSTRAINT media_post_submissions_song_type_check;
ALTER TABLE media_post_submissions ADD CONSTRAINT media_post_submissions_track_shape CHECK (
  (media_kind = 'song' AND title IS NOT NULL AND btrim(title) <> ''
    AND char_length(title) <= 200 AND song_type IN ('original', 'remix')
    AND video_intent IS NULL AND caption IS NULL AND video_revision = 0
    AND poster_timestamp_ms IS NULL)
  OR
  (media_kind = 'video' AND title IS NULL AND song_type IS NULL
    AND video_intent = 'original_audio'
    AND (caption IS NULL OR char_length(caption) <= 5000)
    AND audio_revision = 0 AND lyrics_revision = 0
    AND current_terms_revision IS NULL AND current_lyrics_revision IS NULL
    AND bound_reference_asset_id IS NULL
    AND video_revision >= 0
    AND (poster_timestamp_ms IS NULL OR poster_timestamp_ms BETWEEN 0 AND 179999))
);

CREATE TABLE media_video_revisions (
  submission_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  video_revision BIGINT NOT NULL CHECK (video_revision > 0),
  immutable_ref TEXT NOT NULL,
  canonical_sha256 TEXT NOT NULL CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  content_type TEXT NOT NULL CHECK (content_type IN ('video/mp4', 'video/quicktime')),
  size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 524288000),
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, video_revision),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (community_id, immutable_ref, canonical_sha256, content_type, size_bytes)
    REFERENCES media_immutable_objects (community_id, immutable_ref, canonical_sha256, content_type, size_bytes)
);

CREATE TABLE media_video_analyses (
  submission_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  video_revision BIGINT NOT NULL,
  analysis_revision BIGINT NOT NULL CHECK (analysis_revision > 0),
  canonical_video_sha256 TEXT NOT NULL CHECK (canonical_video_sha256 ~ '^[0-9a-f]{64}$'),
  analysis_snapshot JSONB NOT NULL CHECK (jsonb_typeof(analysis_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, analysis_revision),
  FOREIGN KEY (submission_id, video_revision)
    REFERENCES media_video_revisions (submission_id, video_revision)
);

CREATE TABLE media_video_publication_decisions (
  submission_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  video_revision BIGINT NOT NULL,
  analysis_revision BIGINT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('publish', 'review', 'block')),
  effective_content_rating TEXT NOT NULL CHECK (effective_content_rating IN ('general', 'adult_18')),
  decision_snapshot JSONB NOT NULL CHECK (jsonb_typeof(decision_snapshot) = 'object'),
  decided_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (submission_id, creation_revision),
  FOREIGN KEY (submission_id, analysis_revision)
    REFERENCES media_video_analyses (submission_id, analysis_revision)
);

CREATE TABLE media_video_review_holds (
  submission_id TEXT NOT NULL REFERENCES media_post_submissions (submission_id),
  creation_revision BIGINT NOT NULL,
  hold_kind TEXT NOT NULL CHECK (hold_kind IN ('safety', 'soundtrack')),
  reason_codes JSONB NOT NULL CHECK (jsonb_typeof(reason_codes) = 'array' AND jsonb_array_length(reason_codes) > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'blocked')),
  action_id TEXT,
  evidence_ref TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, creation_revision, hold_kind),
  CONSTRAINT media_video_review_hold_resolution CHECK (
    (status = 'open' AND action_id IS NULL AND evidence_ref IS NULL)
    OR (status = 'approved' AND action_id IS NOT NULL)
    OR (status = 'blocked' AND action_id IS NOT NULL AND evidence_ref IS NOT NULL)
  )
);

CREATE TABLE media_video_original_sounds (
  original_sound_id TEXT PRIMARY KEY CHECK (btrim(original_sound_id) <> ''),
  submission_id TEXT NOT NULL UNIQUE REFERENCES media_post_submissions (submission_id),
  origin_video_post_id TEXT NOT NULL,
  origin_video_revision BIGINT NOT NULL,
  extracted_audio_ref TEXT NOT NULL CHECK (btrim(extracted_audio_ref) <> ''),
  extracted_audio_sha256 TEXT NOT NULL CHECK (extracted_audio_sha256 ~ '^[0-9a-f]{64}$'),
  extraction_policy_revision TEXT NOT NULL CHECK (btrim(extraction_policy_revision) <> ''),
  retention_policy_revision BIGINT NOT NULL CHECK (retention_policy_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (submission_id, origin_video_revision)
    REFERENCES media_video_revisions (submission_id, video_revision)
);

CREATE TABLE media_video_rights (
  submission_id TEXT PRIMARY KEY REFERENCES media_post_submissions (submission_id),
  rights_basis TEXT NOT NULL CHECK (rights_basis = 'original'),
  access_mode TEXT NOT NULL CHECK (access_mode = 'public'),
  royalty_allocations JSONB NOT NULL CHECK (
    royalty_allocations @> '[{"share_bps": 10000}]'::jsonb
    AND jsonb_array_length(royalty_allocations) = 1
  ),
  offered_license JSONB CHECK (offered_license IS NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE media_video_derived_artifacts (
  artifact_ref TEXT PRIMARY KEY CHECK (btrim(artifact_ref) <> ''),
  submission_id TEXT NOT NULL REFERENCES media_post_submissions (submission_id),
  video_revision BIGINT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('extracted_audio', 'poster', 'first', 'midpoint')),
  canonical_sha256 TEXT NOT NULL CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  retention_policy_revision BIGINT NOT NULL CHECK (retention_policy_revision > 0),
  retained_until_source_disposition BOOLEAN NOT NULL DEFAULT TRUE CHECK (retained_until_source_disposition),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (submission_id, video_revision)
    REFERENCES media_video_revisions (submission_id, video_revision),
  UNIQUE (submission_id, video_revision, artifact_kind)
);

CREATE TABLE media_video_enrichment_outbox (
  effect_identity TEXT PRIMARY KEY CHECK (btrim(effect_identity) <> ''),
  submission_id TEXT NOT NULL REFERENCES media_post_submissions (submission_id),
  operation_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  enrichment_kind TEXT NOT NULL CHECK (enrichment_kind IN ('stream', 'thumbnail')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'ready', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (submission_id, enrichment_kind)
);

CREATE TABLE media_video_stream_ingests (
  operation_id TEXT PRIMARY KEY CHECK (btrim(operation_id) <> ''),
  state TEXT NOT NULL DEFAULT 'not_started' CHECK (state IN ('not_started', 'sending', 'bound', 'manual_review')),
  creator_marker TEXT,
  source_sha256 TEXT CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  provider_video_id TEXT,
  claim_fence BIGINT NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_video_stream_ingest_shape CHECK (
    (state = 'not_started' AND creator_marker IS NULL AND source_sha256 IS NULL AND provider_video_id IS NULL)
    OR (state IN ('sending', 'manual_review') AND creator_marker IS NOT NULL AND source_sha256 IS NOT NULL AND provider_video_id IS NULL)
    OR (state = 'bound' AND creator_marker IS NOT NULL AND source_sha256 IS NOT NULL AND provider_video_id IS NOT NULL)
  )
);

DROP TRIGGER media_submission_update_guard ON media_post_submissions;
CREATE TRIGGER media_song_submission_update_guard
  BEFORE UPDATE ON media_post_submissions
  FOR EACH ROW WHEN (OLD.media_kind = 'song')
  EXECUTE FUNCTION guard_media_submission_update();

CREATE FUNCTION guard_media_video_submission_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.media_kind <> 'video' OR NEW.media_kind <> 'video'
    OR ROW(NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.author_persona_id,
           NEW.operation_id, NEW.idempotency_key, NEW.request_hash, NEW.audio_reservation_id,
           NEW.video_intent, NEW.caption, NEW.author_declared_rating, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.author_persona_id,
           OLD.operation_id, OLD.idempotency_key, OLD.request_hash, OLD.audio_reservation_id,
           OLD.video_intent, OLD.caption, OLD.author_declared_rating, OLD.created_at)
  THEN RAISE EXCEPTION 'video submission authority is immutable'; END IF;
  IF NEW.event_sequence <> OLD.event_sequence + 1 OR NEW.updated_at <= OLD.updated_at
  THEN RAISE EXCEPTION 'video submission transition fence did not advance'; END IF;
  IF OLD.status IN ('published', 'blocked', 'abandoned')
  THEN RAISE EXCEPTION 'video submission is terminal'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_video_submission_update_guard
  BEFORE UPDATE ON media_post_submissions
  FOR EACH ROW WHEN (OLD.media_kind = 'video')
  EXECUTE FUNCTION guard_media_video_submission_update();

ALTER TABLE posts DROP CONSTRAINT posts_rated_content_shape;
ALTER TABLE posts ADD CONSTRAINT posts_rated_content_shape CHECK (
  (post_type IN ('text', 'song', 'video')
    AND author_declared_rating IN ('general', 'adult_18')
    AND content_rating IN ('general', 'adult_18')
    AND (content_rating = 'adult_18' OR author_declared_rating = 'general'))
  OR
  (post_type NOT IN ('text', 'song', 'video')
    AND author_declared_rating IS NULL AND content_rating IS NULL)
);
