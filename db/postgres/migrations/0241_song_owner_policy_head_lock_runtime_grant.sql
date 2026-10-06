-- 0202 created lock_song_owner_policy_head_v1, revoked it from PUBLIC and left
-- the runtime grant to roles.sql.example. A database whose role file was not
-- re-applied after 0202 therefore refuses the first reward offer with 42501.
-- Reward authority cannot freeze offer or leg terms without this lock, so the
-- grant travels with the schema. It adds no other privilege.
DO $song_owner_policy_head_lock_runtime_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_next_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION lock_song_owner_policy_head_v1(text,text) TO api_next_app';
  END IF;
END;
$song_owner_policy_head_lock_runtime_grant$;
