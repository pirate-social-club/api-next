-- The publication trigger owns initial private policy rows. The runtime can
-- publish the guarded projection but cannot write the policy ledgers directly.
-- Preserve the initializer body and validate the installed owner/trigger before
-- elevating it. Existing publications and policies are not rewritten.
DO $validate_song_policy_initializer_provenance$
DECLARE
  schema_name TEXT := current_schema();
  namespace_id OID;
  schema_owner OID;
  publication_owner OID;
  initializer_oid OID;
BEGIN
  SELECT oid,nspowner INTO namespace_id,schema_owner
    FROM pg_namespace WHERE nspname=schema_name;
  SELECT relowner INTO publication_owner FROM pg_class
    WHERE relnamespace=namespace_id AND relname='media_publication_projections';
  SELECT oid INTO initializer_oid FROM pg_proc
    WHERE pronamespace=namespace_id AND proname='initialize_song_owner_policy_v1'
      AND pronargs=0 AND prorettype='trigger'::regtype AND proowner=publication_owner;
  IF initializer_oid IS NULL
    OR NOT pg_has_role(publication_owner,schema_owner,'USAGE')
    OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relnamespace=namespace_id AND c.relname='media_publication_projections'
      AND c.relowner=publication_owner
      AND t.tgname='media_publication_song_owner_policy_initialize'
      AND t.tgfoid=initializer_oid AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'song owner policy initializer provenance differs';
  END IF;
END $validate_song_policy_initializer_provenance$;

CREATE OR REPLACE FUNCTION initialize_song_owner_policy_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  publication_post posts%ROWTYPE;
  song_terms media_submission_terms%ROWTYPE;
  initial_derivative_video TEXT;
  initial_hash TEXT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_OP IS DISTINCT FROM 'INSERT'
    OR TG_WHEN IS DISTINCT FROM 'AFTER'
    OR TG_LEVEL IS DISTINCT FROM 'ROW'
    OR TG_TABLE_SCHEMA IS DISTINCT FROM current_schema()
    OR TG_RELID IS DISTINCT FROM to_regclass(
      format('%I.media_publication_projections', current_schema())
    )
  THEN
    RAISE EXCEPTION 'song owner policy initialization requires the canonical publication trigger';
  END IF;

  SELECT * INTO publication_post
    FROM posts
   WHERE community_id = NEW.community_id
     AND post_id = NEW.post_id
   FOR SHARE;
  IF publication_post.post_id IS NULL THEN
    RAISE EXCEPTION 'song owner policy requires a canonical Post';
  END IF;
  IF publication_post.post_type <> 'song' THEN
    RETURN NEW;
  END IF;
  IF publication_post.status <> 'published'
    OR publication_post.author_user_id IS DISTINCT FROM NEW.actor_account_id
  THEN
    RAISE EXCEPTION 'song owner policy requires the canonical published song owner';
  END IF;

  SELECT * INTO song_terms
    FROM media_submission_terms
   WHERE submission_id = NEW.submission_id
     AND community_id = NEW.community_id
     AND actor_user_id = NEW.actor_account_id
     AND operation_id = NEW.operation_id
     AND creation_revision = NEW.creation_revision
   FOR SHARE;
  IF song_terms.submission_id IS NULL THEN
    RAISE EXCEPTION 'song owner policy requires immutable publication terms';
  END IF;

  initial_derivative_video := CASE song_terms.license_preset
    WHEN 'commercial-remix' THEN 'allowed'
    WHEN 'non-commercial' THEN 'allowed'
    WHEN 'commercial-use' THEN 'owner_only'
    ELSE NULL
  END;
  IF initial_derivative_video IS NULL THEN
    RAISE EXCEPTION 'song owner policy license preset is unsupported';
  END IF;

  initial_hash := song_owner_policy_hash_v1(
    NEW.community_id,
    NEW.post_id,
    NEW.audio_revision,
    NEW.actor_account_id,
    1,
    'allowed',
    'allowed',
    initial_derivative_video
  );

  INSERT INTO song_owner_policy_revisions (
    community_id,
    post_id,
    audio_revision,
    owner_account_id,
    policy_revision,
    third_party_reward_legs,
    pool_leg,
    derivative_video,
    policy_hash,
    effective_at
  ) VALUES (
    NEW.community_id,
    NEW.post_id,
    NEW.audio_revision,
    NEW.actor_account_id,
    1,
    'allowed',
    'allowed',
    initial_derivative_video,
    initial_hash,
    database_now
  );

  INSERT INTO song_owner_policies (
    community_id,
    post_id,
    audio_revision,
    owner_account_id,
    current_policy_revision,
    current_policy_hash,
    created_at,
    updated_at
  ) VALUES (
    NEW.community_id,
    NEW.post_id,
    NEW.audio_revision,
    NEW.actor_account_id,
    1,
    initial_hash,
    database_now,
    database_now
  );
  RETURN NEW;
END;
$$;

DO $seal_song_policy_initializer$
DECLARE
  schema_name TEXT := current_schema();
  initializer_oid OID := 'initialize_song_owner_policy_v1()'::regprocedure;
  grantee_name TEXT;
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.initialize_song_owner_policy_v1() SET search_path TO %I,pg_catalog,pg_temp',
    schema_name,schema_name
  );
  EXECUTE format('REVOKE ALL ON FUNCTION %I.initialize_song_owner_policy_v1() FROM PUBLIC',schema_name);
  FOR grantee_name IN
    SELECT DISTINCT pg_get_userbyid(a.grantee)
    FROM pg_proc f
    CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
    WHERE f.oid=initializer_oid AND a.grantee<>0 AND a.grantee<>f.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.initialize_song_owner_policy_v1() FROM %I',schema_name,grantee_name);
  END LOOP;
END $seal_song_policy_initializer$;
