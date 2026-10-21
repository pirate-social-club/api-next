-- SOURCE ONLY. Durable private sealing/processing authority; no provider or role
-- activation. Unknown dispatches never regain a fresh execution authorization.
ALTER TABLE dance_moderated_processing_v1 ADD COLUMN probe_phase TEXT NOT NULL DEFAULT 'unclaimed' CHECK(probe_phase IN('unclaimed','allocating','allocated','submitting','started','complete','unknown')),
 ADD COLUMN probe_attempt JSONB, ADD COLUMN probe_result JSONB,
 ADD COLUMN normalization_claimed_at TIMESTAMPTZ,
 ADD COLUMN observation_token TEXT,
 ADD COLUMN observation_until TIMESTAMPTZ, ADD COLUMN provider_deadline TIMESTAMPTZ;
CREATE TABLE dance_moderated_source_grants_v1 (
 capability_sha256 TEXT PRIMARY KEY CHECK(capability_sha256~'^[a-f0-9]{64}$'),
 upload_id TEXT NOT NULL REFERENCES dance_moderated_uploads_v1, work_token TEXT NOT NULL,
 object_identity JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), CHECK(expires_at>created_at)
);
CREATE TABLE dance_moderated_frame_artifacts_v1 (
 upload_id TEXT NOT NULL REFERENCES dance_moderated_uploads_v1, frame_index INTEGER NOT NULL CHECK(frame_index BETWEEN 0 AND 2),
 object_identity JSONB NOT NULL, sha256 TEXT NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 timestamp_ms BIGINT NOT NULL CHECK(timestamp_ms>=0), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(upload_id,frame_index)
);
CREATE TABLE dance_moderated_provider_calls_v1 (
 upload_id TEXT NOT NULL REFERENCES dance_moderated_uploads_v1, purpose TEXT NOT NULL CHECK(purpose IN('frame:0','frame:1','frame:2')),
 request_hash TEXT NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'), claim_token TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN('sending','succeeded','failed')), result JSONB,
 dispatched_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), completed_at TIMESTAMPTZ,
 PRIMARY KEY(upload_id,purpose), CHECK((state='sending')=(result IS NULL AND completed_at IS NULL))
);
CREATE TABLE dance_moderated_safety_evidence_v1 (
 upload_id TEXT PRIMARY KEY REFERENCES dance_moderated_uploads_v1, input_digest TEXT NOT NULL CHECK(input_digest~'^[a-f0-9]{64}$'),
 evidence JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE dance_moderated_replay_claims_v1 (
 scope TEXT NOT NULL, key_epoch TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('raw','body')),
 digest TEXT NOT NULL CHECK(digest~'^[a-f0-9]{64}$'), source_kind TEXT NOT NULL CHECK(source_kind IN('reference','attempt')),
 source_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope,key_epoch,kind,digest), CHECK(expires_at>created_at)
);
CREATE TABLE dance_moderated_media_dispositions_v1 (
 upload_id TEXT NOT NULL REFERENCES dance_moderated_uploads_v1, kind TEXT NOT NULL CHECK(kind IN('ingress','original','derived','provider')),
 identity JSONB NOT NULL, dispose_by TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL CHECK(state IN('pending','running','unknown','completed','held')),
 completed_at TIMESTAMPTZ, PRIMARY KEY(upload_id,kind)
);
CREATE TABLE dance_moderated_provider_usage_v1 (
 scope TEXT NOT NULL, window_start_ms BIGINT NOT NULL, window_ms BIGINT NOT NULL CHECK(window_ms>0),
 charged_microunits NUMERIC(78,0) NOT NULL CHECK(charged_microunits>=0),
 PRIMARY KEY(scope,window_start_ms,window_ms)
);
CREATE FUNCTION moderated_dance_media_runtime_v1() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='dance_moderated_processing_v1'::regclass))
 OR EXISTS(SELECT 1 FROM dance_moderated_runtime_roles_v1 r WHERE r.purpose='media' AND pg_has_role(session_user,r.role_oid,'MEMBER'))
$$;
CREATE FUNCTION announce_moderated_dance_processor_v1(p_runtime TEXT,p_safety TEXT,p_epochs JSONB) RETURNS VOID
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE policy RECORD; now_at TIMESTAMPTZ:=clock_timestamp(); epoch TEXT; until_at TIMESTAMPTZ;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 IF NOT EXISTS(SELECT 1 FROM dance_moderated_maintenance_readiness_v1 WHERE singleton AND observed_at<=now_at AND valid_until>now_at) THEN RETURN; END IF;
 FOR policy IN SELECT p.operational_profile,p.valid_until,a.valid_until admission_until FROM dance_review_policy_versions_v1 p
 JOIN dance_review_policy_admissions_v1 a USING(policy_id) WHERE a.accepted AND a.effective_at<=now_at AND a.valid_until>now_at AND p.valid_from<=now_at AND p.valid_until>now_at
 AND p.operational_profile->>'mediaRuntimeRevision'=p_runtime AND p.operational_profile->>'safetyProviderRevision'=p_safety LOOP
  IF NOT ((policy.operational_profile->'replayCompatibleEpochs')<@p_epochs) THEN CONTINUE; END IF;
  epoch:=policy.operational_profile->>'replayKeyEpoch';
  until_at:=least(policy.valid_until,policy.admission_until,(SELECT valid_until FROM dance_moderated_maintenance_readiness_v1 WHERE singleton),now_at+((policy.operational_profile->>'readinessLeaseMs')::BIGINT*interval '1 millisecond'));
  IF until_at IS NULL OR until_at<=now_at THEN CONTINUE; END IF;
  INSERT INTO dance_moderated_processor_readiness_v1 VALUES(p_runtime,p_safety,epoch,now_at,until_at)
  ON CONFLICT(runtime_revision,safety_revision,replay_epoch) DO UPDATE SET observed_at=EXCLUDED.observed_at,valid_until=EXCLUDED.valid_until;
 END LOOP;
END $$;
CREATE FUNCTION reserve_moderated_dance_provider_work_v1(p_actor TEXT,p_profile JSONB) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE width BIGINT:=(p_profile->>'windowMs')::BIGINT; bucket BIGINT;
 scope_value TEXT; usage NUMERIC; allowed NUMERIC; envelope NUMERIC:=(p_profile->>'maximumProviderSpendMicrounits')::NUMERIC;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() OR width IS NULL OR width<=0 OR envelope IS NULL OR envelope<=0 THEN RAISE EXCEPTION 'media work policy unavailable' USING ERRCODE='DRV07'; END IF;
 bucket:=(floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT/width)*width;
 FOREACH scope_value IN ARRAY ARRAY['account:'||p_actor,'global'] LOOP
  INSERT INTO dance_moderated_provider_usage_v1 VALUES(scope_value,bucket,width,0) ON CONFLICT DO NOTHING;
  SELECT charged_microunits INTO usage FROM dance_moderated_provider_usage_v1 WHERE scope=scope_value AND window_start_ms=bucket AND window_ms=width FOR UPDATE;
  allowed:=CASE WHEN scope_value='global' THEN (p_profile->>'maximumGlobalProviderSpendPerWindow')::NUMERIC ELSE (p_profile->>'maximumAccountProviderSpendPerWindow')::NUMERIC END;
  IF allowed IS NULL OR usage+envelope>allowed THEN RETURN FALSE; END IF;
 END LOOP;
 UPDATE dance_moderated_provider_usage_v1 SET charged_microunits=charged_microunits+envelope WHERE scope IN('account:'||p_actor,'global') AND window_start_ms=bucket AND window_ms=width;
 RETURN TRUE;
END $$;
CREATE FUNCTION guard_moderated_dance_provider_usage_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR ROW(NEW.scope,NEW.window_start_ms,NEW.window_ms) IS DISTINCT FROM ROW(OLD.scope,OLD.window_start_ms,OLD.window_ms) OR NEW.charged_microunits<OLD.charged_microunits THEN RAISE EXCEPTION 'provider work cannot be restored' USING ERRCODE='DRV01'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER moderated_provider_usage_retained BEFORE UPDATE OR DELETE ON dance_moderated_provider_usage_v1 FOR EACH ROW EXECUTE FUNCTION guard_moderated_dance_provider_usage_v1();
CREATE TRIGGER moderated_provider_usage_no_truncate BEFORE TRUNCATE ON dance_moderated_provider_usage_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE FUNCTION claim_moderated_dance_media_v1(p_token TEXT,p_runtime TEXT,p_safety TEXT,p_epochs JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate RECORD; s dance_moderated_sessions_v1; u dance_moderated_uploads_v1; f dance_review_account_fences_v1;
 work dance_moderated_processing_v1; profile JSONB; now_at TIMESTAMPTZ:=clock_timestamp(); action TEXT; bucket BIGINT; width BIGINT; scope_value TEXT; usage NUMERIC; allowed NUMERIC;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT upload.upload_id,session.account_id INTO candidate FROM dance_moderated_uploads_v1 upload JOIN dance_moderated_sessions_v1 session USING(session_id)
 LEFT JOIN dance_moderated_processing_v1 processing USING(upload_id)
 WHERE upload.state IN('sealing','sealed') AND session.state='awaiting_upload' AND session.expires_at>now_at
 AND session.terms->'profile'->>'mediaRuntimeRevision'=p_runtime AND session.terms->'profile'->>'safetyProviderRevision'=p_safety
 AND (session.terms->'profile'->'replayCompatibleEpochs')<@p_epochs
 AND ((upload.seal_dispatched_at IS NULL) OR (processing.state IN('ready','claimed','unknown') AND (processing.observation_until IS NULL OR processing.observation_until<=now_at)))
 ORDER BY upload.reserved_at,upload.upload_id LIMIT 1;
 IF candidate.upload_id IS NULL THEN RETURN NULL; END IF;
 -- Same users/fence/session/upload ordering as intake and erasure. A competing
 -- worker simply gets no work; it never steals an issued provider grant.
 PERFORM 1 FROM users WHERE user_id=candidate.account_id AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO f FROM dance_review_account_fences_v1 WHERE account_id=candidate.account_id FOR UPDATE;
 SELECT session.* INTO s FROM dance_moderated_sessions_v1 session JOIN dance_moderated_uploads_v1 upload USING(session_id) WHERE upload.upload_id=candidate.upload_id FOR UPDATE OF session;
 SELECT * INTO u FROM dance_moderated_uploads_v1 WHERE upload_id=candidate.upload_id FOR UPDATE SKIP LOCKED;
 IF u.upload_id IS NULL OR f.erasing OR f.revision<>s.capture_account_fence OR now_at>=least(u.expires_at,s.expires_at)
 OR NOT active_activity_persona(s.account_id,s.persona_id,s.community_id) THEN RETURN NULL; END IF;
 profile:=s.terms->'profile';
 IF u.seal_dispatched_at IS NULL THEN
  UPDATE dance_moderated_uploads_v1 SET seal_dispatched_at=now_at,seal_token=p_token WHERE upload_id=u.upload_id;
  action:='seal';
 ELSE
  SELECT * INTO work FROM dance_moderated_processing_v1 WHERE upload_id=u.upload_id FOR UPDATE;
  IF work.state NOT IN('ready','claimed','unknown') OR work.observation_until>now_at THEN RETURN NULL; END IF;
  IF work.state='ready' THEN
   IF (profile->>'maximumProviderCalls')::BIGINT<6 OR (profile->>'maximumProviderSpendMicrounits')::NUMERIC<=0 THEN RETURN NULL; END IF;
   IF NOT reserve_moderated_dance_provider_work_v1(s.account_id,profile) THEN RETURN NULL; END IF;
   UPDATE dance_moderated_processing_v1 SET state='claimed',work_token=p_token,provider_tag='dance-'||u.upload_id,
    dispatched_at=now_at,provider_deadline=least(s.expires_at,now_at+((profile->>'providerWaitMs')::BIGINT*interval '1 millisecond')),
    charged_calls=6,charged_spend_microunits=(profile->>'maximumProviderSpendMicrounits')::NUMERIC
   WHERE upload_id=u.upload_id RETURNING * INTO work;
   action:='dispatch';
  ELSE action:='observe';
  END IF;
  IF now_at>=work.provider_deadline THEN RETURN NULL; END IF;
  UPDATE dance_moderated_processing_v1 SET observation_token=p_token,observation_until=least(work.provider_deadline,now_at+((profile->>'workLeaseMs')::BIGINT*interval '1 millisecond')) WHERE upload_id=u.upload_id;
 END IF;
 RETURN jsonb_build_object('action',action,'uploadId',u.upload_id,'token',p_token,'sessionId',s.session_id,'reviewId',s.review_id,
 'accountId',s.account_id,'communityId',s.community_id,'accountFence',f.revision,'terms',s.terms,
 'ingressKey',u.private_object_key,'contentType',u.content_type,'sizeBytes',u.expected_size_bytes,'consentReceiptId',u.consent_receipt_id,
 'consentRecordedAtMs',(SELECT floor(extract(epoch FROM recorded_at)*1000)::BIGINT FROM dance_moderated_consents_v1 WHERE receipt_id=u.consent_receipt_id),
 'reservedAtMs',floor(extract(epoch FROM u.reserved_at)*1000)::BIGINT,
 'source',u.immutable_object_identity,'providerTag',work.provider_tag,'providerJobId',work.provider_job_id,'workToken',work.work_token,
 'providerDeadlineMs',CASE WHEN work.provider_deadline IS NULL THEN NULL ELSE floor(extract(epoch FROM work.provider_deadline)*1000)::BIGINT END);
END $$;
CREATE FUNCTION persist_moderated_dance_seal_v1(p_upload TEXT,p_token TEXT,p_result JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE u dance_moderated_uploads_v1; s dance_moderated_sessions_v1; f dance_review_account_fences_v1; now_at TIMESTAMPTZ:=clock_timestamp(); valid BOOLEAN;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT session.* INTO STRICT s FROM dance_moderated_sessions_v1 session JOIN dance_moderated_uploads_v1 upload USING(session_id) WHERE upload.upload_id=p_upload;
 PERFORM 1 FROM users WHERE user_id=s.account_id FOR UPDATE;
 SELECT * INTO STRICT f FROM dance_review_account_fences_v1 WHERE account_id=s.account_id FOR UPDATE;
 PERFORM 1 FROM dance_moderated_sessions_v1 WHERE session_id=s.session_id FOR UPDATE;
 SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=p_upload FOR UPDATE;
 IF u.seal_token IS DISTINCT FROM p_token OR u.seal_dispatched_at IS NULL THEN RAISE EXCEPTION 'seal authority changed' USING ERRCODE='DRV05'; END IF;
 IF u.immutable_object_identity IS NOT NULL THEN
  IF u.immutable_object_identity IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'seal identity changed' USING ERRCODE='DRV05'; END IF;
  RETURN;
 END IF;
 IF (p_result->>'outcome'='sealed' AND p_result->>'canonical_sha256'~'^[a-f0-9]{64}$' AND (p_result->>'size_bytes')::BIGINT=u.expected_size_bytes
 AND p_result->>'destination_ref'='moderated-dance/originals/'||p_upload||'/source'
 AND length(p_result->>'version')>0 AND length(p_result->>'etag')>0
 AND p_result->'ingress_identity'->>'key'=u.private_object_key
 AND (p_result->'ingress_identity'->>'size')::BIGINT=u.expected_size_bytes
 AND length(p_result->'ingress_identity'->>'version')>0 AND length(p_result->'ingress_identity'->>'etag')>0
 AND (p_result->>'firstStoredAtMs')::NUMERIC>=extract(epoch FROM u.reserved_at)*1000
 AND (p_result->>'firstStoredAtMs')::NUMERIC>=extract(epoch FROM (SELECT recorded_at FROM dance_moderated_consents_v1 WHERE receipt_id=u.consent_receipt_id))*1000
 AND (p_result->>'firstStoredAtMs')::NUMERIC<=extract(epoch FROM now_at)*1000) IS NOT TRUE THEN RAISE EXCEPTION 'seal proof unavailable' USING ERRCODE='DRV06'; END IF;
 valid:=NOT f.erasing AND f.revision=s.capture_account_fence AND now_at<least(u.expires_at,s.expires_at)
 AND EXISTS(SELECT 1 FROM users WHERE user_id=s.account_id AND status='active') AND active_activity_persona(s.account_id,s.persona_id,s.community_id);
 UPDATE dance_moderated_uploads_v1 SET immutable_object_identity=p_result,server_sha256=p_result->>'canonical_sha256',first_stored_at=to_timestamp((p_result->>'firstStoredAtMs')::NUMERIC/1000),bytes_sealed_at=now_at WHERE upload_id=p_upload;
 INSERT INTO dance_moderated_processing_v1(upload_id,state,source_identity,account_fence,work_token,result)
 VALUES(p_upload,CASE WHEN valid THEN 'ready' ELSE 'failed' END,p_result,s.capture_account_fence,CASE WHEN valid THEN NULL ELSE p_token END,CASE WHEN valid THEN NULL ELSE jsonb_build_object('reason','lifecycle_changed') END);
 IF NOT valid THEN UPDATE dance_moderated_sessions_v1 SET state='terminal' WHERE session_id=s.session_id; DELETE FROM dance_moderated_active_slots_v1 WHERE session_id=s.session_id; END IF;
 -- The eventual drain owns exact-object cleanup. A late seal never disappears
 -- from custody because its account/TTL changed during the object write.
 INSERT INTO dance_moderated_media_dispositions_v1(upload_id,kind,identity,dispose_by,state,completed_at,claim_token,observed_result) VALUES(p_upload,'ingress',p_result->'ingress_identity',now_at+((s.terms->'profile'->>'workLeaseMs')::BIGINT*interval '1 millisecond'),'pending',NULL,NULL,NULL) ON CONFLICT(upload_id,kind) DO UPDATE SET identity=EXCLUDED.identity,state='pending' WHERE dance_moderated_media_dispositions_v1.claim_token IS NULL;
 INSERT INTO dance_moderated_media_dispositions_v1(upload_id,kind,identity,dispose_by,state,completed_at) VALUES(p_upload,'original',p_result,least(s.expires_at,now_at+((SELECT disposition_profile->>'cleanupWithinMs' FROM dance_review_policy_versions_v1 WHERE policy_id=s.policy_id)::BIGINT*interval '1 millisecond')),CASE WHEN valid THEN 'held' ELSE 'pending' END,NULL) ON CONFLICT(upload_id,kind) DO UPDATE SET identity=EXCLUDED.identity,state=EXCLUDED.state WHERE dance_moderated_media_dispositions_v1.claim_token IS NULL;
END $$;
CREATE FUNCTION mark_moderated_dance_media_unknown_v1(p_upload TEXT,p_token TEXT,p_phase TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 IF p_phase='seal' THEN UPDATE dance_moderated_uploads_v1 SET state='unknown' WHERE upload_id=p_upload AND seal_token=p_token AND immutable_object_identity IS NULL;
 ELSE UPDATE dance_moderated_processing_v1 SET state='unknown',observation_until=NULL WHERE upload_id=p_upload AND observation_token=p_token AND state IN('claimed','unknown'); END IF;
 -- No release of source custody, work charge, purpose claim or consent.
END $$;
CREATE FUNCTION attach_moderated_dance_provider_v1(p_upload TEXT,p_token TEXT,p_job TEXT,p_tag TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 IF work.observation_token IS DISTINCT FROM p_token OR work.provider_tag IS DISTINCT FROM p_tag OR work.state NOT IN('claimed','unknown')
 OR work.provider_job_id IS NOT NULL AND work.provider_job_id<>p_job OR p_job IS NULL OR btrim(p_job)='' THEN RAISE EXCEPTION 'provider identity changed' USING ERRCODE='DRV05'; END IF;
 UPDATE dance_moderated_processing_v1 SET provider_job_id=p_job,observation_until=NULL WHERE upload_id=p_upload;
END $$;
CREATE FUNCTION issue_moderated_dance_source_v1(p_upload TEXT,p_token TEXT,p_digest TEXT,p_expires_ms BIGINT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; s dance_moderated_sessions_v1; u dance_moderated_uploads_v1; f dance_review_account_fences_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=p_upload;
 SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=u.session_id;
 SELECT * INTO STRICT f FROM dance_review_account_fences_v1 WHERE account_id=s.account_id;
 IF work.observation_token IS DISTINCT FROM p_token OR work.state NOT IN('claimed','unknown') OR work.provider_job_id IS NOT NULL
 OR p_expires_ms IS NULL OR to_timestamp(p_expires_ms::NUMERIC/1000)<=clock_timestamp() OR to_timestamp(p_expires_ms::NUMERIC/1000)>least(work.provider_deadline,s.expires_at)
 OR f.erasing OR f.revision<>work.account_fence OR clock_timestamp()>=least(work.provider_deadline,s.expires_at)
 THEN RAISE EXCEPTION 'private source unavailable' USING ERRCODE='DRV02'; END IF;
 INSERT INTO dance_moderated_source_grants_v1(capability_sha256,upload_id,work_token,object_identity,expires_at)
 VALUES(p_digest,p_upload,work.work_token,u.immutable_object_identity,to_timestamp(p_expires_ms::NUMERIC/1000));
 RETURN jsonb_build_object('expiresAtMs',p_expires_ms);
END $$;
CREATE FUNCTION resolve_moderated_dance_source_v1(p_digest TEXT) RETURNS TABLE(physical_key TEXT,object_version TEXT,etag TEXT,size_bytes BIGINT,content_type TEXT,canonical_sha256 TEXT,expires_at TIMESTAMPTZ,identity_kind TEXT)
 LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT g.object_identity->>'destination_ref',g.object_identity->>'version',g.object_identity->>'etag',(g.object_identity->>'size_bytes')::BIGINT,u.content_type,g.object_identity->>'canonical_sha256',g.expires_at,'upload_version'
 FROM dance_moderated_source_grants_v1 g JOIN dance_moderated_uploads_v1 u USING(upload_id)
 JOIN dance_moderated_sessions_v1 s USING(session_id) JOIN dance_moderated_processing_v1 work USING(upload_id)
 JOIN dance_review_account_fences_v1 f ON f.account_id=s.account_id JOIN users account ON account.user_id=s.account_id
 WHERE g.capability_sha256=p_digest AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
 AND account.status='active' AND NOT f.erasing AND f.revision=s.capture_account_fence AND work.account_fence=f.revision
 AND g.work_token=work.work_token AND work.state IN('claimed','unknown') AND work.provider_deadline>clock_timestamp() AND s.expires_at>clock_timestamp()
$$;
CREATE FUNCTION claim_moderated_dance_probe_v1(p_upload TEXT,p_token TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; fresh BOOLEAN:=FALSE;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 IF work.observation_token IS DISTINCT FROM p_token OR work.state NOT IN('claimed','unknown') OR work.provider_deadline<=clock_timestamp() THEN RAISE EXCEPTION 'probe authority changed' USING ERRCODE='DRV05'; END IF;
 IF work.probe_phase='unclaimed' THEN
  fresh:=TRUE;
  UPDATE dance_moderated_processing_v1 SET probe_phase='allocating',probe_attempt=jsonb_build_object('version','media-transform-attempt-v1','runtimeFence',jsonb_build_object('submittedAtMs',floor(extract(epoch FROM work.dispatched_at)*1000)::BIGINT,'runtimeDeadlineMs',floor(extract(epoch FROM work.provider_deadline)*1000)::BIGINT)) WHERE upload_id=p_upload RETURNING * INTO work;
 ELSIF work.probe_phase='allocated' THEN
  fresh:=TRUE;
  UPDATE dance_moderated_processing_v1 SET probe_phase='submitting',probe_attempt=probe_attempt||jsonb_build_object('providerJobPhase','submitting') WHERE upload_id=p_upload RETURNING * INTO work;
 END IF;
 RETURN jsonb_build_object('fresh',fresh,'phase',work.probe_phase,'attempt',work.probe_attempt,'probe',work.probe_result);
END $$;
CREATE FUNCTION persist_moderated_dance_probe_v1(p_upload TEXT,p_token TEXT,p_result JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; s dance_moderated_sessions_v1; p JSONB; duration_ms BIGINT;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT session.* INTO STRICT s FROM dance_moderated_sessions_v1 session JOIN dance_moderated_uploads_v1 upload USING(session_id) WHERE upload.upload_id=p_upload;
 p:=s.terms->'profile';
 IF work.observation_token IS DISTINCT FROM p_token OR work.provider_deadline<=clock_timestamp()
 OR p_result->'attempt'->'runtimeFence' IS DISTINCT FROM work.probe_attempt->'runtimeFence'
 OR work.probe_attempt ? 'providerJobId' AND p_result->'attempt'->>'providerJobId' IS DISTINCT FROM work.probe_attempt->>'providerJobId' THEN RAISE EXCEPTION 'probe identity changed' USING ERRCODE='DRV05'; END IF;
 IF p_result->>'status'='completed' THEN
  duration_ms:=(p_result->'probe'->>'durationMs')::BIGINT;
  IF work.probe_phase NOT IN('started','submitting') OR (duration_ms>=(s.terms->'capture'->>'bodyEndMs')::BIGINT AND duration_ms<=(s.terms->'capture'->>'bodyEndMs')::BIGINT+(p->>'maximumDurationErrorMs')::BIGINT
   AND (p_result->'probe'->>'hasAudio')::BOOLEAN AND p_result->'probe'->>'audioCodec'='aac' AND p_result->'probe'->>'videoCodec' IN('h264','hevc')
   AND (p_result->'probe'->>'width')::BIGINT>0 AND (p_result->'probe'->>'height')::BIGINT>0
   AND length(p_result->'probe'->>'evidenceRef')>0) IS NOT TRUE THEN RAISE EXCEPTION 'probe media bounds refused' USING ERRCODE='DRV06'; END IF;
  UPDATE dance_moderated_processing_v1 SET probe_phase='complete',probe_result=p_result->'probe',probe_attempt=p_result->'attempt',observation_until=NULL WHERE upload_id=p_upload;
 ELSIF p_result->>'status' IN('submitted','processing') AND p_result->'attempt'->>'providerJobPhase' IN('allocated','started') THEN
  IF (work.probe_phase='allocating' AND p_result->'attempt'->>'providerJobPhase'='allocated' OR work.probe_phase='submitting' AND p_result->'attempt'->>'providerJobPhase'='started' OR work.probe_phase='started' AND p_result->'attempt'->>'providerJobPhase'='started') IS NOT TRUE
   OR length(p_result->'attempt'->>'providerJobId') IS NULL OR length(p_result->'attempt'->>'providerJobId')<1 THEN RAISE EXCEPTION 'probe transition refused' USING ERRCODE='DRV05'; END IF;
  UPDATE dance_moderated_processing_v1 SET probe_phase=p_result->'attempt'->>'providerJobPhase',probe_attempt=p_result->'attempt',observation_until=NULL WHERE upload_id=p_upload;
 ELSE
  UPDATE dance_moderated_processing_v1 SET probe_phase='unknown',observation_until=NULL WHERE upload_id=p_upload;
 END IF;
END $$;
CREATE FUNCTION claim_moderated_dance_normalization_v1(p_upload TEXT,p_token TEXT) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 IF work.observation_token IS DISTINCT FROM p_token OR work.probe_phase<>'complete' OR work.provider_deadline<=clock_timestamp() THEN RAISE EXCEPTION 'normalization authority changed' USING ERRCODE='DRV05'; END IF;
 IF work.normalization_claimed_at IS NOT NULL THEN RETURN FALSE; END IF;
 UPDATE dance_moderated_processing_v1 SET normalization_claimed_at=clock_timestamp() WHERE upload_id=p_upload;
 RETURN TRUE;
END $$;
CREATE FUNCTION persist_moderated_dance_normalization_v1(p_upload TEXT,p_token TEXT,p_frames JSONB,p_claims JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; s dance_moderated_sessions_v1; u dance_moderated_uploads_v1;
 profile JSONB; claim JSONB; frame JSONB; old dance_moderated_replay_claims_v1; blocked BOOLEAN:=FALSE;
 normalized TEXT; until_at TIMESTAMPTZ; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=u.session_id;
 profile:=s.terms->'profile';
 IF work.observation_token IS DISTINCT FROM p_token OR work.state NOT IN('claimed','unknown') OR work.provider_job_id IS NULL
 OR work.provider_deadline<=now_at OR jsonb_array_length(p_frames) IS DISTINCT FROM 3
 OR jsonb_array_length(p_claims) IS DISTINCT FROM 2*jsonb_array_length(profile->'replayCompatibleEpochs')
 OR (SELECT count(DISTINCT frame->>'index') FROM jsonb_array_elements(p_frames) frame)<>3 THEN RAISE EXCEPTION 'normalization authority unavailable' USING ERRCODE='DRV05'; END IF;
 IF (SELECT count(DISTINCT (c->>'epoch',c->>'kind')) FROM jsonb_array_elements(p_claims) c)<>jsonb_array_length(p_claims)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_claims) c WHERE (jsonb_typeof(c->'digest')='string' AND c->>'digest'~'^[a-f0-9]{64}$'
 AND c->>'kind' IN('raw','body') AND profile->'replayCompatibleEpochs' ? (c->>'epoch')) IS NOT TRUE) THEN
  RAISE EXCEPTION 'replay proof incomplete' USING ERRCODE='DRV06'; END IF;
 SELECT c->>'digest' INTO normalized FROM jsonb_array_elements(p_claims) c WHERE c->>'kind'='body' AND c->>'epoch'=profile->>'replayKeyEpoch';
 IF normalized IS NULL THEN RAISE EXCEPTION 'current replay proof missing' USING ERRCODE='DRV06'; END IF;
 until_at:=now_at+((profile->>'replayRetentionMs')::BIGINT*interval '1 millisecond');
 -- Deterministic order and a UNIQUE global scope/epoch/kind/digest fence.
 -- Expiry does not authorize reuse here; only the reviewed retention drain may
 -- dispose a claim. Account/key/persona/policy changes cannot free it.
 FOR claim IN SELECT c FROM jsonb_array_elements(p_claims) c ORDER BY c->>'epoch',c->>'kind',c->>'digest' LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('dance-recording-replay-v1',profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest')::TEXT,0));
  SELECT * INTO old FROM dance_moderated_replay_claims_v1 WHERE scope=profile->>'replayScope' AND key_epoch=claim->>'epoch' AND kind=claim->>'kind' AND digest=claim->>'digest';
  IF old.source_id IS NOT NULL AND (old.source_kind<>'attempt' OR old.source_id<>p_upload) THEN blocked:=TRUE;
  ELSE INSERT INTO dance_moderated_replay_claims_v1 VALUES(profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest','attempt',p_upload,until_at,now_at) ON CONFLICT DO NOTHING; END IF;
 END LOOP;
 IF u.server_sha256=(SELECT reference_digest FROM dance_moderator_reference_revisions_v1 WHERE choreography_id=s.choreography_id AND revision=s.choreography_revision) THEN blocked:=TRUE; END IF;
 FOR frame IN SELECT value FROM jsonb_array_elements(p_frames) LOOP
  IF (jsonb_typeof(frame->'index')='number' AND (frame->>'index')::INTEGER BETWEEN 0 AND 2
   AND frame->>'sha256'~'^[a-f0-9]{64}$' AND (frame->>'timestampMs')::BIGINT=CASE (frame->>'index')::INTEGER WHEN 0 THEN 0 WHEN 1 THEN floor((s.terms->'capture'->>'bodyStartMs')::NUMERIC/2) WHEN 2 THEN floor(((s.terms->'capture'->>'bodyStartMs')::NUMERIC+(s.terms->'capture'->>'bodyEndMs')::NUMERIC)/2) END
   AND frame->'identity'->>'key'='moderated-dance/derived/'||p_upload||'/frame-'||(frame->>'index')||'.jpg'
   AND (frame->'identity'->>'size')::BIGINT BETWEEN 1 AND (profile->>'maximumFrameBytes')::BIGINT
   AND length(frame->'identity'->>'version')>0 AND length(frame->'identity'->>'etag')>0) IS NOT TRUE THEN RAISE EXCEPTION 'private frame proof invalid' USING ERRCODE='DRV06'; END IF;
  IF EXISTS(SELECT 1 FROM dance_moderated_frame_artifacts_v1 WHERE upload_id=p_upload AND frame_index=(frame->>'index')::INTEGER AND (object_identity IS DISTINCT FROM frame->'identity' OR sha256 IS DISTINCT FROM frame->>'sha256')) THEN RAISE EXCEPTION 'private frame changed' USING ERRCODE='DRV05'; END IF;
  INSERT INTO dance_moderated_frame_artifacts_v1 VALUES(p_upload,(frame->>'index')::INTEGER,frame->'identity',frame->>'sha256',(frame->>'timestampMs')::BIGINT,now_at) ON CONFLICT DO NOTHING;
 END LOOP;
 IF (SELECT count(*) FROM dance_moderated_frame_artifacts_v1 WHERE upload_id=p_upload)<>3 THEN RAISE EXCEPTION 'private frames incomplete' USING ERRCODE='DRV06'; END IF;
 UPDATE dance_moderated_uploads_v1 SET state='sealed',sealed_at=bytes_sealed_at,normalized_digest=normalized,
 normalization_version=s.terms->'capture'->'policy'->>'normalizationVersion',normalization_hash=s.terms->'capture'->'policy'->>'normalizationHash' WHERE upload_id=p_upload;
 UPDATE dance_moderated_processing_v1 SET result=jsonb_build_object('integrity',CASE WHEN blocked THEN 'blocked' ELSE 'unique' END) WHERE upload_id=p_upload;
 INSERT INTO dance_moderated_media_dispositions_v1(upload_id,kind,identity,dispose_by,state,completed_at) VALUES(p_upload,'derived',jsonb_build_object('frames',p_frames),least(s.expires_at,now_at+((SELECT disposition_profile->>'temporaryCleanupWithinMs' FROM dance_review_policy_versions_v1 WHERE policy_id=s.policy_id)::BIGINT*interval '1 millisecond')),'held',NULL) ON CONFLICT(upload_id,kind) DO UPDATE SET identity=EXCLUDED.identity WHERE dance_moderated_media_dispositions_v1.claim_token IS NULL;
 RETURN jsonb_build_object('integrity',CASE WHEN blocked THEN 'blocked' ELSE 'unique' END);
END $$;
CREATE FUNCTION moderated_dance_safety_protocol_v1(p_upload TEXT,p_token TEXT,p_action TEXT,p_input JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; u dance_moderated_uploads_v1; s dance_moderated_sessions_v1;
 call_row dance_moderated_provider_calls_v1; frame dance_moderated_frame_artifacts_v1;
 idx INTEGER; purpose_key TEXT; claim TEXT; prior dance_moderated_safety_evidence_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=p_upload;
 SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=u.session_id;
 -- Recording an original consumed frame claim's exact provider result is
 -- historical evidence, never fresh screening/review authority. Account erasure,
 -- a replaced observation lease, or expiry must not erase knowledge of a reply.
 -- Below, request hash/frame provenance and its immutable claim token still match.
 IF p_action NOT IN('succeed','fail') AND (work.observation_token IS DISTINCT FROM p_token OR work.state NOT IN('claimed','unknown') OR u.state<>'sealed'
 OR work.provider_deadline<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM users a JOIN dance_review_account_fences_v1 f ON f.account_id=a.user_id WHERE a.user_id=s.account_id AND a.status='active' AND NOT f.erasing AND f.revision=work.account_fence)) THEN RAISE EXCEPTION 'screen authority changed' USING ERRCODE='DRV05'; END IF;
 IF p_action IN('load','save') THEN
  SELECT * INTO prior FROM dance_moderated_safety_evidence_v1 WHERE upload_id=p_upload;
  IF prior.upload_id IS NOT NULL THEN
   IF prior.input_digest IS DISTINCT FROM p_input->>'inputDigest' THEN RAISE EXCEPTION 'safety evidence changed' USING ERRCODE='DRV05'; END IF;
   RETURN prior.evidence;
  END IF;
  IF p_action='load' THEN RETURN NULL; END IF;
  IF p_input->>'policyHash' IS DISTINCT FROM s.terms->'capture'->'policy'->>'safetyHash'
   OR jsonb_array_length(p_input->'evidence'->'inputs') NOT BETWEEN 1 AND 3
   OR (SELECT count(*) FROM dance_moderated_provider_calls_v1 WHERE upload_id=p_upload AND state IN('succeeded','failed')) IS DISTINCT FROM jsonb_array_length(p_input->'evidence'->'inputs')
   THEN RAISE EXCEPTION 'safety evidence incomplete' USING ERRCODE='DRV06'; END IF;
  INSERT INTO dance_moderated_safety_evidence_v1 VALUES(p_upload,p_input->>'inputDigest',p_input->'evidence',clock_timestamp());
  RETURN p_input->'evidence';
 END IF;
 idx:=CASE p_input->'frame'->>'frameRole' WHEN 'poster' THEN 0 WHEN 'first' THEN 1 WHEN 'midpoint' THEN 2 END;
 SELECT * INTO frame FROM dance_moderated_frame_artifacts_v1 WHERE upload_id=p_upload AND frame_index=idx;
 IF frame.upload_id IS NULL OR p_input->'frame'->>'operationId' IS DISTINCT FROM s.attempt_id
 OR p_input->'frame'->>'submissionId' IS DISTINCT FROM s.review_id
 OR p_input->'frame'->>'communityId' IS DISTINCT FROM s.community_id
 OR p_input->'frame'->>'frameSha256' IS DISTINCT FROM frame.sha256
 OR p_input->'frame'->>'frameArtifactRef' IS DISTINCT FROM frame.object_identity->>'key'
 OR (p_input->'frame'->>'timestampMs')::BIGINT IS DISTINCT FROM frame.timestamp_ms THEN RAISE EXCEPTION 'screen frame changed' USING ERRCODE='DRV06'; END IF;
 purpose_key:='frame:'||idx;
 SELECT * INTO call_row FROM dance_moderated_provider_calls_v1 WHERE upload_id=p_upload AND dance_moderated_provider_calls_v1.purpose=purpose_key FOR UPDATE;
 IF call_row.upload_id IS NOT NULL THEN
  IF call_row.request_hash IS DISTINCT FROM p_input->>'requestHash' THEN RAISE EXCEPTION 'screen request changed' USING ERRCODE='DRV05'; END IF;
  IF p_action IN('inspect','claim') THEN
   RETURN CASE call_row.state WHEN 'sending' THEN jsonb_build_object('status','unresolved') WHEN 'succeeded' THEN jsonb_build_object('status','succeeded','result',call_row.result) ELSE jsonb_build_object('status','failed','failure',call_row.result) END;
  END IF;
  IF call_row.claim_token IS DISTINCT FROM p_input->>'claimToken' THEN RAISE EXCEPTION 'screen claim changed' USING ERRCODE='DRV05'; END IF;
  IF call_row.state<>'sending' THEN
   IF call_row.result IS DISTINCT FROM p_input->'result' THEN RAISE EXCEPTION 'screen result changed' USING ERRCODE='DRV05'; END IF;
   RETURN call_row.result;
  END IF;
  IF p_action='succeed' AND p_input->'result'->>'input_sha256' IS DISTINCT FROM frame.sha256 THEN RAISE EXCEPTION 'screen digest changed' USING ERRCODE='DRV06'; END IF;
  IF p_action NOT IN('succeed','fail') OR jsonb_typeof(p_input->'result') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'screen result unavailable' USING ERRCODE='DRV06'; END IF;
  UPDATE dance_moderated_provider_calls_v1 SET state=CASE WHEN p_action='succeed' THEN 'succeeded' ELSE 'failed' END,result=p_input->'result',completed_at=clock_timestamp() WHERE upload_id=p_upload AND dance_moderated_provider_calls_v1.purpose=purpose_key;
  RETURN p_input->'result';
 END IF;
 IF p_action='inspect' THEN RETURN jsonb_build_object('status','absent'); END IF;
 IF p_action<>'claim' THEN RAISE EXCEPTION 'screen claim missing' USING ERRCODE='DRV05'; END IF;
 claim:=p_input->>'claimToken';
 INSERT INTO dance_moderated_provider_calls_v1(upload_id,purpose,request_hash,claim_token,state) VALUES(p_upload,purpose_key,p_input->>'requestHash',claim,'sending');
 RETURN jsonb_build_object('status','dispatch','claimToken',claim);
END $$;
CREATE FUNCTION load_moderated_dance_sealed_capture_v1(p_upload TEXT,p_token TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; s dance_moderated_sessions_v1; u dance_moderated_uploads_v1;
 consent dance_moderated_consents_v1; policy dance_review_policy_versions_v1; f dance_review_account_fences_v1;
 owner community_role_assignments; e dance_moderated_safety_evidence_v1; cutoff TIMESTAMPTZ;
 capture JSONB; facts JSONB; status_value TEXT; frame_hashes JSONB; active BOOLEAN; admitted BOOLEAN;
 now_ms BIGINT:=floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload;
 SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=p_upload;
 SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=u.session_id;
 SELECT * INTO STRICT policy FROM dance_review_policy_versions_v1 WHERE policy_id=s.policy_id;
 SELECT * INTO STRICT consent FROM dance_moderated_consents_v1 WHERE receipt_id=u.consent_receipt_id;
 SELECT * INTO STRICT f FROM dance_review_account_fences_v1 WHERE account_id=s.account_id;
 SELECT * INTO e FROM dance_moderated_safety_evidence_v1 WHERE upload_id=p_upload;
 IF work.observation_token IS DISTINCT FROM p_token OR u.state<>'sealed' OR e.upload_id IS NULL
 OR work.state NOT IN('claimed','unknown','screened') THEN RAISE EXCEPTION 'sealed capture unavailable' USING ERRCODE='DRV05'; END IF;
 SELECT * INTO owner FROM community_role_assignments WHERE community_id=s.community_id AND role='owner' AND status='active' AND (SELECT count(*) FROM community_role_assignments sole WHERE sole.community_id=s.community_id AND sole.role='owner' AND sole.status='active')=1;
 SELECT status='active' AND NOT f.erasing INTO active FROM users WHERE user_id=s.account_id;
 SELECT cutoff_at INTO cutoff FROM dance_moderator_reference_cutoffs_v1 WHERE choreography_id=s.choreography_id AND revision=s.choreography_revision;
 SELECT jsonb_agg(sha256 ORDER BY frame_index) INTO frame_hashes FROM dance_moderated_frame_artifacts_v1 WHERE upload_id=p_upload;
 status_value:=CASE WHEN (e.evidence->>'platformHeld')::BOOLEAN IS TRUE OR e.evidence->'fact'->>'mediaSafety'='blocked' THEN 'flagged'
 WHEN jsonb_array_length(e.evidence->'inputs')=3 AND (SELECT count(*) FROM dance_moderated_provider_calls_v1 WHERE upload_id=p_upload AND state='succeeded')=3
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.evidence->'inputs') i WHERE (i->>'outcome'='evaluated' AND i->'resolution'->>'effective_policy_decision'='permit') IS NOT TRUE)
 AND e.evidence->'fact'->>'adapterRevision'='video-openai-safety-v2' THEN 'accepted' ELSE 'failed' END;
 capture:=s.terms->'capture'||jsonb_build_object('uploadId',p_upload,'sourceDigest',u.server_sha256,'normalizedDigest',u.normalized_digest,
 'analysisRevision',1,'firstStoredAtMs',floor(extract(epoch FROM u.first_stored_at)*1000)::BIGINT,
 'uploadedAtMs',floor(extract(epoch FROM u.bytes_sealed_at)*1000)::BIGINT,
 'consent',jsonb_build_object('receiptId',consent.receipt_id,'uploadId',u.upload_id,'recordedAtMs',floor(extract(epoch FROM consent.recorded_at)*1000)::BIGINT,'accountId',consent.account_id,'personaId',consent.persona_id,'termsHash',consent.terms_hash,'version',consent.consent_version,'policyHash',consent.consent_hash));
 SELECT EXISTS(SELECT 1 FROM qualification_policy_versions q JOIN activity_registry a ON a.activity_key=q.activity_key WHERE q.qualification_policy_version_id=policy.qualification_policy_version_id AND q.activity_key='dance' AND q.policy_kind='dance_owner_verdict_v1' AND q.policy_document->>'policy_hash'=capture->'policy'->>'qualificationHash' AND a.status='active' AND capture->'policy'->>'admission' IN('streak_admitted','money_admitted')) INTO admitted;
 facts:=jsonb_build_object('accountActive',coalesce(active,FALSE),'accountFenceRevision',f.revision,'workerAuthorized',FALSE,
 'ownedPersona',jsonb_build_object('active',active_activity_persona(s.account_id,s.persona_id,s.community_id),'accountId',s.account_id,'personaId',s.persona_id,'communityId',s.community_id),
 'owner',CASE WHEN owner.role_assignment_id IS NULL THEN NULL ELSE jsonb_build_object('accountId',owner.account_id,'communityId',owner.community_id,'assignmentId',owner.role_assignment_id,'revision',owner.authority_revision,'canInspect',status_value='accepted' AND can_account_view_content_rating_v1(owner.account_id,e.evidence->'fact'->>'automatedRating')) END,
 'referenceCutoffAtMs',CASE WHEN cutoff IS NULL THEN NULL ELSE floor(extract(epoch FROM cutoff)*1000)::BIGINT END,
 'media',jsonb_build_object('accepted',TRUE,'sourceDigest',u.server_sha256,'normalizedDigest',u.normalized_digest,'normalizationVersion',u.normalization_version,'normalizationHash',u.normalization_hash),
 'safety',jsonb_build_object('status',status_value,'persisted',TRUE,'sourceDigest',u.server_sha256,'analysisRevision',1,'policyHash',capture->'policy'->>'safetyHash','frameDigests',frame_hashes),
 'integrity',jsonb_build_object('status',work.result->>'integrity','persisted',TRUE,'sourceDigest',u.server_sha256,'normalizedDigest',u.normalized_digest,'policyHash',u.normalization_hash),
 'disposition',policy.disposition_profile,'submissionDay',NULL,
 'qualification',CASE WHEN NOT admitted THEN NULL ELSE jsonb_build_object('admitted',TRUE,'producerId',capture->'policy'->>'producerId','policyVersion',policy.qualification_policy_version_id,'policyHash',capture->'policy'->>'qualificationHash','admissionVersion',capture->'policy'->>'admissionVersion','admissionHash',capture->'policy'->>'admissionHash') END);
 RETURN jsonb_build_object('capture',capture,'facts',facts,'nowMs',now_ms);
END $$;
CREATE FUNCTION initialize_moderated_dance_review_v1(p_upload TEXT,p_token TEXT,p_state JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s dance_moderated_sessions_v1; u dance_moderated_uploads_v1; work dance_moderated_processing_v1;
 f dance_review_account_fences_v1; facts JSONB; capture JSONB; e dance_moderated_safety_evidence_v1; safety_status TEXT; hashes TEXT[];
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT session.* INTO STRICT s FROM dance_moderated_sessions_v1 session JOIN dance_moderated_uploads_v1 upload USING(session_id) WHERE upload.upload_id=p_upload;
 PERFORM 1 FROM users WHERE user_id=s.account_id AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'private capture unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT f FROM dance_review_account_fences_v1 WHERE account_id=s.account_id FOR UPDATE;
 PERFORM 1 FROM dance_moderated_sessions_v1 WHERE session_id=s.session_id FOR UPDATE;
 SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 facts:=load_moderated_dance_sealed_capture_v1(p_upload,p_token);capture:=facts->'capture';
 IF EXISTS(SELECT 1 FROM dance_moderated_reviews_v1 WHERE review_id=s.review_id) THEN
  IF EXISTS(SELECT 1 FROM dance_moderated_reviews_v1 WHERE review_id=s.review_id AND state->'capture'=capture) THEN RETURN; END IF;
  RAISE EXCEPTION 'review identity changed' USING ERRCODE='DRV05';
 END IF;
 IF f.erasing OR f.revision<>s.capture_account_fence OR clock_timestamp()>=s.expires_at
 OR (facts->'facts'->'owner'->>'accountId') IS NULL OR facts->'facts'->'owner'->>'accountId'=s.account_id
 OR p_state->'capture' IS DISTINCT FROM capture OR (p_state->>'revision')::BIGINT IS DISTINCT FROM 1
 OR p_state->>'state' IS DISTINCT FROM 'uploaded' OR p_state->'initialSubmit' IS DISTINCT FROM 'null'::JSONB
 OR p_state->'submittedAtMs' IS DISTINCT FROM 'null'::JSONB OR p_state->'verdict' IS DISTINCT FROM 'null'::JSONB
 OR p_state->'qualificationRef' IS DISTINCT FROM 'null'::JSONB OR p_state->'attestation' IS DISTINCT FROM 'null'::JSONB
 OR p_state->'showPublicly' IS DISTINCT FROM 'null'::JSONB OR p_state->>'publication' IS DISTINCT FROM 'none'
 OR (p_state->>'publicationRevision')::BIGINT IS DISTINCT FROM 0 OR (p_state->>'generation')::BIGINT IS DISTINCT FROM 0
 OR (p_state->>'reviewDeadlineMs')::NUMERIC IS DISTINCT FROM (capture->>'uploadedAtMs')::NUMERIC+604800000 THEN RAISE EXCEPTION 'capture state changed' USING ERRCODE='DRV05'; END IF;
 SELECT * INTO STRICT e FROM dance_moderated_safety_evidence_v1 WHERE upload_id=p_upload;
 safety_status:=facts->'facts'->'safety'->>'status';
 SELECT array_agg(sha256 ORDER BY frame_index) INTO hashes FROM dance_moderated_frame_artifacts_v1 WHERE upload_id=p_upload;
 INSERT INTO dance_moderated_reviews_v1(review_id,session_id,account_id,community_id,state,revision,publication_revision,status,uploaded_at,review_deadline)
 VALUES(s.review_id,s.session_id,s.account_id,s.community_id,p_state,1,0,'uploaded',u.bytes_sealed_at,u.bytes_sealed_at+interval '168 hours');
 INSERT INTO dance_moderated_review_evidence_v1(review_id,analysis_revision,source_digest,normalization_hash,safety_policy_hash,frame_digests,safety_status,content_rating,integrity_status,normalized_digest,evidence)
 VALUES(s.review_id,1,u.server_sha256,u.normalization_hash,capture->'policy'->>'safetyHash',hashes,safety_status,e.evidence->'fact'->>'automatedRating',work.result->>'integrity',u.normalized_digest,e.evidence);
 UPDATE dance_moderated_processing_v1 SET state='screened',completed_at=clock_timestamp(),observation_until=NULL WHERE upload_id=p_upload;
 UPDATE dance_moderated_sessions_v1 SET state='uploaded' WHERE session_id=s.session_id;
END $$;
DO $acl$
DECLARE t TEXT; f RECORD; recipient RECORD; trusted TEXT:=current_schema();
BEGIN
 FOREACH t IN ARRAY ARRAY['dance_moderated_source_grants_v1','dance_moderated_frame_artifacts_v1','dance_moderated_provider_calls_v1','dance_moderated_safety_evidence_v1','dance_moderated_replay_claims_v1','dance_moderated_media_dispositions_v1','dance_moderated_provider_usage_v1'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC CASCADE',t);
  FOR recipient IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=to_regclass(t) AND a.grantee NOT IN(0,c.relowner) LOOP EXECUTE format('REVOKE ALL ON TABLE %I FROM %I CASCADE',t,recipient.name); END LOOP;
 END LOOP;
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace AND p.proname IN('moderated_dance_media_runtime_v1','announce_moderated_dance_processor_v1','claim_moderated_dance_media_v1','reserve_moderated_dance_provider_work_v1','guard_moderated_dance_provider_usage_v1','persist_moderated_dance_seal_v1','mark_moderated_dance_media_unknown_v1','attach_moderated_dance_provider_v1','issue_moderated_dance_source_v1','resolve_moderated_dance_source_v1','persist_moderated_dance_normalization_v1','claim_moderated_dance_probe_v1','persist_moderated_dance_probe_v1','claim_moderated_dance_normalization_v1','moderated_dance_safety_protocol_v1','load_moderated_dance_sealed_capture_v1','initialize_moderated_dance_review_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted); EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR recipient IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(0,f.proowner) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,recipient.name); END LOOP;
 END LOOP;
END $acl$;
