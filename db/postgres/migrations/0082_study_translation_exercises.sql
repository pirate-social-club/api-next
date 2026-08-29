-- Durable, rights-gated Study translation generation for spec 019.

CREATE TABLE study_translation_quality_policies (
  target_language TEXT NOT NULL CHECK (
    char_length(target_language) <= 64
    AND target_language ~ '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'
  ),
  quality_policy_revision TEXT NOT NULL CHECK (
    char_length(quality_policy_revision) BETWEEN 1 AND 128
  ),
  release_state TEXT NOT NULL CHECK (release_state IN ('evaluation', 'active')),
  corpus_sample_count BIGINT NOT NULL CHECK (corpus_sample_count >= 0),
  source_binding_bps INTEGER NOT NULL CHECK (source_binding_bps BETWEEN 0 AND 10000),
  meaning_preservation_bps INTEGER NOT NULL CHECK (
    meaning_preservation_bps BETWEEN 0 AND 10000
  ),
  bilingual_rubric_bps INTEGER NOT NULL CHECK (bilingual_rubric_bps BETWEEN 0 AND 10000),
  critical_defect_count BIGINT NOT NULL CHECK (critical_defect_count >= 0),
  accepted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (target_language, quality_policy_revision),
  CONSTRAINT study_translation_active_quality_shape CHECK (
    release_state <> 'active' OR (
      corpus_sample_count >= 100
      AND source_binding_bps = 10000
      AND meaning_preservation_bps = 10000
      AND bilingual_rubric_bps >= 9500
      AND critical_defect_count = 0
    )
  )
);

CREATE TABLE study_translation_quality_registry (
  target_language TEXT PRIMARY KEY,
  quality_policy_revision TEXT NOT NULL,
  selected_at TIMESTAMPTZ NOT NULL,
  selected_by TEXT NOT NULL CHECK (char_length(selected_by) BETWEEN 1 AND 128),
  FOREIGN KEY (target_language, quality_policy_revision)
    REFERENCES study_translation_quality_policies (target_language, quality_policy_revision)
);

CREATE TABLE study_translation_generation_runs (
  generation_run_id TEXT PRIMARY KEY CHECK (
    char_length(generation_run_id) BETWEEN 1 AND 256
  ),
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  submission_id TEXT NOT NULL REFERENCES media_post_submissions (submission_id),
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  analysis_revision BIGINT NOT NULL CHECK (analysis_revision > 0),
  lyrics_revision BIGINT NOT NULL CHECK (lyrics_revision > 0),
  lyrics_source_hash TEXT NOT NULL CHECK (lyrics_source_hash ~ '^[0-9a-f]{64}$'),
  language_profile_revision BIGINT NOT NULL CHECK (language_profile_revision > 0),
  learning_language TEXT NOT NULL CHECK (learning_language = 'en'),
  target_language TEXT NOT NULL CHECK (target_language <> learning_language),
  learner_band TEXT NOT NULL CHECK (learner_band IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  generator_policy_revision TEXT NOT NULL,
  prompt_revision TEXT NOT NULL CHECK (prompt_revision = 'song_study_translation_prompt_v1'),
  structural_validator_revision TEXT NOT NULL CHECK (
    structural_validator_revision = 'study_translation_validator_v1'
  ),
  semantic_validator_revision TEXT NOT NULL,
  safety_validator_revision TEXT NOT NULL,
  quality_policy_revision TEXT NOT NULL,
  rights_policy_revision TEXT NOT NULL,
  rights_evidence_ref TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'leased', 'succeeded', 'failed', 'policy_blocked', 'stale')
  ),
  attempt_number BIGINT NOT NULL CHECK (attempt_number > 0),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  provider_id TEXT,
  provider_model TEXT,
  provider_request_id TEXT,
  retryable BOOLEAN,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  FOREIGN KEY (community_id, post_id, lyrics_revision, language_profile_revision)
    REFERENCES study_language_profiles (
      community_id, post_id, lyrics_revision, language_profile_revision
    ),
  FOREIGN KEY (target_language, quality_policy_revision)
    REFERENCES study_translation_quality_policies (target_language, quality_policy_revision),
  UNIQUE (
    community_id, post_id, lyrics_revision, language_profile_revision,
    target_language, learner_band, generator_policy_revision,
    prompt_revision, quality_policy_revision, attempt_number
  ),
  UNIQUE (generation_run_id, community_id, post_id),
  CONSTRAINT study_translation_run_lease_shape CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT study_translation_run_terminal_shape CHECK (
    (status IN ('failed', 'policy_blocked', 'stale')
      AND retryable IS NOT NULL AND failure_reason IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'succeeded'
      AND retryable IS NULL AND failure_reason IS NULL AND completed_at IS NOT NULL)
    OR (status IN ('pending', 'leased')
      AND retryable IS NULL AND failure_reason IS NULL AND completed_at IS NULL)
  ),
  CONSTRAINT study_translation_run_provider_shape CHECK (
    (status = 'succeeded' AND provider_id IS NOT NULL AND provider_model IS NOT NULL)
    OR status <> 'succeeded'
  ),
  CONSTRAINT study_translation_run_time_shape CHECK (
    updated_at >= created_at AND (completed_at IS NULL OR completed_at >= created_at)
  )
);

CREATE TABLE study_translation_generation_items (
  generation_run_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  study_unit_id TEXT NOT NULL,
  lyric_line_id TEXT NOT NULL,
  line_version BIGINT NOT NULL CHECK (line_version > 0),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  item_ordinal BIGINT NOT NULL CHECK (item_ordinal BETWEEN 0 AND 255),
  status TEXT NOT NULL CHECK (status IN ('ready', 'not_applicable', 'skipped')),
  disposition_reason TEXT,
  translation_version_id TEXT,
  exercise_version_id TEXT,
  result_digest TEXT NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  accepted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (generation_run_id, study_unit_id),
  UNIQUE (generation_run_id, item_ordinal),
  FOREIGN KEY (generation_run_id, community_id, post_id)
    REFERENCES study_translation_generation_runs (generation_run_id, community_id, post_id),
  FOREIGN KEY (community_id, post_id, study_unit_id)
    REFERENCES localization_study_units (community_id, post_id, study_unit_id),
  FOREIGN KEY (community_id, post_id, lyric_line_id, line_version, source_hash)
    REFERENCES localization_lyric_line_versions (
      community_id, post_id, lyric_line_id, line_version, source_hash
    ),
  FOREIGN KEY (exercise_version_id) REFERENCES study_exercise_versions (exercise_version_id),
  FOREIGN KEY (translation_version_id) REFERENCES localization_translation_versions (
    translation_version_id
  ),
  CONSTRAINT study_translation_item_result_shape CHECK (
    (status = 'ready' AND disposition_reason IS NULL
      AND translation_version_id IS NOT NULL AND exercise_version_id IS NOT NULL)
    OR (status IN ('not_applicable', 'skipped') AND disposition_reason IS NOT NULL
      AND translation_version_id IS NULL AND exercise_version_id IS NULL)
  )
);

CREATE INDEX study_translation_generation_runs_dispatch_idx
  ON study_translation_generation_runs (status, created_at, generation_run_id)
  WHERE status IN ('pending', 'leased');

CREATE TRIGGER study_translation_quality_policies_immutable
  BEFORE UPDATE OR DELETE ON study_translation_quality_policies
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();

CREATE TRIGGER study_translation_generation_items_immutable
  BEFORE UPDATE OR DELETE ON study_translation_generation_items
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();

-- Study v2 sessions enter the same qualification substrate as the original
-- Study producer. Keep the original reducer validation as a compatibility
-- branch while validating v2 from its immutable attempts and terminal session.
CREATE OR REPLACE FUNCTION guard_activity_qualification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  study_record study_sessions%ROWTYPE;
  study_v2_record RECORD;
  karaoke_session_record karaoke_sessions%ROWTYPE;
  karaoke_attempt_record karaoke_attempts%ROWTYPE;
  karaoke_policy_document JSONB;
  karaoke_policy_kind TEXT;
  expected_evidence JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'activity qualifications are append-only';
  END IF;
  IF NEW.activity_key = 'study' THEN
    SELECT session.account_id, session.persona_id, session.community_id, session.post_id,
           session.audio_revision, session.qualification_policy_revision,
           session.timezone, session.status, session.completed_at,
           count(item.session_item_id)::bigint AS qualifying_exercise_count,
           count(item.session_item_id) FILTER (WHERE EXISTS (
             SELECT 1 FROM study_attempts_v2 attempt
              WHERE attempt.session_item_id=item.session_item_id
           ))::bigint AS presented_count,
           count(item.session_item_id) FILTER (WHERE EXISTS (
             SELECT 1 FROM study_attempts_v2 attempt
              WHERE attempt.session_item_id=item.session_item_id
                AND attempt.attempt_number=1 AND attempt.outcome='correct'
           ))::bigint AS first_pass_correct
      INTO study_v2_record
     FROM study_sessions_v2 session
      JOIN study_session_items_v2 item ON item.session_id=session.session_id
     WHERE session.session_id=NEW.study_session_id
     GROUP BY session.session_id;
    IF study_v2_record.account_id IS NOT NULL THEN
      expected_evidence := jsonb_build_object(
        'kind', 'study_session_first_pass_v2',
        'qualifying_exercise_count', study_v2_record.qualifying_exercise_count,
        'first_pass_correct', study_v2_record.first_pass_correct,
        'required_correct', greatest(
          1, ceil((7 * study_v2_record.qualifying_exercise_count)::numeric / 10)::bigint
        )
      );
      IF study_v2_record.status <> 'completed'
         OR study_v2_record.presented_count <> study_v2_record.qualifying_exercise_count
         OR study_v2_record.first_pass_correct < greatest(
           1, ceil((7 * study_v2_record.qualifying_exercise_count)::numeric / 10)::bigint
         )
         OR ROW(
           NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
           NEW.audio_revision, NEW.qualification_policy_version_id,
           NEW.score_bps, NEW.qualified_at, NEW.streak_day, NEW.evidence_summary
         ) IS DISTINCT FROM ROW(
           study_v2_record.account_id, study_v2_record.persona_id,
           study_v2_record.community_id, study_v2_record.post_id,
           study_v2_record.audio_revision, study_v2_record.qualification_policy_revision,
           ((10000 * study_v2_record.first_pass_correct)
             / study_v2_record.qualifying_exercise_count)::integer,
           study_v2_record.completed_at,
           (study_v2_record.completed_at AT TIME ZONE study_v2_record.timezone)::date,
           expected_evidence
         ) THEN
        RAISE EXCEPTION 'Study v2 qualification is not exact reducer output';
      END IF;
      RETURN NEW;
    END IF;

    SELECT * INTO study_record FROM study_sessions
     WHERE session_id = NEW.study_session_id FOR SHARE;
    expected_evidence := jsonb_build_object(
      'kind', 'study_session_first_pass_v2',
      'qualifying_exercise_count', study_record.qualifying_exercise_count,
      'first_pass_correct', study_record.first_pass_correct,
      'required_correct', study_record.required_correct
    );
    IF study_record.session_id IS NULL OR study_record.status <> 'completed'
       OR study_record.first_pass_correct < study_record.required_correct
       OR ROW(
         NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
         NEW.audio_revision, NEW.qualification_policy_version_id,
         NEW.score_bps, NEW.qualified_at, NEW.streak_day, NEW.evidence_summary
       ) IS DISTINCT FROM ROW(
         study_record.account_id, study_record.persona_id,
         study_record.community_id, study_record.post_id,
         study_record.audio_revision, study_record.qualification_policy_version_id,
         study_record.score_bps, study_record.completed_at,
         study_record.streak_day, expected_evidence
       ) THEN
      RAISE EXCEPTION 'Study qualification is not exact reducer output';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.activity_key = 'karaoke' THEN
    SELECT * INTO karaoke_session_record FROM karaoke_sessions
     WHERE session_id = NEW.karaoke_session_id
       AND attempt_id = NEW.karaoke_attempt_id FOR SHARE;
    SELECT * INTO karaoke_attempt_record FROM karaoke_attempts
     WHERE session_id = NEW.karaoke_session_id
       AND attempt_id = NEW.karaoke_attempt_id FOR SHARE;
    SELECT policy_kind, policy_document INTO karaoke_policy_kind, karaoke_policy_document
      FROM qualification_policy_versions
     WHERE qualification_policy_version_id = karaoke_session_record.qualification_policy_version_id
       AND activity_key = 'karaoke';
    IF karaoke_session_record.session_id IS NULL
       OR karaoke_session_record.status <> 'completed'
       OR karaoke_attempt_record.completion_reason <> 'completed'
       OR karaoke_attempt_record.scored_line_count < 5
       OR karaoke_attempt_record.coverage_bps < 8500
       OR karaoke_attempt_record.final_score_bps < 7000
       OR (
         karaoke_policy_kind = 'karaoke_qualification_v2'
         AND NOT (karaoke_policy_document->'eligible_playback_kinds'
           ? karaoke_session_record.playback_kind)
       )
       OR ROW(
         NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
         NEW.audio_revision, NEW.qualification_policy_version_id,
         NEW.score_bps, NEW.qualified_at, NEW.streak_day, NEW.evidence_summary
       ) IS DISTINCT FROM ROW(
         karaoke_session_record.account_id, karaoke_session_record.persona_id,
         karaoke_session_record.community_id, karaoke_session_record.post_id,
         karaoke_session_record.audio_revision,
         karaoke_session_record.qualification_policy_version_id,
         karaoke_attempt_record.final_score_bps, karaoke_attempt_record.completed_at,
         (karaoke_attempt_record.completed_at AT TIME ZONE karaoke_session_record.timezone)::date,
         karaoke_attempt_record.evidence_summary
       ) THEN
      RAISE EXCEPTION 'Karaoke qualification is not exact reducer output';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reserved activities cannot produce qualifications';
END
$$;
