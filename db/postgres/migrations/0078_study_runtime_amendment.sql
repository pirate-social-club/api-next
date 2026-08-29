-- Reconcile the unpublished Study v2 foundation with ratified spec 019.
-- Occurrence identity remains Karaoke-facing; repeated normalized lyric text
-- shares one post-scoped Study unit and one private review history.

CREATE TABLE localization_study_units (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  study_unit_id TEXT NOT NULL CHECK (char_length(study_unit_id) BETWEEN 1 AND 256),
  identity_normalization_revision TEXT NOT NULL,
  normalized_source_hash TEXT NOT NULL CHECK (normalized_source_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, post_id, study_unit_id),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  UNIQUE NULLS NOT DISTINCT (
    community_id, post_id, identity_normalization_revision, normalized_source_hash
  )
);

CREATE TABLE localization_lyric_line_study_units (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  lyric_line_id TEXT NOT NULL,
  line_version BIGINT NOT NULL,
  study_unit_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, post_id, lyric_line_id, line_version),
  FOREIGN KEY (community_id, post_id, lyric_line_id, line_version)
    REFERENCES localization_lyric_line_versions (
      community_id, post_id, lyric_line_id, line_version
    ),
  FOREIGN KEY (community_id, post_id, study_unit_id)
    REFERENCES localization_study_units (community_id, post_id, study_unit_id)
);

CREATE TRIGGER localization_study_units_immutable
  BEFORE UPDATE OR DELETE ON localization_study_units
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();
CREATE TRIGGER localization_lyric_line_study_units_immutable
  BEFORE UPDATE OR DELETE ON localization_lyric_line_study_units
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();

CREATE TABLE study_language_profiles (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  lyrics_revision BIGINT NOT NULL CHECK (lyrics_revision > 0),
  language_profile_revision BIGINT NOT NULL CHECK (language_profile_revision > 0),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  prompt_revision TEXT NOT NULL,
  validator_revision TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  accepted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, post_id, lyrics_revision, language_profile_revision),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id)
);

CREATE TABLE study_language_profile_units (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  lyrics_revision BIGINT NOT NULL,
  language_profile_revision BIGINT NOT NULL,
  study_unit_id TEXT NOT NULL,
  detected_languages JSONB NOT NULL CHECK (jsonb_typeof(detected_languages) = 'array'),
  dominant_language TEXT,
  mixed BOOLEAN NOT NULL,
  vocable_only BOOLEAN NOT NULL,
  confidence NUMERIC(6,5) CHECK (confidence BETWEEN 0 AND 1),
  PRIMARY KEY (
    community_id, post_id, lyrics_revision, language_profile_revision, study_unit_id
  ),
  FOREIGN KEY (community_id, post_id, lyrics_revision, language_profile_revision)
    REFERENCES study_language_profiles (
      community_id, post_id, lyrics_revision, language_profile_revision
    ),
  FOREIGN KEY (community_id, post_id, study_unit_id)
    REFERENCES localization_study_units (community_id, post_id, study_unit_id)
);

CREATE TRIGGER study_language_profiles_immutable
  BEFORE UPDATE OR DELETE ON study_language_profiles
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();
CREATE TRIGGER study_language_profile_units_immutable
  BEFORE UPDATE OR DELETE ON study_language_profile_units
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();

DROP TABLE study_transcript_evidence_v2;

ALTER TABLE study_exercise_versions
  RENAME COLUMN helper_language TO target_language;
ALTER TABLE study_exercise_versions
  DROP CONSTRAINT study_exercise_versions_exercise_type_check,
  DROP CONSTRAINT study_exercise_language_shape,
  ADD COLUMN study_unit_id TEXT NOT NULL,
  ADD COLUMN language_profile_revision BIGINT CHECK (language_profile_revision > 0),
  ALTER COLUMN learner_band DROP NOT NULL,
  ADD CONSTRAINT study_exercise_versions_exercise_type_check CHECK (
    exercise_type IN ('say_it_back', 'translation_choice')
  ),
  ADD CONSTRAINT study_exercise_language_shape CHECK (
    (exercise_type = 'say_it_back' AND target_language IS NULL AND learner_band IS NULL)
    OR (exercise_type = 'translation_choice' AND target_language IS NOT NULL
      AND target_language <> learning_language AND learner_band IS NOT NULL)
  ),
  ADD CONSTRAINT study_exercise_unit_fk FOREIGN KEY (
    community_id, post_id, study_unit_id
  ) REFERENCES localization_study_units (community_id, post_id, study_unit_id);

ALTER TABLE study_review_items
  ADD COLUMN community_id TEXT NOT NULL,
  ADD COLUMN post_id TEXT NOT NULL,
  ADD COLUMN study_unit_id TEXT NOT NULL,
  ADD COLUMN exercise_kind TEXT NOT NULL CHECK (
    exercise_kind IN ('say_it_back', 'translation_choice')
  ),
  ADD COLUMN learning_language TEXT NOT NULL DEFAULT 'en' CHECK (learning_language = 'en'),
  ADD COLUMN target_language TEXT,
  ADD COLUMN learner_band TEXT CHECK (learner_band IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  ADD COLUMN repetitions BIGINT NOT NULL DEFAULT 0 CHECK (repetitions >= 0),
  ADD COLUMN lapses BIGINT NOT NULL DEFAULT 0 CHECK (lapses >= 0),
  ADD COLUMN stability NUMERIC(8,3) NOT NULL DEFAULT 1 CHECK (stability BETWEEN 0.25 AND 365),
  ADD COLUMN difficulty NUMERIC(5,3) NOT NULL DEFAULT 5 CHECK (difficulty BETWEEN 1 AND 10),
  ADD COLUMN review_state TEXT NOT NULL DEFAULT 'new' CHECK (
    review_state IN ('new', 'learning', 'relearning', 'review')
  ),
  ADD COLUMN due_at TIMESTAMPTZ,
  ADD COLUMN last_reviewed_at TIMESTAMPTZ,
  ADD CONSTRAINT study_review_unit_fk FOREIGN KEY (community_id, post_id, study_unit_id)
    REFERENCES localization_study_units (community_id, post_id, study_unit_id),
  ADD CONSTRAINT study_review_language_shape CHECK (
    (exercise_kind = 'say_it_back' AND target_language IS NULL AND learner_band IS NULL)
    OR (exercise_kind = 'translation_choice' AND target_language IS NOT NULL
      AND target_language <> learning_language AND learner_band IS NOT NULL)
  ),
  ADD CONSTRAINT study_review_scheduler_version CHECK (
    scheduler_policy_revision = 'study_review_schedule_v1'
  ),
  ADD CONSTRAINT study_review_identity_v2 UNIQUE NULLS NOT DISTINCT (
    account_id, post_id, study_unit_id, exercise_kind,
    learning_language, target_language, learner_band
  );

ALTER TABLE study_sessions_v2
  RENAME COLUMN helper_language TO target_language;
ALTER TABLE study_sessions_v2
  ALTER COLUMN learner_band DROP NOT NULL,
  ADD COLUMN language_profile_revision BIGINT CHECK (language_profile_revision > 0),
  ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  ADD CONSTRAINT study_session_language_shape CHECK (
    (target_language IS NULL AND learner_band IS NULL)
    OR (target_language IS NOT NULL AND target_language <> learning_language
      AND learner_band IS NOT NULL)
  ),
  ADD CONSTRAINT study_session_expiry_shape CHECK (expires_at > created_at);

ALTER TABLE study_session_items_v2
  DROP CONSTRAINT study_session_items_v2_ordinal_check,
  DROP CONSTRAINT study_session_items_v2_maximum_attempts_check,
  ADD CONSTRAINT study_session_items_v2_ordinal_check CHECK (ordinal BETWEEN 0 AND 9),
  ADD CONSTRAINT study_session_items_v2_maximum_attempts_check CHECK (maximum_attempts = 3);

ALTER TABLE study_attempts_v2
  DROP CONSTRAINT study_attempts_v2_submission_kind_check,
  ADD COLUMN study_unit_id TEXT NOT NULL,
  ADD COLUMN exercise_kind TEXT NOT NULL CHECK (
    exercise_kind IN ('say_it_back', 'translation_choice')
  ),
  ADD COLUMN learning_language TEXT NOT NULL DEFAULT 'en' CHECK (learning_language = 'en'),
  ADD COLUMN target_language TEXT,
  ADD COLUMN learner_band TEXT CHECK (learner_band IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  ADD COLUMN source_line_revision BIGINT NOT NULL CHECK (source_line_revision > 0),
  ADD COLUMN language_profile_revision BIGINT CHECK (language_profile_revision > 0),
  ADD COLUMN localization_revision BIGINT CHECK (localization_revision > 0),
  ADD COLUMN grading_revision TEXT NOT NULL,
  ADD COLUMN review_schedule_version TEXT NOT NULL DEFAULT 'study_review_schedule_v1' CHECK (
    review_schedule_version = 'study_review_schedule_v1'
  ),
  ADD COLUMN presented_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN answered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN audio_byte_size BIGINT CHECK (audio_byte_size BETWEEN 1 AND 524288),
  ADD COLUMN audio_duration_ms BIGINT CHECK (audio_duration_ms BETWEEN 1 AND 60000),
  ADD COLUMN provider_detected_language TEXT,
  ADD COLUMN provider_detected_language_confidence NUMERIC(6,5) CHECK (
    provider_detected_language_confidence BETWEEN 0 AND 1
  ),
  ADD COLUMN token_diff JSONB CHECK (
    token_diff IS NULL OR (
      jsonb_typeof(token_diff) = 'object' AND octet_length(token_diff::text) <= 32768
    )
  ),
  ADD CONSTRAINT study_attempts_v2_submission_kind_check CHECK (
    submission_kind IN ('raw_audio', 'single_select')
  ),
  ADD CONSTRAINT study_attempt_language_shape CHECK (
    (exercise_kind = 'say_it_back' AND target_language IS NULL AND learner_band IS NULL)
    OR (exercise_kind = 'translation_choice' AND target_language IS NOT NULL
      AND target_language <> learning_language AND learner_band IS NOT NULL)
  ),
  ADD CONSTRAINT study_attempt_audio_shape CHECK (
    (submission_kind = 'raw_audio' AND audio_byte_size IS NOT NULL
      AND audio_duration_ms IS NOT NULL AND token_diff IS NOT NULL)
    OR (submission_kind = 'single_select' AND audio_byte_size IS NULL
      AND audio_duration_ms IS NULL AND token_diff IS NULL)
  );

CREATE TABLE study_presentations_v2 (
  presentation_id TEXT PRIMARY KEY CHECK (char_length(presentation_id) BETWEEN 1 AND 256),
  session_id TEXT NOT NULL REFERENCES study_sessions_v2 (session_id),
  session_item_id TEXT NOT NULL REFERENCES study_session_items_v2 (session_item_id),
  presentation_number BIGINT NOT NULL CHECK (presentation_number BETWEEN 1 AND 3),
  queue_ordinal BIGINT NOT NULL CHECK (queue_ordinal BETWEEN 0 AND 19),
  presented_at TIMESTAMPTZ NOT NULL,
  answered_at TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IN ('correct', 'incorrect')),
  UNIQUE (session_item_id, presentation_number),
  UNIQUE (session_id, queue_ordinal),
  CHECK ((answered_at IS NULL AND outcome IS NULL) OR (answered_at IS NOT NULL AND outcome IS NOT NULL))
);

CREATE TABLE study_spoken_answer_commands (
  command_id TEXT PRIMARY KEY CHECK (char_length(command_id) BETWEEN 1 AND 256),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  session_id TEXT NOT NULL REFERENCES study_sessions_v2 (session_id),
  session_item_id TEXT NOT NULL REFERENCES study_session_items_v2 (session_item_id),
  attempt_number BIGINT NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  audio_digest TEXT NOT NULL CHECK (audio_digest ~ '^[0-9a-f]{64}$'),
  audio_content_type TEXT NOT NULL CHECK (
    audio_content_type IN ('audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav')
  ),
  audio_byte_size BIGINT NOT NULL CHECK (audio_byte_size BETWEEN 1 AND 524288),
  audio_duration_ms BIGINT NOT NULL CHECK (audio_duration_ms BETWEEN 1 AND 60000),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'completed', 'retryable_failed')),
  provider_failure_kind TEXT,
  result_snapshot JSONB,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  UNIQUE (session_id, session_item_id, attempt_number),
  UNIQUE (session_id, idempotency_key),
  CHECK (result_snapshot IS NULL OR (
    jsonb_typeof(result_snapshot) = 'object' AND octet_length(result_snapshot::text) <= 131072
  )),
  CHECK (
    (state = 'reserved' AND provider_failure_kind IS NULL AND result_snapshot IS NULL AND completed_at IS NULL)
    OR (state = 'completed' AND provider_failure_kind IS NULL AND result_snapshot IS NOT NULL AND completed_at IS NOT NULL)
    OR (state = 'retryable_failed' AND provider_failure_kind IS NOT NULL AND result_snapshot IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE learner_audio_artifacts (
  learner_audio_artifact_id TEXT PRIMARY KEY CHECK (char_length(learner_audio_artifact_id) BETWEEN 1 AND 256),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('study', 'karaoke')),
  attempt_ref TEXT NOT NULL,
  object_ref TEXT,
  content_digest TEXT NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  duration_ms BIGINT NOT NULL CHECK (duration_ms > 0),
  platform_retention TEXT NOT NULL CHECK (platform_retention IN ('private_learning', 'ephemeral')),
  provider_retention TEXT NOT NULL CHECK (provider_retention = 'not_stored'),
  recording_state TEXT NOT NULL CHECK (recording_state IN ('pending', 'stored', 'failed', 'deleted')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (source_kind, attempt_ref, content_digest),
  CHECK ((recording_state = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK ((recording_state = 'stored') = (object_ref IS NOT NULL))
);

ALTER TABLE study_attempts_v2
  ADD COLUMN learner_audio_artifact_id TEXT,
  ADD CONSTRAINT study_attempt_audio_artifact_fk FOREIGN KEY (learner_audio_artifact_id)
    REFERENCES learner_audio_artifacts (learner_audio_artifact_id),
  ADD CONSTRAINT study_attempt_audio_artifact_shape CHECK (
    (submission_kind = 'raw_audio') = (learner_audio_artifact_id IS NOT NULL)
  );

CREATE TRIGGER study_presentations_v2_immutable
  BEFORE UPDATE OR DELETE ON study_presentations_v2
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();
