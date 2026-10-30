-- The moderation action was inserted in this transaction and is append-only.
-- Its exact identity/evidence predicates suffice; FOR SHARE additionally needs
-- UPDATE privilege that the serving role must not have on immutable receipts.
-- Preserve the active rating guard and every other authority/concurrency check.
DO $migration$
DECLARE
  target regprocedure := 'guard_media_submission_update_rating_v2()'::regprocedure;
  body text;
  definition text;
  locked_read text := 'SELECT * INTO moderation_action FROM media_moderation_actions WHERE action_id=NEW.moderator_action_id AND community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;';
BEGIN
  SELECT prosrc,pg_get_functiondef(oid) INTO body,definition
    FROM pg_proc WHERE oid=target AND NOT prosecdef;
  IF body IS NULL OR
     encode(sha256(convert_to(body,'UTF8')),'hex') <> 'e40a5726dc0e828a12a8af55aaa473ce1eb401bde36dfa9b35304b022f4761f6' OR
     (length(body)-length(replace(body,locked_read,''))) <> length(locked_read) OR
     NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid='media_post_submissions'::regclass
          AND tgname='media_song_submission_update_guard' AND tgfoid=target
     ) THEN
    RAISE EXCEPTION 'active song moderation guard source is not recognized exactly';
  END IF;
  EXECUTE replace(definition,locked_read,replace(locked_read,' FOR SHARE',''));
END;
$migration$;
