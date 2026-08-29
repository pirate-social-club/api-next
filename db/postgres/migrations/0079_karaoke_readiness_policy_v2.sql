-- Spec 019 lane 2: preserve Karaoke v1 history while installing playback-
-- aware qualification policy and evidence for the forthcoming runtime.

ALTER TABLE qualification_policy_versions
  DROP CONSTRAINT qualification_policy_kind_shape,
  DROP CONSTRAINT qualification_policy_document_shape,
  ADD CONSTRAINT qualification_policy_kind_shape CHECK (
    (activity_key = 'study' AND policy_kind = 'study_session_first_pass_v2')
    OR (activity_key = 'karaoke' AND policy_kind IN (
      'karaoke_qualification_v1', 'karaoke_qualification_v2'
    ))
  ),
  ADD CONSTRAINT qualification_policy_document_shape CHECK (
    (policy_kind = 'study_session_first_pass_v2'
      AND policy_document = '{"required_correct_bps": 7000}'::jsonb)
    OR (policy_kind = 'karaoke_qualification_v1'
      AND policy_document = '{"minimum_scored_line_count": 5, "minimum_coverage_bps": 8500, "minimum_final_score_bps": 7000}'::jsonb)
    OR (policy_kind = 'karaoke_qualification_v2'
      AND policy_document - 'eligible_playback_kinds'
        = '{"minimum_scored_line_count": 5, "minimum_coverage_bps": 8500, "minimum_final_score_bps": 7000}'::jsonb
      AND policy_document->'eligible_playback_kinds' IN (
        '["full_mix"]'::jsonb,
        '["instrumental"]'::jsonb,
        '["full_mix", "instrumental"]'::jsonb,
        '["instrumental", "full_mix"]'::jsonb
      ))
  );

INSERT INTO qualification_policy_versions (
  qualification_policy_version_id, activity_key, policy_kind, policy_document
) VALUES (
  'karaoke_qualification_v2@1',
  'karaoke',
  'karaoke_qualification_v2',
  '{"minimum_scored_line_count": 5, "minimum_coverage_bps": 8500, "minimum_final_score_bps": 7000, "eligible_playback_kinds": ["full_mix"]}'::jsonb
);

UPDATE activity_registry
   SET producer_version = 'karaoke_postgres_v2',
       current_policy_version_id = 'karaoke_qualification_v2@1',
       updated_at = clock_timestamp()
 WHERE activity_key = 'karaoke';

ALTER TABLE karaoke_sessions
  ADD COLUMN playback_kind TEXT NOT NULL DEFAULT 'full_mix' CHECK (
    playback_kind IN ('full_mix', 'instrumental')
  );

CREATE FUNCTION guard_karaoke_session_playback_kind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.playback_kind IS DISTINCT FROM OLD.playback_kind THEN
    RAISE EXCEPTION 'Karaoke session playback kind is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER karaoke_sessions_playback_kind_guard
BEFORE UPDATE OF playback_kind ON karaoke_sessions
FOR EACH ROW EXECUTE FUNCTION guard_karaoke_session_playback_kind();

CREATE OR REPLACE FUNCTION guard_karaoke_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  session_record karaoke_sessions%ROWTYPE;
  policy_kind_record TEXT;
  expected_evidence JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Karaoke attempts are append-only';
  END IF;
  SELECT * INTO session_record FROM karaoke_sessions
   WHERE session_id = NEW.session_id AND attempt_id = NEW.attempt_id FOR SHARE;
  SELECT policy_kind INTO policy_kind_record FROM qualification_policy_versions
   WHERE qualification_policy_version_id = session_record.qualification_policy_version_id;
  IF session_record.session_id IS NULL OR session_record.status <> 'active'
     OR NEW.created_at IS DISTINCT FROM session_record.created_at
     OR NEW.completed_at < session_record.created_at THEN
    RAISE EXCEPTION 'Karaoke attempt is not bound to its active session';
  END IF;
  expected_evidence := jsonb_build_object(
    'kind', policy_kind_record,
    'scored_line_count', NEW.scored_line_count,
    'line_count', NEW.line_count,
    'coverage_bps', floor(10000.0 * NEW.scored_line_count / NEW.line_count)::integer,
    'final_score_bps', NEW.final_score_bps,
    'scoring_version', NEW.scoring_version,
    'scoring_provider', NEW.scoring_provider,
    'karaoke_revision_id', session_record.karaoke_revision_id
  );
  IF policy_kind_record = 'karaoke_qualification_v2' THEN
    expected_evidence := expected_evidence || jsonb_build_object(
      'playback_kind', session_record.playback_kind
    );
  ELSIF policy_kind_record <> 'karaoke_qualification_v1' THEN
    RAISE EXCEPTION 'Karaoke attempt policy is unsupported';
  END IF;
  IF NEW.evidence_summary <> expected_evidence THEN
    RAISE EXCEPTION 'Karaoke attempt evidence summary is not exact';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION guard_activity_qualification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  study_record study_sessions%ROWTYPE;
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
