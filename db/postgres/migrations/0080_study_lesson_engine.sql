-- Authoritative Study lesson orchestration for spec 019.

ALTER TABLE study_sessions_v2
  DROP CONSTRAINT study_session_completion_shape,
  ADD COLUMN current_session_item_id TEXT,
  ADD COLUMN current_presented_at TIMESTAMPTZ,
  ADD COLUMN presentation_count BIGINT NOT NULL DEFAULT 0 CHECK (
    presentation_count BETWEEN 0 AND 20
  ),
  ADD COLUMN completion_reason TEXT CHECK (
    completion_reason IN ('all_resolved', 'presentation_budget')
  );

CREATE TABLE study_lesson_item_state_v2 (
  session_item_id TEXT PRIMARY KEY REFERENCES study_session_items_v2 (session_item_id),
  session_id TEXT NOT NULL REFERENCES study_sessions_v2 (session_id),
  original_ordinal BIGINT NOT NULL CHECK (original_ordinal BETWEEN 0 AND 9),
  presentation_count BIGINT NOT NULL DEFAULT 0 CHECK (presentation_count BETWEEN 0 AND 3),
  last_queue_ordinal BIGINT CHECK (last_queue_ordinal BETWEEN 0 AND 19),
  mastered BOOLEAN NOT NULL DEFAULT FALSE,
  lesson_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_id, original_ordinal),
  CHECK (NOT mastered OR lesson_resolved),
  CHECK ((presentation_count = 0) = (last_queue_ordinal IS NULL))
);

INSERT INTO study_lesson_item_state_v2 (
  session_item_id, session_id, original_ordinal, presentation_count,
  last_queue_ordinal, mastered, lesson_resolved
)
SELECT item.session_item_id, item.session_id, item.ordinal,
       LEAST(3, count(attempt.attempt_id))::bigint,
       CASE WHEN count(attempt.attempt_id)=0 THEN NULL ELSE item.ordinal END,
       coalesce(bool_or(attempt.outcome='correct'), FALSE),
       coalesce(bool_or(attempt.attempt_state='spent'), FALSE)
  FROM study_session_items_v2 item
  LEFT JOIN study_attempts_v2 attempt ON attempt.session_item_id=item.session_item_id
 GROUP BY item.session_item_id, item.session_id, item.ordinal;

UPDATE study_sessions_v2 session
   SET presentation_count=LEAST(20, (
         SELECT count(*)::bigint
           FROM study_attempts_v2 attempt
           JOIN study_session_items_v2 item ON item.session_item_id=attempt.session_item_id
          WHERE item.session_id=session.session_id
       )),
       current_session_item_id=CASE WHEN session.status='active' THEN (
         SELECT item.session_item_id
           FROM study_session_items_v2 item
          WHERE item.session_id=session.session_id
          ORDER BY item.ordinal
          LIMIT 1
       ) END,
       current_presented_at=CASE WHEN session.status='active' THEN session.created_at END,
       completion_reason=CASE WHEN session.status='completed' THEN 'all_resolved' END;

ALTER TABLE study_sessions_v2
  ADD CONSTRAINT study_session_completion_shape CHECK (
    (status = 'active' AND completed_at IS NULL AND completion_reason IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND completion_reason IS NOT NULL)
  ),
  ADD CONSTRAINT study_session_current_presentation_shape CHECK (
    (status = 'active' AND current_session_item_id IS NOT NULL
      AND current_presented_at IS NOT NULL)
    OR (status = 'completed' AND current_session_item_id IS NULL
      AND current_presented_at IS NULL)
  );

ALTER TABLE study_sessions_v2
  ADD CONSTRAINT study_session_current_item_fk FOREIGN KEY (current_session_item_id)
    REFERENCES study_lesson_item_state_v2 (session_item_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX study_lesson_item_state_queue_idx
  ON study_lesson_item_state_v2 (
    session_id, lesson_resolved, presentation_count, last_queue_ordinal, original_ordinal
  );

CREATE INDEX study_review_items_due_selection_idx
  ON study_review_items (
    account_id, post_id, exercise_kind, lifecycle_status, due_at, created_at
  );

WITH candidates AS (
  SELECT line.community_id, line.post_id, revision.submission_id,
         revision.lyrics_revision, source.audio_revision, line.ordinal,
         line.lyric_line_id, line.line_version, line.source_hash,
         version.canonical_text, unit.study_unit_id,
         row_number() OVER (
           PARTITION BY line.community_id, line.post_id, line.lyrics_revision, unit.study_unit_id
           ORDER BY line.ordinal
         ) AS unit_ordinal
    FROM localization_lyrics_revision_lines line
    JOIN media_song_lyrics_revisions source
      ON source.submission_id=line.submission_id
     AND source.lyrics_revision=line.lyrics_revision
    JOIN media_song_lyrics_revisions revision
      ON revision.submission_id=line.submission_id
     AND revision.lyrics_revision=line.lyrics_revision
    JOIN localization_lyric_line_versions version
      ON version.community_id=line.community_id AND version.post_id=line.post_id
     AND version.lyric_line_id=line.lyric_line_id AND version.line_version=line.line_version
    JOIN localization_lyric_line_study_units unit
      ON unit.community_id=line.community_id AND unit.post_id=line.post_id
     AND unit.lyric_line_id=line.lyric_line_id AND unit.line_version=line.line_version
)
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
SELECT 'study-exercise-' || encode(sha256(convert_to(
         candidate.post_id || ':' || candidate.study_unit_id || ':' || candidate.audio_revision
           || ':' || candidate.lyrics_revision,
         'UTF8')), 'hex'),
       candidate.community_id, candidate.post_id, candidate.audio_revision,
       candidate.lyrics_revision, candidate.lyric_line_id, candidate.line_version,
       candidate.source_hash,
       'study-review-say-' || encode(sha256(convert_to(
         candidate.post_id || ':' || candidate.study_unit_id, 'UTF8')), 'hex'),
       'say_it_back', 'spoken-recall-v1', 'en', NULL, NULL,
       candidate.audio_revision * 1000000 + candidate.lyrics_revision,
       jsonb_build_object('kind','say_it_back','reference_text',candidate.canonical_text,
         'capture','microphone_audio'),
       jsonb_build_object('kind','source_token_diff_v1','reference_text',candidate.canonical_text,
         'tokenizer_policy_revision','script_aware_token_diff_v1'),
       candidate.study_unit_id, NULL, 'always_visible', 'every_graded_attempt',
       'script_aware_token_diff_v1', 'spoken-feedback-v1', 'deterministic',
       'study-source-' || encode(sha256(convert_to(
         candidate.submission_id || ':' || candidate.study_unit_id || ':' || candidate.lyrics_revision,
         'UTF8')), 'hex'),
       'accepted-lyrics-say-it-back-v1', NULL, 'accepted-say-it-back-v1',
       candidate.source_hash, candidate.source_hash, 'study-source-structure-v1',
       'study-source-semantic-v1', 'study-source-safety-v1', 'study-source-quality-v1',
       'accepted-source-v1', clock_timestamp(), clock_timestamp(), clock_timestamp()
  FROM candidates candidate
 WHERE candidate.unit_ordinal=1
ON CONFLICT (exercise_review_key, content_revision) DO NOTHING;
