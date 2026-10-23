-- Private keyed replay material has a bounded lifetime. Result/consent,
-- source commitments, immutable verdicts and financial identities are retained.
ALTER TABLE dance_moderated_uploads_v1 ADD COLUMN replay_expires_at TIMESTAMPTZ,
 ADD COLUMN replay_last_checked_at TIMESTAMPTZ,
 ADD COLUMN replay_retired_at TIMESTAMPTZ,
 ADD CONSTRAINT moderated_dance_retired_digest_absent_v1 CHECK(replay_retired_at IS NULL OR normalized_digest IS NULL);
UPDATE dance_moderated_uploads_v1 upload SET replay_expires_at=coalesce(
 (SELECT min(claim.expires_at) FROM dance_moderated_replay_claims_v1 claim WHERE claim.source_kind='attempt' AND claim.source_id=upload.upload_id),
 upload.reserved_at+(session.terms->'profile'->>'replayRetentionMs')::BIGINT*interval '1 millisecond')
 FROM dance_moderated_sessions_v1 session WHERE session.session_id=upload.session_id AND upload.normalized_digest IS NOT NULL;

CREATE TABLE dance_moderated_replay_retirements_v1 (
 upload_id TEXT PRIMARY KEY REFERENCES dance_moderated_uploads_v1,
 terms_hash TEXT NOT NULL CHECK(terms_hash~'^[a-f0-9]{64}$'), key_epoch TEXT NOT NULL,
 due_at TIMESTAMPTZ NOT NULL, retired_at TIMESTAMPTZ NOT NULL CHECK(retired_at>=due_at AND retired_at<=clock_timestamp()),
 removed_claims BIGINT NOT NULL CHECK(removed_claims>=0)
);
CREATE TRIGGER moderated_replay_retirement_immutable BEFORE UPDATE OR DELETE ON dance_moderated_replay_retirements_v1 FOR EACH ROW EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE TRIGGER moderated_replay_retirement_no_truncate BEFORE TRUNCATE ON dance_moderated_replay_retirements_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();

DO $sealed_check$
DECLARE item RECORD; found_count INTEGER:=0;
BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='dance_moderated_uploads_v1'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%normalized_digest IS NOT NULL%' LOOP
  EXECUTE format('ALTER TABLE dance_moderated_uploads_v1 DROP CONSTRAINT %I',item.conname); found_count:=found_count+1;
 END LOOP;
 IF found_count<>1 THEN RAISE EXCEPTION 'exact sealed evidence constraint unavailable'; END IF;
 ALTER TABLE dance_moderated_uploads_v1 ADD CONSTRAINT moderated_dance_retained_seal_v2 CHECK(
  state NOT IN('sealed','held') OR (sealed_at IS NOT NULL AND first_stored_at IS NOT NULL AND server_sha256 IS NOT NULL
  AND (normalized_digest IS NOT NULL OR replay_retired_at IS NOT NULL) AND normalization_version IS NOT NULL AND normalization_hash IS NOT NULL));
 ALTER TABLE dance_moderated_review_evidence_v1 ALTER COLUMN normalized_digest DROP NOT NULL;
END $sealed_check$;

CREATE FUNCTION guard_moderated_dance_replay_retirement_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload TEXT; retired BOOLEAN;
BEGIN
 IF TG_TABLE_NAME='dance_moderated_uploads_v1' THEN
  IF OLD.replay_expires_at IS NOT NULL AND NEW.replay_expires_at IS DISTINCT FROM OLD.replay_expires_at THEN RAISE EXCEPTION 'replay retention cannot renew' USING ERRCODE='DRV01'; END IF;
  IF OLD.replay_retired_at IS NOT NULL THEN
   IF NEW.normalized_digest IS NOT NULL OR NEW.replay_retired_at IS DISTINCT FROM OLD.replay_retired_at
    OR NEW.replay_expires_at IS DISTINCT FROM OLD.replay_expires_at THEN RAISE EXCEPTION 'retired replay cannot reopen' USING ERRCODE='DRV01'; END IF;
   RETURN NEW;
  END IF;
  IF NEW.normalized_digest IS NOT DISTINCT FROM OLD.normalized_digest
   AND NEW.replay_retired_at IS NOT DISTINCT FROM OLD.replay_retired_at
   AND NEW.replay_expires_at IS NOT DISTINCT FROM OLD.replay_expires_at THEN RETURN NEW; END IF;
  IF NEW.replay_retired_at IS NULL AND NEW.normalized_digest IS NOT NULL THEN
   IF OLD.normalized_digest IS NOT NULL AND NEW.normalized_digest<>OLD.normalized_digest THEN RAISE EXCEPTION 'replay identity changed' USING ERRCODE='DRV01'; END IF;
   RETURN NEW;
  END IF;
  IF NEW.replay_retired_at IS NOT NULL AND NEW.normalized_digest IS NULL
   AND (to_jsonb(NEW)-'normalized_digest'-'replay_retired_at')=(to_jsonb(OLD)-'normalized_digest'-'replay_retired_at') THEN upload:=OLD.upload_id;
  ELSE IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF; RAISE EXCEPTION 'replay retirement unavailable' USING ERRCODE='DRV01'; END IF;
 ELSIF TG_TABLE_NAME='dance_moderated_reviews_v1' THEN
  IF NEW.state#>>'{capture,normalizedDigest}' IS NOT DISTINCT FROM OLD.state#>>'{capture,normalizedDigest}' THEN RETURN NEW; END IF;
  IF NEW.state#>>'{capture,normalizedDigest}'='keyed-replay-retired-v1'
   AND (to_jsonb(NEW)-'state')=(to_jsonb(OLD)-'state')
   AND (NEW.state#-'{capture,normalizedDigest}')=(OLD.state#-'{capture,normalizedDigest}') THEN
   SELECT upload_id INTO upload FROM dance_moderated_uploads_v1 WHERE session_id=OLD.session_id;
  ELSE RAISE EXCEPTION 'retained capture identity changed' USING ERRCODE='DRV01'; END IF;
 ELSE
  IF TG_OP='UPDATE' AND OLD.normalized_digest IS NOT NULL AND NEW.normalized_digest IS NULL
   AND (to_jsonb(NEW)-'normalized_digest')=(to_jsonb(OLD)-'normalized_digest') THEN
   SELECT u.upload_id INTO upload FROM dance_moderated_uploads_v1 u JOIN dance_moderated_reviews_v1 r USING(session_id) WHERE r.review_id=OLD.review_id;
  ELSE RAISE EXCEPTION 'review evidence is immutable' USING ERRCODE='DRV01'; END IF;
 END IF;
 SELECT EXISTS(SELECT 1 FROM dance_moderated_replay_retirements_v1 receipt JOIN dance_moderated_uploads_v1 u USING(upload_id)
 JOIN dance_moderated_sessions_v1 s USING(session_id) WHERE receipt.upload_id=upload AND receipt.terms_hash=s.terms_hash
 AND receipt.retired_at>=receipt.due_at AND receipt.due_at=u.replay_expires_at) INTO retired;
 IF NOT retired THEN RAISE EXCEPTION 'replay retirement receipt missing' USING ERRCODE='DRV01'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER moderated_upload_replay_retirement BEFORE UPDATE ON dance_moderated_uploads_v1 FOR EACH ROW EXECUTE FUNCTION guard_moderated_dance_replay_retirement_v1();
CREATE TRIGGER moderated_review_replay_retirement BEFORE UPDATE ON dance_moderated_reviews_v1 FOR EACH ROW EXECUTE FUNCTION guard_moderated_dance_replay_retirement_v1();
DROP TRIGGER dance_moderated_review_evidence_v1_immutable ON dance_moderated_review_evidence_v1;
CREATE TRIGGER dance_moderated_review_evidence_v1_immutable BEFORE UPDATE OR DELETE ON dance_moderated_review_evidence_v1 FOR EACH ROW EXECUTE FUNCTION guard_moderated_dance_replay_retirement_v1();

CREATE FUNCTION drain_moderated_dance_replay_v1() RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate TEXT; u dance_moderated_uploads_v1; s dance_moderated_sessions_v1; r dance_moderated_reviews_v1;
 work dance_moderated_processing_v1; now_at TIMESTAMPTZ; removed BIGINT; drained INTEGER:=0;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'replay drain unavailable' USING ERRCODE='DRV02'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 FOR candidate IN SELECT upload_id FROM dance_moderated_uploads_v1 WHERE replay_expires_at<=clock_timestamp()
 AND replay_retired_at IS NULL AND normalized_digest IS NOT NULL
 ORDER BY replay_last_checked_at NULLS FIRST,replay_expires_at,upload_id LIMIT 20 LOOP
  -- Never wait while holding the family lock for a command which acquired its
  -- source locks first. A skipped source remains an explicit obligation.
  SELECT * INTO u FROM dance_moderated_uploads_v1 WHERE upload_id=candidate FOR UPDATE SKIP LOCKED;
  IF u.upload_id IS NULL THEN CONTINUE; END IF;
  UPDATE dance_moderated_uploads_v1 SET replay_last_checked_at=clock_timestamp() WHERE upload_id=u.upload_id;
  SELECT * INTO s FROM dance_moderated_sessions_v1 WHERE session_id=u.session_id FOR UPDATE SKIP LOCKED;
  IF s.session_id IS NULL THEN CONTINUE; END IF;
  SELECT * INTO r FROM dance_moderated_reviews_v1 WHERE session_id=s.session_id FOR UPDATE SKIP LOCKED;
  IF EXISTS(SELECT 1 FROM dance_moderated_reviews_v1 WHERE session_id=s.session_id) AND r.review_id IS NULL THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM dance_moderated_processing_v1 WHERE upload_id=u.upload_id) THEN
   SELECT * INTO work FROM dance_moderated_processing_v1 WHERE upload_id=u.upload_id FOR UPDATE SKIP LOCKED;
   IF work.upload_id IS NULL OR work.state IN('ready','claimed','unknown') THEN CONTINUE; END IF;
  END IF;
  now_at:=clock_timestamp();
  IF u.replay_retired_at IS NOT NULL OR u.replay_expires_at>now_at
   OR r.review_id IS NULL AND s.state<>'terminal'
   OR r.review_id IS NOT NULL AND (r.terminal_at IS NULL OR r.state->>'publication'='pending')
   OR EXISTS(SELECT 1 FROM dance_moderated_replay_claims_v1 c WHERE c.source_kind='attempt' AND c.source_id=u.upload_id AND c.expires_at>now_at) THEN CONTINUE; END IF;
  SELECT count(*) INTO removed FROM dance_moderated_replay_claims_v1 WHERE source_kind='attempt' AND source_id=u.upload_id;
  INSERT INTO dance_moderated_replay_retirements_v1 VALUES(u.upload_id,s.terms_hash,s.terms->'profile'->>'replayKeyEpoch',u.replay_expires_at,now_at,removed);
  UPDATE dance_moderated_uploads_v1 SET normalized_digest=NULL,replay_retired_at=now_at WHERE upload_id=u.upload_id;
  IF r.review_id IS NOT NULL THEN
   UPDATE dance_moderated_reviews_v1 SET state=jsonb_set(state,'{capture,normalizedDigest}','"keyed-replay-retired-v1"'::JSONB) WHERE review_id=r.review_id;
   UPDATE dance_moderated_review_evidence_v1 SET normalized_digest=NULL WHERE review_id=r.review_id AND normalized_digest IS NOT NULL;
  END IF;
  DELETE FROM dance_moderated_replay_claims_v1 WHERE source_kind='attempt' AND source_id=u.upload_id;
  drained:=drained+1;
 END LOOP;
 RETURN jsonb_build_object('retiredAttempts',drained);
END $$;

CREATE OR REPLACE FUNCTION persist_moderated_dance_normalization_v1(p_upload TEXT,p_token TEXT,p_frames JSONB,p_claims JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; s dance_moderated_sessions_v1; u dance_moderated_uploads_v1;
 profile JSONB; claim JSONB; frame JSONB; old dance_moderated_replay_claims_v1; blocked BOOLEAN:=FALSE;
 normalized TEXT; until_at TIMESTAMPTZ; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 work:=lock_moderated_dance_processing_authority_v1(p_upload);
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 now_at:=clock_timestamp();
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=u.session_id;
 profile:=s.terms->'profile';
 IF u.replay_retired_at IS NOT NULL OR EXISTS(SELECT 1 FROM dance_moderated_replay_retirements_v1 WHERE upload_id=p_upload)
 OR work.observation_token IS DISTINCT FROM p_token OR work.state NOT IN('claimed','unknown') OR work.provider_job_id IS NULL
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
 UPDATE dance_moderated_uploads_v1 SET state='sealed',sealed_at=bytes_sealed_at,normalized_digest=normalized,replay_expires_at=coalesce(replay_expires_at,until_at),
 normalization_version=s.terms->'capture'->'policy'->>'normalizationVersion',normalization_hash=s.terms->'capture'->'policy'->>'normalizationHash' WHERE upload_id=p_upload;
 UPDATE dance_moderated_processing_v1 SET result=jsonb_build_object('integrity',CASE WHEN blocked THEN 'blocked' ELSE 'unique' END) WHERE upload_id=p_upload;
 INSERT INTO dance_moderated_media_dispositions_v1(upload_id,kind,identity,dispose_by,state,completed_at) VALUES(p_upload,'derived',jsonb_build_object('frames',p_frames),least(s.expires_at,now_at+((SELECT disposition_profile->>'temporaryCleanupWithinMs' FROM dance_review_policy_versions_v1 WHERE policy_id=s.policy_id)::BIGINT*interval '1 millisecond')),'held',NULL) ON CONFLICT(upload_id,kind) DO UPDATE SET identity=EXCLUDED.identity WHERE dance_moderated_media_dispositions_v1.claim_token IS NULL;
 RETURN jsonb_build_object('integrity',CASE WHEN blocked THEN 'blocked' ELSE 'unique' END);
END $$;

CREATE OR REPLACE FUNCTION record_moderated_dance_maintenance_v1() RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE lease_ms BIGINT; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() OR NOT dance_review_worker_authorized_v1() THEN RAISE EXCEPTION 'maintenance purposes unavailable' USING ERRCODE='DRV02'; END IF;
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

CREATE OR REPLACE FUNCTION grant_moderated_dance_runtime_v1(p_role TEXT,p_purpose TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE target RECORD; owner_oid OID; names TEXT[]; f RECORD; t RECORD; found_count INTEGER:=0;
BEGIN
 SELECT relowner INTO owner_oid FROM pg_class WHERE oid='dance_moderated_sessions_v1'::regclass;
 IF session_user<>pg_get_userbyid(owner_oid) THEN RAISE EXCEPTION 'runtime binding requires admitted owner custody' USING ERRCODE='DRV02'; END IF;
 SELECT oid,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication INTO target FROM pg_roles WHERE rolname=p_role;
 IF target.oid IS NULL OR target.oid=owner_oid OR target.rolsuper OR target.rolbypassrls OR target.rolcreaterole OR target.rolcreatedb OR target.rolreplication THEN RAISE EXCEPTION 'runtime role is not confined' USING ERRCODE='DRV06'; END IF;
 FOR t IN SELECT c.oid FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind IN('r','p') AND
 (c.relname LIKE 'dance_moderated_%_v1' OR c.relname IN('dance_review_account_fences_v1','dance_review_policy_versions_v1','dance_review_policy_admissions_v1','dance_moderator_reference_revisions_v1','dance_moderator_reference_cutoffs_v1')) LOOP
  IF has_table_privilege(target.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(target.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'inherited/raw private table privilege must be reconciled first' USING ERRCODE='DRV06'; END IF;
 END LOOP;
 IF p_purpose='account' THEN
  names:=ARRAY['lock_moderated_dance_intake_command_v1','load_moderated_dance_creation_facts_v1','apply_moderated_dance_intake_v1','read_owned_moderated_dance_session_v1','read_moderated_dance_capture_options_v1','create_moderated_dance_reference_v1','read_owned_moderated_dance_reference_v1','issue_moderated_dance_media_lease_v1','resolve_moderated_dance_media_lease_v1',
   'lock_moderated_dance_review_v1','read_moderated_dance_receipt_v1','moderated_dance_review_facts_v1','commit_moderated_dance_review_v1','read_owned_moderated_dance_review_v1','latest_owned_moderated_dance_review_v1','owner_moderated_dance_queue_v1','owner_moderated_dance_detail_v1'];
 ELSIF p_purpose='worker' THEN
  names:=ARRAY['next_moderated_dance_review_task_v1','lock_moderated_dance_review_v1','read_moderated_dance_receipt_v1','moderated_dance_review_facts_v1','commit_moderated_dance_review_v1'];
 ELSIF p_purpose='media' THEN
  names:=ARRAY['announce_moderated_dance_processor_v1','claim_moderated_dance_media_v1','persist_moderated_dance_seal_v1','mark_moderated_dance_media_unknown_v1','attach_moderated_dance_provider_v1','issue_moderated_dance_source_v1','claim_moderated_dance_probe_v1','persist_moderated_dance_probe_v1','claim_moderated_dance_normalization_v1','persist_moderated_dance_normalization_v1','moderated_dance_safety_protocol_v1','load_moderated_dance_sealed_capture_v1','initialize_moderated_dance_review_v1','claim_moderated_dance_reference_media_v1','persist_moderated_dance_reference_segment_v1','record_moderated_dance_reference_provider_v1','claim_moderated_dance_reference_normalization_v1','attach_moderated_dance_reference_provider_v1','issue_moderated_dance_reference_source_v1','publish_moderated_dance_reference_v1','claim_moderated_dance_owned_cleanup_v1','finish_moderated_dance_owned_cleanup_v1','record_moderated_dance_maintenance_v1','claim_moderated_dance_provider_cleanup_v1','identify_moderated_dance_provider_cleanup_v1','finish_moderated_dance_provider_cleanup_v1','drain_moderated_dance_replay_v1'];
 ELSIF p_purpose='erasure' THEN names:=ARRAY['begin_moderated_dance_account_erasure_v1'];
 ELSIF p_purpose='source_gateway' THEN names:=ARRAY['resolve_moderated_dance_source_v1','resolve_moderated_dance_reference_source_v1'];
 ELSE RAISE EXCEPTION 'unknown runtime purpose' USING ERRCODE='DRV06'; END IF;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND p.proname=ANY(names) LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,p_role);found_count:=found_count+1;
 END LOOP;
 IF found_count<>cardinality(names) THEN RAISE EXCEPTION 'exact purpose function closure incomplete' USING ERRCODE='DRV06'; END IF;
 IF p_purpose<>'source_gateway' THEN INSERT INTO dance_moderated_runtime_roles_v1 VALUES(target.oid,p_purpose) ON CONFLICT DO NOTHING; END IF;
END $$;

DO $acl$
DECLARE f RECORD; grantee RECORD; trusted TEXT:=current_schema();
BEGIN
 REVOKE ALL ON dance_moderated_replay_retirements_v1 FROM PUBLIC CASCADE;
 FOR grantee IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_class c
 CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
 WHERE c.oid='dance_moderated_replay_retirements_v1'::regclass AND a.grantee NOT IN(0,c.relowner) LOOP
  EXECUTE format('REVOKE ALL ON dance_moderated_replay_retirements_v1 FROM %I CASCADE',grantee.name);
 END LOOP;
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace
 AND p.proname IN('guard_moderated_dance_replay_retirement_v1','drain_moderated_dance_replay_v1','persist_moderated_dance_normalization_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  IF f.oid<>'persist_moderated_dance_normalization_v1(text,text,jsonb,jsonb)'::regprocedure THEN
   FOR grantee IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(0,f.proowner) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,grantee.name);
   END LOOP;
  END IF;
 END LOOP;
END $acl$;
