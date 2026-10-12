-- Additional private controlled recovery leaves; no ordinal or runtime grant.
-- Root must install with private binder/positive inventory before composition.
SELECT pg_advisory_xact_lock(83000003,1);
CREATE FUNCTION find_owner_guest_spoken_success_for_audio_v1(
 p_access JSONB,p_community TEXT,p_session TEXT,p_item TEXT,p_key TEXT,
 p_attempt INTEGER,p_digest TEXT,p_type TEXT,p_bytes INTEGER,p_duration INTEGER
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT; cap guest_study_spoken_captures%ROWTYPE;
 sess study_sessions_v2%ROWTYPE; main_op guest_participation_operations%ROWTYPE; op JSONB;
BEGIN
 -- Access is verified initiating-browser adapter output, never a JSON body.
 -- NEW browser recovery read requires current confirmed same-origin proof;
 -- accepted internal post-I/O continuation and cron remain proof-independent.
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 PERFORM require_guest_practice_only_schema_phase_v1();
 source_id:=require_owner_guest_source_private_v1(jsonb_build_object('kind','guest','ownerId',p_access->>'ownerId'));
 IF p_community IS NULL OR char_length(p_community) NOT BETWEEN 1 AND 128
  OR p_session IS NULL OR char_length(p_session) NOT BETWEEN 1 AND 128
  OR p_item IS NULL OR char_length(p_item) NOT BETWEEN 1 AND 128
  OR p_key IS NULL OR char_length(p_key) NOT BETWEEN 1 AND 128
  OR p_attempt IS NULL OR p_attempt NOT BETWEEN 1 AND 3
  OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$'
  OR p_type IS NULL OR p_type NOT IN('audio/webm','audio/ogg','audio/mp4','audio/wav')
  OR p_bytes IS NULL OR p_bytes NOT BETWEEN 1 AND 524288
  OR p_duration IS NULL OR p_duration NOT BETWEEN 1 AND 60000 THEN
  RAISE EXCEPTION 'closed recovery audio tuple required' USING ERRCODE='GP005'; END IF;
 SELECT * INTO cap FROM guest_study_spoken_captures
  WHERE source_owner_id=source_id AND idempotency_key=p_key;
 IF NOT FOUND THEN
  PERFORM require_guest_audio_recovery_access_private_v1(p_access,source_id);
  RETURN NULL;
 END IF;
 -- Correlate and lock the original immutable source and actual credential.
 -- The accepted helper prevents crossed foreign component locking and rereads
 -- confirmed state/root. No server age or learning-lease check is introduced.
 PERFORM require_guest_audio_recovery_access_private_v1(p_access,cap.source_owner_id);
 SELECT * INTO STRICT sess FROM study_sessions_v2 WHERE session_id=cap.session_id;
 SELECT * INTO STRICT main_op FROM guest_participation_operations WHERE operation_id=cap.operation_id;
 IF ROW(sess.community_id,cap.session_id,cap.session_item_id,cap.attempt_number,
   cap.audio_digest,cap.audio_content_type,cap.audio_byte_size,cap.audio_duration_ms)
  IS DISTINCT FROM ROW(p_community,p_session,p_item,p_attempt,p_digest,p_type,p_bytes,p_duration)
  OR ROW(sess.participation_owner_id,sess.participation_owner_kind,
    main_op.source_owner_id,main_op.operation_kind,main_op.idempotency_key,main_op.request_hash,main_op.resource_scope)
  IS DISTINCT FROM ROW(source_id,'guest'::TEXT,source_id,'study_answer'::TEXT,p_key,cap.request_hash,
    guest_study_answer_resource_scope_v1(p_community,p_session,p_item,p_attempt,'spoken')) THEN
  RAISE EXCEPTION 'original recovery operation differs' USING ERRCODE='GP005'; END IF;
 op:=jsonb_build_object('sourceOwnerId',source_id,'kind','study_answer',
   'idempotencyKey',cap.idempotency_key,'requestHash',cap.request_hash);
 -- Original command/lease/hash and accepted grade come only from immutable
 -- storage. Missing CP is NULL, never authority to regrade/reclaim/redispatch.
 RETURN load_guest_spoken_success_private_v1(source_id,op,cap.command_id,cap.original_lease_token);
END $$;
CREATE FUNCTION list_guest_spoken_closed_recovery_v1(p_maximum INTEGER) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 PERFORM require_guest_practice_only_schema_phase_v1();
 IF p_maximum IS NULL OR p_maximum NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'bounded recovery scan required' USING ERRCODE='22023'; END IF;
 -- No destructive claim/expiry/reset. Several workers may replay the exact
 -- accepted continuation, whose existing callbacks serialize/idempotently end.
 -- Registered/writing/unknown upload is NOT guessed absent or re-PUT by cron.
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('checkpointId',candidate.checkpoint_id)
   ORDER BY candidate.persisted_at,candidate.checkpoint_id) FROM (
   SELECT cp.checkpoint_id,cp.persisted_at FROM guest_study_spoken_checkpoints cp
   JOIN guest_study_spoken_captures cap USING(capture_id)
   JOIN guest_participation_operations op ON op.operation_id=cap.operation_id
   JOIN learner_audio_upload_attempts upload ON upload.upload_attempt_id=cap.upload_attempt_id
   WHERE op.state='reserved' AND upload.io_state='closed'
    AND upload.storage_disposition IN('stored','failed','absent')
   ORDER BY cp.persisted_at,cp.checkpoint_id LIMIT p_maximum
  ) candidate),'[]'::JSONB);
END $$;
CREATE FUNCTION read_guest_spoken_closed_recovery_v1(p_checkpoint TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE cp guest_study_spoken_checkpoints%ROWTYPE; cap guest_study_spoken_captures%ROWTYPE;
 upload learner_audio_upload_attempts%ROWTYPE; fence learner_audio_owner_fences%ROWTYPE;
 artifact learner_audio_artifacts%ROWTYPE; op guest_participation_operations%ROWTYPE;
 source_id TEXT; operation JSONB; saved JSONB; eligible BOOLEAN; io_capture JSONB;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 PERFORM require_guest_practice_only_schema_phase_v1();
 IF p_checkpoint IS NULL OR char_length(p_checkpoint) NOT BETWEEN 1 AND 128 THEN
  RAISE EXCEPTION 'bounded checkpoint locator required' USING ERRCODE='GP005'; END IF;
 SELECT * INTO cp FROM guest_study_spoken_checkpoints WHERE checkpoint_id=p_checkpoint;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO STRICT cap FROM guest_study_spoken_captures WHERE capture_id=cp.capture_id;
 source_id:=require_owner_guest_source_private_v1(jsonb_build_object('kind','guest','ownerId',cap.source_owner_id));
 SELECT * INTO STRICT op FROM guest_participation_operations WHERE operation_id=cap.operation_id;
 IF op.state='completed' THEN RETURN NULL; END IF;
 IF op.state<>'reserved' OR ROW(op.source_owner_id,op.operation_kind,op.idempotency_key,op.request_hash)
  IS DISTINCT FROM ROW(source_id,'study_answer'::TEXT,cap.idempotency_key,cap.request_hash) THEN
  RAISE EXCEPTION 'checkpoint operation lineage differs' USING ERRCODE='GP005'; END IF;
 -- Validate actual257 full original upload/artifact/resource/digest/fence
 -- lineage. The private helper joins the accepted CP; caller locator is no proof.
 io_capture:=read_guest_audio_io_capture_private_v1(cap.upload_attempt_id);
 IF io_capture IS NULL THEN RAISE EXCEPTION 'original archive capture unavailable' USING ERRCODE='GP005'; END IF;
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=cap.upload_attempt_id;
 IF upload.io_state<>'closed' OR upload.storage_disposition IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT fence FROM learner_audio_owner_fences WHERE owner_id=source_id;
 SELECT * INTO STRICT artifact FROM learner_audio_artifacts WHERE learner_audio_artifact_id=cap.artifact_id;
 eligible:=upload.storage_disposition='stored' AND NOT upload.cleanup_required
  AND fence.revision=cap.deletion_fence_revision AND fence.active_delete_command_id IS NULL
  AND artifact.recording_state<>'deleted'
  AND NOT EXISTS(SELECT 1 FROM learner_audio_deleted_objects WHERE object_ref=upload.object_ref);
 operation:=jsonb_build_object('sourceOwnerId',source_id,'kind','study_answer',
  'idempotencyKey',cap.idempotency_key,'requestHash',cap.request_hash);
 saved:=load_guest_spoken_success_private_v1(source_id,operation,cap.command_id,cap.original_lease_token);
 IF saved IS NULL OR saved->>'checkpointId' IS DISTINCT FROM p_checkpoint THEN
  RAISE EXCEPTION 'original successful checkpoint unavailable' USING ERRCODE='GP005'; END IF;
 -- This is observed closed ledger authority, not a placeholder archive failure.
 -- ACK and finalizer rederive eligibility under existing ordered locks; a fence
 -- between this read and ACK cannot resurrect publication or erase the grade.
 RETURN jsonb_build_object('saved',saved,'archive',CASE WHEN eligible THEN
  jsonb_build_object('state','stored','objectRef',upload.object_ref)
  ELSE jsonb_build_object('state','failed','objectRef',NULL) END);
END $$;
DO $bind_guest_spoken_recovery$
DECLARE signature TEXT; namespace_id OID; owner_id OID; schema_name TEXT; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF schema_name IS NULL OR schema_name='pg_catalog' OR schema_name ~ '^pg_temp' THEN
  RAISE EXCEPTION 'trusted guest recovery schema required'; END IF;
 FOREACH signature IN ARRAY ARRAY[
  'find_owner_guest_spoken_success_for_audio_v1(jsonb,text,text,text,text,integer,text,text,integer,integer)',
  'list_guest_spoken_closed_recovery_v1(integer)','read_guest_spoken_closed_recovery_v1(text)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure AND f.pronamespace=namespace_id AND f.proowner=owner_id) THEN
   RAISE EXCEPTION 'guest recovery function provenance differs'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $bind_guest_spoken_recovery$;

-- OUTSIDE SOURCE PROPOSAL. No ordinal, runtime EXECUTE grant or activation.
-- Requires the independently reviewed/adopted private recovery-access helper.
-- Trusted p_access is the browser adapter's digest-verified RecoveryAccess,
-- never request JSON. This is an economic-participation list, not Study history.
SELECT pg_advisory_xact_lock(83000003,1);

CREATE FUNCTION list_guest_practice_participations_v1(
 p_access JSONB,p_cursor TEXT,p_limit INTEGER
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE phase_name TEXT; source_ids TEXT[];
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  OR (p_cursor IS NOT NULL AND (char_length(p_cursor) NOT BETWEEN 1 AND 128
   OR p_cursor ~ '[[:space:][:cntrl:]]')) THEN
  RAISE EXCEPTION 'invalid bounded participation page' USING ERRCODE='22023'; END IF;
 -- Stabilize the positive phase witness before the C-sorted component locks.
 -- All admitted schema/topology transitions take the exclusive barrier first.
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 PERFORM require_guest_practice_only_schema_phase_v1();
 SELECT phase INTO phase_name FROM guest_learning_schema_phase WHERE singleton FOR SHARE;
 -- Keep this literal here even when accounting replaces the shared predicate:
 -- an old practice reader MUST NOT silently erase newly admitted liabilities.
 IF NOT FOUND OR phase_name IS DISTINCT FROM 'practice_only_owner_spoken_checkpoint_history_v4' THEN
  RAISE EXCEPTION 'practice participation reader unavailable' USING ERRCODE='GP003'; END IF;
 source_ids:=require_guest_audio_recovery_access_private_v1(p_access,p_access->>'ownerId');
 -- Recovery deliberately ignores learning-lease/credential age. The helper
 -- rechecks confirmed state, exact origin, original credential provenance,
 -- effective root and complete component after locks, without creating a fence.
 IF EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=ANY(source_ids) AND kind<>'guest')
  OR EXISTS(SELECT 1 FROM study_sessions_v2 WHERE participation_owner_id=ANY(source_ids)
   AND (participation_owner_kind IS DISTINCT FROM 'guest'
    OR guest_reward_mode IS DISTINCT FROM 'practice_only' OR guest_reward_terms IS NOT NULL
    OR account_id IS NOT NULL OR persona_id IS NOT NULL OR telegram_practice_only IS NOT FALSE)) THEN
  RAISE EXCEPTION 'practice source inventory differs' USING ERRCODE='GP003'; END IF;
 -- The positive native inventory excludes every accepted guest financial family;
 -- existing qualifications/shares/credits remain account-only. Immutable guest
 -- session guards plus the scoped persisted-mode check permanently exclude
 -- practice sessions from admission. Nonempty learning history remains intact.
 RETURN jsonb_build_object('items','[]'::JSONB,'nextCursor',NULL);
END $$;

DO $bind_practice_participation_reader$
DECLARE trusted_namespace OID; trusted_owner OID; trusted_schema TEXT; actual_owner OID;
 actual_namespace OID; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT trusted_namespace,trusted_owner,trusted_schema
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 SELECT pronamespace,proowner INTO STRICT actual_namespace,actual_owner FROM pg_proc
 WHERE oid='list_guest_practice_participations_v1(jsonb,text,integer)'::regprocedure;
 IF actual_namespace<>trusted_namespace OR actual_owner<>trusted_owner
  OR trusted_schema='information_schema' OR trusted_schema LIKE 'pg_%' THEN
  RAISE EXCEPTION 'private participation reader custody differs'; END IF;
 ALTER FUNCTION list_guest_practice_participations_v1(JSONB,TEXT,INTEGER) SECURITY DEFINER;
 EXECUTE format('ALTER FUNCTION list_guest_practice_participations_v1(jsonb,text,integer) SET search_path TO pg_catalog,%I,pg_temp',trusted_schema);
 REVOKE ALL ON FUNCTION list_guest_practice_participations_v1(JSONB,TEXT,INTEGER) FROM PUBLIC;
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
 FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
 WHERE f.oid='list_guest_practice_participations_v1(jsonb,text,integer)'::regprocedure
  AND a.grantee<>0 AND a.grantee<>f.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION list_guest_practice_participations_v1(jsonb,text,integer) FROM %I',grantee_name); END LOOP;
END $bind_practice_participation_reader$;
