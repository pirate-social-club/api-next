-- Fresh global Postgres authority for spec 017 translation identity and lifecycle.
-- Community-shard localization tables are historical evidence only and are not imported.

CREATE TABLE localization_source_units (
  source_unit_kind TEXT NOT NULL CHECK (
    source_unit_kind IN ('post', 'comment', 'community_text', 'lyric_line')
  ),
  source_unit_id TEXT NOT NULL CHECK (char_length(source_unit_id) BETWEEN 1 AND 256),
  field_key TEXT NOT NULL CHECK (char_length(field_key) BETWEEN 1 AND 128),
  source_revision BIGINT NOT NULL CHECK (source_revision > 0),
  source_language TEXT NOT NULL CHECK (
    char_length(source_language) <= 64
    AND source_language ~ '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'
  ),
  source_language_policy_version TEXT NOT NULL CHECK (
    char_length(source_language_policy_version) BETWEEN 1 AND 128
  ),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  hash_policy_version TEXT NOT NULL CHECK (char_length(hash_policy_version) BETWEEN 1 AND 128),
  canonical_value TEXT NOT NULL CHECK (char_length(canonical_value) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    source_unit_kind, source_unit_id, field_key, source_revision, source_hash
  )
);

CREATE TABLE localization_translation_versions (
  translation_version_id TEXT PRIMARY KEY CHECK (
    char_length(translation_version_id) BETWEEN 1 AND 256
  ),
  source_unit_kind TEXT NOT NULL,
  source_unit_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  source_revision BIGINT NOT NULL,
  source_hash TEXT NOT NULL,
  target_language TEXT NOT NULL CHECK (
    char_length(target_language) <= 64
    AND target_language ~ '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'
  ),
  translation_policy_version TEXT NOT NULL CHECK (
    char_length(translation_policy_version) BETWEEN 1 AND 128
  ),
  version_number BIGINT NOT NULL CHECK (version_number > 0),
  translated_value TEXT NOT NULL CHECK (char_length(translated_value) > 0),
  translation_origin TEXT NOT NULL CHECK (translation_origin IN ('machine', 'human')),
  provider_id TEXT,
  model_id TEXT,
  prompt_revision TEXT,
  generation_run_id TEXT,
  quality_policy_revision TEXT NOT NULL CHECK (
    char_length(quality_policy_revision) BETWEEN 1 AND 128
  ),
  moderation_result TEXT NOT NULL CHECK (
    moderation_result IN ('allow', 'review_required', 'blocked')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (
    source_unit_kind, source_unit_id, field_key, source_revision, source_hash
  ) REFERENCES localization_source_units (
    source_unit_kind, source_unit_id, field_key, source_revision, source_hash
  ),
  CONSTRAINT localization_translation_machine_provenance CHECK (
    (translation_origin = 'machine'
      AND provider_id IS NOT NULL
      AND model_id IS NOT NULL
      AND prompt_revision IS NOT NULL
      AND generation_run_id IS NOT NULL)
    OR
    (translation_origin = 'human'
      AND provider_id IS NULL
      AND model_id IS NULL
      AND prompt_revision IS NULL)
  ),
  UNIQUE (
    source_unit_kind, source_unit_id, field_key, source_revision, source_hash,
    target_language, translation_policy_version, version_number
  ),
  UNIQUE (
    translation_version_id, source_unit_kind, source_unit_id, field_key,
    source_revision, source_hash, target_language, translation_policy_version
  )
);

CREATE TABLE localization_translation_selections (
  source_unit_kind TEXT NOT NULL,
  source_unit_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  source_revision BIGINT NOT NULL,
  source_hash TEXT NOT NULL,
  target_language TEXT NOT NULL,
  translation_policy_version TEXT NOT NULL,
  selected_translation_version_id TEXT NOT NULL,
  selected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  selected_by TEXT NOT NULL CHECK (char_length(selected_by) BETWEEN 1 AND 128),
  PRIMARY KEY (
    source_unit_kind, source_unit_id, field_key, source_revision, source_hash,
    target_language, translation_policy_version
  ),
  FOREIGN KEY (
    selected_translation_version_id, source_unit_kind, source_unit_id, field_key,
    source_revision, source_hash, target_language, translation_policy_version
  ) REFERENCES localization_translation_versions (
    translation_version_id, source_unit_kind, source_unit_id, field_key,
    source_revision, source_hash, target_language, translation_policy_version
  )
);

CREATE TABLE localization_translation_jobs (
  translation_job_id TEXT PRIMARY KEY CHECK (
    char_length(translation_job_id) BETWEEN 1 AND 256
  ),
  source_unit_kind TEXT NOT NULL,
  source_unit_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  source_revision BIGINT NOT NULL,
  source_hash TEXT NOT NULL,
  target_language TEXT NOT NULL CHECK (
    char_length(target_language) <= 64
    AND target_language ~ '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'
  ),
  translation_policy_version TEXT NOT NULL CHECK (
    char_length(translation_policy_version) BETWEEN 1 AND 128
  ),
  prompt_revision TEXT NOT NULL CHECK (char_length(prompt_revision) BETWEEN 1 AND 128),
  attempt_number BIGINT NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'leased', 'succeeded', 'failed', 'stale', 'policy_blocked')
  ),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  provider_request_id TEXT,
  deadline_at TIMESTAMPTZ NOT NULL,
  retryable BOOLEAN,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (
    source_unit_kind, source_unit_id, field_key, source_revision, source_hash
  ) REFERENCES localization_source_units (
    source_unit_kind, source_unit_id, field_key, source_revision, source_hash
  ),
  CONSTRAINT localization_translation_job_lease_shape CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT localization_translation_job_terminal_shape CHECK (
    (status IN ('failed', 'stale', 'policy_blocked')
      AND retryable IS NOT NULL
      AND failure_reason IS NOT NULL)
    OR (status NOT IN ('failed', 'stale', 'policy_blocked')
      AND retryable IS NULL
      AND failure_reason IS NULL)
  ),
  UNIQUE (
    source_unit_kind, source_unit_id, field_key, source_revision, source_hash,
    target_language, translation_policy_version, prompt_revision, attempt_number
  )
);

CREATE OR REPLACE FUNCTION reject_localization_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER localization_source_units_immutable
  BEFORE UPDATE OR DELETE ON localization_source_units
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();

CREATE TRIGGER localization_translation_versions_immutable
  BEFORE UPDATE OR DELETE ON localization_translation_versions
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();
