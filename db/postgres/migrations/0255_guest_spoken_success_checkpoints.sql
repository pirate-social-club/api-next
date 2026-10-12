-- PRIVATE proposal, no ordinal reservation, execution, runtime grants or activation.
-- Root adopts core+closed phase+ACL as ONE transaction. Private server-only seam.
SELECT pg_advisory_xact_lock(83000003,1);

-- One shared internal identity helper; root composes ONE definition with the
-- consumer's JSON/spoken packet. Caller kind is never a provider privilege.
CREATE FUNCTION guest_study_answer_resource_scope_v1(p_community TEXT,p_session TEXT,p_item TEXT,p_attempt INTEGER,p_kind TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN('choice','spoken') OR p_attempt IS NULL OR p_attempt NOT BETWEEN 1 AND 3
 THEN RAISE EXCEPTION 'closed answer scope required' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_array('guest_study_answer_v1',p_community,p_session,p_item,p_attempt,p_kind)::TEXT;
END;
$$;

CREATE TABLE guest_study_spoken_captures (
 capture_id TEXT PRIMARY KEY,
 source_owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 operation_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(char_length(idempotency_key) BETWEEN 1 AND 128),
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 command_id TEXT NOT NULL REFERENCES study_spoken_answer_commands(command_id),
 original_lease_token TEXT NOT NULL CHECK(char_length(original_lease_token) BETWEEN 1 AND 256),
 original_lease_digest TEXT NOT NULL CHECK(original_lease_digest ~ '^[0-9a-f]{64}$'),
 session_id TEXT NOT NULL,
 session_item_id TEXT NOT NULL,
 attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 3),
 attempt_id TEXT NOT NULL,
 artifact_id TEXT NOT NULL,
 provider_call_id TEXT NOT NULL UNIQUE REFERENCES guest_resource_provider_calls(call_id),
 resource_reservation_id TEXT NOT NULL,
 upload_attempt_id TEXT NOT NULL,
 deletion_fence_revision BIGINT NOT NULL CHECK(deletion_fence_revision BETWEEN 0 AND 9007199254740991),
 audio_digest TEXT NOT NULL CHECK(audio_digest ~ '^[0-9a-f]{64}$'),
 audio_content_type TEXT NOT NULL CHECK(audio_content_type IN('audio/webm','audio/ogg','audio/mp4','audio/wav')),
 audio_byte_size INTEGER NOT NULL CHECK(audio_byte_size BETWEEN 1 AND 524288),
 audio_duration_ms INTEGER NOT NULL CHECK(audio_duration_ms BETWEEN 1 AND 60000),
 provider_retention TEXT NOT NULL CHECK(provider_retention IN('not_stored','stored')),
 grading_context JSONB NOT NULL CHECK(jsonb_typeof(grading_context)='object' AND octet_length(grading_context::TEXT)<=65536),
 created_at TIMESTAMPTZ NOT NULL,
 source_owner_kind TEXT NOT NULL DEFAULT 'guest' CHECK(source_owner_kind='guest'),
 FOREIGN KEY(source_owner_id,source_owner_kind) REFERENCES participation_owners(owner_id,kind),
 UNIQUE(command_id,original_lease_digest),
 UNIQUE(source_owner_id,idempotency_key),
 UNIQUE(capture_id,source_owner_id,provider_call_id,resource_reservation_id),
 FOREIGN KEY(operation_id,source_owner_id) REFERENCES guest_participation_operations(operation_id,source_owner_id),
 FOREIGN KEY(session_item_id,session_id,source_owner_id) REFERENCES study_session_items_v2(session_item_id,session_id,participation_owner_id),
 FOREIGN KEY(artifact_id,source_owner_id) REFERENCES learner_audio_artifacts(learner_audio_artifact_id,participation_owner_id),
 FOREIGN KEY(resource_reservation_id,source_owner_id,session_id) REFERENCES guest_resource_session_reservations(reservation_id,source_owner_id,session_id),
 FOREIGN KEY(upload_attempt_id,source_owner_id) REFERENCES learner_audio_upload_attempts(upload_attempt_id,owner_id),
 CHECK(original_lease_digest=encode(sha256(convert_to(original_lease_token,'UTF8')),'hex'))
);
CREATE TABLE guest_study_spoken_checkpoints (
 checkpoint_id TEXT PRIMARY KEY,
 capture_id TEXT NOT NULL UNIQUE REFERENCES guest_study_spoken_captures(capture_id),
 source_owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 provider_call_id TEXT NOT NULL UNIQUE REFERENCES guest_resource_provider_calls(call_id),
 resource_reservation_id TEXT NOT NULL,
 success_result JSONB NOT NULL CHECK(jsonb_typeof(success_result)='object' AND octet_length(success_result::TEXT)<=131072),
 provider_result JSONB NOT NULL CHECK(jsonb_typeof(provider_result)='object' AND octet_length(provider_result::TEXT)<=32768),
 payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
 charge_basis TEXT NOT NULL CHECK(charge_basis='reserved_ceiling_v1'),
 charged_cost_micros NUMERIC NOT NULL CHECK(charged_cost_micros>0 AND scale(charged_cost_micros)=0),
 persisted_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(capture_id,source_owner_id,provider_call_id,resource_reservation_id)
  REFERENCES guest_study_spoken_captures(capture_id,source_owner_id,provider_call_id,resource_reservation_id),
 CHECK(payload_sha256=encode(sha256(convert_to(jsonb_build_array(success_result,provider_result)::TEXT,'UTF8')),'hex')),
 CHECK((provider_result ?& ARRAY['detectedLanguage','detectedLanguageConfidence','transcriptSha256']
   AND provider_result-ARRAY['detectedLanguage','detectedLanguageConfidence','transcriptSha256']='{}'::JSONB
   AND jsonb_typeof(provider_result->'transcriptSha256')='string'
   AND provider_result->>'transcriptSha256' ~ '^[0-9a-f]{64}$') IS TRUE),
 CHECK((provider_result->>'transcriptSha256'=encode(sha256(convert_to(success_result#>>'{grade,heardTranscript}','UTF8')),'hex')) IS TRUE)
);
CREATE TRIGGER guest_spoken_capture_immutable BEFORE UPDATE OR DELETE ON guest_study_spoken_captures
 FOR EACH ROW EXECUTE FUNCTION reject_guest_immutable_mutation_v1();
CREATE TRIGGER guest_spoken_checkpoint_immutable BEFORE UPDATE OR DELETE ON guest_study_spoken_checkpoints
 FOR EACH ROW EXECUTE FUNCTION reject_guest_immutable_mutation_v1();

-- Called ONLY in the accepted reserve wrapper's same transaction, after its
-- exact original proof/origin/live-learning-lease/current-item checks and actual
-- reserve_guest_provider_call_v1 first-fresh receipt. No direct runtime grant.
CREATE FUNCTION capture_guest_spoken_dispatch_private_v1(
 p_source TEXT,p_operation JSONB,p_command TEXT,p_lease TEXT,p_call TEXT,
 p_reservation TEXT,p_upload TEXT,p_fence BIGINT,p_rerecord_enabled BOOLEAN
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE cmd study_spoken_answer_commands%ROWTYPE; call_row guest_resource_provider_calls%ROWTYPE;
 rsv guest_resource_session_reservations%ROWTYPE; upload learner_audio_upload_attempts%ROWTYPE;
 artifact learner_audio_artifacts%ROWTYPE; main_op guest_participation_operations%ROWTYPE;
 sess study_sessions_v2%ROWTYPE; item study_session_items_v2%ROWTYPE;
 exercise study_exercise_versions%ROWTYPE; profile study_language_profile_units%ROWTYPE;
 prior guest_study_spoken_captures%ROWTYPE; context JSONB; provenance JSONB; dominant TEXT; cid TEXT;
BEGIN
 PERFORM validate_guest_resource_operation_v1(p_source,p_operation,'study_answer');
 SELECT * INTO STRICT rsv FROM guest_resource_session_reservations WHERE reservation_id=p_reservation AND source_owner_id=p_source;
 PERFORM lock_guest_resource_budget_v1(p_source,rsv.edge_fingerprint);
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[p_source]);
 SELECT * INTO prior FROM guest_study_spoken_captures WHERE source_owner_id=p_source AND idempotency_key=p_operation->>'idempotencyKey';
 IF FOUND THEN
  IF ROW(prior.request_hash,prior.command_id,prior.original_lease_token,prior.provider_call_id,prior.resource_reservation_id,prior.upload_attempt_id,prior.deletion_fence_revision)
    IS DISTINCT FROM ROW(p_operation->>'requestHash',p_command,p_lease,p_call,p_reservation,p_upload,p_fence)
   THEN RAISE EXCEPTION 'captured dispatch conflict' USING ERRCODE='GP005'; END IF;
  -- A locator-only replay conveys NO new provider dispatch authorization.
  RETURN jsonb_build_object('captureId',prior.capture_id,'fresh',FALSE);
 END IF;
 -- Compose only after the accepted40-unit plan successor and its exact required
 -- plan checker are supplied by the shared resource owner. Preserve rerecord.
 IF p_rerecord_enabled IS NULL OR p_lease IS NULL OR char_length(p_lease) NOT BETWEEN 1 AND 256 THEN
  RAISE EXCEPTION 'closed capture policy required' USING ERRCODE='GP006'; END IF;
 PERFORM 1 FROM learner_audio_owner_fences WHERE owner_id=p_source AND revision=p_fence
  AND active_delete_command_id IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'deletion-in-progress' USING ERRCODE='GP006'; END IF;
 SELECT * INTO STRICT cmd FROM study_spoken_answer_commands WHERE command_id=p_command FOR UPDATE;
 SELECT * INTO STRICT sess FROM study_sessions_v2 WHERE session_id=cmd.session_id FOR UPDATE;
 SELECT * INTO STRICT item FROM study_session_items_v2 WHERE session_item_id=cmd.session_item_id FOR UPDATE;
 SELECT * INTO STRICT main_op FROM guest_participation_operations WHERE source_owner_id=p_source
  AND operation_kind='study_answer' AND idempotency_key=p_operation->>'idempotencyKey' FOR UPDATE;
 SELECT * INTO STRICT call_row FROM guest_resource_provider_calls WHERE call_id=p_call FOR UPDATE;
 SELECT * INTO STRICT artifact FROM learner_audio_artifacts WHERE learner_audio_artifact_id=cmd.learner_audio_artifact_id FOR UPDATE;
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload FOR UPDATE;
 -- Mandatory private helper from the independently accepted40-unit source
 -- successor: immutable actual session plan/original reservation, not a flag.
 PERFORM require_guest_spoken_resource_plan_v1(p_source,cmd.session_id,p_reservation,p_rerecord_enabled);
 IF ROW(cmd.participation_owner_id,cmd.participation_owner_kind,cmd.account_id,cmd.lease_token,cmd.request_hash,cmd.idempotency_key,cmd.state)
   IS DISTINCT FROM ROW(p_source,'guest'::TEXT,NULL::TEXT,p_lease,p_operation->>'requestHash',p_operation->>'idempotencyKey','reserved'::TEXT)
  OR ROW(sess.participation_owner_id,sess.participation_owner_kind,sess.status,sess.guest_resource_reservation_id)
    IS DISTINCT FROM ROW(p_source,'guest'::TEXT,'active'::TEXT,p_reservation)
  OR sess.expires_at<=clock_timestamp() OR sess.current_session_item_id IS DISTINCT FROM cmd.session_item_id
  OR rsv.state<>'active' OR rsv.reservation_expires_at<=clock_timestamp()
  OR ROW(item.session_id,item.participation_owner_id) IS DISTINCT FROM ROW(cmd.session_id,p_source)
  OR main_op.request_hash IS DISTINCT FROM p_operation->>'requestHash' OR main_op.state<>'reserved'
  OR main_op.resource_scope IS DISTINCT FROM guest_study_answer_resource_scope_v1(sess.community_id,cmd.session_id,cmd.session_item_id,cmd.attempt_number::INTEGER,'spoken')
  OR ROW(call_row.source_owner_id,call_row.idempotency_key,call_row.request_hash,call_row.reservation_id,call_row.session_id,call_row.disposition)
    IS DISTINCT FROM ROW(p_source,p_operation->>'idempotencyKey',p_operation->>'requestHash',p_reservation,cmd.session_id,'reserved'::TEXT)
  OR ROW(artifact.participation_owner_id,artifact.source_kind,artifact.attempt_ref,artifact.content_digest,artifact.content_type,artifact.byte_size,artifact.duration_ms)
    IS DISTINCT FROM ROW(p_source,'study'::TEXT,cmd.attempt_id,cmd.audio_digest,cmd.audio_content_type,cmd.audio_byte_size,cmd.audio_duration_ms)
  OR ROW(upload.owner_id,upload.artifact_id,upload.source_kind,upload.attempt_ref,upload.command_ref,upload.reservation_ref,upload.captured_revision,upload.io_state)
    IS DISTINCT FROM ROW(p_source,cmd.learner_audio_artifact_id,'study'::TEXT,cmd.attempt_id,p_command,p_reservation,p_fence,'registered'::TEXT)
  OR upload.object_ref IS DISTINCT FROM artifact.expected_object_ref
 THEN RAISE EXCEPTION 'captured command/call/audio mismatch' USING ERRCODE='GP006'; END IF;
 SELECT * INTO STRICT exercise FROM study_exercise_versions WHERE exercise_version_id=item.exercise_version_id;
 IF item.item_snapshot->>'exercise_type'<>'say_it_back'
  OR jsonb_typeof(exercise.private_grader->'reference_text')<>'string'
  OR NOT((exercise.private_grader->>'kind'='source_token_diff_v1' AND item.item_snapshot->>'grader_policy_revision'='script_aware_token_diff_v1')
    OR (exercise.private_grader->>'kind'='source_token_phonetic_v2' AND item.item_snapshot->>'grader_policy_revision'='script_aware_token_phonetic_v2')
    OR (exercise.private_grader->>'kind'='source_token_phonetic_v3' AND item.item_snapshot->>'grader_policy_revision'='script_aware_token_phonetic_v3')
    OR (exercise.private_grader->>'kind'='source_token_phonetic_v4' AND item.item_snapshot->>'grader_policy_revision'='script_aware_token_phonetic_v4'))
 THEN RAISE EXCEPTION 'accepted spoken context required' USING ERRCODE='GP006'; END IF;
 SELECT * INTO profile FROM study_language_profile_units WHERE community_id=sess.community_id AND post_id=sess.post_id
  AND lyrics_revision=sess.lyrics_revision AND language_profile_revision=sess.language_profile_revision AND study_unit_id=exercise.study_unit_id;
 dominant:=CASE WHEN profile.mixed IS FALSE AND profile.confidence>=0.8 THEN profile.dominant_language END;
 provenance:=CASE WHEN dominant IS NULL THEN jsonb_build_object('kind','no_authoritative_evidence') ELSE
  jsonb_build_object('kind','unit_profile','community_id',profile.community_id,'post_id',profile.post_id,'lyrics_revision',profile.lyrics_revision,
    'language_profile_revision',profile.language_profile_revision,'study_unit_id',profile.study_unit_id,'confidence',profile.confidence,'dominant_language',dominant) END;
 context:=jsonb_build_object('item',item.item_snapshot,'referenceText',exercise.private_grader->>'reference_text',
  'dominantLanguage',dominant,'languageProvenance',provenance,'rerecordEnabled',p_rerecord_enabled,'communityId',sess.community_id,
  'disclosureVersion',sess.guest_disclosure_version,'disclosureAccepted',sess.guest_disclosure_accepted);
 cid:='gsc_'||gen_random_uuid()::TEXT;
 INSERT INTO guest_study_spoken_captures(capture_id,source_owner_id,operation_id,idempotency_key,request_hash,
  command_id,original_lease_token,original_lease_digest,session_id,session_item_id,attempt_number,attempt_id,artifact_id,
  provider_call_id,resource_reservation_id,upload_attempt_id,deletion_fence_revision,audio_digest,audio_content_type,
  audio_byte_size,audio_duration_ms,provider_retention,grading_context,created_at)
 VALUES(cid,p_source,main_op.operation_id,p_operation->>'idempotencyKey',p_operation->>'requestHash',
  p_command,p_lease,encode(sha256(convert_to(p_lease,'UTF8')),'hex'),cmd.session_id,cmd.session_item_id,cmd.attempt_number,cmd.attempt_id,
  cmd.learner_audio_artifact_id,p_call,p_reservation,p_upload,p_fence,cmd.audio_digest,cmd.audio_content_type,cmd.audio_byte_size,cmd.audio_duration_ms,
  artifact.provider_retention,context,clock_timestamp());
 RETURN jsonb_build_object('captureId',cid,'fresh',TRUE);
END $$;

-- Validated/internal sanitized facts only. result excludes archive AND leaseToken;
-- raw internal lease is separately correlated, stored only in private capture.
CREATE FUNCTION persist_guest_spoken_success_private_v1(
 p_source TEXT,p_operation JSONB,p_command TEXT,p_original_lease TEXT,p_result JSONB,p_provider JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE captured guest_study_spoken_captures%ROWTYPE; prior guest_study_spoken_checkpoints%ROWTYPE;
 rsv guest_resource_session_reservations%ROWTYPE; call_row guest_resource_provider_calls%ROWTYPE;
 cp TEXT; sha TEXT; provider_metadata JSONB;
BEGIN
 PERFORM validate_guest_resource_operation_v1(p_source,p_operation,'study_answer');
 SELECT * INTO STRICT captured FROM guest_study_spoken_captures WHERE command_id=p_command AND source_owner_id=p_source
  AND original_lease_digest=encode(sha256(convert_to(p_original_lease,'UTF8')),'hex');
 SELECT * INTO STRICT rsv FROM guest_resource_session_reservations WHERE reservation_id=captured.resource_reservation_id;
 PERFORM lock_guest_resource_budget_v1(p_source,rsv.edge_fingerprint);
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[p_source]);
 IF ROW(captured.idempotency_key,captured.request_hash,captured.original_lease_token)
  IS DISTINCT FROM ROW(p_operation->>'idempotencyKey',p_operation->>'requestHash',p_original_lease)
 THEN RAISE EXCEPTION 'checkpoint captured lease mismatch' USING ERRCODE='GP005'; END IF;
 PERFORM require_guest_spoken_resource_plan_v1(p_source,captured.session_id,captured.resource_reservation_id,
  (captured.grading_context->>'rerecordEnabled')::BOOLEAN);
 IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR octet_length(p_result::TEXT)>131072
  OR (SELECT count(*) FROM jsonb_object_keys(p_result))<>20
  OR NOT(p_result ?& ARRAY['acceptedAt','artifactId','attemptId','attemptNumber','audioByteSize','audioContentType','audioDigest',
    'audioDurationMs','commandId','communityId','grade','languageProvenance','rerecordAssessment','rerecordEnabled',
    'providerDetectedLanguage','providerDetectedLanguageConfidence','qualificationId','requestHash','sessionId','sessionItemId'])
  OR p_provider IS NULL OR jsonb_typeof(p_provider)<>'object' OR octet_length(p_provider::TEXT)>32768
  OR (SELECT count(*) FROM jsonb_object_keys(p_provider))<>3
  OR NOT(p_provider ?& ARRAY['transcript','detectedLanguage','detectedLanguageConfidence'])
  OR jsonb_typeof(p_provider->'transcript')<>'string' OR char_length(p_provider->>'transcript')>4096
 THEN RAISE EXCEPTION 'closed sanitized success facts required' USING ERRCODE='22023'; END IF;
 IF ROW(p_result->>'artifactId',p_result->>'attemptId',p_result->>'commandId',p_result->>'requestHash',p_result->>'sessionId',p_result->>'sessionItemId',
    p_result->>'audioDigest',p_result->>'audioContentType',p_result->>'communityId')
  IS DISTINCT FROM ROW(captured.artifact_id,captured.attempt_id,captured.command_id,captured.request_hash,captured.session_id,captured.session_item_id,
    captured.audio_digest,captured.audio_content_type,captured.grading_context->>'communityId')
  OR p_result->'attemptNumber' IS DISTINCT FROM to_jsonb(captured.attempt_number)
  OR p_result->'audioByteSize' IS DISTINCT FROM to_jsonb(captured.audio_byte_size)
  OR p_result->'audioDurationMs' IS DISTINCT FROM to_jsonb(captured.audio_duration_ms)
  OR p_result->'languageProvenance' IS DISTINCT FROM captured.grading_context->'languageProvenance'
  OR p_result->'rerecordEnabled' IS DISTINCT FROM captured.grading_context->'rerecordEnabled'
  OR p_result->'providerDetectedLanguage' IS DISTINCT FROM p_provider->'detectedLanguage'
  OR p_result->'providerDetectedLanguageConfidence' IS DISTINCT FROM p_provider->'detectedLanguageConfidence'
  OR p_result#>'{grade,heardTranscript}' IS DISTINCT FROM p_provider->'transcript'
  OR p_result#>>'{grade,policyRevision}' IS DISTINCT FROM captured.grading_context#>>'{item,grader_policy_revision}'
 THEN RAISE EXCEPTION 'successful source/policy correlation failed' USING ERRCODE='GP005'; END IF;
 -- Platform adapter strict-decodes existing grade/feedback/provenance schemas
 -- and recomputes genuine shared grading against retained context BEFORE this
 -- private writer. This function is NEVER a browser/body-facing grant.
 -- Transcript already exists in bounded grade.heardTranscript. Store no
 -- duplicate raw transcript/body; reconstruct the narrow frozen result on read.
 provider_metadata:=jsonb_build_object('detectedLanguage',p_provider->'detectedLanguage',
  'detectedLanguageConfidence',p_provider->'detectedLanguageConfidence',
  'transcriptSha256',encode(sha256(convert_to(p_provider->>'transcript','UTF8')),'hex'));
 sha:=encode(sha256(convert_to(jsonb_build_array(p_result,provider_metadata)::TEXT,'UTF8')),'hex');
 SELECT * INTO prior FROM guest_study_spoken_checkpoints WHERE capture_id=captured.capture_id;
 IF FOUND THEN
  IF prior.payload_sha256<>sha THEN RAISE EXCEPTION 'successful result replay conflict' USING ERRCODE='GP005'; END IF;
  RETURN jsonb_build_object('state','completed','outcome_id',prior.checkpoint_id,'result',jsonb_build_object('checkpointId',prior.checkpoint_id));
 END IF;
 SELECT * INTO STRICT call_row FROM guest_resource_provider_calls WHERE call_id=captured.provider_call_id FOR UPDATE;
 IF ROW(call_row.source_owner_id,call_row.request_hash,call_row.idempotency_key,call_row.reservation_id,call_row.session_id)
  IS DISTINCT FROM ROW(p_source,captured.request_hash,captured.idempotency_key,captured.resource_reservation_id,captured.session_id)
  OR call_row.disposition NOT IN('reserved','unknown') THEN
  RAISE EXCEPTION 'accepted original provider call required' USING ERRCODE='GP006'; END IF;
 -- Never test current browser proof, learning/command lease expiry, current
 -- session expiry/status, current deletion fence, or archive publication here.
 cp:='gcp_'||gen_random_uuid()::TEXT;
 INSERT INTO guest_study_spoken_checkpoints VALUES(cp,captured.capture_id,p_source,captured.provider_call_id,captured.resource_reservation_id,
  p_result,provider_metadata,sha,'reserved_ceiling_v1',call_row.maximum_provider_cost_micros,clock_timestamp());
 -- Resource result and success checkpoint settle atomically. No invoice claim:
 -- charge the exact original conservative ceiling, never a caller lower price.
 PERFORM complete_guest_provider_call_v1(p_source,p_operation,captured.resource_reservation_id,captured.provider_call_id,
  'completed',cp,call_row.maximum_provider_cost_micros::TEXT);
 RETURN jsonb_build_object('state','completed','outcome_id',cp,'result',jsonb_build_object('checkpointId',cp));
END $$;

CREATE OR REPLACE FUNCTION require_guest_resource_success_checkpoint_v1(
 p_checkpoint_id TEXT,p_call_id TEXT,p_reservation_id TEXT,p_source_owner_id TEXT,p_actual_cost NUMERIC
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 PERFORM require_guest_practice_only_schema_phase_v1();
 IF NOT EXISTS(SELECT 1 FROM guest_study_spoken_checkpoints cp
   JOIN guest_study_spoken_captures cap ON cap.capture_id=cp.capture_id
   JOIN guest_resource_provider_calls call_row ON call_row.call_id=cp.provider_call_id
   WHERE cp.checkpoint_id=p_checkpoint_id AND cp.provider_call_id=p_call_id
     AND cp.resource_reservation_id=p_reservation_id AND cp.source_owner_id=p_source_owner_id
     AND cap.source_owner_id=cp.source_owner_id AND cap.provider_call_id=cp.provider_call_id
     AND cap.resource_reservation_id=cp.resource_reservation_id
     AND ROW(call_row.source_owner_id,call_row.idempotency_key,call_row.request_hash,call_row.reservation_id,call_row.session_id)
       IS NOT DISTINCT FROM ROW(cap.source_owner_id,cap.idempotency_key,cap.request_hash,cap.resource_reservation_id,cap.session_id)
     AND cp.charge_basis='reserved_ceiling_v1' AND cp.charged_cost_micros=p_actual_cost
     AND cp.charged_cost_micros=call_row.maximum_provider_cost_micros)
 THEN RAISE EXCEPTION 'successful checkpoint lineage unavailable' USING ERRCODE='GP006'; END IF;
 -- Complete validation includes the frozen session paid-call plan. It must
 -- inspect original facts only and remain usable after lease/session expiry.
 PERFORM require_guest_spoken_resource_plan_v1(p_source_owner_id,
  (SELECT cap.session_id FROM guest_study_spoken_checkpoints cp JOIN guest_study_spoken_captures cap USING(capture_id)
    WHERE cp.checkpoint_id=p_checkpoint_id),p_reservation_id,
  (SELECT (cap.grading_context->>'rerecordEnabled')::BOOLEAN FROM guest_study_spoken_checkpoints cp
    JOIN guest_study_spoken_captures cap USING(capture_id) WHERE cp.checkpoint_id=p_checkpoint_id));
END $$;

-- Read-only recovery helper. A trusted worker/wrapper supplies exact original
-- operation and command; absent row is NULL, never abort/regrade/provider work.
CREATE FUNCTION load_guest_spoken_success_private_v1(p_source TEXT,p_operation JSONB,p_command TEXT,p_original_lease TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE cp guest_study_spoken_checkpoints%ROWTYPE; cap guest_study_spoken_captures%ROWTYPE;
BEGIN
 PERFORM validate_guest_resource_operation_v1(p_source,p_operation,'study_answer');
 SELECT * INTO cap FROM guest_study_spoken_captures WHERE source_owner_id=p_source AND command_id=p_command
  AND original_lease_digest=encode(sha256(convert_to(p_original_lease,'UTF8')),'hex');
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF ROW(cap.idempotency_key,cap.request_hash,cap.original_lease_token)
  IS DISTINCT FROM ROW(p_operation->>'idempotencyKey',p_operation->>'requestHash',p_original_lease)
 THEN RAISE EXCEPTION 'checkpoint lookup source mismatch' USING ERRCODE='GP005'; END IF;
 SELECT * INTO cp FROM guest_study_spoken_checkpoints WHERE capture_id=cap.capture_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('checkpointId',cp.checkpoint_id,'captureId',cap.capture_id,
  'source',jsonb_build_object('kind','guest','ownerId',p_source),'operation',p_operation,'commandId',cap.command_id,
  'result',cp.success_result||jsonb_build_object('leaseToken',cap.original_lease_token),
  'providerResult',(cp.provider_result-'transcriptSha256')||jsonb_build_object('transcript',cp.success_result#>'{grade,heardTranscript}'),
  'resourceReservationId',cap.resource_reservation_id,
  'deletionFenceRevision',cap.deletion_fence_revision,'uploadAttemptId',cap.upload_attempt_id);
END $$;

-- Private immutable context reader for the internal result adapter. Never
-- publish reference text, dispatch lease, provider facts or capture JSON over HTTP.
CREATE FUNCTION read_guest_spoken_capture_private_v1(p_source TEXT,p_operation JSONB,p_command TEXT,p_original_lease TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE cap guest_study_spoken_captures%ROWTYPE;
BEGIN
 PERFORM validate_guest_resource_operation_v1(p_source,p_operation,'study_answer');
 SELECT * INTO STRICT cap FROM guest_study_spoken_captures WHERE source_owner_id=p_source AND command_id=p_command
  AND original_lease_digest=encode(sha256(convert_to(p_original_lease,'UTF8')),'hex');
 IF ROW(cap.idempotency_key,cap.request_hash,cap.original_lease_token)
  IS DISTINCT FROM ROW(p_operation->>'idempotencyKey',p_operation->>'requestHash',p_original_lease)
 THEN RAISE EXCEPTION 'capture reader mismatch' USING ERRCODE='GP005'; END IF;
 RETURN jsonb_build_object('captureId',cap.capture_id,'sourceOwnerId',cap.source_owner_id,
  'commandId',cap.command_id,'operation',p_operation,'sessionId',cap.session_id,'sessionItemId',cap.session_item_id,
  'attemptId',cap.attempt_id,'artifactId',cap.artifact_id,'attemptNumber',cap.attempt_number,
  'resourceReservationId',cap.resource_reservation_id,'deletionFenceRevision',cap.deletion_fence_revision,
  'audioDigest',cap.audio_digest,'audioContentType',cap.audio_content_type,'audioByteSize',cap.audio_byte_size,
  'audioDurationMs',cap.audio_duration_ms,'gradingContext',cap.grading_context);
END $$;

CREATE FUNCTION guest_spoken_component_has_history_private_v1(component_ids TEXT[])
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM guest_study_spoken_captures WHERE source_owner_id=ANY(component_ids))
   OR EXISTS(SELECT 1 FROM guest_study_spoken_checkpoints WHERE source_owner_id=ANY(component_ids))
$$;

-- Captured core command fields are mutable only by a separately reviewed retry
-- wrapper after definitive failed/not_invoked AND closed absent upload. Consumer
-- must install its actual guarded reclamation transition before runtime grants.
-- Finalizer resolves this original capture/checkpoint, not a later recovery token.

-- Actual253 phase/predicate copied by exact bound generator, with only the
-- explicit two checkpoint identities and component-history predicate added.
DO $require_prior_spoken_phase$
BEGIN
 IF (SELECT count(*) FROM guest_learning_schema_phase WHERE singleton AND phase='practice_only_owner_audio_history_v3')<>1
 THEN RAISE EXCEPTION 'positive prior audio phase required'; END IF;
END $require_prior_spoken_phase$;
ALTER TABLE guest_learning_schema_phase DROP CONSTRAINT guest_learning_schema_phase_phase_check;
UPDATE guest_learning_schema_phase SET phase='practice_only_owner_spoken_checkpoint_history_v4' WHERE singleton AND phase='practice_only_owner_audio_history_v3';
ALTER TABLE guest_learning_schema_phase ADD CONSTRAINT guest_learning_schema_phase_phase_check CHECK(phase='practice_only_owner_spoken_checkpoint_history_v4');
CREATE OR REPLACE FUNCTION require_guest_practice_only_schema_phase_v1()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE trusted_namespace OID; trusted_owner OID;
BEGIN
  SELECT relnamespace,relowner INTO STRICT trusted_namespace,trusted_owner
    FROM pg_class WHERE oid='participation_owners'::regclass;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='guest_learning_schema_phase'::regclass
      AND relnamespace=trusted_namespace AND relowner=trusted_owner)
    OR (SELECT count(*) FROM guest_learning_schema_phase
      WHERE singleton AND phase='practice_only_owner_spoken_checkpoint_history_v4')<>1
    OR EXISTS(SELECT 1 FROM unnest(ARRAY[
      'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks','guest_learning_preferences','guest_participation_operations','guest_secret_issuance_operations','guest_attachment_intents','study_sessions_v2','study_review_items','study_session_items_v2','study_spoken_answer_commands','learner_audio_artifacts','guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts','learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints'
      ]) required_name WHERE NOT EXISTS(SELECT 1 FROM pg_class relation
      WHERE relation.oid=to_regclass(required_name) AND relation.relnamespace=trusted_namespace
        AND relation.relowner=trusted_owner AND relation.relkind='r'))
    OR NOT EXISTS(SELECT 1 FROM pg_class sequence_relation
      WHERE sequence_relation.oid=to_regclass('learner_audio_fence_revision_v1')
        AND sequence_relation.relnamespace=trusted_namespace
        AND sequence_relation.relowner=trusted_owner AND sequence_relation.relkind='S')
    OR EXISTS(SELECT 1 FROM pg_depend dependency
      LEFT JOIN pg_attrdef default_expression ON dependency.classid='pg_attrdef'::regclass
        AND default_expression.oid=dependency.objid
      LEFT JOIN pg_class consumer_relation ON consumer_relation.oid=CASE
        WHEN dependency.classid='pg_attrdef'::regclass THEN default_expression.adrelid
        WHEN dependency.classid='pg_class'::regclass THEN dependency.objid END
      WHERE dependency.refclassid='pg_class'::regclass
        AND dependency.refobjid='learner_audio_fence_revision_v1'::regclass
        AND NOT (COALESCE(consumer_relation.relnamespace=trusted_namespace AND consumer_relation.relname IN
          ('learner_audio_owner_fences','learner_audio_delete_commands'),FALSE)
          OR (dependency.classid='pg_proc'::regclass AND dependency.objid=
            'prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)'::regprocedure)))
    OR EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relnamespace=trusted_namespace AND c.relkind IN ('r','p','f','v','m')
        AND a.attnum>0 AND NOT a.attisdropped
        -- Guest source IDs; ordinary account/policy/lease owner fields have
        -- separate accepted authorities and do not reference guest identities.
        AND a.attname ~ '(^|_)owner_id$'
        AND c.relname NOT IN (
          'participation_owners','guest_credentials','guest_empty_owner_aliases',
          'participation_owner_clocks','guest_learning_preferences',
          'guest_participation_operations','guest_secret_issuance_operations','guest_attachment_intents',
          'study_sessions_v2','study_review_items','study_session_items_v2',
          'study_spoken_answer_commands','learner_audio_artifacts',
          'guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts',
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints'))
    OR EXISTS(SELECT 1 FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE fk.contype='f' AND fk.confrelid=ANY(ARRAY[
          'participation_owners'::regclass,'guest_credentials'::regclass,
          'guest_empty_owner_aliases'::regclass,'participation_owner_clocks'::regclass,
          'guest_learning_preferences'::regclass,'guest_participation_operations'::regclass,
          'guest_secret_issuance_operations'::regclass,'guest_attachment_intents'::regclass,
          'guest_resource_session_reservations'::regclass,'guest_resource_provider_calls'::regclass,
          'guest_resource_release_receipts'::regclass,
          'learner_audio_owner_fences'::regclass,'learner_audio_delete_commands'::regclass,'learner_audio_delete_sources'::regclass,'learner_audio_delete_target_artifacts'::regclass,'learner_audio_object_names'::regclass,'learner_audio_upload_attempts'::regclass,'learner_audio_delete_batches'::regclass,'learner_audio_delete_batch_items'::regclass,'learner_audio_deleted_objects'::regclass,'guest_study_spoken_captures'::regclass,'guest_study_spoken_checkpoints'::regclass])
        AND c.relnamespace=trusted_namespace AND c.relname NOT IN (
          'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks',
          'guest_learning_preferences','guest_participation_operations',
          'guest_secret_issuance_operations','guest_attachment_intents',
          'study_sessions_v2','study_review_items','study_session_items_v2',
          'study_spoken_answer_commands','learner_audio_artifacts',
          'guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts',
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints'))
    OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=trusted_namespace
      AND relname IN ('guest_owner_associations','participation_eligibility_decisions',
        'megapot_owner_shares','megapot_owner_snapshot_leaves','megapot_owner_allocations',
        'reward_credit_persona_bindings','reward_credit_recipient_selections'))
  THEN RAISE EXCEPTION 'owner history closure unavailable' USING ERRCODE='GP003'; END IF;
END $$;

CREATE OR REPLACE FUNCTION guest_authority_component_is_empty_v1(original_source_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE root_id TEXT; member_ids TEXT[];
BEGIN
  PERFORM require_guest_practice_only_schema_phase_v1();
  root_id := resolve_guest_empty_owner_root_v1(original_source_id);
  WITH RECURSIVE component(owner_id) AS (
    SELECT root_id UNION SELECT a.source_owner_id FROM guest_empty_owner_aliases a
      JOIN component c ON a.canonical_owner_id=c.owner_id
  ) SELECT array_agg(owner_id ORDER BY owner_id COLLATE "C") INTO member_ids FROM component;
  RETURN EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=root_id AND kind='guest' AND state='empty')
    AND NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=ANY(member_ids) AND state='established')
    AND NOT EXISTS(SELECT 1 FROM study_sessions_v2 WHERE participation_owner_id=ANY(member_ids))
    AND NOT EXISTS(SELECT 1 FROM study_review_items WHERE participation_owner_id=ANY(member_ids))
    AND NOT EXISTS(SELECT 1 FROM study_session_items_v2 WHERE participation_owner_id=ANY(member_ids))
    AND NOT EXISTS(SELECT 1 FROM study_spoken_answer_commands WHERE participation_owner_id=ANY(member_ids))
    AND NOT EXISTS(SELECT 1 FROM learner_audio_artifacts WHERE participation_owner_id=ANY(member_ids))
    AND NOT guest_resource_component_has_history_v1(member_ids)
    AND NOT learner_audio_component_has_history_private_v1(member_ids)
    AND NOT guest_spoken_component_has_history_private_v1(member_ids)
    AND NOT EXISTS(SELECT 1 FROM guest_participation_operations WHERE source_owner_id=ANY(member_ids)
      AND operation_kind IN ('study_start','study_answer','learning_retention','learner_audio_deletion')
      AND state<>'known_aborted')
    AND NOT EXISTS(SELECT 1 FROM guest_attachment_intents WHERE owner_id=ANY(member_ids)
      AND state IN ('awaiting_account','awaiting_confirmation') AND expires_at>clock_timestamp());
END $$;


DO $pin_private_spoken_checkpoint_packet$
DECLARE relation_name TEXT; signature TEXT; trusted_schema TEXT:=current_schema(); grantee_name TEXT; expected_owner OID;
BEGIN
 SELECT relowner INTO STRICT expected_owner FROM pg_class WHERE oid='participation_owners'::regclass;
 IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN RAISE EXCEPTION 'trusted checkpoint schema required'; END IF;
 FOREACH relation_name IN ARRAY ARRAY['guest_study_spoken_captures','guest_study_spoken_checkpoints'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=relation_name::regclass AND relowner=expected_owner) THEN RAISE EXCEPTION 'checkpoint relation owner differs'; END IF;
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',relation_name);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c
   CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid=relation_name::regclass AND a.grantee<>0 AND a.grantee<>c.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',relation_name,grantee_name);
  END LOOP;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY[
  'guest_study_answer_resource_scope_v1(text,text,text,integer,text)',
  'capture_guest_spoken_dispatch_private_v1(text,jsonb,text,text,text,text,text,bigint,boolean)',
  'persist_guest_spoken_success_private_v1(text,jsonb,text,text,jsonb,jsonb)',
  'load_guest_spoken_success_private_v1(text,jsonb,text,text)',
  'read_guest_spoken_capture_private_v1(text,jsonb,text,text)',
  'require_guest_resource_success_checkpoint_v1(text,text,text,text,numeric)',
  'guest_spoken_component_has_history_private_v1(text[])',
  'require_guest_practice_only_schema_phase_v1()',
  'guest_authority_component_is_empty_v1(text)'
 ] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=signature::regprocedure AND proowner=expected_owner) THEN RAISE EXCEPTION 'checkpoint function owner differs'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $pin_private_spoken_checkpoint_packet$;
SELECT require_guest_practice_only_schema_phase_v1();
-- Convergence in actual253 already calls the empty predicate for every root,
-- whose full reverse component now includes both new retained identities.
-- No runtime grants, serving composition, provider I/O or feature activation.

-- Approved serving/worker LEAF candidates around ungranted internal primitives.
-- Root may grant only these exact wrappers to the independently accepted
-- trusted server LOGIN after genuine composed-role/phase/browser tests. No raw
-- table privileges, generic capture, audio lock or arbitrary checkpoint grant.
CREATE FUNCTION require_owner_guest_source_private_v1(p_source JSONB) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
 IF p_source IS NULL OR jsonb_typeof(p_source) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(p_source))<>2
  OR NOT(p_source ?& ARRAY['kind','ownerId']) OR p_source->>'kind' IS DISTINCT FROM 'guest'
  OR jsonb_typeof(p_source->'ownerId') IS DISTINCT FROM 'string'
  OR char_length(p_source->>'ownerId') NOT BETWEEN 1 AND 128
  OR NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=p_source->>'ownerId' AND kind='guest') THEN
  RAISE EXCEPTION 'captured guest source required' USING ERRCODE='GP002'; END IF;
 RETURN p_source->>'ownerId';
END $$;

CREATE FUNCTION persist_owner_guest_spoken_success_v1(p_source JSONB,p_operation JSONB,
 p_command TEXT,p_original_lease TEXT,p_result JSONB,p_provider JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT;
BEGIN
 source_id:=require_owner_guest_source_private_v1(p_source);
 PERFORM require_guest_study_composition_v1();
 RETURN persist_guest_spoken_success_private_v1(source_id,p_operation,p_command,p_original_lease,p_result,p_provider);
END $$;

CREATE FUNCTION read_owner_guest_spoken_success_v1(p_source JSONB,p_operation JSONB,p_command TEXT,p_original_lease TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT;
BEGIN
 source_id:=require_owner_guest_source_private_v1(p_source);
 PERFORM require_guest_study_composition_v1();
 RETURN load_guest_spoken_success_private_v1(source_id,p_operation,p_command,p_original_lease);
END $$;

CREATE FUNCTION read_owner_guest_spoken_capture_v1(p_source JSONB,p_operation JSONB,p_command TEXT,p_original_lease TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT;
BEGIN
 source_id:=require_owner_guest_source_private_v1(p_source);
 PERFORM require_guest_study_composition_v1();
 RETURN read_guest_spoken_capture_private_v1(source_id,p_operation,p_command,p_original_lease);
END $$;

-- Frozen persistSuccessfulSpokenResult ACKS an EXISTING exact checkpoint after
-- an actually observed archive result. It cannot create late success, claim an
-- unknown upload failed, settle another call or use a renewed browser lease.
CREATE FUNCTION acknowledge_owner_guest_spoken_success_v1(p_source JSONB,p_operation JSONB,
 p_command TEXT,p_original_lease TEXT,p_result JSONB,p_provider JSONB,p_reservation TEXT,p_fence BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT; saved JSONB; cap guest_study_spoken_captures%ROWTYPE;
 rsv guest_resource_session_reservations%ROWTYPE; upload learner_audio_upload_attempts%ROWTYPE;
 fence learner_audio_owner_fences%ROWTYPE; artifact learner_audio_artifacts%ROWTYPE; published BOOLEAN;
BEGIN
 source_id:=require_owner_guest_source_private_v1(p_source);
 PERFORM require_guest_study_composition_v1();
 saved:=load_guest_spoken_success_private_v1(source_id,p_operation,p_command,p_original_lease);
 IF saved IS NULL THEN RAISE EXCEPTION 'prearchive successful checkpoint required' USING ERRCODE='GP010'; END IF;
 IF p_result IS NULL OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
  OR NOT(p_result ? 'archive') OR jsonb_typeof(p_result->'archive') IS DISTINCT FROM 'object'
  OR (p_result-'archive') IS DISTINCT FROM saved->'result'
  OR p_provider IS DISTINCT FROM saved->'providerResult'
  OR saved->>'resourceReservationId' IS DISTINCT FROM p_reservation
  OR (saved->>'deletionFenceRevision')::BIGINT IS DISTINCT FROM p_fence THEN
  RAISE EXCEPTION 'accepted success acknowledgement changed' USING ERRCODE='GP005'; END IF;
 SELECT * INTO STRICT cap FROM guest_study_spoken_captures WHERE capture_id=saved->>'captureId';
 SELECT * INTO STRICT rsv FROM guest_resource_session_reservations WHERE reservation_id=cap.resource_reservation_id;
 PERFORM lock_guest_resource_budget_v1(source_id,rsv.edge_fingerprint);
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[source_id]);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=cap.upload_attempt_id FOR UPDATE;
 SELECT * INTO STRICT fence FROM learner_audio_owner_fences WHERE owner_id=source_id FOR UPDATE;
 SELECT * INTO STRICT artifact FROM learner_audio_artifacts WHERE learner_audio_artifact_id=cap.artifact_id FOR UPDATE;
 IF ROW(upload.owner_id,upload.artifact_id,upload.command_ref,upload.reservation_ref,upload.captured_revision,upload.object_ref)
  IS DISTINCT FROM ROW(source_id,cap.artifact_id,cap.command_id,p_reservation,p_fence,artifact.expected_object_ref) THEN
  RAISE EXCEPTION 'actual archive source changed' USING ERRCODE='GP005'; END IF;
 IF upload.io_state<>'closed' THEN
  RETURN jsonb_build_object('state','reserved','outcome_id',saved->>'checkpointId','result',NULL); END IF;
 published:=upload.storage_disposition='stored' AND NOT upload.cleanup_required
  AND fence.revision=p_fence AND fence.active_delete_command_id IS NULL AND artifact.recording_state<>'deleted'
  AND NOT EXISTS(SELECT 1 FROM learner_audio_deleted_objects WHERE object_ref=upload.object_ref);
 -- A truthful earlier stored observation stays acknowledged after later delete;
 -- immutable upload history proves that I/O fact. Publication eligibility is
 -- rederived separately by the finalizer, which cannot resurrect that object.
 IF p_result->'archive' IS DISTINCT FROM CASE
   WHEN p_result#>>'{archive,state}'='stored' AND upload.storage_disposition='stored'
    THEN jsonb_build_object('state','stored','objectRef',upload.object_ref)
   WHEN p_result#>>'{archive,state}'='failed' AND (upload.storage_disposition IN('failed','absent') OR NOT published)
    THEN jsonb_build_object('state','failed','objectRef',NULL)
   ELSE NULL::JSONB END THEN
  RAISE EXCEPTION 'truthful retained archive observation required' USING ERRCODE='GP005'; END IF;
 RETURN jsonb_build_object('state','completed','outcome_id',saved->>'checkpointId',
  'result',jsonb_build_object('checkpointId',saved->>'checkpointId'));
END $$;

-- Optional narrow root-owned checkpoint composition: bind ONLY the five
-- controlled leaf functions after their bodies exist in the same transaction.
-- No serving grant; generic core capture/persist/load/audio helpers stay private.
DO $bind_owner_guest_checkpoint_leaves$
DECLARE signature TEXT; grantee_name TEXT; trusted_schema TEXT; expected_owner OID;
BEGIN
 SELECT n.nspname,c.relowner INTO STRICT trusted_schema,expected_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
  RAISE EXCEPTION 'trusted checkpoint leaf schema required'; END IF;
 FOREACH signature IN ARRAY ARRAY[
  'require_owner_guest_source_private_v1(jsonb)',
  'persist_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb)',
  'read_owner_guest_spoken_success_v1(jsonb,jsonb,text,text)',
  'read_owner_guest_spoken_capture_v1(jsonb,jsonb,text,text)',
  'acknowledge_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb,text,bigint)'
 ] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
    WHERE f.oid=signature::regprocedure AND f.proowner=expected_owner AND n.nspname=trusted_schema) THEN
   RAISE EXCEPTION 'approved checkpoint leaf owner required'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $bind_owner_guest_checkpoint_leaves$;
