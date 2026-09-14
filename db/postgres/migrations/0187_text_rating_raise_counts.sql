-- Preserve the helper's changed-row contract after current rating floors began
-- cascading a parent raise before the helper's descendant update executes.
CREATE OR REPLACE FUNCTION raise_text_rating_with_descendants_v1(
  target_community_id TEXT,
  target_kind TEXT,
  target_resource_id TEXT,
  transition_at TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  changed_count INTEGER := 0;
BEGIN
  IF target_kind = 'text_post' THEN
    SELECT
      (SELECT count(*) FROM posts
        WHERE community_id = target_community_id
          AND post_id = target_resource_id
          AND post_type = 'text'
          AND content_rating <> 'adult_18')
      +
      (SELECT count(*) FROM comments
        WHERE community_id = target_community_id
          AND post_id = target_resource_id
          AND content_rating <> 'adult_18')
      INTO changed_count;

    UPDATE posts
       SET content_rating = 'adult_18', updated_at = transition_at
     WHERE community_id = target_community_id
       AND post_id = target_resource_id
       AND post_type = 'text'
       AND content_rating <> 'adult_18';

    UPDATE comments
       SET content_rating = 'adult_18', updated_at = transition_at
     WHERE community_id = target_community_id
       AND post_id = target_resource_id
       AND content_rating <> 'adult_18';
  ELSIF target_kind IN ('comment', 'reply') THEN
    WITH RECURSIVE descendants AS (
      SELECT comment_id
        FROM comments
       WHERE community_id = target_community_id
         AND comment_id = target_resource_id
      UNION ALL
      SELECT child.comment_id
        FROM comments AS child
        JOIN descendants AS parent ON parent.comment_id = child.parent_comment_id
       WHERE child.community_id = target_community_id
    )
    SELECT count(*) INTO changed_count
      FROM comments AS comment
      JOIN descendants ON descendants.comment_id = comment.comment_id
     WHERE comment.community_id = target_community_id
       AND comment.content_rating <> 'adult_18';

    WITH RECURSIVE descendants AS (
      SELECT comment_id
        FROM comments
       WHERE community_id = target_community_id
         AND comment_id = target_resource_id
      UNION ALL
      SELECT child.comment_id
        FROM comments AS child
        JOIN descendants AS parent ON parent.comment_id = child.parent_comment_id
       WHERE child.community_id = target_community_id
    )
    UPDATE comments AS comment
       SET content_rating = 'adult_18', updated_at = transition_at
      FROM descendants
     WHERE comment.community_id = target_community_id
       AND comment.comment_id = descendants.comment_id
       AND comment.content_rating <> 'adult_18';
  ELSE
    RAISE EXCEPTION 'unsupported text rating target kind';
  END IF;

  UPDATE comment_publication_projection AS projection
     SET content_rating = comment.content_rating, updated_at = transition_at
    FROM comments AS comment
   WHERE projection.community_id = target_community_id
     AND comment.community_id = projection.community_id
     AND comment.comment_id = projection.comment_id
     AND projection.content_rating IS DISTINCT FROM comment.content_rating;
  RETURN changed_count;
END;
$$;
