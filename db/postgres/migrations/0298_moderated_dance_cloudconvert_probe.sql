-- Future captures select this route through immutable v2 profile terms. Keep
-- every existing v1/unknown Qencode identity and the original consumed grant.
CREATE OR REPLACE FUNCTION capture_moderated_dance_attempt_provider_effects_v1() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s dance_moderated_sessions_v1; cloudconvert_probe BOOLEAN;
BEGIN
 SELECT session.* INTO STRICT s FROM dance_moderated_sessions_v1 session
 JOIN dance_moderated_uploads_v1 upload USING(session_id) WHERE upload.upload_id=NEW.upload_id;
 cloudconvert_probe:=(s.terms->'profile'->>'mediaRuntimeRevision'='dance-moderated-media-v2');
 IF NEW.probe_phase<>'unclaimed' THEN
  PERFORM register_moderated_dance_provider_effect_v1(NEW.upload_id,NULL,'probe',
   CASE WHEN cloudconvert_probe THEN 'cloudconvert' ELSE 'qencode' END,
   CASE WHEN cloudconvert_probe THEN 'private-probe-'||NEW.upload_id ELSE NULL END,
   NEW.probe_attempt->>'providerJobId',s.terms_hash,NEW.provider_deadline,s.terms->'disposition',s.terms->'profile');
 END IF;
 IF NEW.normalization_claimed_at IS NOT NULL THEN
  PERFORM register_moderated_dance_provider_effect_v1(NEW.upload_id,NULL,'normalization','cloudconvert',NEW.provider_tag,NEW.provider_job_id,
   s.terms_hash,NEW.provider_deadline,s.terms->'disposition',s.terms->'profile');
 END IF;
 RETURN NEW;
END $$;

-- Every fresh inner grant repeats the account erasure/lifecycle fence. The
-- outer work claim alone cannot authorize egress after a later erasure commit.
CREATE FUNCTION lock_moderated_dance_processing_authority_v1(p_upload TEXT)
 RETURNS dance_moderated_processing_v1 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE actor_id TEXT; s dance_moderated_sessions_v1; f dance_review_account_fences_v1;
 work dance_moderated_processing_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT session.account_id INTO STRICT actor_id FROM dance_moderated_sessions_v1 session
 JOIN dance_moderated_uploads_v1 upload USING(session_id) WHERE upload.upload_id=p_upload;
 PERFORM 1 FROM users WHERE user_id=actor_id AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'processing account unavailable' USING ERRCODE='DRV05'; END IF;
 SELECT fence.* INTO STRICT f FROM dance_review_account_fences_v1 fence WHERE fence.account_id=actor_id FOR UPDATE;
 SELECT session.* INTO STRICT s FROM dance_moderated_sessions_v1 session
 JOIN dance_moderated_uploads_v1 upload USING(session_id) WHERE upload.upload_id=p_upload FOR UPDATE OF session;
 PERFORM 1 FROM dance_moderated_uploads_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 IF NOT active_activity_persona(s.account_id,s.persona_id,s.community_id) THEN
  RAISE EXCEPTION 'processing persona changed' USING ERRCODE='DRV05';
 END IF;
 IF f.erasing OR f.revision<>s.capture_account_fence OR f.revision<>work.account_fence
 OR work.state NOT IN('claimed','unknown') OR least(work.provider_deadline,s.expires_at)<=clock_timestamp() THEN
  RAISE EXCEPTION 'processing lifecycle changed' USING ERRCODE='DRV05';
 END IF;
 RETURN work;
END $$;

CREATE OR REPLACE FUNCTION claim_moderated_dance_probe_v1(p_upload TEXT,p_token TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; fresh BOOLEAN:=FALSE;
BEGIN
 work:=lock_moderated_dance_processing_authority_v1(p_upload);
 IF work.observation_token IS DISTINCT FROM p_token THEN RAISE EXCEPTION 'probe authority changed' USING ERRCODE='DRV05'; END IF;
 IF work.probe_phase='unclaimed' THEN
  fresh:=TRUE;
  UPDATE dance_moderated_processing_v1 SET probe_phase='allocating',probe_attempt=jsonb_build_object('version','media-transform-attempt-v1','runtimeFence',jsonb_build_object('submittedAtMs',floor(extract(epoch FROM work.dispatched_at)*1000)::BIGINT,'runtimeDeadlineMs',floor(extract(epoch FROM work.provider_deadline)*1000)::BIGINT)) WHERE upload_id=p_upload RETURNING * INTO work;
 ELSIF work.probe_phase='allocated' THEN
  fresh:=TRUE;
  UPDATE dance_moderated_processing_v1 SET probe_phase='submitting',probe_attempt=probe_attempt||jsonb_build_object('providerJobPhase','submitting') WHERE upload_id=p_upload RETURNING * INTO work;
 END IF;
 RETURN jsonb_build_object('fresh',fresh,'phase',work.probe_phase,'attempt',work.probe_attempt,'probe',work.probe_result);
END $$;
CREATE OR REPLACE FUNCTION claim_moderated_dance_normalization_v1(p_upload TEXT,p_token TEXT) RETURNS BOOLEAN
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1;
BEGIN
 work:=lock_moderated_dance_processing_authority_v1(p_upload);
 IF work.observation_token IS DISTINCT FROM p_token OR work.probe_phase<>'complete' THEN RAISE EXCEPTION 'normalization authority changed' USING ERRCODE='DRV05'; END IF;
 IF work.normalization_claimed_at IS NOT NULL THEN RETURN FALSE; END IF;
 UPDATE dance_moderated_processing_v1 SET normalization_claimed_at=clock_timestamp() WHERE upload_id=p_upload;
 RETURN TRUE;
END $$;

-- CREATE OR REPLACE retains the existing private ACL. Reassert the trusted
-- search path; no new role, EXECUTE grant, public route or operational policy.
DO $harden$
DECLARE f RECORD; grantee RECORD;
BEGIN
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace
 AND p.proname IN('capture_moderated_dance_attempt_provider_effects_v1','lock_moderated_dance_processing_authority_v1','claim_moderated_dance_probe_v1','claim_moderated_dance_normalization_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,current_schema());
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  IF f.oid='lock_moderated_dance_processing_authority_v1(text)'::regprocedure THEN
   FOR grantee IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(0,f.proowner) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,grantee.name);
   END LOOP;
  END IF;
 END LOOP;
END $harden$;
