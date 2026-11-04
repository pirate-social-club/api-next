-- Account Karaoke cancellation before any archive I/O. The attempt host closes
-- an unclaimed registered upload when the learner stops before the first audio
-- frame. 0262 left that host calling the generic private closure, which takes
-- an upload ID alone and binds no Karaoke account, capture or generation, so
-- the serving role cannot be granted it without widening its authority. This
-- additive entry point admits only the genuine captured account Karaoke upload
-- and keeps the generic closure owner-only. Applied migrations are unchanged.

CREATE FUNCTION cancel_unclaimed_account_karaoke_audio_private_v1(
 p_account TEXT,p_session TEXT,p_attempt TEXT,p_artifact TEXT,p_capture JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT;
BEGIN
 -- Same account audio group lock and exact account/session/attempt/artifact
 -- lookup as the attempt host's capture read. Study, guest and other accounts'
 -- captures have no matching Karaoke row and refuse.
 IF p_capture IS NULL
  OR read_account_karaoke_audio_capture_private_v1(p_account,p_session,p_attempt,p_artifact) IS DISTINCT FROM p_capture
 THEN RAISE EXCEPTION 'Karaoke capture differs'; END IF;
 -- Exact immutable capture generation: owner, key and captured revision.
 upload_id:=require_captured_learner_audio_private_v1(p_capture);
 -- Mandatory claim takes the same source lock and upload row lock. Only a
 -- registered upload with no storage I/O closes; writing, unknown and closed
 -- producers answer false and change nothing.
 RETURN close_unclaimed_learner_audio_private_v1(upload_id);
END $$;

DO $pin_account_karaoke_unclaimed_cancellation$
DECLARE signature TEXT:='cancel_unclaimed_account_karaoke_audio_private_v1(text,text,text,text,jsonb)';
 namespace_id OID; owner_id OID; schema_name TEXT; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure
  AND f.pronamespace=namespace_id AND f.proowner=owner_id) THEN RAISE EXCEPTION 'Karaoke function provenance differs'; END IF;
 EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
  CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
  WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 -- No role grant inferred. The serving role's EXECUTE is the separately
 -- reviewed incremental block in db/postgres/roles.sql.example.
END $pin_account_karaoke_unclaimed_cancellation$;
