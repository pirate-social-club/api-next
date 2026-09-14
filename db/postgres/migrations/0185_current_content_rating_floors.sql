-- Current read floors are monotonic; historical decisions remain immutable.
CREATE FUNCTION enforce_current_content_rating_floor_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_rating text;
BEGIN
  IF TG_OP='UPDATE' AND OLD.content_rating='adult_18'
     AND NEW.content_rating IS DISTINCT FROM 'adult_18' THEN
    RAISE EXCEPTION 'current content rating cannot be lowered' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='comments' THEN
    SELECT content_rating INTO parent_rating FROM posts
      WHERE community_id=NEW.community_id AND post_id=NEW.post_id FOR SHARE;
    IF parent_rating='adult_18' THEN NEW.content_rating:='adult_18'; END IF;
    IF NEW.parent_comment_id IS NOT NULL THEN
      SELECT content_rating INTO parent_rating FROM comments
        WHERE community_id=NEW.community_id AND comment_id=NEW.parent_comment_id FOR SHARE;
      IF parent_rating='adult_18' THEN NEW.content_rating:='adult_18'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER comments_text_rating_ancestry_v1 ON comments;
CREATE TRIGGER comments_current_rating_floor_v2 BEFORE INSERT OR UPDATE OF
  community_id,post_id,parent_comment_id,content_rating ON comments
  FOR EACH ROW EXECUTE FUNCTION enforce_current_content_rating_floor_v2();
CREATE TRIGGER posts_current_rating_floor_v2 BEFORE UPDATE OF content_rating ON posts
  FOR EACH ROW EXECUTE FUNCTION enforce_current_content_rating_floor_v2();

CREATE FUNCTION cascade_current_content_rating_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_rating IS DISTINCT FROM 'adult_18' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='posts' THEN
    UPDATE comments SET content_rating='adult_18',updated_at=GREATEST(updated_at,NEW.updated_at)
      WHERE community_id=NEW.community_id AND post_id=NEW.post_id AND content_rating<>'adult_18';
    UPDATE media_post_submissions s SET resulting_content_rating='adult_18'
      FROM media_publication_projections p
      WHERE p.community_id=NEW.community_id AND p.post_id=NEW.post_id
        AND s.submission_id=p.submission_id AND s.resulting_content_rating<>'adult_18';
    UPDATE media_publication_projections SET content_rating='adult_18'
      WHERE community_id=NEW.community_id AND post_id=NEW.post_id AND content_rating<>'adult_18';
    UPDATE posts video SET content_rating='adult_18',updated_at=GREATEST(video.updated_at,NEW.updated_at)
      FROM media_video_song_references r JOIN media_post_submissions s ON s.submission_id=r.submission_id
      WHERE r.song_community_id=NEW.community_id AND r.song_post_id=NEW.post_id
        AND video.community_id=s.community_id AND video.post_id=r.post_id AND video.content_rating<>'adult_18';
  ELSE
    UPDATE comments SET content_rating='adult_18',updated_at=GREATEST(updated_at,NEW.updated_at)
      WHERE community_id=NEW.community_id AND parent_comment_id=NEW.comment_id AND content_rating<>'adult_18';
    UPDATE comment_publication_projection SET content_rating='adult_18',updated_at=GREATEST(updated_at,NEW.updated_at)
      WHERE community_id=NEW.community_id AND comment_id=NEW.comment_id AND content_rating<>'adult_18';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER posts_current_rating_cascade_v2 AFTER UPDATE OF content_rating ON posts
  FOR EACH ROW WHEN (OLD.content_rating IS DISTINCT FROM NEW.content_rating)
  EXECUTE FUNCTION cascade_current_content_rating_v2();
CREATE TRIGGER comments_current_rating_cascade_v2 AFTER UPDATE OF content_rating ON comments
  FOR EACH ROW WHEN (OLD.content_rating IS DISTINCT FROM NEW.content_rating)
  EXECUTE FUNCTION cascade_current_content_rating_v2();

-- Rating-only repairs preserve all transition and identity fields. The generated
-- account alias is excluded because PostgreSQL computes NEW generated fields
-- after BEFORE triggers; its source actor_user_id remains in the exact comparison.
CREATE FUNCTION is_current_media_rating_raise_v2(previous media_post_submissions, following media_post_submissions)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT previous.resulting_content_rating='general' AND following.resulting_content_rating='adult_18'
    AND (to_jsonb(previous)-ARRAY['resulting_content_rating','actor_account_id'])
      =(to_jsonb(following)-ARRAY['resulting_content_rating','actor_account_id']);
$$;

-- Preserve each original guard as history and derive a named successor whose
-- only additional path is the exact monotonic current-floor repair above.
DO $$
DECLARE original_name text; successor_name text; body text; boundary integer;
BEGIN
  FOREACH original_name IN ARRAY ARRAY['guard_media_submission_update','guard_media_video_submission_update'] LOOP
    successor_name := original_name || '_rating_v2';
    SELECT prosrc INTO body FROM pg_proc WHERE oid=(original_name || '()')::regprocedure AND NOT prosecdef;
    boundary := strpos(body,E'\nBEGIN\n');
    IF body IS NULL OR boundary=0 THEN RAISE EXCEPTION 'current-rating guard source is not recognized'; END IF;
    body := overlay(body placing E'\nBEGIN\n  IF is_current_media_rating_raise_v2(OLD,NEW) THEN RETURN NEW; END IF;\n'
      from boundary for length(E'\nBEGIN\n'));
    EXECUTE format('CREATE FUNCTION %I() RETURNS trigger LANGUAGE plpgsql AS %L',successor_name,body);
  END LOOP;
END;
$$;
DROP TRIGGER media_song_submission_update_guard ON media_post_submissions;
CREATE TRIGGER media_song_submission_update_guard BEFORE UPDATE ON media_post_submissions FOR EACH ROW WHEN (((old.media_kind = 'song'::text) AND (NOT (new.current_lyrics_revision IS DISTINCT FROM old.current_lyrics_revision)) AND (NOT (new.workflow_replacement_sequence IS DISTINCT FROM old.workflow_replacement_sequence)) AND (NOT (((old.status = 'processing'::text) AND (old.phase = 'awaiting_upload'::text) AND (new.status = 'processing'::text) AND (new.phase = 'finalize'::text)) OR ((old.status = 'processing'::text) AND (old.phase = 'finalize'::text) AND (new.status = 'processing'::text) AND (new.phase = 'analysis'::text) AND (new.audio_revision = (old.audio_revision + 1))))))) EXECUTE FUNCTION guard_media_submission_update_rating_v2();
DROP TRIGGER media_video_submission_update_guard ON media_post_submissions;
CREATE TRIGGER media_video_submission_update_guard BEFORE UPDATE ON media_post_submissions FOR EACH ROW WHEN ((old.media_kind = 'video'::text)) EXECUTE FUNCTION guard_media_video_submission_update_rating_v2();

DROP TRIGGER media_submission_event_pair ON media_post_submissions;
CREATE CONSTRAINT TRIGGER media_submission_event_pair AFTER UPDATE ON media_post_submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((((new.media_kind = 'song'::text) AND (NOT (new.current_lyrics_revision IS DISTINCT FROM old.current_lyrics_revision)) AND (NOT (new.workflow_replacement_sequence IS DISTINCT FROM old.workflow_replacement_sequence)) AND (NOT ((old.status = 'processing'::text) AND (old.phase = 'publish'::text) AND (new.status = 'published'::text))) AND (NOT (((old.status = 'processing'::text) AND (old.phase = 'awaiting_upload'::text) AND (new.status = 'processing'::text) AND (new.phase = 'finalize'::text)) OR ((old.status = 'processing'::text) AND (old.phase = 'finalize'::text) AND (new.status = 'processing'::text) AND (new.phase = 'analysis'::text) AND (new.audio_revision = (old.audio_revision + 1))))))) AND NOT is_current_media_rating_raise_v2(OLD,NEW)) EXECUTE FUNCTION validate_media_submission_event_pair();
