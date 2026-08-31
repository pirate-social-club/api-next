-- Preserve strict v1 exercise versions for existing session snapshots while making
-- the restored English phonetic policy the newest immutable version selected for
-- future Study sessions.

INSERT INTO study_exercise_versions (
  exercise_version_id, community_id, post_id, audio_revision, lyrics_revision,
  lyric_line_id, line_version, line_source_hash, exercise_review_key,
  exercise_type, exercise_variant, learning_language, target_language, learner_band,
  content_revision, presentation, private_grader, study_unit_id,
  language_profile_revision, answer_visibility, feedback_release,
  grader_policy_revision, feedback_policy_revision, generation_kind, generation_run_id,
  producer_id, provider_model, prompt_revision, request_hash, raw_result_digest,
  structural_validator_revision, semantic_validator_revision, safety_validator_revision,
  quality_validator_revision, quality_policy_revision, generated_at, validated_at, accepted_at
)
SELECT
  'study-exercise-' || encode(sha256(convert_to(
    exercise.exercise_version_id || ':spoken-phonetic-v2', 'UTF8'
  )), 'hex'),
  exercise.community_id,
  exercise.post_id,
  exercise.audio_revision,
  exercise.lyrics_revision,
  exercise.lyric_line_id,
  exercise.line_version,
  exercise.line_source_hash,
  exercise.exercise_review_key,
  exercise.exercise_type,
  'spoken-recall-v2',
  exercise.learning_language,
  exercise.target_language,
  exercise.learner_band,
  exercise.content_revision * 100 + 2,
  exercise.presentation,
  jsonb_build_object(
    'kind', 'source_token_phonetic_v2',
    'reference_text', exercise.private_grader->>'reference_text',
    'tokenizer_policy_revision', 'script_aware_token_phonetic_v2'
  ),
  exercise.study_unit_id,
  exercise.language_profile_revision,
  exercise.answer_visibility,
  exercise.feedback_release,
  'script_aware_token_phonetic_v2',
  exercise.feedback_policy_revision,
  exercise.generation_kind,
  'study-source-' || encode(sha256(convert_to(
    exercise.exercise_version_id || ':spoken-phonetic-v2', 'UTF8'
  )), 'hex'),
  'accepted-lyrics-say-it-back-v2',
  exercise.provider_model,
  'accepted-say-it-back-v2',
  encode(sha256(convert_to(
    exercise.request_hash || ':spoken-phonetic-v2', 'UTF8'
  )), 'hex'),
  exercise.raw_result_digest,
  exercise.structural_validator_revision,
  exercise.semantic_validator_revision,
  exercise.safety_validator_revision,
  exercise.quality_validator_revision,
  exercise.quality_policy_revision,
  clock_timestamp(),
  clock_timestamp(),
  clock_timestamp()
FROM study_exercise_versions exercise
WHERE exercise.exercise_type = 'say_it_back'
  AND exercise.grader_policy_revision = 'script_aware_token_diff_v1'
  AND exercise.private_grader->>'kind' = 'source_token_diff_v1'
ON CONFLICT (exercise_review_key, content_revision) DO NOTHING;
