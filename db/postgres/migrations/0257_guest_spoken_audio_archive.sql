-- Private guest captured archive callbacks; no serving/runtime grants.
SELECT pg_advisory_xact_lock(83000003,1);

-- Standalone guest-only sidecar: no account capture tables or new guest authority.
-- Requires actual253 and accepted guest_study_spoken_{captures,checkpoints}.
-- All functions are bounded private callbacks. No raw253 runtime grant.
CREATE FUNCTION read_guest_audio_io_capture_private_v1(p_upload TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSONB;
BEGIN
 SELECT jsonb_build_object('uploadAttemptId',cap.upload_attempt_id,'sourceOwnerId',cap.source_owner_id,
  'artifactId',cap.artifact_id,'sourceKind','study','attemptRef',cap.attempt_id,'commandRef',cap.command_id,
  'reservationRef',u.reservation_ref,'capturedRevision',cap.deletion_fence_revision,'objectRef',u.object_ref,
  'contentDigest',cap.audio_digest,'contentType',cap.audio_content_type,'byteSize',cap.audio_byte_size,'durationMs',cap.audio_duration_ms)
 INTO STRICT result FROM guest_study_spoken_captures cap JOIN guest_study_spoken_checkpoints cp USING(capture_id)
  JOIN learner_audio_upload_attempts u ON u.upload_attempt_id=cap.upload_attempt_id
  WHERE cap.upload_attempt_id=p_upload AND u.owner_id=cap.source_owner_id AND u.artifact_id=cap.artifact_id
   AND u.source_kind='study' AND u.attempt_ref=cap.attempt_id AND u.command_ref=cap.command_id
   AND u.reservation_ref=cap.resource_reservation_id AND u.captured_revision=cap.deletion_fence_revision
   AND u.object_ref='learner-audio/study/'||cap.attempt_id||'/'||cap.audio_digest;
 RETURN result;
END $$;
CREATE FUNCTION require_guest_audio_io_capture_private_v1(p_capture JSONB) RETURNS TEXT
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT:=p_capture->>'uploadAttemptId';
BEGIN
 IF p_capture IS NULL OR read_guest_audio_io_capture_private_v1(upload_id) IS DISTINCT FROM p_capture THEN
  RAISE EXCEPTION 'original archive capture differs' USING ERRCODE='GP005'; END IF;
 RETURN upload_id;
END $$;
CREATE FUNCTION resolve_guest_audio_io_capture_private_v1(p_source JSONB,p_operation JSONB,p_artifact TEXT,p_reservation TEXT,p_revision BIGINT,p_digest TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT; source_id TEXT;
BEGIN
 source_id:=require_owner_guest_source_private_v1(p_source);
 PERFORM validate_guest_resource_operation_v1(source_id,p_operation,'study_answer');
 IF p_source IS NULL OR p_source-ARRAY['kind','ownerId']<>'{}'::JSONB
  OR p_source->>'kind'<>'guest' OR p_operation->>'kind'<>'study_answer'
  OR p_operation->>'sourceOwnerId' IS DISTINCT FROM p_source->>'ownerId' THEN RAISE EXCEPTION 'original archive source differs' USING ERRCODE='GP005'; END IF;
 SELECT cap.upload_attempt_id INTO STRICT upload_id FROM guest_study_spoken_captures cap
  JOIN guest_study_spoken_checkpoints cp USING(capture_id)
  WHERE cap.source_owner_id=p_source->>'ownerId' AND cap.idempotency_key=p_operation->>'idempotencyKey'
   AND cap.request_hash=p_operation->>'requestHash' AND cap.artifact_id=p_artifact
   AND cap.resource_reservation_id=p_reservation AND cap.deletion_fence_revision=p_revision AND cap.audio_digest=p_digest;
 RETURN read_guest_audio_io_capture_private_v1(upload_id);
END $$;
CREATE FUNCTION claim_guest_audio_io_private_v1(p_capture JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT; claimed BOOLEAN; upload learner_audio_upload_attempts%ROWTYPE; fence learner_audio_owner_fences%ROWTYPE;
BEGIN
 upload_id:=require_guest_audio_io_capture_private_v1(p_capture);
 claimed:=claim_learner_audio_upload_private_v1(upload_id);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=upload_id;
 SELECT * INTO STRICT fence FROM learner_audio_owner_fences WHERE owner_id=upload.owner_id;
 RETURN jsonb_build_object('capture',p_capture,'claimed',claimed,'ioState',upload.io_state,
  'storageDisposition',upload.storage_disposition,'cleanupRequired',upload.cleanup_required,
  'mayContinue',upload.io_state='writing' AND fence.revision=upload.captured_revision AND fence.active_delete_command_id IS NULL,
  'mayPublish',upload.io_state='closed' AND upload.storage_disposition='stored' AND NOT upload.cleanup_required
   AND fence.revision=upload.captured_revision AND fence.active_delete_command_id IS NULL);
END $$;
CREATE FUNCTION settle_guest_audio_io_private_v1(p_capture JSONB,p_disposition TEXT,p_known BOOLEAN) RETURNS BOOLEAN
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT;
BEGIN
 upload_id:=require_guest_audio_io_capture_private_v1(p_capture);
 RETURN settle_learner_audio_upload_private_v1(upload_id,p_disposition,p_known,NULL);
END $$;
DO $pin_guest_audio_io_leaf$
DECLARE signature TEXT; grantee_name TEXT; trusted_schema TEXT; trusted_namespace OID; trusted_owner OID;
BEGIN
 SELECT relation.relnamespace,relation.relowner,namespace.nspname INTO STRICT trusted_namespace,trusted_owner,trusted_schema
  FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE relation.oid='participation_owners'::regclass;
 IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN RAISE EXCEPTION 'trusted capture schema required'; END IF;
 FOREACH signature IN ARRAY ARRAY['read_guest_audio_io_capture_private_v1(text)','require_guest_audio_io_capture_private_v1(jsonb)',
  'resolve_guest_audio_io_capture_private_v1(jsonb,jsonb,text,text,bigint,text)',
  'claim_guest_audio_io_private_v1(jsonb)','settle_guest_audio_io_private_v1(jsonb,text,boolean)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc function WHERE function.oid=signature::regprocedure
   AND function.pronamespace=trusted_namespace AND function.proowner=trusted_owner) THEN
   RAISE EXCEPTION 'guest audio callback owner/namespace differs'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 END LOOP;
END $pin_guest_audio_io_leaf$;
