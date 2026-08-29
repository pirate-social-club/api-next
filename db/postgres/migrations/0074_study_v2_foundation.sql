-- Fresh Study v2 authority for spec 018. Dormant community-shard Study and
-- generic-learning tables remain historical evidence and are not imported.

CREATE TABLE study_exercise_versions (
  exercise_version_id TEXT PRIMARY KEY CHECK (char_length(exercise_version_id) BETWEEN 1 AND 256),
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  lyrics_revision BIGINT NOT NULL CHECK (lyrics_revision > 0),
  lyric_line_id TEXT NOT NULL,
  line_version BIGINT NOT NULL CHECK (line_version > 0),
  line_source_hash TEXT NOT NULL CHECK (line_source_hash ~ '^[0-9a-f]{64}$'),
  exercise_review_key TEXT NOT NULL CHECK (char_length(exercise_review_key) BETWEEN 1 AND 256),
  exercise_type TEXT NOT NULL CHECK (
    exercise_type IN ('say_it_back', 'translation_choice', 'typed_cloze')
  ),
  exercise_variant TEXT NOT NULL CHECK (char_length(exercise_variant) BETWEEN 1 AND 128),
  learning_language TEXT NOT NULL CHECK (learning_language = 'en'),
  helper_language TEXT,
  learner_band TEXT NOT NULL CHECK (learner_band IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  content_revision BIGINT NOT NULL CHECK (content_revision > 0),
  presentation JSONB NOT NULL CHECK (jsonb_typeof(presentation) = 'object'),
  private_grader JSONB NOT NULL CHECK (jsonb_typeof(private_grader) = 'object'),
  answer_visibility TEXT NOT NULL CHECK (
    answer_visibility IN ('always_visible', 'secret_until_spent')
  ),
  feedback_release TEXT NOT NULL CHECK (
    feedback_release IN ('every_graded_attempt', 'spent_only')
  ),
  grader_policy_revision TEXT NOT NULL,
  feedback_policy_revision TEXT NOT NULL,
  generation_kind TEXT NOT NULL CHECK (
    generation_kind IN ('deterministic', 'provider_generated')
  ),
  generation_run_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  provider_model TEXT,
  prompt_revision TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  raw_result_custody_ref TEXT,
  raw_result_digest TEXT CHECK (raw_result_digest IS NULL OR raw_result_digest ~ '^[0-9a-f]{64}$'),
  structural_validator_revision TEXT NOT NULL,
  semantic_validator_revision TEXT NOT NULL,
  safety_validator_revision TEXT NOT NULL,
  quality_validator_revision TEXT NOT NULL,
  quality_policy_revision TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, post_id, lyric_line_id, line_version, line_source_hash)
    REFERENCES localization_lyric_line_versions (
      community_id, post_id, lyric_line_id, line_version, source_hash
    ),
  UNIQUE (exercise_review_key, content_revision),
  CONSTRAINT study_exercise_language_shape CHECK (
    (exercise_type = 'translation_choice' AND helper_language IS NOT NULL
      AND helper_language <> learning_language)
    OR
    (exercise_type IN ('say_it_back', 'typed_cloze') AND helper_language IS NULL)
  ),
  CONSTRAINT study_exercise_disclosure_shape CHECK (
    (exercise_type = 'say_it_back' AND answer_visibility = 'always_visible'
      AND feedback_release = 'every_graded_attempt')
    OR
    (exercise_type IN ('translation_choice', 'typed_cloze')
      AND answer_visibility = 'secret_until_spent' AND feedback_release = 'spent_only')
  ),
  CONSTRAINT study_exercise_generation_shape CHECK (
    (generation_kind = 'deterministic' AND provider_model IS NULL)
    OR (generation_kind = 'provider_generated' AND provider_model IS NOT NULL)
  ),
  CONSTRAINT study_exercise_raw_result_evidence CHECK (
    raw_result_custody_ref IS NOT NULL OR raw_result_digest IS NOT NULL
  ),
  CONSTRAINT study_exercise_acceptance_order CHECK (
    generated_at <= validated_at AND validated_at <= accepted_at
      AND (retired_at IS NULL OR retired_at >= accepted_at)
  )
);

CREATE TABLE study_review_items (
  review_item_id TEXT PRIMARY KEY CHECK (char_length(review_item_id) BETWEEN 1 AND 256),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  exercise_review_key TEXT NOT NULL,
  current_exercise_version_id TEXT NOT NULL REFERENCES study_exercise_versions (exercise_version_id),
  scheduler_policy_revision TEXT NOT NULL,
  scheduler_state JSONB NOT NULL CHECK (jsonb_typeof(scheduler_state) = 'object'),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retired_at TIMESTAMPTZ,
  UNIQUE (account_id, exercise_review_key),
  CONSTRAINT study_review_lifecycle_shape CHECK (
    (lifecycle_status = 'active' AND retired_at IS NULL)
    OR (lifecycle_status = 'retired' AND retired_at IS NOT NULL)
  )
);

CREATE TABLE study_sessions_v2 (
  session_id TEXT PRIMARY KEY CHECK (char_length(session_id) BETWEEN 1 AND 256),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL REFERENCES personas (persona_id),
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  lyrics_revision BIGINT NOT NULL CHECK (lyrics_revision > 0),
  learning_language TEXT NOT NULL CHECK (learning_language = 'en'),
  helper_language TEXT,
  learner_band TEXT NOT NULL CHECK (learner_band IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  study_profile_revision BIGINT NOT NULL CHECK (study_profile_revision > 0),
  source_set_revision BIGINT NOT NULL CHECK (source_set_revision > 0),
  selection_policy_revision TEXT NOT NULL,
  qualification_policy_revision TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  CONSTRAINT study_session_completion_shape CHECK (
    (status = 'active' AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL)
  )
);

CREATE TABLE study_session_items_v2 (
  session_item_id TEXT PRIMARY KEY CHECK (char_length(session_item_id) BETWEEN 1 AND 256),
  session_id TEXT NOT NULL REFERENCES study_sessions_v2 (session_id),
  ordinal BIGINT NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  exercise_review_key TEXT NOT NULL,
  exercise_version_id TEXT NOT NULL REFERENCES study_exercise_versions (exercise_version_id),
  review_item_id TEXT NOT NULL REFERENCES study_review_items (review_item_id),
  item_snapshot JSONB NOT NULL CHECK (jsonb_typeof(item_snapshot) = 'object'),
  maximum_attempts BIGINT NOT NULL CHECK (maximum_attempts > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_id, ordinal),
  UNIQUE (session_id, exercise_review_key)
);

CREATE TABLE study_attempts_v2 (
  attempt_id TEXT PRIMARY KEY CHECK (char_length(attempt_id) BETWEEN 1 AND 256),
  session_item_id TEXT NOT NULL REFERENCES study_session_items_v2 (session_item_id),
  attempt_number BIGINT NOT NULL CHECK (attempt_number > 0),
  submission_kind TEXT NOT NULL CHECK (
    submission_kind IN ('single_select', 'text_response', 'transcript_response')
  ),
  submission_evidence JSONB NOT NULL CHECK (jsonb_typeof(submission_evidence) = 'object'),
  outcome TEXT NOT NULL CHECK (outcome IN ('correct', 'incorrect')),
  first_pass BOOLEAN NOT NULL,
  attempt_state TEXT NOT NULL CHECK (attempt_state IN ('retryable', 'spent')),
  feedback_kind TEXT NOT NULL CHECK (
    feedback_kind IN ('none', 'transcript_diff', 'choice_reveal', 'text_reveal')
  ),
  feedback_evidence JSONB NOT NULL CHECK (jsonb_typeof(feedback_evidence) = 'object'),
  grader_policy_revision TEXT NOT NULL,
  feedback_policy_revision TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_item_id, attempt_number),
  CONSTRAINT study_attempt_lifecycle_shape CHECK (
    (attempt_state = 'retryable' AND outcome = 'incorrect' AND feedback_kind = 'none')
    OR attempt_state = 'spent'
  )
);

CREATE TRIGGER study_exercise_versions_immutable
  BEFORE UPDATE OR DELETE ON study_exercise_versions
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();

CREATE TRIGGER study_session_items_v2_immutable
  BEFORE UPDATE OR DELETE ON study_session_items_v2
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();

CREATE TRIGGER study_attempts_v2_immutable
  BEFORE UPDATE OR DELETE ON study_attempts_v2
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();
