-- Admit the reviewed v3 translation prompt as a distinct generation identity.

ALTER TABLE study_translation_generation_runs
  DROP CONSTRAINT study_translation_generation_runs_prompt_revision_check;

ALTER TABLE study_translation_generation_runs
  ADD CONSTRAINT study_translation_generation_runs_prompt_revision_check
    CHECK (prompt_revision IN (
      'song_study_translation_prompt_v1',
      'song_study_translation_prompt_v2',
      'song_study_translation_prompt_v3'
    ));

ALTER TABLE study_translation_quality_policies
  ADD COLUMN prompt_revision TEXT;

ALTER TABLE study_translation_quality_policies
  ADD CONSTRAINT study_translation_quality_prompt_revision_check
    CHECK (prompt_revision IS NULL OR prompt_revision IN (
      'song_study_translation_prompt_v2',
      'song_study_translation_prompt_v3'
    ));

ALTER TABLE study_translation_quality_policies
  DROP CONSTRAINT study_translation_active_quality_shape;

ALTER TABLE study_translation_quality_policies
  ADD CONSTRAINT study_translation_active_quality_shape CHECK (
    release_state <> 'active' OR (
      corpus_sample_count >= 200
      AND source_binding_bps = 10000
      AND meaning_preservation_bps = 10000
      AND bilingual_rubric_bps >= 9500
      AND critical_defect_count = 0
      AND corpus_revision IS NOT NULL
      AND reviewed_file_sha256 IS NOT NULL
      AND reviewer_role IS NOT NULL
      AND evaluator_revision IS NOT NULL
      AND prompt_revision IS NOT NULL
    )
  );

COMMENT ON COLUMN study_translation_quality_policies.prompt_revision IS
  'Exact translation prompt revision used to generate the reviewed corpus.';
