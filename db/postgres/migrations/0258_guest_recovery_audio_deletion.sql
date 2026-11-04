-- Genuine production-source leaf proposal, not a test wrapper. No ordinal.
-- Actual248..257 parents; one owned transaction, no raw253 runtime grants.
-- Access is verified browser adapter output, never a JSON body. Ordinary account
-- binding remains closed until actual association/accounting authority exists.
SELECT pg_advisory_xact_lock(83000003,1);
CREATE FUNCTION require_guest_audio_recovery_access_private_v1(p_access JSONB,p_source TEXT) RETURNS TEXT[]
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE sources TEXT[]; credential guest_credentials%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 PERFORM require_guest_practice_only_schema_phase_v1();
 IF p_access IS NULL OR jsonb_typeof(p_access) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(p_access))<>4 OR NOT(p_access ?& ARRAY['kind','ownerId','credentialId','origin'])
  OR p_access->>'kind' IS DISTINCT FROM 'guest'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['kind','ownerId','credentialId','origin']) field WHERE jsonb_typeof(p_access->field) IS DISTINCT FROM 'string')
  OR p_access->>'ownerId' IS DISTINCT FROM resolve_guest_empty_owner_root_v1(p_source)
  OR NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=p_source AND kind='guest') THEN
  RAISE EXCEPTION 'recovery source mismatch' USING ERRCODE='GP002'; END IF;
 -- Topology is stable, so correlate the proved credential's immutable owner
 -- BEFORE locking any component. A malformed A-source/B-proof pair never locks
 -- separate components in the opposite order. State/root are reread afterward.
 SELECT * INTO credential FROM guest_credentials WHERE credential_id=p_access->>'credentialId' AND origin=p_access->>'origin';
 IF NOT FOUND OR credential.state<>'confirmed' THEN RAISE EXCEPTION 'recovery proof revoked' USING ERRCODE='GP001'; END IF;
 IF resolve_guest_empty_owner_root_v1(credential.owner_id) IS DISTINCT FROM resolve_guest_empty_owner_root_v1(p_source) THEN
  RAISE EXCEPTION 'recovery source mismatch' USING ERRCODE='GP002'; END IF;
 sources:=learner_audio_source_component_private_v1(ARRAY[p_source]);
 PERFORM lock_learner_audio_sources_private_v1(sources);
 PERFORM lock_guest_authority_sources_v1(p_access->>'origin',ARRAY[p_access->>'credentialId']);
 SELECT * INTO credential FROM guest_credentials WHERE credential_id=p_access->>'credentialId' AND origin=p_access->>'origin';
 IF NOT FOUND OR credential.state<>'confirmed' THEN RAISE EXCEPTION 'recovery proof revoked' USING ERRCODE='GP001'; END IF;
 IF resolve_guest_empty_owner_root_v1(credential.owner_id) IS DISTINCT FROM resolve_guest_empty_owner_root_v1(p_source) THEN
  RAISE EXCEPTION 'recovery source mismatch' USING ERRCODE='GP002'; END IF;
 -- Confirmed recovery has no server age or learning-lease expiry.
 RETURN sources;
END $$;
CREATE FUNCTION validate_guest_recovery_operation_private_v1(p_operation JSONB,p_kind TEXT) RETURNS TEXT
 LANGUAGE plpgsql AS $$
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN('learner_audio_deletion','learning_retention') OR p_operation IS NULL OR jsonb_typeof(p_operation) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(p_operation))<>4
  OR NOT(p_operation ?& ARRAY['sourceOwnerId','kind','idempotencyKey','requestHash'])
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['sourceOwnerId','kind','idempotencyKey','requestHash']) field WHERE jsonb_typeof(p_operation->field) IS DISTINCT FROM 'string')
  OR char_length(p_operation->>'sourceOwnerId') NOT BETWEEN 1 AND 128 OR p_operation->>'kind' IS DISTINCT FROM p_kind
  OR char_length(p_operation->>'idempotencyKey') NOT BETWEEN 1 AND 128 OR p_operation->>'requestHash' !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'invalid recovery operation' USING ERRCODE='GP005'; END IF;
 RETURN p_operation->>'sourceOwnerId';
END $$;
CREATE FUNCTION read_guest_owner_audio_delete_batch_private_v1(p_batch TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE batch learner_audio_delete_batches%ROWTYPE; command learner_audio_delete_commands%ROWTYPE; result JSONB;
BEGIN
 SELECT * INTO STRICT batch FROM learner_audio_delete_batches WHERE batch_id=p_batch;
 SELECT * INTO STRICT command FROM learner_audio_delete_commands WHERE command_id=batch.command_id;
 IF EXISTS(SELECT 1 FROM learner_audio_delete_sources s JOIN participation_owners o USING(owner_id)
  WHERE s.command_id=command.command_id AND o.kind<>'guest') THEN RAISE EXCEPTION 'guest deletion sources differ' USING ERRCODE='GP002'; END IF;
 SELECT jsonb_build_object('operation',jsonb_build_object('sourceOwnerId',command.source_owner_id,'kind','learner_audio_deletion','idempotencyKey',command.idempotency_key,'requestHash',command.request_hash),
 'batchId',batch.batch_id,'fenceRevision',batch.revision,
 'sourceOwnerIds',(SELECT jsonb_agg(owner_id ORDER BY convert_to(owner_id,'UTF8')) FROM learner_audio_delete_sources WHERE command_id=command.command_id),
 'artifacts',COALESCE((SELECT jsonb_agg(jsonb_build_object('artifactId',artifact_id,'source',jsonb_build_object('kind','guest','ownerId',owner_id),'objectRef',object_ref) ORDER BY ordinal) FROM learner_audio_delete_batch_items WHERE batch_id=batch.batch_id),'[]'::JSONB),
 'providerDisposition',command.provider_disposition) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION guest_owner_audio_delete_projection_private_v1(p_command TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command learner_audio_delete_commands%ROWTYPE; deleted_count BIGINT; remaining_count BIGINT;
BEGIN
 SELECT * INTO STRICT command FROM learner_audio_delete_commands WHERE command_id=p_command;
 IF command.state='completed' THEN RETURN command.final_result; END IF;
 SELECT count(*) FILTER(WHERE a.recording_state='deleted'),count(*) FILTER(WHERE COALESCE(a.recording_state,'unpublished')<>'deleted')
 INTO deleted_count,remaining_count FROM learner_audio_delete_target_artifacts target
 LEFT JOIN learner_audio_artifacts a ON a.learner_audio_artifact_id=target.artifact_id AND a.participation_owner_id=target.owner_id
 WHERE target.command_id=p_command;
 RETURN jsonb_build_object('operation',jsonb_build_object('operation_kind','learner_audio_deletion','idempotency_key',command.idempotency_key,'operation_id',command.command_id),
 'state','pending','deleted_count',deleted_count,'remaining_count',remaining_count,'provider_disposition',command.provider_disposition);
END $$;
CREATE FUNCTION prepare_guest_owner_audio_delete_v1(p_access JSONB,p_operation JSONB,p_maximum INTEGER) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT; sources TEXT[]; selected_batch TEXT; command learner_audio_delete_commands%ROWTYPE;
BEGIN
 source_id:=validate_guest_recovery_operation_private_v1(p_operation,'learner_audio_deletion');
 sources:=require_guest_audio_recovery_access_private_v1(p_access,source_id);
 IF p_maximum IS NULL OR p_maximum NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'batch bound1..1000 required' USING ERRCODE='22023'; END IF;
 IF resolve_guest_empty_owner_root_v1(source_id)<>source_id OR NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=source_id AND state IN('empty','established')) THEN RAISE EXCEPTION 'active deletion source required' USING ERRCODE='GP002'; END IF;
 SELECT * INTO command FROM learner_audio_delete_commands WHERE source_owner_id=source_id AND idempotency_key=p_operation->>'idempotencyKey';
 IF FOUND THEN
  IF command.request_hash<>p_operation->>'requestHash' THEN RAISE EXCEPTION 'deletion key conflict' USING ERRCODE='GP005'; END IF;
 ELSIF EXISTS(SELECT 1 FROM learner_audio_owner_fences WHERE owner_id=ANY(sources) AND active_delete_command_id IS NOT NULL) THEN
  RAISE EXCEPTION 'original deletion remains pending' USING ERRCODE='GD001'; END IF;
 selected_batch:=prepare_learner_audio_delete_private_v1(source_id,p_operation->>'idempotencyKey',p_operation->>'requestHash',
  'audio_delete_'||gen_random_uuid()::TEXT,sources,'audio_batch_'||gen_random_uuid()::TEXT,p_maximum,'unknown');
 IF selected_batch IS NULL THEN
  SELECT * INTO STRICT command FROM learner_audio_delete_commands WHERE source_owner_id=source_id AND idempotency_key=p_operation->>'idempotencyKey';
  SELECT batch_id INTO STRICT selected_batch FROM learner_audio_delete_batches WHERE command_id=command.command_id AND state='confirmed' ORDER BY created_at DESC,batch_id DESC LIMIT 1;
 END IF;
 RETURN jsonb_build_object('state','completed','operation',p_operation,'outcomeId',selected_batch,'result',read_guest_owner_audio_delete_batch_private_v1(selected_batch));
END $$;
CREATE FUNCTION confirm_guest_owner_audio_delete_v1(p_batch JSONB,p_fact TEXT,p_deleted_at TIMESTAMPTZ) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE selected_batch TEXT; command_id TEXT; original JSONB;
BEGIN
 selected_batch:=p_batch->>'batchId';original:=read_guest_owner_audio_delete_batch_private_v1(selected_batch);
 IF p_batch IS DISTINCT FROM original THEN RAISE EXCEPTION 'original deletion batch differs' USING ERRCODE='GP005'; END IF;
 -- Original immutable command/source/revision survive proof revocation or lease
 -- loss after external DELETE. No renewed authority is required for callback.
 PERFORM confirm_learner_audio_delete_private_v1(selected_batch,(original->>'fenceRevision')::BIGINT,p_fact,p_deleted_at);
 SELECT b.command_id INTO STRICT command_id FROM learner_audio_delete_batches b WHERE b.batch_id=selected_batch;
 RETURN jsonb_build_object('state','completed','operation',original->'operation','outcomeId',command_id,'result',guest_owner_audio_delete_projection_private_v1(command_id));
END $$;
CREATE FUNCTION fail_guest_owner_audio_delete_v1(p_batch JSONB,p_fact TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE selected_batch TEXT; command_id TEXT; original JSONB;
BEGIN
 selected_batch:=p_batch->>'batchId';original:=read_guest_owner_audio_delete_batch_private_v1(selected_batch);
 IF p_batch IS DISTINCT FROM original THEN RAISE EXCEPTION 'original deletion batch differs' USING ERRCODE='GP005'; END IF;
 PERFORM fail_learner_audio_delete_private_v1(selected_batch,p_fact);
 SELECT b.command_id INTO STRICT command_id FROM learner_audio_delete_batches b WHERE b.batch_id=selected_batch;
 RETURN jsonb_build_object('state','completed','operation',original->'operation','outcomeId',command_id,'result',guest_owner_audio_delete_projection_private_v1(command_id));
END $$;
CREATE FUNCTION find_guest_owner_audio_delete_v1(p_access JSONB,p_source TEXT,p_key TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command_id TEXT;
BEGIN
 PERFORM require_guest_audio_recovery_access_private_v1(p_access,p_source);
 IF p_key IS NULL OR char_length(p_key) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'invalid deletion key' USING ERRCODE='GP005'; END IF;
 SELECT c.command_id INTO command_id FROM learner_audio_delete_commands c WHERE source_owner_id=p_source AND idempotency_key=p_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'deletion operation not found' USING ERRCODE='GP004'; END IF;
 RETURN guest_owner_audio_delete_projection_private_v1(command_id);
END $$;
CREATE FUNCTION set_guest_learning_retention_v1(p_access JSONB,p_operation JSONB,p_mode TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT; operation guest_participation_operations%ROWTYPE; scope TEXT; at_time TIMESTAMPTZ; result JSONB;
BEGIN
 source_id:=validate_guest_recovery_operation_private_v1(p_operation,'learning_retention');
 PERFORM require_guest_audio_recovery_access_private_v1(p_access,source_id);
 IF p_mode IS NULL OR p_mode NOT IN('private_learning','ephemeral') THEN RAISE EXCEPTION 'invalid retention mode' USING ERRCODE='22023'; END IF;
 IF resolve_guest_empty_owner_root_v1(source_id)<>source_id THEN RAISE EXCEPTION 'active retention source required' USING ERRCODE='GP002'; END IF;
 scope:=jsonb_build_array('guest_learning_retention_v1',source_id,p_mode)::TEXT;
 SELECT * INTO operation FROM guest_participation_operations WHERE source_owner_id=source_id AND operation_kind='learning_retention' AND idempotency_key=p_operation->>'idempotencyKey' FOR UPDATE;
 IF FOUND THEN
  IF operation.request_hash<>p_operation->>'requestHash' OR operation.resource_scope<>scope THEN RAISE EXCEPTION 'retention key conflict' USING ERRCODE='GP005'; END IF;
  IF operation.state='completed' THEN RETURN jsonb_build_object('state','completed','operation',p_operation,'outcomeId',operation.operation_id,'result',operation.result_snapshot); END IF;
  IF operation.state='known_aborted' THEN RETURN jsonb_build_object('state','known_aborted','operation',p_operation); END IF;
  RETURN jsonb_build_object('state','pending_confirmation','operation',p_operation,'outcomeId',operation.operation_id);
 END IF;
 at_time:=clock_timestamp();result:=jsonb_build_object('mode',p_mode,'effective_at',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,result_snapshot,created_at,resolved_at)
 VALUES('retention_'||gen_random_uuid()::TEXT,source_id,'learning_retention',scope,p_operation->>'idempotencyKey',p_operation->>'requestHash','completed',result,at_time,at_time) RETURNING * INTO operation;
 INSERT INTO guest_learning_preferences(owner_id,mode,changed_at,operation_id) VALUES(source_id,p_mode,at_time,operation.operation_id)
 ON CONFLICT(owner_id) DO UPDATE SET mode=EXCLUDED.mode,changed_at=EXCLUDED.changed_at,operation_id=EXCLUDED.operation_id;
 UPDATE participation_owners SET state='established' WHERE owner_id=source_id AND state='empty';
 -- Future retention only (Spec028§3). No mass deletion of previously retained
 -- learning audio, financial evidence, provider records or successful CP.
 RETURN jsonb_build_object('state','completed','operation',p_operation,'outcomeId',operation.operation_id,'result',result);
END $$;
DO $pin_guest_recovery_delete_leaf$
DECLARE signature TEXT; namespace_id OID; owner_id OID; schema_name TEXT; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF schema_name IS NULL OR schema_name='pg_catalog' OR schema_name ~ '^pg_temp' THEN RAISE EXCEPTION 'trusted guest recovery schema required'; END IF;
 FOREACH signature IN ARRAY ARRAY['require_guest_audio_recovery_access_private_v1(jsonb,text)','validate_guest_recovery_operation_private_v1(jsonb,text)',
 'read_guest_owner_audio_delete_batch_private_v1(text)','guest_owner_audio_delete_projection_private_v1(text)',
 'prepare_guest_owner_audio_delete_v1(jsonb,jsonb,integer)','confirm_guest_owner_audio_delete_v1(jsonb,text,timestamptz)',
 'fail_guest_owner_audio_delete_v1(jsonb,text)','find_guest_owner_audio_delete_v1(jsonb,text,text)','set_guest_learning_retention_v1(jsonb,jsonb,text)'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure AND f.pronamespace=namespace_id AND f.proowner=owner_id) THEN RAISE EXCEPTION 'guest recovery leaf provenance differs'; END IF;
 EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 END LOOP;
END $pin_guest_recovery_delete_leaf$;
