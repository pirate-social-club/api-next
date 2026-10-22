-- Prospective provider contract binding. No historical dispatch is backfilled
-- with an assumed retention promise or an invented erasure observation.
ALTER TABLE dance_moderated_provider_calls_v1 ADD COLUMN provider_contract JSONB
 CHECK(provider_contract IS NULL OR jsonb_typeof(provider_contract)='object');
CREATE FUNCTION moderated_dance_safety_contract_v1() RETURNS JSONB LANGUAGE sql IMMUTABLE SECURITY DEFINER AS $$
 SELECT '{"version":"private-dance-safety-retention-v1","provider":"openai","endpoint":"https://api.openai.com/v1/moderations","model":"omni-moderation-2024-09-26","input":"inline-jpeg-data-url","abuseMonitoring":"no-ordinary-content-retention","applicationState":"none","evidenceKind":"documented-endpoint-contract","preservation":"legal-or-provider-preservation-is-not-observed-absence","source":"https://developers.openai.com/api/docs/guides/your-data","observedOn":"2026-10-23"}'::JSONB
$$;
CREATE FUNCTION guard_moderated_dance_safety_call_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'safety dispatch history retained' USING ERRCODE='DRV01'; END IF;
 IF (to_jsonb(NEW)-'state'-'result'-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'result'-'completed_at')
 OR (OLD.state<>'sending' AND NEW IS DISTINCT FROM OLD) OR NEW.state='sending' AND NEW IS DISTINCT FROM OLD
 OR (NEW.state<>'sending' AND (NEW.completed_at IS NULL OR NEW.completed_at<OLD.dispatched_at OR jsonb_typeof(NEW.result) IS DISTINCT FROM 'object'))
 OR NEW.completed_at>clock_timestamp() THEN RAISE EXCEPTION 'safety dispatch identity changed' USING ERRCODE='DRV01'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER moderated_safety_call_retained BEFORE UPDATE OR DELETE ON dance_moderated_provider_calls_v1 FOR EACH ROW EXECUTE FUNCTION guard_moderated_dance_safety_call_v1();
CREATE TRIGGER moderated_safety_call_no_truncate BEFORE TRUNCATE ON dance_moderated_provider_calls_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();


CREATE OR REPLACE FUNCTION moderated_dance_safety_protocol_v1(p_upload TEXT,p_token TEXT,p_action TEXT,p_input JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; u dance_moderated_uploads_v1; s dance_moderated_sessions_v1;
 call_row dance_moderated_provider_calls_v1; frame dance_moderated_frame_artifacts_v1;
 idx INTEGER; purpose_key TEXT; claim TEXT; prior dance_moderated_safety_evidence_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 IF p_action NOT IN('succeed','fail') THEN work:=lock_moderated_dance_processing_authority_v1(p_upload);
 ELSE SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE; END IF;
 SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=p_upload;
 SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=u.session_id;
 -- Recording an original consumed frame claim's exact provider result is
 -- historical evidence, never fresh screening/review authority. Account erasure,
 -- a replaced observation lease, or expiry must not erase knowledge of a reply.
 -- Below, request hash/frame provenance and its immutable claim token still match.
 IF p_action NOT IN('succeed','fail') AND (work.observation_token IS DISTINCT FROM p_token OR work.state NOT IN('claimed','unknown') OR u.state<>'sealed'
 OR work.provider_deadline<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM users a JOIN dance_review_account_fences_v1 f ON f.account_id=a.user_id WHERE a.user_id=s.account_id AND a.status='active' AND NOT f.erasing AND f.revision=work.account_fence)) THEN RAISE EXCEPTION 'screen authority changed' USING ERRCODE='DRV05'; END IF;
 IF p_action IN('load','save') THEN
  IF p_input->'providerContract' IS DISTINCT FROM moderated_dance_safety_contract_v1()
  OR s.terms->'profile'->>'safetyProviderRevision' IS DISTINCT FROM 'private-three-still-openai-contract-v1'
  OR EXISTS(SELECT 1 FROM dance_moderated_provider_calls_v1 c WHERE c.upload_id=p_upload AND c.provider_contract IS DISTINCT FROM moderated_dance_safety_contract_v1()) THEN
   RAISE EXCEPTION 'safety provider retention unbound' USING ERRCODE='DRV07'; END IF;
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
  IF call_row.provider_contract IS DISTINCT FROM p_input->'providerContract' THEN RAISE EXCEPTION 'screen provider contract changed' USING ERRCODE='DRV05'; END IF;
  IF call_row.request_hash IS DISTINCT FROM p_input->>'requestHash' THEN RAISE EXCEPTION 'screen request changed' USING ERRCODE='DRV05'; END IF;
  IF p_action IN('inspect','claim') THEN
   IF call_row.provider_contract IS NULL THEN RETURN jsonb_build_object('status','unresolved'); END IF;
   RETURN CASE call_row.state WHEN 'sending' THEN jsonb_build_object('status','unresolved') WHEN 'succeeded' THEN jsonb_build_object('status','succeeded','result',call_row.result) ELSE jsonb_build_object('status','failed','failure',call_row.result) END;
  END IF;
  IF call_row.claim_token IS DISTINCT FROM p_input->>'claimToken' THEN RAISE EXCEPTION 'screen claim changed' USING ERRCODE='DRV05'; END IF;
  IF call_row.state<>'sending' THEN
   IF call_row.result IS DISTINCT FROM p_input->'result' THEN RAISE EXCEPTION 'screen result changed' USING ERRCODE='DRV05'; END IF;
   RETURN call_row.result;
  END IF;
  IF p_action='succeed' AND p_input->'result'->>'input_sha256' IS DISTINCT FROM frame.sha256 THEN RAISE EXCEPTION 'screen digest changed' USING ERRCODE='DRV06'; END IF;
  IF p_action='succeed' AND call_row.provider_contract IS NOT NULL AND (p_input->'result'->>'provider_id'='openai' AND p_input->'result'->>'requested_model'=call_row.provider_contract->>'model' AND p_input->'result'->>'returned_model'=call_row.provider_contract->>'model') IS NOT TRUE THEN RAISE EXCEPTION 'screen provider model changed' USING ERRCODE='DRV06'; END IF;
  IF p_action NOT IN('succeed','fail') OR jsonb_typeof(p_input->'result') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'screen result unavailable' USING ERRCODE='DRV06'; END IF;
  UPDATE dance_moderated_provider_calls_v1 SET state=CASE WHEN p_action='succeed' THEN 'succeeded' ELSE 'failed' END,result=p_input->'result',completed_at=clock_timestamp() WHERE upload_id=p_upload AND dance_moderated_provider_calls_v1.purpose=purpose_key;
  RETURN p_input->'result';
 END IF;
 IF p_action='inspect' THEN RETURN jsonb_build_object('status','absent'); END IF;
 IF p_action<>'claim' THEN RAISE EXCEPTION 'screen claim missing' USING ERRCODE='DRV05'; END IF;
 IF p_input->'providerContract' IS DISTINCT FROM moderated_dance_safety_contract_v1()
 OR s.terms->'profile'->>'safetyProviderRevision' IS DISTINCT FROM 'private-three-still-openai-contract-v1' THEN
  RAISE EXCEPTION 'safety provider retention unbound' USING ERRCODE='DRV07'; END IF;
 claim:=p_input->>'claimToken';
 INSERT INTO dance_moderated_provider_calls_v1(upload_id,purpose,request_hash,claim_token,state,provider_contract) VALUES(p_upload,purpose_key,p_input->>'requestHash',claim,'sending',p_input->'providerContract');
 RETURN jsonb_build_object('status','dispatch','claimToken',claim);
END $$;

CREATE OR REPLACE FUNCTION load_moderated_dance_sealed_capture_v1(p_upload TEXT,p_token TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; s dance_moderated_sessions_v1; u dance_moderated_uploads_v1;
 consent dance_moderated_consents_v1; policy dance_review_policy_versions_v1; f dance_review_account_fences_v1;
 owner community_role_assignments; e dance_moderated_safety_evidence_v1; cutoff TIMESTAMPTZ;
 capture JSONB; facts JSONB; status_value TEXT; frame_hashes JSONB; active BOOLEAN; admitted BOOLEAN;
 now_ms BIGINT:=floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_provider_calls_v1 c WHERE c.upload_id=p_upload AND c.provider_contract IS DISTINCT FROM moderated_dance_safety_contract_v1()) THEN RAISE EXCEPTION 'safety provider retention unbound' USING ERRCODE='DRV07'; END IF;
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

CREATE OR REPLACE FUNCTION record_moderated_dance_maintenance_v1() RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE lease_ms BIGINT; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() OR NOT dance_review_worker_authorized_v1() THEN RAISE EXCEPTION 'maintenance purposes unavailable' USING ERRCODE='DRV02'; END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_provider_calls_v1 WHERE provider_contract IS DISTINCT FROM moderated_dance_safety_contract_v1()) THEN DELETE FROM dance_moderated_maintenance_readiness_v1; DELETE FROM dance_moderated_processor_readiness_v1; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_provider_effects_v1 effect
  LEFT JOIN dance_moderated_processing_v1 processing ON processing.upload_id=effect.upload_id
  LEFT JOIN dance_moderated_uploads_v1 upload ON upload.upload_id=effect.upload_id
  LEFT JOIN dance_moderated_reviews_v1 review ON review.session_id=upload.session_id
  WHERE effect.state<>'completed' AND CASE WHEN processing.state='held' OR review.status='held' THEN effect.hold_dispose_by ELSE effect.dispose_by END<=now_at) THEN
  DELETE FROM dance_moderated_maintenance_readiness_v1;
  DELETE FROM dance_moderated_processor_readiness_v1;
  RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_uploads_v1 WHERE normalized_digest IS NOT NULL AND replay_retired_at IS NULL AND replay_expires_at<=now_at)
 OR EXISTS(SELECT 1 FROM dance_moderated_media_dispositions_v1 d WHERE d.state IN('pending','running','unknown') AND d.dispose_by<=now_at)
 OR EXISTS(SELECT 1 FROM dance_moderated_media_dispositions_v1 d JOIN dance_moderated_uploads_v1 u USING(upload_id)
 JOIN dance_moderated_reviews_v1 r USING(session_id) JOIN dance_moderated_review_intents_v1 i USING(review_id)
 WHERE d.state='held' AND i.status<>'completed' AND i.deadline_at<=now_at AND
  (i.kind='hold_review' OR i.kind='cleanup_review' AND d.kind IN('ingress','original') OR i.kind='cleanup_temporary' AND d.kind='derived')) THEN
  DELETE FROM dance_moderated_maintenance_readiness_v1; DELETE FROM dance_moderated_processor_readiness_v1; RETURN;
 END IF;
 SELECT min((p.operational_profile->>'readinessLeaseMs')::BIGINT) INTO lease_ms FROM dance_review_policy_versions_v1 p
 JOIN dance_review_policy_admissions_v1 a USING(policy_id) WHERE a.accepted AND now_at>=a.effective_at AND now_at<a.valid_until AND now_at>=p.valid_from AND now_at<p.valid_until;
 IF lease_ms IS NULL OR lease_ms<=0 THEN RETURN; END IF;
 INSERT INTO dance_moderated_maintenance_readiness_v1 VALUES(TRUE,now_at,now_at+lease_ms*interval '1 millisecond')
 ON CONFLICT(singleton) DO UPDATE SET observed_at=EXCLUDED.observed_at,valid_until=EXCLUDED.valid_until;
END $$;

DO $acl$
DECLARE f RECORD; r RECORD; trusted TEXT:=current_schema();
BEGIN
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace
 AND p.proname IN('moderated_dance_safety_contract_v1','guard_moderated_dance_safety_call_v1','moderated_dance_safety_protocol_v1','load_moderated_dance_sealed_capture_v1','record_moderated_dance_maintenance_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  IF f.oid IN('moderated_dance_safety_contract_v1()'::regprocedure,'guard_moderated_dance_safety_call_v1()'::regprocedure) THEN
   FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(0,f.proowner) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name); END LOOP;
  END IF;
 END LOOP;
END $acl$;
