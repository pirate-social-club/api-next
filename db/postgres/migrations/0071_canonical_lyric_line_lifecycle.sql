-- Canonical per-occurrence lyric-line identity for spec 017 section 3.3.

ALTER TABLE localization_translation_versions
  DROP CONSTRAINT localization_translation_machine_provenance,
  ADD CONSTRAINT localization_translation_machine_provenance CHECK (
    (translation_origin = 'machine'
      AND provider_id IS NOT NULL
      AND model_id IS NOT NULL
      AND prompt_revision IS NOT NULL
      AND generation_run_id IS NOT NULL)
    OR
    (translation_origin = 'human'
      AND provider_id IS NULL
      AND model_id IS NULL
      AND prompt_revision IS NULL
      AND generation_run_id IS NULL)
  );

CREATE UNIQUE INDEX media_publication_lyrics_revision_uidx
  ON media_publication_projections (
    community_id, actor_user_id, post_id, lyrics_revision
  );

CREATE TABLE localization_lyric_line_occurrences (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  lyric_line_id TEXT NOT NULL CHECK (char_length(lyric_line_id) BETWEEN 1 AND 256),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN ('active', 'retired')
  ),
  retirement_reason TEXT CHECK (
    retirement_reason IN ('deleted', 'split', 'merged', 'replaced')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (community_id, post_id, lyric_line_id),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  CONSTRAINT localization_lyric_line_retirement_shape CHECK (
    (lifecycle_status = 'active' AND retirement_reason IS NULL AND retired_at IS NULL)
    OR
    (lifecycle_status = 'retired' AND retirement_reason IS NOT NULL AND retired_at IS NOT NULL)
  )
);

CREATE TABLE localization_lyric_line_versions (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  lyric_line_id TEXT NOT NULL,
  line_version BIGINT NOT NULL CHECK (line_version > 0),
  canonical_text TEXT NOT NULL CHECK (char_length(canonical_text) > 0),
  source_language TEXT NOT NULL CHECK (
    char_length(source_language) <= 64
    AND source_language ~ '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'
  ),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, post_id, lyric_line_id, line_version),
  FOREIGN KEY (community_id, post_id, lyric_line_id)
    REFERENCES localization_lyric_line_occurrences (community_id, post_id, lyric_line_id),
  UNIQUE (community_id, post_id, lyric_line_id, line_version, source_hash)
);

CREATE TABLE localization_lyrics_revision_lines (
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  lyrics_revision BIGINT NOT NULL CHECK (lyrics_revision > 0),
  ordinal BIGINT NOT NULL CHECK (ordinal > 0),
  lyric_line_id TEXT NOT NULL,
  line_version BIGINT NOT NULL,
  source_hash TEXT NOT NULL,
  PRIMARY KEY (community_id, post_id, lyrics_revision, ordinal),
  UNIQUE (community_id, post_id, lyrics_revision, lyric_line_id),
  FOREIGN KEY (community_id, actor_user_id, post_id, lyrics_revision)
    REFERENCES media_publication_projections (
      community_id, actor_user_id, post_id, lyrics_revision
    ),
  FOREIGN KEY (community_id, post_id, lyric_line_id, line_version, source_hash)
    REFERENCES localization_lyric_line_versions (
      community_id, post_id, lyric_line_id, line_version, source_hash
    )
);

CREATE TABLE localization_lyric_line_lineage (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  transition_kind TEXT NOT NULL CHECK (transition_kind IN ('split', 'merge', 'replaced')),
  predecessor_line_id TEXT NOT NULL,
  successor_line_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    community_id, post_id, transition_kind, predecessor_line_id, successor_line_id
  ),
  CHECK (predecessor_line_id <> successor_line_id),
  FOREIGN KEY (community_id, post_id, predecessor_line_id)
    REFERENCES localization_lyric_line_occurrences (community_id, post_id, lyric_line_id),
  FOREIGN KEY (community_id, post_id, successor_line_id)
    REFERENCES localization_lyric_line_occurrences (community_id, post_id, lyric_line_id)
);

CREATE TABLE localization_lyric_reconciliation_decisions (
  reconciliation_id TEXT PRIMARY KEY CHECK (char_length(reconciliation_id) BETWEEN 1 AND 256),
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  from_lyrics_revision BIGINT NOT NULL CHECK (from_lyrics_revision > 0),
  to_lyrics_revision BIGINT NOT NULL CHECK (to_lyrics_revision > from_lyrics_revision),
  prior_ordinal BIGINT NOT NULL CHECK (prior_ordinal > 0),
  candidate_ordinal BIGINT CHECK (candidate_ordinal IS NULL OR candidate_ordinal > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('retained', 'retired', 'uncertain')),
  lyric_line_id TEXT,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  CONSTRAINT localization_lyric_reconciliation_shape CHECK (
    (outcome = 'retained' AND candidate_ordinal IS NOT NULL AND lyric_line_id IS NOT NULL)
    OR (outcome = 'retired' AND lyric_line_id IS NOT NULL)
    OR (outcome = 'uncertain' AND lyric_line_id IS NULL)
  )
);

CREATE OR REPLACE FUNCTION guard_localization_lyric_line_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.community_id IS DISTINCT FROM NEW.community_id
     OR OLD.post_id IS DISTINCT FROM NEW.post_id
     OR OLD.lyric_line_id IS DISTINCT FROM NEW.lyric_line_id
     OR OLD.lifecycle_status <> 'active'
     OR NEW.lifecycle_status <> 'retired'
     OR NEW.retirement_reason IS NULL
     OR NEW.retired_at IS NULL THEN
    RAISE EXCEPTION 'lyric line lifecycle permits only one active-to-retired transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER localization_lyric_line_lifecycle_guard
  BEFORE UPDATE ON localization_lyric_line_occurrences
  FOR EACH ROW EXECUTE FUNCTION guard_localization_lyric_line_lifecycle();

CREATE TRIGGER localization_lyric_line_delete_guard
  BEFORE DELETE ON localization_lyric_line_occurrences
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();

CREATE TRIGGER localization_lyric_line_versions_immutable
  BEFORE UPDATE OR DELETE ON localization_lyric_line_versions
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();

CREATE TRIGGER localization_lyrics_revision_lines_immutable
  BEFORE UPDATE OR DELETE ON localization_lyrics_revision_lines
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();

CREATE TRIGGER localization_lyric_line_lineage_immutable
  BEFORE UPDATE OR DELETE ON localization_lyric_line_lineage
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();

CREATE TRIGGER localization_lyric_reconciliation_decisions_immutable
  BEFORE UPDATE OR DELETE ON localization_lyric_reconciliation_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();
