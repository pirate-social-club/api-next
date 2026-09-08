-- Reserved by api-song-video-persistence-publication (2026-09-08), under the
-- Spec 013 Gate A canonical-replacement ratification.
--
-- Three identities are stored separately and must not collapse: the render plan
-- frozen at reservation, one attempt executing it, and the master revision
-- sealed only after verification. Acceptance is a compare-and-set on the plan,
-- so exactly one master can win.
--
-- U.2, U.4, U.5 and U.6 remain open gates. Nothing here supplies a default for
-- the source-overrun disposition, the master byte ceiling, master retention or
-- an execution path; the byte ceiling that applied is recorded per master so a
-- later ratified value is auditable rather than retroactively assumed.
CREATE TABLE media_song_video_render_plans (
  plan_id TEXT PRIMARY KEY CHECK (length(plan_id) BETWEEN 1 AND 128 AND btrim(plan_id) = plan_id),
  submission_id TEXT NOT NULL,
  song_post_id TEXT NOT NULL CHECK (btrim(song_post_id) <> ''),
  song_asset_id TEXT NOT NULL CHECK (btrim(song_asset_id) <> ''),
  audio_revision INTEGER NOT NULL CHECK (audio_revision >= 0),
  song_duration_samples BIGINT NOT NULL CHECK (song_duration_samples > 0),
  clip_start_samples BIGINT NOT NULL CHECK (clip_start_samples >= 0),
  clip_duration_samples BIGINT NOT NULL CHECK (clip_duration_samples > 0),
  frozen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(frozen_at)),
  -- D.9 containment, in integer 48 kHz samples with no tolerance. A plan that
  -- runs past the song cannot be stored, so no later stage can inherit one.
  CONSTRAINT song_video_plan_canonical_containment
    CHECK (clip_start_samples + clip_duration_samples <= song_duration_samples)
);
CREATE INDEX media_song_video_render_plans_submission_idx
  ON media_song_video_render_plans (submission_id);

CREATE TABLE media_song_video_render_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) BETWEEN 1 AND 128 AND btrim(attempt_id) = attempt_id),
  plan_id TEXT NOT NULL REFERENCES media_song_video_render_plans (plan_id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('started', 'sealed', 'accepted', 'loser', 'abandoned')),
  disposition TEXT CHECK (disposition IS NULL OR btrim(disposition) <> ''),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(started_at)),
  -- Attempt identity is persisted before dispatch, so a stopped worker is always
  -- attributable to a known attempt rather than an unrecorded orphan.
  UNIQUE (plan_id, generation)
);
CREATE INDEX media_song_video_render_attempts_plan_idx
  ON media_song_video_render_attempts (plan_id, state);

CREATE TABLE media_song_video_masters (
  master_revision_id TEXT PRIMARY KEY CHECK (length(master_revision_id) BETWEEN 1 AND 128 AND btrim(master_revision_id) = master_revision_id),
  plan_id TEXT NOT NULL REFERENCES media_song_video_render_plans (plan_id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES media_song_video_render_attempts (attempt_id) ON DELETE RESTRICT,
  -- The sealed source this master was rendered from, established against the
  -- stored sealed object rather than accepted from a caller's claim.
  source_immutable_ref TEXT NOT NULL REFERENCES media_immutable_objects (immutable_ref) ON DELETE RESTRICT,
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  master_sha256 TEXT NOT NULL CHECK (master_sha256 ~ '^[a-f0-9]{64}$'),
  master_byte_length BIGINT NOT NULL CHECK (master_byte_length > 0),
  master_ceiling_bytes BIGINT NOT NULL CHECK (master_ceiling_bytes > 0),
  renderer_identity TEXT NOT NULL CHECK (btrim(renderer_identity) <> ''),
  renderer_policy_revision INTEGER NOT NULL CHECK (renderer_policy_revision >= 0),
  decision_clip_start_samples BIGINT NOT NULL CHECK (decision_clip_start_samples >= 0),
  decision_clip_duration_samples BIGINT NOT NULL CHECK (decision_clip_duration_samples > 0),
  sealed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(sealed_at)),
  -- Source and master are distinct sealed artifacts; neither substitutes for the
  -- other in any ledger, projection or registration.
  CONSTRAINT song_video_master_identity_distinct CHECK (master_sha256 <> source_sha256),
  -- U.6's ceiling is enforced at seal time against the value that applied.
  CONSTRAINT song_video_master_within_ceiling CHECK (master_byte_length <= master_ceiling_bytes)
);

-- Acceptance is a compare-and-set on the plan: at most one master per plan wins,
-- enforced by the database rather than by application ordering.
CREATE TABLE media_song_video_accepted_masters (
  plan_id TEXT PRIMARY KEY REFERENCES media_song_video_render_plans (plan_id) ON DELETE RESTRICT,
  master_revision_id TEXT NOT NULL UNIQUE REFERENCES media_song_video_masters (master_revision_id) ON DELETE RESTRICT,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(accepted_at))
);
