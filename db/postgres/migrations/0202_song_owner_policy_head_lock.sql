-- Reward authority must hold the song owner-policy head steady while it freezes
-- offer and leg terms, so a policy revision cannot interleave. SELECT ... FOR
-- SHARE needs UPDATE, DELETE or TRUNCATE privilege, and the runtime role holds
-- only SELECT on song_owner_policies: the head changes solely through
-- append_song_owner_policy_revision_v1. This routine takes the share lock on
-- one head row by primary key on the runtime's behalf and returns it; the lock
-- lasts until the calling transaction ends.
CREATE FUNCTION lock_song_owner_policy_head_v1(
  input_community_id TEXT,
  input_post_id TEXT
) RETURNS TABLE (
  owner_account_id TEXT,
  audio_revision BIGINT,
  current_policy_revision BIGINT,
  current_policy_hash TEXT
)
LANGUAGE SQL
VOLATILE
STRICT
AS $$
  SELECT head.owner_account_id, head.audio_revision,
         head.current_policy_revision, head.current_policy_hash
    FROM song_owner_policies AS head
   WHERE head.community_id = input_community_id
     AND head.post_id = input_post_id
     FOR SHARE
$$;

ALTER FUNCTION lock_song_owner_policy_head_v1(TEXT, TEXT) SECURITY DEFINER;

DO $$
DECLARE
  installed_schema TEXT := current_schema();
BEGIN
  IF installed_schema IS NULL THEN
    RAISE EXCEPTION 'song owner policy head lock migration requires a current schema';
  END IF;
  EXECUTE format(
    'ALTER FUNCTION %I.lock_song_owner_policy_head_v1(text,text) SET search_path TO %I, pg_temp',
    installed_schema,
    installed_schema
  );
END;
$$;

REVOKE ALL ON FUNCTION lock_song_owner_policy_head_v1(TEXT, TEXT) FROM PUBLIC;
