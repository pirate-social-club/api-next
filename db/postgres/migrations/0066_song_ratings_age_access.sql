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
  ADD COLUMN resulting_content_rating TEXT
    CHECK (resulting_content_rating IN ('general', 'adult_18'));

ALTER TABLE media_publication_projections
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility = 'public'),
  ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'general'
    CHECK (content_rating IN ('general', 'adult_18'));

UPDATE media_post_submissions AS submission
   SET resulting_content_rating = post.content_rating
  FROM posts AS post
 WHERE post.community_id = submission.community_id
   AND post.post_id = submission.post_id
   AND submission.status = 'published';

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
