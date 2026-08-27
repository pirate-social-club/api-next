-- Song ratings and viewer-scoped Pirate projections.
-- Canonical public IPFS registration remains unchanged: this migration gates
-- Pirate-owned projections and delivery metadata, not immutable public bytes.

ALTER TABLE posts DROP CONSTRAINT posts_text_rating_shape;

UPDATE posts
   SET author_declared_rating = 'general', content_rating = 'general'
 WHERE post_type = 'song';

ALTER TABLE posts
  ADD CONSTRAINT posts_rated_content_shape CHECK (
    (post_type IN ('text', 'song')
      AND author_declared_rating IN ('general', 'adult_18')
      AND content_rating IN ('general', 'adult_18')
      AND (content_rating = 'adult_18' OR author_declared_rating = 'general'))
    OR (post_type NOT IN ('text', 'song')
      AND author_declared_rating IS NULL
      AND content_rating IS NULL)
  );

CREATE OR REPLACE FUNCTION default_text_post_rating_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.post_type IN ('text', 'song') THEN
    NEW.author_declared_rating := COALESCE(NEW.author_declared_rating, 'general');
    NEW.content_rating := COALESCE(NEW.content_rating, 'general');
  ELSIF NEW.author_declared_rating IS NOT NULL OR NEW.content_rating IS NOT NULL THEN
    RAISE EXCEPTION 'unrated post type cannot carry a content rating';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE media_post_submissions
  ADD COLUMN author_declared_rating TEXT NOT NULL DEFAULT 'general'
    CHECK (author_declared_rating IN ('general', 'adult_18')),
  ADD COLUMN resulting_content_rating TEXT NOT NULL DEFAULT 'general'
    CHECK (resulting_content_rating IN ('general', 'adult_18'));

ALTER TABLE media_publication_projections
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'members_only')),
  ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'general'
    CHECK (content_rating IN ('general', 'adult_18'));

CREATE OR REPLACE FUNCTION enforce_song_rating_projection_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  post_rating TEXT;
  declared_rating TEXT;
BEGIN
  SELECT post.content_rating, post.author_declared_rating
    INTO post_rating, declared_rating
    FROM posts AS post
   WHERE post.community_id = NEW.community_id
     AND post.post_id = NEW.post_id
     AND post.post_type = 'song';
  IF post_rating IS NULL
     OR NEW.content_rating <> post_rating
     OR NEW.content_rating <> (
       SELECT submission.resulting_content_rating
         FROM media_post_submissions AS submission
        WHERE submission.community_id = NEW.community_id
          AND submission.submission_id = NEW.submission_id
          AND submission.operation_id = NEW.operation_id
     )
     OR declared_rating <> (
       SELECT submission.author_declared_rating
         FROM media_post_submissions AS submission
        WHERE submission.community_id = NEW.community_id
          AND submission.submission_id = NEW.submission_id
          AND submission.operation_id = NEW.operation_id
     ) THEN
    RAISE EXCEPTION 'song rating projection disagrees with durable authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER media_publication_projection_rating_guard_v1
AFTER INSERT OR UPDATE ON media_publication_projections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_song_rating_projection_v1();

CREATE OR REPLACE FUNCTION guard_song_rating_lowering_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.resulting_content_rating = 'adult_18'
     AND NEW.resulting_content_rating IS DISTINCT FROM 'adult_18' THEN
    RAISE EXCEPTION 'song content rating cannot be lowered';
  END IF;
  IF NEW.author_declared_rating = 'adult_18'
     AND NEW.resulting_content_rating IS DISTINCT FROM 'adult_18' THEN
    RAISE EXCEPTION 'adult author declaration cannot resolve as general';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_post_submission_rating_guard_v1
BEFORE UPDATE ON media_post_submissions
FOR EACH ROW EXECUTE FUNCTION guard_song_rating_lowering_v1();

-- Until a visual safety provider is ratified, a successfully extracted cover is
-- retained as restricted analysis evidence but omitted from publication. The
-- song itself may publish; an unsafe cover still blocks the whole submission.
ALTER TABLE media_analysis_evidence
  DROP CONSTRAINT media_analysis_evidence_media_safety_check,
  ADD CONSTRAINT media_analysis_evidence_media_safety_check CHECK (
    media_safety IN (
      'not_applicable',
      'allow',
      'visual_provider_unavailable',
      'draft',
      'review_required',
      'blocked'
    )
  );

DO $migration$
DECLARE definition TEXT; patched TEXT;
BEGIN
  SELECT pg_get_functiondef('guard_media_submission_update()'::regprocedure) INTO definition;
  patched := replace(
    definition,
    'analysis_record.media_safety NOT IN (''allow'', ''not_applicable'')',
    'analysis_record.media_safety NOT IN (''allow'', ''not_applicable'', ''visual_provider_unavailable'')'
  );
  patched := replace(
    patched,
    'analysis_record.media_safety <> ''allow''',
    'analysis_record.media_safety NOT IN (''allow'', ''visual_provider_unavailable'')'
  );
  IF patched = definition THEN
    RAISE EXCEPTION 'guard_media_submission_update media-safety predicate was not found';
  END IF;
  EXECUTE patched;

  SELECT pg_get_functiondef('validate_media_snapshot_insert()'::regprocedure) INTO definition;
  patched := replace(
    definition,
    'ARRAY[''analysisRevision'',''audioRevision'',''canonicalAudioSha256'',''creationRevision'',''decisionRevision'',''evidenceRef'',''outcome'',''policyRevision'']::TEXT[]',
    'ARRAY[''analysisRevision'',''audioRevision'',''canonicalAudioSha256'',''contentRating'',''creationRevision'',''decisionRevision'',''evidenceRef'',''outcome'',''policyRevision'']::TEXT[]'
  );
  patched := replace(
    patched,
    'OR jsonb_typeof(NEW.decision_snapshot->''evidenceRef'') IS DISTINCT FROM ''string'' THEN',
    'OR jsonb_typeof(NEW.decision_snapshot->''evidenceRef'') IS DISTINCT FROM ''string''
       OR NEW.decision_snapshot->>''contentRating'' NOT IN (''general'', ''adult_18'') THEN'
  );
  IF patched = definition THEN
    RAISE EXCEPTION 'decision snapshot rating predicate was not found';
  END IF;
  EXECUTE patched;

  SELECT pg_get_functiondef(
    'validate_media_publication_projection_insert_v2()'::regprocedure
  ) INTO definition;
  patched := replace(
    definition,
    '(CASE WHEN analysis_record.cover_status=''ready'' THEN analysis_record.cover_artifact_ref ELSE NULL END)',
    '(CASE WHEN analysis_record.cover_status=''ready'' AND analysis_record.media_safety=''allow'' THEN analysis_record.cover_artifact_ref ELSE NULL END)'
  );
  IF patched = definition THEN
    RAISE EXCEPTION 'publication projection cover predicate was not found';
  END IF;
  EXECUTE patched;
END;
$migration$;
