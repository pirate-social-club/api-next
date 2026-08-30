-- Keep canonical lyric occurrence identity independent from exercise suitability.
-- Complete structural-metadata lines are excluded before catalog materialization;
-- retained lyric units receive an immutable, versioned per-exercise decision.

CREATE TABLE study_unit_exercise_eligibility (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  study_unit_id TEXT NOT NULL,
  exercise_kind TEXT NOT NULL CHECK (
    exercise_kind IN ('say_it_back', 'translation_choice')
  ),
  policy_revision TEXT NOT NULL CHECK (
    policy_revision = 'study_unit_eligibility_v1'
  ),
  eligibility TEXT NOT NULL CHECK (eligibility IN ('eligible', 'ineligible')),
  ineligibility_reason TEXT CHECK (
    ineligibility_reason IS NULL OR ineligibility_reason IN ('spoken_recall_too_long')
  ),
  measured_token_count BIGINT NOT NULL CHECK (measured_token_count >= 0),
  measured_character_count BIGINT NOT NULL CHECK (measured_character_count >= 0),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    community_id, post_id, study_unit_id, exercise_kind, policy_revision
  ),
  FOREIGN KEY (community_id, post_id, study_unit_id)
    REFERENCES localization_study_units (community_id, post_id, study_unit_id),
  CHECK (
    (eligibility = 'eligible' AND ineligibility_reason IS NULL)
    OR (eligibility = 'ineligible' AND ineligibility_reason IS NOT NULL)
  )
);

CREATE TRIGGER study_unit_exercise_eligibility_immutable
  BEFORE UPDATE OR DELETE ON study_unit_exercise_eligibility
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();
