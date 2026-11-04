-- Ordinary Study explicit refusal settlement. No billing or paid allowance
-- assertion, no historical unknown reset, no session abandonment.
SELECT pg_advisory_xact_lock(83000003,1);
ALTER TABLE learner_audio_account_provider_calls ADD COLUMN refusal_http_status INTEGER
 CHECK (refusal_http_status IN (400,401,403,413,415,422,429));
ALTER TABLE learner_audio_account_provider_calls ADD CONSTRAINT account_provider_refusal_terminal
 CHECK (refusal_http_status IS NULL OR state='known_failed');

CREATE OR REPLACE FUNCTION guard_account_audio_provider_call_private_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'provider outcome evidence retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','resolved_at','refusal_http_status']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','resolved_at','refusal_http_status']) THEN
   RAISE EXCEPTION 'provider identity differs'; END IF;
 IF OLD.refusal_http_status IS NOT NULL AND NEW.refusal_http_status IS DISTINCT FROM OLD.refusal_http_status THEN
   RAISE EXCEPTION 'provider refusal evidence differs'; END IF;
 IF OLD.state IN('known_failed','succeeded') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
   RAISE EXCEPTION 'terminal provider outcome differs'; END IF;
 IF NOT ((OLD.state='registered' AND NEW.state IN('registered','started','known_failed'))
  OR (OLD.state IN('started','unknown') AND NEW.state IN('unknown','known_failed','succeeded'))
  OR (OLD.state IN('known_failed','succeeded') AND NEW.state=OLD.state)) THEN
   RAISE EXCEPTION 'provider state transition differs'; END IF;
 RETURN NEW;
END $$;

-- The callback supplies the exact original private capture, not a current lease.
-- A successful acknowledgement may be replayed after a newer generation begins;
-- it never changes the new generation. Conflicting or forged evidence refuses.
CREATE FUNCTION settle_account_spoken_provider_refusal_private_v1(p_capture JSONB,p_status INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT; captured learner_audio_account_producer_captures%ROWTYPE;
 provider learner_audio_account_provider_calls%ROWTYPE; command study_spoken_answer_commands%ROWTYPE;
 artifact learner_audio_artifacts%ROWTYPE; upload learner_audio_upload_attempts%ROWTYPE;
 at_time TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF p_status IS NULL OR p_status NOT IN(400,401,403,413,415,422,429) THEN
   RAISE EXCEPTION 'explicit unsuccessful response required'; END IF;
 upload_id:=require_captured_learner_audio_private_v1(p_capture);
 SELECT * INTO STRICT captured FROM learner_audio_account_producer_captures
  WHERE upload_attempt_id=upload_id AND source_kind='study';
 PERFORM lock_original_account_audio_source_private_v1(captured.account_id);
 PERFORM require_captured_learner_audio_private_v1(p_capture);
 SELECT * INTO STRICT provider FROM learner_audio_account_provider_calls WHERE upload_attempt_id=upload_id FOR UPDATE;
 IF provider.state='known_failed' AND provider.refusal_http_status=p_status THEN RETURN; END IF;
 -- Unknown means there is no retained conclusive response. Only a separately
 -- reviewed operator reconciliation may resolve it; this callback cannot.
 IF provider.owner_id<>captured.owner_id OR provider.state<>'started'
  OR EXISTS(SELECT 1 FROM learner_audio_account_spoken_checkpoints WHERE upload_attempt_id=upload_id)
  OR EXISTS(SELECT 1 FROM learner_audio_upload_terminal_facts WHERE upload_attempt_id=upload_id) THEN
   RAISE EXCEPTION 'provider refusal conflicts with retained outcome'; END IF;
 SELECT * INTO STRICT command FROM study_spoken_answer_commands WHERE command_id=captured.command_ref FOR UPDATE;
 SELECT * INTO STRICT artifact FROM learner_audio_artifacts WHERE learner_audio_artifact_id=captured.artifact_id FOR UPDATE;
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=upload_id FOR UPDATE;
 IF command.state<>'reserved' OR ROW(command.account_id,command.participation_owner_id,command.lease_token,
   command.attempt_id,command.learner_audio_artifact_id,command.request_hash,command.audio_digest,
   command.session_id,command.session_item_id,command.attempt_number,command.idempotency_key)
   IS DISTINCT FROM ROW(captured.account_id,captured.owner_id,captured.producer_generation,
   captured.attempt_ref,captured.artifact_id,captured.request_hash,captured.content_digest,
   captured.session_id,captured.session_item_id,captured.attempt_number,captured.idempotency_key)
  OR artifact.account_id IS DISTINCT FROM captured.account_id OR artifact.participation_owner_id<>captured.owner_id
  OR artifact.recording_state<>'pending' OR artifact.content_digest<>captured.content_digest
  OR upload.io_state<>'registered' OR upload.cleanup_required THEN
   RAISE EXCEPTION 'provider refusal generation or storage differs'; END IF;
 IF NOT close_unclaimed_learner_audio_private_v1(upload_id) THEN
   RAISE EXCEPTION 'provider refusal cannot close claimed storage'; END IF;
 UPDATE learner_audio_account_provider_calls SET state='known_failed',resolved_at=at_time,refusal_http_status=p_status
   WHERE upload_attempt_id=upload_id;
 UPDATE study_spoken_answer_commands SET state='retryable_failed',completed_at=at_time,
   provider_failure_kind='provider_refused' WHERE command_id=captured.command_ref;
 UPDATE learner_audio_artifacts SET recording_state='failed' WHERE learner_audio_artifact_id=captured.artifact_id;
END $$;

-- Safe current-card projection, with no provider response, transcript, upload or
-- command identity exposed. Live in-flight calls are not reported as unknown.
CREATE FUNCTION read_account_study_spoken_block_private_v1(p_account TEXT,p_session TEXT,p_community TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT jsonb_build_object('state','provider_outcome_unknown','session_item_id',c.session_item_id,
   'attempt_number',c.attempt_number,'next_action','operator_review')
 FROM study_sessions_v2 s
 JOIN learner_audio_account_producer_captures c ON c.session_id=s.session_id
   AND c.account_id=s.account_id AND c.owner_id=s.participation_owner_id AND c.source_kind='study'
   AND c.session_item_id=s.current_session_item_id
 JOIN learner_audio_account_provider_calls p USING(upload_attempt_id)
 JOIN study_spoken_answer_commands command ON command.command_id=c.command_ref
 WHERE s.account_id=p_account AND s.session_id=p_session AND s.community_id=p_community AND s.status='active'
  AND active_activity_persona(s.account_id,s.persona_id,s.community_id)
  AND can_account_access_activity_song(s.account_id,s.community_id,s.post_id)
  AND (p.state='unknown' OR (p.state IN('registered','started') AND command.lease_expires_at<=clock_timestamp()))
  AND NOT EXISTS(SELECT 1 FROM learner_audio_account_spoken_checkpoints cp WHERE cp.upload_attempt_id=c.upload_attempt_id)
 ORDER BY c.created_at,c.upload_attempt_id LIMIT 1
$$;

CREATE FUNCTION require_account_study_spoken_available_private_v1(p_account TEXT,p_session TEXT,p_item TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE blocked JSONB; community TEXT;
BEGIN
 SELECT community_id INTO community FROM study_sessions_v2 WHERE session_id=p_session AND account_id=p_account;
 blocked:=read_account_study_spoken_block_private_v1(p_account,p_session,community);
 IF blocked->>'session_item_id'=p_item THEN
   RAISE EXCEPTION 'Study provider outcome requires review' USING ERRCODE='SP001'; END IF;
END $$;

CREATE OR REPLACE FUNCTION capture_account_study_audio_private_v1(p_account TEXT,p_command TEXT,p_lease TEXT,p_upload TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT; command study_spoken_answer_commands%ROWTYPE;
 artifact learner_audio_artifacts%ROWTYPE; prior learner_audio_account_producer_captures%ROWTYPE;
 revision BIGINT; generation_ref TEXT; session study_sessions_v2%ROWTYPE; item study_session_items_v2%ROWTYPE;
BEGIN
 source_id:=lock_original_account_audio_source_private_v1(p_account);
 SELECT * INTO STRICT command FROM study_spoken_answer_commands WHERE command_id=p_command AND account_id=p_account FOR UPDATE;
 SELECT * INTO STRICT artifact FROM learner_audio_artifacts WHERE learner_audio_artifact_id=command.learner_audio_artifact_id FOR UPDATE;
 IF command.state<>'reserved' OR command.lease_token IS DISTINCT FROM p_lease
  OR command.lease_expires_at<=clock_timestamp() OR command.participation_owner_id<>source_id
  OR artifact.participation_owner_id<>source_id OR artifact.account_id IS DISTINCT FROM p_account
  OR artifact.source_kind<>'study' OR artifact.attempt_ref<>command.attempt_id
  OR artifact.content_digest<>command.audio_digest THEN RAISE EXCEPTION 'account capture provenance differs'; END IF;
 SELECT * INTO prior FROM learner_audio_account_producer_captures
  WHERE owner_id=source_id AND source_kind='study' AND command_ref=p_command AND producer_generation=p_lease;
 IF FOUND THEN RETURN jsonb_build_object('uploadAttemptId',prior.upload_attempt_id,
  'sourceOwnerId',source_id,'artifactId',prior.artifact_id,'sourceKind','study','attemptRef',prior.attempt_ref,
  'commandRef',prior.command_ref,'reservationRef',prior.reservation_ref,'capturedRevision',prior.captured_revision,
  'objectRef',prior.expected_object_ref,'contentDigest',prior.content_digest,'contentType',prior.content_type,'byteSize',prior.byte_size,'durationMs',prior.duration_ms); END IF;
 -- This SQLSTATE names only unresolved provider generations, never general
 -- storage/checkpoint constraints. Reclaim is rolled back with this refusal.
 IF EXISTS(SELECT 1 FROM learner_audio_account_producer_captures c
   JOIN learner_audio_account_provider_calls p USING(upload_attempt_id)
   WHERE c.owner_id=source_id AND c.command_ref=p_command
     AND p.state IN('registered','started','unknown')
     AND NOT EXISTS(SELECT 1 FROM learner_audio_account_spoken_checkpoints cp
       WHERE cp.upload_attempt_id=c.upload_attempt_id)) THEN
   RAISE EXCEPTION 'Study provider outcome requires review' USING ERRCODE='SP001'; END IF;
 -- All unresolved older generations block reclaim; lease expiry is no I/O fact.
 IF EXISTS(SELECT 1 FROM learner_audio_account_producer_captures c JOIN learner_audio_upload_attempts u USING(upload_attempt_id)
  WHERE c.owner_id=source_id AND c.command_ref=p_command AND (u.io_state<>'closed' OR u.cleanup_required))
  OR EXISTS(SELECT 1 FROM learner_audio_account_spoken_checkpoints cp JOIN learner_audio_account_producer_captures c USING(upload_attempt_id)
   WHERE c.owner_id=source_id AND c.command_ref=p_command)
 THEN
  RAISE EXCEPTION 'prior captured generation requires reconciliation'; END IF;
 generation_ref:=jsonb_build_array('account_study_audio_generation_v1',p_command,p_lease)::TEXT;
 SELECT COALESCE((SELECT f.revision FROM learner_audio_owner_fences f WHERE f.owner_id=source_id),0) INTO revision;
 SELECT * INTO STRICT session FROM study_sessions_v2 WHERE session_id=command.session_id AND participation_owner_id=source_id;
 SELECT * INTO STRICT item FROM study_session_items_v2 WHERE session_item_id=command.session_item_id
  AND session_id=session.session_id AND participation_owner_id=source_id;
 revision:=register_learner_audio_upload_private_v1(source_id,artifact.learner_audio_artifact_id,'study',command.attempt_id,
  command.command_id,generation_ref,artifact.expected_object_ref,p_upload,revision);
 INSERT INTO learner_audio_account_producer_captures(upload_attempt_id,owner_id,account_id,artifact_id,source_kind,
  attempt_ref,command_ref,producer_generation,reservation_ref,captured_revision,expected_object_ref,content_digest,
  content_type,byte_size,duration_ms,session_id,session_item_id,attempt_number,idempotency_key,request_hash,community_id,item_snapshot)
 VALUES(p_upload,source_id,p_account,artifact.learner_audio_artifact_id,'study',command.attempt_id,p_command,p_lease,
  generation_ref,revision,artifact.expected_object_ref,command.audio_digest,command.audio_content_type,command.audio_byte_size,command.audio_duration_ms,
  command.session_id,command.session_item_id,command.attempt_number,command.idempotency_key,command.request_hash,session.community_id,item.item_snapshot);
 RETURN jsonb_build_object('uploadAttemptId',p_upload,'sourceOwnerId',source_id,'artifactId',artifact.learner_audio_artifact_id,
  'sourceKind','study','attemptRef',command.attempt_id,'commandRef',p_command,'reservationRef',generation_ref,
  'capturedRevision',revision,'objectRef',artifact.expected_object_ref,'contentDigest',command.audio_digest,
  'contentType',command.audio_content_type,'byteSize',command.audio_byte_size,'durationMs',command.audio_duration_ms);
END $$;

-- Keep replacements pinned and make new entry points owner-only even when the
-- database has permissive default privileges. Runtime grants are reviewed apart.
DO $pin_study_refusal$
DECLARE signature TEXT; namespace_id OID; owner_id OID; schema_name TEXT; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 FOREACH signature IN ARRAY ARRAY[
  'guard_account_audio_provider_call_private_v1()',
  'settle_account_spoken_provider_refusal_private_v1(jsonb,integer)',
  'read_account_study_spoken_block_private_v1(text,text,text)',
  'require_account_study_spoken_available_private_v1(text,text,text)',
  'capture_account_study_audio_private_v1(text,text,text,text)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure
    AND f.pronamespace=namespace_id AND f.proowner=owner_id) THEN RAISE EXCEPTION 'Study function custody differs'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
    CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
    WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $pin_study_refusal$;
