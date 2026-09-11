-- Spec 013 §5A.7: song-reference video submission, rendering and publication.
-- Ordinal chosen in api-song-video-persistence-publication on 2026-09-10; it is
-- not reserved and must be coordinated with other lanes before landing.
--
-- A song-reference video publishes a rendered master, never its capture. The
-- schema below lets that path exist and binds every published fact to the
-- frozen work: the submission to its reservation's intent, the render plan to
-- the reservation's frozen plan, the published video to the accepted master,
-- the song edge to a permitting owner-policy observation taken at commit, and
-- the derivative DATA intent to a deterministic parent.

-- 1. Song-reference video submissions, and the render phase they pass through.
ALTER TABLE media_post_submissions DROP CONSTRAINT media_post_submissions_track_shape;
ALTER TABLE media_post_submissions ADD CONSTRAINT media_post_submissions_track_shape CHECK (
  (media_kind = 'song' AND title IS NOT NULL AND btrim(title) <> ''
    AND char_length(title) <= 200 AND song_type IN ('original', 'remix')
    AND video_intent IS NULL AND caption IS NULL AND video_revision = 0
    AND poster_timestamp_ms IS NULL AND video_state_snapshot IS NULL)
  OR
  (media_kind = 'video' AND title IS NULL AND song_type IS NULL
    AND video_intent IN ('original_audio', 'song_reference')
    AND (caption IS NULL OR char_length(caption) <= 5000)
    AND audio_revision = 0 AND lyrics_revision = 0
    AND current_terms_revision IS NULL AND current_lyrics_revision IS NULL
    AND bound_reference_asset_id IS NULL
    AND video_revision >= 0 AND jsonb_typeof(video_state_snapshot) = 'object'
    AND (poster_timestamp_ms IS NULL OR (poster_timestamp_ms >= 0 AND poster_timestamp_ms <= 179999)))
);
ALTER TABLE media_post_submissions DROP CONSTRAINT media_post_submissions_phase_check;
ALTER TABLE media_post_submissions ADD CONSTRAINT media_post_submissions_phase_check CHECK (
  phase IS NULL
  OR phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish')
  OR (media_kind = 'video' AND video_intent = 'song_reference' AND phase = 'render')
);
ALTER TABLE media_post_submissions DROP CONSTRAINT media_post_submissions_last_safe_phase_check;
ALTER TABLE media_post_submissions ADD CONSTRAINT media_post_submissions_last_safe_phase_check CHECK (
  last_safe_phase IS NULL
  OR last_safe_phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish')
  OR (media_kind = 'video' AND video_intent = 'song_reference' AND last_safe_phase = 'render')
);
-- A video submission carries its reservation's intent. Song rows have no video
-- intent, and a null component leaves this key unenforced for them.
ALTER TABLE media_post_submissions
  ADD CONSTRAINT media_post_submissions_video_intent_fk
  FOREIGN KEY (audio_reservation_id, community_id, video_intent)
  REFERENCES media_upload_reservations (reservation_id, community_id, video_intent);

-- 2. The render plan is the reservation's frozen plan, for a song-reference
-- submission, once. Nothing downstream can render an interval the reservation
-- did not freeze.
ALTER TABLE media_song_video_render_plans
  ADD CONSTRAINT media_song_video_render_plans_submission_fk
  FOREIGN KEY (submission_id) REFERENCES media_post_submissions (submission_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX media_song_video_render_plans_one_per_submission
  ON media_song_video_render_plans (submission_id);

CREATE FUNCTION require_song_video_render_plan_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM media_post_submissions s
      JOIN media_video_reservation_song_plans r ON r.reservation_id = s.audio_reservation_id
     WHERE s.submission_id = NEW.submission_id
       AND s.media_kind = 'video'
       AND s.video_intent = 'song_reference'
       AND r.song_post_id = NEW.song_post_id
       AND r.audio_revision = NEW.audio_revision
       AND r.song_asset_id = NEW.song_asset_id
       AND r.song_duration_samples = NEW.song_duration_samples
       AND r.clip_start_samples = NEW.clip_start_samples
       AND r.clip_duration_samples = NEW.clip_duration_samples
  ) THEN
    RAISE EXCEPTION 'a song-video render plan must be its reservation''s frozen plan';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_song_video_render_plan_frozen
  BEFORE INSERT ON media_song_video_render_plans
  FOR EACH ROW EXECUTE FUNCTION require_song_video_render_plan_frozen();

CREATE FUNCTION guard_song_video_render_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a song-video render plan is immutable';
END;
$$;
CREATE TRIGGER media_song_video_render_plan_guard
  BEFORE UPDATE OR DELETE ON media_song_video_render_plans
  FOR EACH ROW EXECUTE FUNCTION guard_song_video_render_plan();

-- Execution of an attempt, kept apart from its outcome. The intent to execute
-- is recorded before the renderer is invoked, so an attempt whose execution may
-- have begun is afterwards only observed, never started again: a lost response
-- or a retried step cannot render the same attempt twice.
ALTER TABLE media_song_video_render_attempts
  ADD COLUMN execution_phase TEXT NOT NULL DEFAULT 'recorded'
    CHECK (execution_phase IN ('recorded', 'submitting', 'submitted')),
  ADD COLUMN execution_started_at TIMESTAMPTZ
    CHECK (execution_started_at IS NULL OR isfinite(execution_started_at)),
  ADD CONSTRAINT media_song_video_render_attempt_execution_shape
    CHECK ((execution_phase = 'recorded') = (execution_started_at IS NULL));

CREATE FUNCTION guard_song_video_render_attempt_execution() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_song_video_render_attempt_execution_guard
  BEFORE UPDATE ON media_song_video_render_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_song_video_render_attempt_execution();

-- The master's decoded audio, established at seal by decoding the verified
-- bytes and the canonical song under the one pinned chain and finding them
-- identical. Duration and sample rate alone cannot tell two songs apart.
ALTER TABLE media_song_video_masters
  ADD COLUMN soundtrack_sha256 TEXT NOT NULL CHECK (soundtrack_sha256 ~ '^[0-9a-f]{64}$');

-- Composite targets, so a published fact binds to the accepted master of one
-- plan and to that master's verified bytes rather than to rows that exist.
-- The pair leads with the master so that acceptance's serializable read by
-- plan keeps using the primary key: a second index led by plan_id would take
-- that read, and a racing insert would then surface as a plain unique
-- violation instead of the serialization failure acceptance retries on.
ALTER TABLE media_song_video_accepted_masters
  ADD CONSTRAINT media_song_video_accepted_masters_pair_key UNIQUE (master_revision_id, plan_id);
ALTER TABLE media_song_video_masters
  ADD CONSTRAINT media_song_video_masters_digest_key UNIQUE (master_revision_id, master_sha256);

-- 3. A song-reference video's rights are derivative; an original-audio
-- video's remain original. The basis is checked against the intent at commit.
ALTER TABLE media_video_rights DROP CONSTRAINT media_video_rights_rights_basis_check;
ALTER TABLE media_video_rights ADD CONSTRAINT media_video_rights_rights_basis_check
  CHECK (rights_basis IN ('original', 'derivative'));

CREATE FUNCTION require_media_video_rights_basis_matches_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM media_post_submissions s
     WHERE s.submission_id = NEW.submission_id AND s.media_kind = 'video'
       AND ((s.video_intent = 'original_audio' AND NEW.rights_basis = 'original')
         OR (s.video_intent = 'song_reference' AND NEW.rights_basis = 'derivative'))
  ) THEN
    RAISE EXCEPTION 'video rights basis does not match the submission intent';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER media_video_rights_basis_matches_intent
  AFTER INSERT OR UPDATE ON media_video_rights
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_media_video_rights_basis_matches_intent();

-- 4. The references_song edge with its committed owner-policy snapshot.
-- The snapshot is the observation taken inside the publication transaction at
-- publication_committed, and it must be one that permitted this account.
ALTER TABLE song_derivative_video_policy_observations
  ADD CONSTRAINT song_derivative_video_policy_observation_snapshot_key UNIQUE (
    operation_id, observed_at_transition, creation_revision, community_id, post_id,
    audio_revision, actor_account_id, owner_policy_revision, owner_policy_hash,
    derivative_video, permitted
  );

CREATE TABLE media_video_song_references (
  submission_id TEXT PRIMARY KEY REFERENCES media_post_submissions (submission_id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL,
  creation_revision BIGINT NOT NULL CHECK (creation_revision >= 1),
  actor_account_id TEXT NOT NULL,
  post_id TEXT NOT NULL UNIQUE CHECK (btrim(post_id) <> ''),
  relationship TEXT NOT NULL DEFAULT 'references_song' CHECK (relationship = 'references_song'),
  song_community_id TEXT NOT NULL,
  song_post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision >= 1),
  plan_id TEXT NOT NULL,
  master_revision_id TEXT NOT NULL UNIQUE,
  policy_transition TEXT NOT NULL DEFAULT 'publication_committed'
    CHECK (policy_transition = 'publication_committed'),
  owner_policy_revision BIGINT NOT NULL CHECK (owner_policy_revision >= 1),
  owner_policy_hash TEXT NOT NULL CHECK (owner_policy_hash ~ '^[0-9a-f]{64}$'),
  derivative_video TEXT NOT NULL CHECK (derivative_video IN ('allowed', 'owner_only')),
  policy_permitted BOOLEAN NOT NULL DEFAULT true CHECK (policy_permitted),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  -- The plan is this submission's plan, and the master is that plan's winner.
  FOREIGN KEY (plan_id, submission_id)
    REFERENCES media_song_video_render_plans (plan_id, submission_id) ON DELETE RESTRICT,
  FOREIGN KEY (master_revision_id, plan_id)
    REFERENCES media_song_video_accepted_masters (master_revision_id, plan_id) ON DELETE RESTRICT,
  -- The committed snapshot is a permitting observation for this operation.
  FOREIGN KEY (
    operation_id, policy_transition, creation_revision, song_community_id, song_post_id,
    audio_revision, actor_account_id, owner_policy_revision, owner_policy_hash,
    derivative_video, policy_permitted
  ) REFERENCES song_derivative_video_policy_observations (
    operation_id, observed_at_transition, creation_revision, community_id, post_id,
    audio_revision, actor_account_id, owner_policy_revision, owner_policy_hash,
    derivative_video, permitted
  ) ON DELETE RESTRICT
);

-- The song's rating is a lower bound on the video's at commit. Checked when the
-- transaction commits, against the song as it is then, so a song made
-- adult-only while its master rendered cannot publish a general video.
CREATE FUNCTION require_song_video_rating_floor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM media_post_submissions s
      JOIN posts video ON video.community_id = s.community_id AND video.post_id = NEW.post_id
      JOIN posts song ON song.community_id = NEW.song_community_id AND song.post_id = NEW.song_post_id
     WHERE s.submission_id = NEW.submission_id
       AND video.post_type = 'video'
       AND song.post_type = 'song'
       AND (song.content_rating <> 'adult_18' OR video.content_rating = 'adult_18')
  ) THEN
    RAISE EXCEPTION 'a song-reference video must be rated at least as its song';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER media_video_song_reference_rating_floor
  AFTER INSERT ON media_video_song_references
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_song_video_rating_floor();

CREATE FUNCTION guard_media_video_song_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a published song reference is immutable';
END;
$$;
CREATE TRIGGER media_video_song_reference_guard
  BEFORE UPDATE OR DELETE ON media_video_song_references
  FOR EACH ROW EXECUTE FUNCTION guard_media_video_song_reference();

-- 5. The published video is the accepted master: its asset and digest are the
-- master's, and the original-sound identity is absent.
ALTER TABLE media_publication_projections
  ADD COLUMN song_video_plan_id TEXT,
  ADD COLUMN song_video_master_revision_id TEXT;
ALTER TABLE media_publication_projections DROP CONSTRAINT media_publication_projection_track_shape;
ALTER TABLE media_publication_projections ADD CONSTRAINT media_publication_projection_track_shape CHECK (
  (media_kind = 'song' AND video_revision = 0 AND caption IS NULL
    AND video_asset_ref IS NULL AND poster_artifact_ref IS NULL
    AND original_sound_id IS NULL AND canonical_video_sha256 IS NULL
    AND song_video_plan_id IS NULL AND song_video_master_revision_id IS NULL
    AND title IS NOT NULL AND audio_asset_ref IS NOT NULL
    AND canonical_audio_sha256 ~ '^[0-9a-f]{64}$')
  OR
  (media_kind = 'video' AND audio_revision = 0 AND video_revision > 0
    AND title IS NULL AND audio_asset_ref IS NULL AND canonical_audio_sha256 IS NULL
    AND (caption IS NULL OR char_length(caption) <= 5000)
    AND video_asset_ref IS NOT NULL AND btrim(video_asset_ref) <> ''
    AND poster_artifact_ref IS NOT NULL AND btrim(poster_artifact_ref) <> ''
    AND canonical_video_sha256 ~ '^[0-9a-f]{64}$'
    AND (
      (original_sound_id IS NOT NULL AND btrim(original_sound_id) <> ''
        AND song_video_plan_id IS NULL AND song_video_master_revision_id IS NULL)
      OR
      (original_sound_id IS NULL
        AND song_video_plan_id IS NOT NULL AND song_video_master_revision_id IS NOT NULL)
    ))
);
ALTER TABLE media_publication_projections
  ADD CONSTRAINT media_publication_projection_song_video_master_fk
  FOREIGN KEY (song_video_master_revision_id, song_video_plan_id)
  REFERENCES media_song_video_accepted_masters (master_revision_id, plan_id) ON DELETE RESTRICT;
ALTER TABLE media_publication_projections
  ADD CONSTRAINT media_publication_projection_song_video_digest_fk
  FOREIGN KEY (song_video_master_revision_id, canonical_video_sha256)
  REFERENCES media_song_video_masters (master_revision_id, master_sha256) ON DELETE RESTRICT;

-- Every video publication rests on one decision. Its decision_revision names
-- the creation revision whose decision, moderator approvals and safety
-- evidence authorize it: the publication's own revision, or an earlier one
-- when a publication-only retry published at a later revision on the same
-- decision. Delivery reads those facts at that revision, so it must exist.
CREATE FUNCTION require_video_publication_decision_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision_revision > NEW.creation_revision OR NOT EXISTS (
    SELECT 1 FROM media_video_publication_decisions d
     WHERE d.submission_id = NEW.submission_id
       AND d.creation_revision = NEW.decision_revision
       AND d.video_revision = NEW.video_revision
       AND d.analysis_revision = NEW.analysis_revision
       AND d.outcome IN ('publish', 'review')
  ) THEN
    RAISE EXCEPTION 'a video publication must rest on a publishing decision';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER media_publication_projection_video_decision_anchor
  AFTER INSERT ON media_publication_projections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.media_kind = 'video')
  EXECUTE FUNCTION require_video_publication_decision_anchor();

-- Publication evidence is immutable, so an existing video publication cannot be
-- re-anchored here. Video is disabled in every environment and none should
-- exist; one that does not rest on a publishing decision needs an operator.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM media_publication_projections p
     WHERE p.media_kind = 'video' AND NOT EXISTS (
       SELECT 1 FROM media_video_publication_decisions d
        WHERE d.submission_id = p.submission_id
          AND d.creation_revision = p.decision_revision
          AND d.video_revision = p.video_revision
          AND d.analysis_revision = p.analysis_revision
          AND d.outcome IN ('publish', 'review'))
  ) THEN
    RAISE EXCEPTION 'a video publication does not rest on a publishing decision';
  END IF;
END;
$$;

-- A song-reference projection exists only with its edge, checked at commit.
CREATE FUNCTION require_song_video_projection_edge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM media_video_song_references e
     WHERE e.submission_id = NEW.submission_id
       AND e.post_id = NEW.post_id
       AND e.plan_id = NEW.song_video_plan_id
       AND e.master_revision_id = NEW.song_video_master_revision_id
  ) THEN
    RAISE EXCEPTION 'a song-reference video projection requires its song edge';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER media_publication_projection_song_video_edge
  AFTER INSERT OR UPDATE ON media_publication_projections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.media_kind = 'video' AND NEW.song_video_plan_id IS NOT NULL)
  EXECUTE FUNCTION require_song_video_projection_edge();

-- 6. Derivative-video DATA intent (Spec 008). The intent names its parent only
-- by local asset and deterministic registration-operation identity, and carries
-- the parent license read at publication and the committed owner policy.
ALTER TABLE data_registration_operations DROP CONSTRAINT data_registration_operation_media_shape;
ALTER TABLE data_registration_operations ADD CONSTRAINT data_registration_operation_media_shape CHECK (
  (media_kind = 'song' AND rights_basis IN ('original', 'derivative'))
  OR (media_kind = 'video' AND rights_basis IN ('original', 'derivative'))
);

CREATE TABLE data_registration_parent_references (
  registration_operation_id TEXT PRIMARY KEY
    REFERENCES data_registration_operations (registration_operation_id) ON DELETE RESTRICT,
  relationship TEXT NOT NULL CHECK (relationship = 'references_song'),
  parent_asset_id TEXT NOT NULL CHECK (btrim(parent_asset_id) <> ''),
  parent_registration_operation_id TEXT NOT NULL
    REFERENCES data_registration_operations (registration_operation_id) ON DELETE RESTRICT,
  expected_parent_license_preset TEXT NOT NULL CHECK (
    expected_parent_license_preset IN ('non-commercial', 'commercial-use', 'commercial-remix')
  ),
  expected_parent_commercial_rev_share_bps INTEGER CHECK (
    expected_parent_commercial_rev_share_bps IS NULL
    OR (expected_parent_commercial_rev_share_bps >= 0 AND expected_parent_commercial_rev_share_bps <= 10000)
  ),
  owner_policy_revision BIGINT NOT NULL CHECK (owner_policy_revision >= 1),
  owner_policy_hash TEXT NOT NULL CHECK (owner_policy_hash ~ '^[0-9a-f]{64}$'),
  owner_derivative_video TEXT NOT NULL CHECK (owner_derivative_video IN ('allowed', 'owner_only')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  CONSTRAINT data_registration_parent_not_self
    CHECK (parent_registration_operation_id <> registration_operation_id),
  -- Spec 008: the share is null under the non-commercial and commercial-use presets.
  CONSTRAINT data_registration_parent_license_shape CHECK (
    (expected_parent_license_preset = 'commercial-remix')
    = (expected_parent_commercial_rev_share_bps IS NOT NULL)
  )
);

CREATE FUNCTION guard_data_registration_parent_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a DATA parent reference is immutable';
END;
$$;
CREATE TRIGGER data_registration_parent_reference_guard
  BEFORE UPDATE OR DELETE ON data_registration_parent_references
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_parent_reference();

-- A derivative video names a parent and an original video never does. Song
-- operations are untouched here; their remix parent is a separate task.
CREATE FUNCTION require_data_registration_video_parent_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  has_parent BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM data_registration_parent_references p
     WHERE p.registration_operation_id = NEW.registration_operation_id
  ) INTO has_parent;
  IF (NEW.rights_basis = 'derivative') <> has_parent THEN
    RAISE EXCEPTION 'a video DATA intent has a parent exactly when it is derivative';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER data_registration_video_parent_shape
  AFTER INSERT ON data_registration_operations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.media_kind = 'video')
  EXECUTE FUNCTION require_data_registration_video_parent_shape();
