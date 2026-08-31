-- Make provider retention truthful, version Study generation authority, and
-- bind active translation policy rows to the reviewed corpus evidence.

ALTER TABLE learner_audio_artifacts
  DROP CONSTRAINT learner_audio_artifacts_provider_retention_check;

ALTER TABLE learner_audio_artifacts
  ADD CONSTRAINT learner_audio_artifacts_provider_retention_check
  CHECK (provider_retention IN ('not_stored', 'stored'));

ALTER TABLE study_translation_quality_policies
  ADD COLUMN corpus_revision TEXT,
  ADD COLUMN reviewed_file_sha256 TEXT,
  ADD COLUMN reviewer_role TEXT,
  ADD COLUMN evaluator_revision TEXT;

ALTER TABLE study_translation_quality_policies
  ADD CONSTRAINT study_translation_quality_corpus_revision_check
    CHECK (corpus_revision IS NULL OR char_length(corpus_revision) BETWEEN 1 AND 256),
  ADD CONSTRAINT study_translation_quality_reviewed_file_sha256_check
    CHECK (reviewed_file_sha256 IS NULL OR reviewed_file_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT study_translation_quality_reviewer_role_check
    CHECK (reviewer_role IS NULL OR char_length(reviewer_role) BETWEEN 1 AND 128),
  ADD CONSTRAINT study_translation_quality_evaluator_revision_check
    CHECK (evaluator_revision IS NULL OR char_length(evaluator_revision) BETWEEN 1 AND 128);

ALTER TABLE study_translation_quality_policies
  DROP CONSTRAINT study_translation_active_quality_shape;

ALTER TABLE study_translation_quality_policies
  ADD CONSTRAINT study_translation_active_quality_shape CHECK (
    release_state <> 'active' OR (
      corpus_sample_count >= 100
      AND source_binding_bps = 10000
      AND meaning_preservation_bps = 10000
      AND bilingual_rubric_bps >= 9500
      AND critical_defect_count = 0
      AND corpus_revision IS NOT NULL
      AND reviewed_file_sha256 IS NOT NULL
      AND reviewer_role IS NOT NULL
      AND evaluator_revision IS NOT NULL
    )
  );

ALTER TABLE study_translation_generation_runs
  DROP CONSTRAINT study_translation_generation_runs_prompt_revision_check,
  DROP CONSTRAINT study_translation_generation_structural_validator_revisio_check;

ALTER TABLE study_translation_generation_runs
  ADD CONSTRAINT study_translation_generation_runs_prompt_revision_check
    CHECK (prompt_revision IN (
      'song_study_translation_prompt_v1',
      'song_study_translation_prompt_v2'
    )),
  ADD CONSTRAINT study_translation_run_structural_validator_check
    CHECK (structural_validator_revision IN (
      'study_translation_validator_v1',
      'study_translation_validator_v2'
    ));

COMMENT ON COLUMN study_translation_quality_policies.reviewed_file_sha256 IS
  'SHA-256 of the exact private corpus file accepted by the bilingual review.';

COMMENT ON COLUMN study_translation_quality_policies.evaluator_revision IS
  'Revision of the deterministic corpus evaluator that produced the activation metrics.';
