-- Private ordinary Study/Karaoke captured audio authority. All runtime grants
-- and deployment remain separately gated. Apply as one maintained migration.
SELECT pg_advisory_xact_lock(83000003,1);


CREATE OR REPLACE FUNCTION register_learner_audio_upload_private_v1(
 expected_owner TEXT,expected_artifact TEXT,expected_kind TEXT,expected_attempt TEXT,
 expected_command TEXT,expected_reservation TEXT,expected_object_ref TEXT,upload_id TEXT,
 expected_captured_revision BIGINT
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE fence learner_audio_owner_fences%ROWTYPE; existing learner_audio_upload_attempts%ROWTYPE;
BEGIN
 -- Trusted wrapper first proves the actual Study command/session or Karaoke
 -- recording/session and exact existing account owner mapping. Input alone is
 -- not source authority. Guest Karaoke is not composed by that wrapper.
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[expected_owner]);
 SELECT * INTO existing FROM learner_audio_upload_attempts WHERE upload_attempt_id=upload_id;
 -- Replay below must preserve the original source; only new insertion requires
 -- an active nonalias source. Existing fence is created in the same transaction.
 IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=expected_owner
   AND state IN('empty','established')) THEN RAISE EXCEPTION 'active audio source required'; END IF;
 INSERT INTO learner_audio_owner_fences(owner_id) VALUES(expected_owner) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT fence FROM learner_audio_owner_fences WHERE owner_id=expected_owner FOR UPDATE;
 SELECT * INTO existing FROM learner_audio_upload_attempts WHERE upload_attempt_id=upload_id;
 IF FOUND THEN
   IF ROW(existing.owner_id,existing.artifact_id,existing.source_kind,existing.attempt_ref,
       existing.command_ref,existing.reservation_ref,existing.object_ref,existing.captured_revision)
     IS DISTINCT FROM ROW(expected_owner,expected_artifact,expected_kind,expected_attempt,
       expected_command,expected_reservation,expected_object_ref,expected_captured_revision) THEN
     RAISE EXCEPTION 'upload identity conflict'; END IF;
   RETURN existing.captured_revision; END IF;
 IF expected_captured_revision IS NULL OR expected_captured_revision<>fence.revision
   OR fence.active_delete_command_id IS NOT NULL THEN RAISE EXCEPTION 'deletion-in-progress'; END IF;
 INSERT INTO learner_audio_object_names(object_ref,owner_id,artifact_id,source_kind,attempt_ref)
   VALUES(expected_object_ref,expected_owner,expected_artifact,expected_kind,expected_attempt)
   ON CONFLICT(object_ref) DO NOTHING;
 PERFORM 1 FROM learner_audio_object_names WHERE object_ref=expected_object_ref
   AND owner_id=expected_owner AND artifact_id=expected_artifact AND source_kind=expected_kind
   AND attempt_ref=expected_attempt FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'object namespace/source conflict'; END IF;
 IF EXISTS(SELECT 1 FROM learner_audio_upload_attempts WHERE object_ref=expected_object_ref
   AND (io_state<>'closed' OR cleanup_required)) THEN RAISE EXCEPTION 'prior object write or cleanup is unresolved'; END IF;
 IF EXISTS(SELECT 1 FROM learner_audio_deleted_objects WHERE object_ref=expected_object_ref) THEN
   RAISE EXCEPTION 'deleted object namespace cannot be reused'; END IF;
 INSERT INTO learner_audio_upload_attempts(upload_attempt_id,owner_id,artifact_id,object_ref,
   source_kind,attempt_ref,command_ref,reservation_ref,captured_revision,io_state,created_at)
   VALUES(upload_id,expected_owner,expected_artifact,expected_object_ref,expected_kind,expected_attempt,
     expected_command,expected_reservation,fence.revision,'registered',clock_timestamp());
 UPDATE participation_owners SET state='established' WHERE owner_id=expected_owner AND state='empty';
 RETURN fence.revision;
END $$;


-- PRIVATE producer successor. No ordinal, execution, role grant or activation.
-- Requires actual253 and root-adopted guest capture/checkpoint packet for its
-- guest branch. Root must merge the exact positive phase inventory atomically.
SELECT pg_advisory_xact_lock(83000003,1);
CREATE TABLE learner_audio_account_producer_captures (
 upload_attempt_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 account_id TEXT NOT NULL REFERENCES users(user_id),
 owner_kind TEXT GENERATED ALWAYS AS ('account'::TEXT) STORED,
 artifact_id TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN('study','karaoke')),
 attempt_ref TEXT NOT NULL,
 command_ref TEXT NOT NULL,
 producer_generation TEXT NOT NULL,
 session_id TEXT, session_item_id TEXT, attempt_number INTEGER, idempotency_key TEXT, request_hash TEXT, community_id TEXT,
 item_snapshot JSONB,
 reservation_ref TEXT NOT NULL,
 captured_revision BIGINT NOT NULL CHECK(captured_revision BETWEEN 0 AND 9007199254740991),
 expected_object_ref TEXT NOT NULL,
 content_digest TEXT CHECK(content_digest ~ '^[0-9a-f]{64}$'),
 content_type TEXT NOT NULL,
 byte_size BIGINT CHECK(byte_size>0),
 duration_ms INTEGER CHECK(duration_ms>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(upload_attempt_id,owner_id) REFERENCES learner_audio_upload_attempts(upload_attempt_id,owner_id),
 FOREIGN KEY(owner_id,account_id) REFERENCES participation_owners(owner_id,account_id),
 FOREIGN KEY(owner_id,owner_kind) REFERENCES participation_owners(owner_id,kind),
 UNIQUE(owner_id,source_kind,command_ref,producer_generation),
 UNIQUE(upload_attempt_id,owner_id),
 CHECK((source_kind='study' AND content_digest IS NOT NULL AND byte_size IS NOT NULL AND duration_ms IS NOT NULL
  AND session_id IS NOT NULL AND session_item_id IS NOT NULL AND attempt_number IS NOT NULL AND attempt_number>0 AND idempotency_key IS NOT NULL
  AND request_hash IS NOT NULL AND request_hash ~ '^[0-9a-f]{64}$' AND community_id IS NOT NULL AND item_snapshot IS NOT NULL AND jsonb_typeof(item_snapshot)='object')
  OR (source_kind='karaoke' AND session_id IS NULL AND session_item_id IS NULL AND attempt_number IS NULL
   AND idempotency_key IS NULL AND request_hash IS NULL AND community_id IS NULL AND item_snapshot IS NULL))
);
CREATE TABLE learner_audio_upload_terminal_facts (
 upload_attempt_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 content_digest TEXT NOT NULL CHECK(content_digest ~ '^[0-9a-f]{64}$'),
 content_type TEXT NOT NULL,
 byte_size BIGINT NOT NULL CHECK(byte_size>0),
 duration_ms INTEGER NOT NULL CHECK(duration_ms>0),
 settled_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(upload_attempt_id,owner_id) REFERENCES learner_audio_upload_attempts(upload_attempt_id,owner_id)
);
CREATE TABLE learner_audio_upload_cleanup_commands (
 cleanup_id TEXT PRIMARY KEY,
 upload_attempt_id TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 object_ref TEXT NOT NULL REFERENCES learner_audio_object_names(object_ref),
 state TEXT NOT NULL CHECK(state IN('pending','completed')),
 created_at TIMESTAMPTZ NOT NULL,
 completed_at TIMESTAMPTZ,
 FOREIGN KEY(upload_attempt_id,owner_id) REFERENCES learner_audio_upload_attempts(upload_attempt_id,owner_id),
 CHECK((state='completed')=(completed_at IS NOT NULL))
);
CREATE TABLE learner_audio_account_spoken_checkpoints (
 upload_attempt_id TEXT PRIMARY KEY REFERENCES learner_audio_account_producer_captures(upload_attempt_id),
 owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 successful_result JSONB NOT NULL CHECK(jsonb_typeof(successful_result)='object' AND octet_length(successful_result::TEXT)<=131072),
 payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
 persisted_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(upload_attempt_id,owner_id) REFERENCES learner_audio_account_producer_captures(upload_attempt_id,owner_id),
 CHECK(payload_sha256=encode(sha256(convert_to(successful_result::TEXT,'UTF8')),'hex'))
);
CREATE TRIGGER learner_audio_account_capture_immutable BEFORE UPDATE OR DELETE ON learner_audio_account_producer_captures
 FOR EACH ROW EXECUTE FUNCTION retain_learner_audio_immutable_private_v1();
CREATE TRIGGER learner_audio_terminal_fact_immutable BEFORE UPDATE OR DELETE ON learner_audio_upload_terminal_facts
 FOR EACH ROW EXECUTE FUNCTION retain_learner_audio_immutable_private_v1();
CREATE TRIGGER learner_audio_account_checkpoint_immutable BEFORE UPDATE OR DELETE ON learner_audio_account_spoken_checkpoints
 FOR EACH ROW EXECUTE FUNCTION retain_learner_audio_immutable_private_v1();

-- Called at owning business transaction entry BEFORE admission/session/item,
-- command, legacy media or persona rows. Account alias/group resolver is a root
-- source-owned authority seam: do not derive guest bindings from awaiting intents.
-- Current practice-only source permits original account owner plus genuine empty
-- alias components; later bound-account group expansion is an atomic successor.
CREATE FUNCTION lock_account_audio_group_private_v1(p_original_account TEXT) RETURNS TEXT[]
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE account_ids TEXT[]; source_ids TEXT[]; canonical_count INTEGER; locked_account_id TEXT;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 -- No alias-row or user-row lock may precede topology. This table lock also
 -- stabilizes existing ordinary alias writers until their controlled outer
 -- exclusive-barrier admission is installed; it grants them no new authority.
 LOCK TABLE account_aliases IN SHARE MODE;
 WITH RECURSIVE group_members(account_id) AS (
  SELECT p_original_account UNION SELECT CASE WHEN a.source_user_id=g.account_id THEN a.canonical_user_id ELSE a.source_user_id END
  FROM group_members g JOIN account_aliases a ON (a.source_user_id=g.account_id OR a.canonical_user_id=g.account_id)
  WHERE (a.kind='alias' AND a.status='active') OR (a.kind='merge' AND a.status IN('finalizing','completed'))
 ) SELECT array_agg(account_id ORDER BY convert_to(account_id,'UTF8')) INTO account_ids FROM group_members;
 IF account_ids IS NULL OR cardinality(account_ids)>10000
  OR EXISTS(SELECT 1 FROM account_aliases WHERE source_user_id=ANY(account_ids) AND kind='merge' AND status='finalizing')
  OR EXISTS(SELECT 1 FROM unnest(account_ids) id WHERE NOT EXISTS(SELECT 1 FROM users WHERE user_id=id)) THEN
  RAISE EXCEPTION 'account audio group is unsettled'; END IF;
 SELECT count(*) INTO canonical_count FROM unnest(account_ids) id WHERE NOT EXISTS(SELECT 1 FROM account_aliases a
  WHERE a.source_user_id=id AND ((a.kind='alias' AND a.status='active') OR (a.kind='merge' AND a.status='completed')));
 IF canonical_count<>1 THEN RAISE EXCEPTION 'account audio group canonical closure differs'; END IF;
 PERFORM 1 FROM users WHERE user_id=ANY(account_ids) ORDER BY convert_to(user_id,'UTF8') FOR UPDATE;
 SELECT array_agg(owner_id ORDER BY convert_to(owner_id,'UTF8')) INTO source_ids FROM participation_owners
  WHERE kind='account' AND account_id=ANY(account_ids);
 IF source_ids IS NULL OR cardinality(source_ids)<>cardinality(account_ids) THEN RAISE EXCEPTION 'account audio owner map incomplete'; END IF;
 PERFORM lock_learner_audio_sources_private_v1(source_ids);
 FOREACH locked_account_id IN ARRAY account_ids LOOP PERFORM pg_advisory_xact_lock(hashtextextended(locked_account_id,83000001)); END LOOP;
 RETURN source_ids;
END $$;
CREATE FUNCTION lock_original_account_audio_source_private_v1(p_account TEXT) RETURNS TEXT
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT;
BEGIN
 PERFORM lock_account_audio_group_private_v1(p_account);
 source_id:=require_existing_account_participation_owner_v1(p_account);
 RETURN source_id;
END $$;

-- Successful ordinary reservation/reclaim invokes this in the SAME transaction,
-- BEFORE provider dispatch. Its original lease generation is durable even if a
-- later reclaim rewrites today's command lease or artifact digest/ref.
CREATE FUNCTION capture_account_study_audio_private_v1(p_account TEXT,p_command TEXT,p_lease TEXT,p_upload TEXT)
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
 -- All unresolved older generations block reclaim; lease expiry is no I/O fact.
 IF EXISTS(SELECT 1 FROM learner_audio_account_producer_captures c JOIN learner_audio_upload_attempts u USING(upload_attempt_id)
  WHERE c.owner_id=source_id AND c.command_ref=p_command AND (u.io_state<>'closed' OR u.cleanup_required))
  OR EXISTS(SELECT 1 FROM learner_audio_account_spoken_checkpoints cp JOIN learner_audio_account_producer_captures c USING(upload_attempt_id)
   WHERE c.owner_id=source_id AND c.command_ref=p_command)
  OR EXISTS(SELECT 1 FROM learner_audio_account_producer_captures c JOIN learner_audio_account_provider_calls p USING(upload_attempt_id)
   WHERE c.owner_id=source_id AND c.command_ref=p_command AND p.state IN('registered','started','unknown')) THEN
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

-- Current explicit generation is admitted with pending recording/session before
-- the DO can create an upload. Legacy253 unknown captures are NOT replaced here.
CREATE FUNCTION capture_account_karaoke_audio_private_v1(p_account TEXT,p_session TEXT,p_upload TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT; recording karaoke_recordings%ROWTYPE;
 prior learner_audio_account_producer_captures%ROWTYPE; revision BIGINT; ref TEXT;
BEGIN
 source_id:=lock_original_account_audio_source_private_v1(p_account);
 SELECT * INTO STRICT recording FROM karaoke_recordings WHERE session_id=p_session AND account_id=p_account FOR UPDATE;
 SELECT * INTO prior FROM learner_audio_account_producer_captures
  WHERE owner_id=source_id AND source_kind='karaoke' AND command_ref=p_session AND producer_generation=p_session;
 IF FOUND THEN RETURN jsonb_build_object('uploadAttemptId',prior.upload_attempt_id,'sourceOwnerId',source_id,
  'artifactId',prior.artifact_id,'sourceKind','karaoke','attemptRef',prior.attempt_ref,'commandRef',prior.command_ref,
  'reservationRef',prior.reservation_ref,'capturedRevision',prior.captured_revision,'objectRef',prior.expected_object_ref,
  'contentDigest',NULL,'contentType',prior.content_type,'byteSize',NULL,'durationMs',NULL); END IF;
 IF recording.state<>'pending' OR NOT EXISTS(SELECT 1 FROM karaoke_sessions WHERE session_id=p_session
  AND account_id=p_account AND attempt_id=recording.attempt_id AND status='active') THEN
  RAISE EXCEPTION 'new Karaoke capture provenance differs'; END IF;
 IF EXISTS(SELECT 1 FROM learner_audio_upload_attempts WHERE owner_id=source_id AND source_kind='karaoke'
  AND attempt_ref=recording.attempt_id) THEN RAISE EXCEPTION 'legacy recording requires positive producer disposition'; END IF;
 ref:='karaoke/'||p_account||'/'||recording.attempt_id||'.pcm';
 SELECT COALESCE((SELECT f.revision FROM learner_audio_owner_fences f WHERE f.owner_id=source_id),0) INTO revision;
 revision:=register_learner_audio_upload_private_v1(source_id,recording.artifact_id,'karaoke',recording.attempt_id,
  p_session,p_session,ref,p_upload,revision);
 INSERT INTO learner_audio_account_producer_captures(upload_attempt_id,owner_id,account_id,artifact_id,source_kind,
  attempt_ref,command_ref,producer_generation,reservation_ref,captured_revision,expected_object_ref,content_type)
 VALUES(p_upload,source_id,p_account,recording.artifact_id,'karaoke',recording.attempt_id,p_session,p_session,p_session,
  revision,ref,'audio/L16;rate=16000;channels=1');
 RETURN jsonb_build_object('uploadAttemptId',p_upload,'sourceOwnerId',source_id,'artifactId',recording.artifact_id,
  'sourceKind','karaoke','attemptRef',recording.attempt_id,'commandRef',p_session,'reservationRef',p_session,
  'capturedRevision',revision,'objectRef',ref,'contentDigest',NULL,'contentType','audio/L16;rate=16000;channels=1','byteSize',NULL,'durationMs',NULL);
END $$;

CREATE FUNCTION note_learner_audio_multipart_id_private_v1(p_upload TEXT,p_id TEXT) RETURNS VOID
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload learner_audio_upload_attempts%ROWTYPE;
BEGIN
 IF p_id IS NULL OR char_length(p_id) NOT BETWEEN 1 AND 2048 THEN RAISE EXCEPTION 'multipart locator invalid'; END IF;
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[upload.owner_id]);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload FOR UPDATE;
 IF upload.multipart_upload_id IS NOT NULL AND upload.multipart_upload_id<>p_id THEN RAISE EXCEPTION 'multipart locator differs'; END IF;
 IF upload.io_state NOT IN('writing','unknown') THEN RAISE EXCEPTION 'producer is not an admitted writer'; END IF;
 UPDATE learner_audio_upload_attempts SET multipart_upload_id=p_id WHERE upload_attempt_id=p_upload;
 -- ID capture does not itself declare uncertain/closed I/O or clear a fence.
END $$;

CREATE FUNCTION close_unclaimed_learner_audio_private_v1(p_upload TEXT) RETURNS BOOLEAN
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload learner_audio_upload_attempts%ROWTYPE;
BEGIN
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[upload.owner_id]);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload FOR UPDATE;
 IF upload.io_state<>'registered' THEN RETURN FALSE; END IF;
 -- Mandatory claim uses this same lock. No storage I/O has been issued.
 UPDATE learner_audio_upload_attempts SET io_state='closed',storage_disposition='absent',closed_at=clock_timestamp(),cleanup_required=FALSE
  WHERE upload_attempt_id=p_upload;
 RETURN TRUE;
END $$;

CREATE FUNCTION persist_account_spoken_success_private_v1(p_upload TEXT,p_success JSONB) RETURNS VOID
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE captured learner_audio_account_producer_captures%ROWTYPE; prior learner_audio_account_spoken_checkpoints%ROWTYPE;
 digest TEXT;
BEGIN
 SELECT * INTO STRICT captured FROM learner_audio_account_producer_captures WHERE upload_attempt_id=p_upload AND source_kind='study';
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[captured.owner_id]);
 -- Invoked by real accepted provider/grader callback only. Exact captured
 -- generation survives current browser/lease/visibility and active deletion.
 IF jsonb_typeof(p_success)<>'object' OR octet_length(p_success::TEXT)>131072
  OR p_success->>'commandId' IS DISTINCT FROM captured.command_ref
  OR p_success->>'leaseToken' IS DISTINCT FROM captured.producer_generation
  OR p_success->>'artifactId' IS DISTINCT FROM captured.artifact_id
  OR p_success->>'attemptId' IS DISTINCT FROM captured.attempt_ref
  OR p_success->>'audioDigest' IS DISTINCT FROM captured.content_digest
  OR p_success->>'accountId' IS DISTINCT FROM captured.account_id
  OR p_success->>'sessionId' IS DISTINCT FROM captured.session_id OR p_success->>'sessionItemId' IS DISTINCT FROM captured.session_item_id
  OR p_success->>'communityId' IS DISTINCT FROM captured.community_id
  OR p_success->>'requestHash' IS DISTINCT FROM captured.request_hash
  OR (p_success->>'attemptNumber')::INTEGER IS DISTINCT FROM captured.attempt_number
  OR (p_success->>'audioByteSize')::BIGINT IS DISTINCT FROM captured.byte_size
  OR (p_success->>'audioDurationMs')::INTEGER IS DISTINCT FROM captured.duration_ms
  OR p_success->>'audioContentType' IS DISTINCT FROM captured.content_type
  OR p_success->'grade'->>'policyRevision' IS DISTINCT FROM captured.item_snapshot->>'grader_policy_revision' THEN
  RAISE EXCEPTION 'successful account checkpoint capture differs'; END IF;
 digest:=encode(sha256(convert_to(p_success::TEXT,'UTF8')),'hex');
 SELECT * INTO prior FROM learner_audio_account_spoken_checkpoints WHERE upload_attempt_id=p_upload;
 IF FOUND THEN IF prior.payload_sha256<>digest THEN RAISE EXCEPTION 'accepted result changed'; END IF; RETURN; END IF;
 INSERT INTO learner_audio_account_spoken_checkpoints VALUES(p_upload,captured.owner_id,p_success,digest,clock_timestamp());
 UPDATE learner_audio_account_provider_calls SET state='succeeded',resolved_at=clock_timestamp()
  WHERE upload_attempt_id=p_upload AND state IN('started','unknown');
 IF NOT FOUND THEN RAISE EXCEPTION 'original provider dispatch missing'; END IF;
END $$;

-- A real terminal storage response supplies immutable exact metadata. Raw role
-- DML cannot create this receipt. No body Boolean is a no-more-I/O proof.
CREATE FUNCTION settle_learner_audio_terminal_fact_private_v1(p_upload TEXT,p_disposition TEXT,p_known BOOLEAN,p_multipart TEXT,p_fact JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload learner_audio_upload_attempts%ROWTYPE; published BOOLEAN; captured learner_audio_account_producer_captures%ROWTYPE;
BEGIN
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[upload.owner_id]);
 IF p_known IS TRUE AND p_disposition='stored' THEN
  IF p_fact IS NULL OR p_fact-ARRAY['contentDigest','contentType','byteSize','durationMs']<>'{}'::JSONB
   OR NOT p_fact ?& ARRAY['contentDigest','contentType','byteSize','durationMs'] THEN RAISE EXCEPTION 'closed terminal metadata required'; END IF;
  SELECT * INTO captured FROM learner_audio_account_producer_captures WHERE upload_attempt_id=p_upload AND source_kind='study';
  IF FOUND AND (p_fact->>'contentDigest' IS DISTINCT FROM captured.content_digest
   OR p_fact->>'contentType' IS DISTINCT FROM captured.content_type OR (p_fact->>'byteSize')::BIGINT IS DISTINCT FROM captured.byte_size
   OR (p_fact->>'durationMs')::INTEGER IS DISTINCT FROM captured.duration_ms) THEN RAISE EXCEPTION 'terminal metadata differs from original Study capture'; END IF;
  INSERT INTO learner_audio_upload_terminal_facts(upload_attempt_id,owner_id,content_digest,content_type,byte_size,duration_ms,settled_at)
   VALUES(p_upload,upload.owner_id,p_fact->>'contentDigest',p_fact->>'contentType',(p_fact->>'byteSize')::BIGINT,(p_fact->>'durationMs')::INTEGER,clock_timestamp())
   ON CONFLICT(upload_attempt_id) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM learner_audio_upload_terminal_facts f WHERE f.upload_attempt_id=p_upload
   AND jsonb_build_object('contentDigest',f.content_digest,'contentType',f.content_type,'byteSize',f.byte_size,'durationMs',f.duration_ms)=p_fact) THEN
   RAISE EXCEPTION 'terminal storage fact changed'; END IF;
 END IF;
 published:=settle_learner_audio_upload_private_v1(p_upload,p_disposition,p_known,p_multipart);
 RETURN published;
END $$;



-- All helpers and new tables stay private. Root merges the complete explicit
-- phase closure (+5relations/+5FKtargets and every separately adopted guest
-- capture/control relation), pins EVERY helper to trusted_schema, and revokes
-- inherited/PUBLIC grants before source-gate admission. No serving role grants.
DO $pin_private_audio_producer_packet$
DECLARE trusted_schema TEXT:=current_schema(); relation_name TEXT; signature TEXT; grantee_name TEXT;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['learner_audio_account_producer_captures','learner_audio_upload_terminal_facts',
  'learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',relation_name);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c
   CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid=relation_name::regclass AND a.grantee<>0 AND a.grantee<>c.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',relation_name,grantee_name); END LOOP;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['lock_account_audio_group_private_v1(text)','lock_original_account_audio_source_private_v1(text)',
  'capture_account_study_audio_private_v1(text,text,text,text)','capture_account_karaoke_audio_private_v1(text,text,text)',
  'note_learner_audio_multipart_id_private_v1(text,text)','close_unclaimed_learner_audio_private_v1(text)',
  'persist_account_spoken_success_private_v1(text,jsonb)','settle_learner_audio_terminal_fact_private_v1(text,text,boolean,text,jsonb)'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 END LOOP;
END $pin_private_audio_producer_packet$;

-- Apply these bodies in the same packet and pin/revoke their exact signatures
-- in the final binder. Guest tables are the independently reviewed guest-spoken
-- capture/checkpoint packet, never an invented second guest authority store.
CREATE FUNCTION read_captured_learner_audio_private_v1(p_upload TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload learner_audio_upload_attempts%ROWTYPE; result JSONB;
BEGIN
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload;
 SELECT jsonb_build_object('uploadAttemptId',c.upload_attempt_id,'sourceOwnerId',c.owner_id,
  'artifactId',c.artifact_id,'sourceKind',c.source_kind,'attemptRef',c.attempt_ref,'commandRef',c.command_ref,
  'reservationRef',c.reservation_ref,'capturedRevision',c.captured_revision,'objectRef',c.expected_object_ref,
  'contentDigest',c.content_digest,'contentType',c.content_type,'byteSize',c.byte_size,'durationMs',c.duration_ms)
 INTO result FROM learner_audio_account_producer_captures c WHERE c.upload_attempt_id=p_upload;
 IF result IS NULL OR ROW(upload.owner_id,upload.artifact_id,upload.source_kind,upload.attempt_ref,
  upload.command_ref,upload.reservation_ref,upload.captured_revision,upload.object_ref)
  IS DISTINCT FROM ROW(result->>'sourceOwnerId',result->>'artifactId',result->>'sourceKind',result->>'attemptRef',
  result->>'commandRef',result->>'reservationRef',(result->>'capturedRevision')::BIGINT,result->>'objectRef') THEN
  RAISE EXCEPTION 'immutable archive capture missing or differs'; END IF;
 RETURN result;
END $$;
CREATE FUNCTION require_captured_learner_audio_private_v1(p_capture JSONB) RETURNS TEXT
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT:=p_capture->>'uploadAttemptId';
BEGIN
 IF p_capture IS NULL OR read_captured_learner_audio_private_v1(upload_id) IS DISTINCT FROM p_capture THEN
  RAISE EXCEPTION 'archive generation differs'; END IF;
 RETURN upload_id;
END $$;
CREATE FUNCTION read_learner_audio_upload_status_private_v1(p_upload TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload learner_audio_upload_attempts%ROWTYPE; fence learner_audio_owner_fences%ROWTYPE;
BEGIN
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload;
 SELECT * INTO STRICT fence FROM learner_audio_owner_fences WHERE owner_id=upload.owner_id;
 RETURN jsonb_build_object('capture',read_captured_learner_audio_private_v1(p_upload),
  'ioState',upload.io_state,'storageDisposition',upload.storage_disposition,'cleanupRequired',upload.cleanup_required,
  'mayPublish',upload.io_state='closed' AND upload.storage_disposition='stored' AND NOT upload.cleanup_required
    AND fence.revision=upload.captured_revision AND fence.active_delete_command_id IS NULL,
  'mayContinue',upload.io_state='writing' AND fence.revision=upload.captured_revision AND fence.active_delete_command_id IS NULL);
END $$;
CREATE FUNCTION claim_captured_learner_audio_private_v1(p_capture JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT; claimed BOOLEAN;
BEGIN
 upload_id:=require_captured_learner_audio_private_v1(p_capture);
 claimed:=claim_learner_audio_upload_private_v1(upload_id);
 RETURN read_learner_audio_upload_status_private_v1(upload_id)||jsonb_build_object('claimed',claimed);
END $$;
CREATE FUNCTION continue_captured_learner_audio_private_v1(p_capture JSONB) RETURNS BOOLEAN
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT; upload learner_audio_upload_attempts%ROWTYPE;
BEGIN
 upload_id:=require_captured_learner_audio_private_v1(p_capture);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=upload_id;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[upload.owner_id]);
 RETURN (read_learner_audio_upload_status_private_v1(upload_id)->>'mayContinue')::BOOLEAN;
END $$;
DO $pin_captured_audio_io_packet$
DECLARE trusted_schema TEXT:=current_schema(); signature TEXT; grantee_name TEXT;
BEGIN
 FOREACH signature IN ARRAY ARRAY['read_captured_learner_audio_private_v1(text)',
  'require_captured_learner_audio_private_v1(jsonb)','read_learner_audio_upload_status_private_v1(text)',
  'claim_captured_learner_audio_private_v1(jsonb)','continue_captured_learner_audio_private_v1(jsonb)'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 END LOOP;
END $pin_captured_audio_io_packet$;

-- Provider lifecycle is separate from archive lifecycle. Audio registered/no-I/O
-- may close while a provider remains unknown; that NEVER permits provider replay.
CREATE TABLE learner_audio_account_provider_calls (
 upload_attempt_id TEXT PRIMARY KEY REFERENCES learner_audio_account_producer_captures(upload_attempt_id),
 owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 state TEXT NOT NULL CHECK(state IN('registered','started','unknown','known_failed','succeeded')),
 created_at TIMESTAMPTZ NOT NULL,
 resolved_at TIMESTAMPTZ,
 FOREIGN KEY(upload_attempt_id,owner_id) REFERENCES learner_audio_account_producer_captures(upload_attempt_id,owner_id),
 CHECK((state IN('known_failed','succeeded'))=(resolved_at IS NOT NULL))
);
CREATE FUNCTION guard_account_audio_provider_call_private_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'provider outcome evidence retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','resolved_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','resolved_at']) THEN RAISE EXCEPTION 'provider identity differs'; END IF;
 IF OLD.state IN('known_failed','succeeded') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'terminal provider outcome differs'; END IF;
 IF NOT ((OLD.state='registered' AND NEW.state IN('registered','started','known_failed'))
  OR (OLD.state IN('started','unknown') AND NEW.state IN('unknown','known_failed','succeeded'))
  OR (OLD.state IN('known_failed','succeeded') AND NEW.state=OLD.state)) THEN RAISE EXCEPTION 'provider state transition differs'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER learner_audio_account_provider_call_state BEFORE UPDATE OR DELETE ON learner_audio_account_provider_calls
 FOR EACH ROW EXECUTE FUNCTION guard_account_audio_provider_call_private_v1();
CREATE FUNCTION begin_account_spoken_provider_private_v1(p_upload TEXT) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE captured learner_audio_account_producer_captures%ROWTYPE; prior learner_audio_account_provider_calls%ROWTYPE;
BEGIN
 SELECT * INTO STRICT captured FROM learner_audio_account_producer_captures WHERE upload_attempt_id=p_upload AND source_kind='study';
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[captured.owner_id]);
 INSERT INTO learner_audio_account_provider_calls VALUES(p_upload,captured.owner_id,'registered',clock_timestamp(),NULL) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT prior FROM learner_audio_account_provider_calls WHERE upload_attempt_id=p_upload FOR UPDATE;
 IF prior.state<>'registered' THEN RETURN FALSE; END IF;
 UPDATE learner_audio_account_provider_calls SET state='started' WHERE upload_attempt_id=p_upload;
 RETURN TRUE;
END $$;
CREATE FUNCTION mark_account_spoken_provider_unknown_private_v1(p_upload TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT;
BEGIN
 SELECT owner_id INTO STRICT source_id FROM learner_audio_account_producer_captures WHERE upload_attempt_id=p_upload AND source_kind='study';
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[source_id]);
 UPDATE learner_audio_account_provider_calls SET state='unknown' WHERE upload_attempt_id=p_upload AND state='started';
 -- Archive never started after provider failure, so registered audio may safely
 -- close. The independent unknown provider fact still blocks a new generation.
 PERFORM close_unclaimed_learner_audio_private_v1(p_upload);
END $$;
DO $pin_account_audio_provider_packet$
DECLARE trusted_schema TEXT:=current_schema(); grantee_name TEXT; signature TEXT;
BEGIN
 REVOKE ALL ON learner_audio_account_provider_calls FROM PUBLIC;
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.oid='learner_audio_account_provider_calls'::regclass AND a.grantee<>0 AND a.grantee<>c.relowner LOOP
  EXECUTE format('REVOKE ALL ON learner_audio_account_provider_calls FROM %I',grantee_name); END LOOP;
 FOREACH signature IN ARRAY ARRAY['guard_account_audio_provider_call_private_v1()',
  'begin_account_spoken_provider_private_v1(text)','mark_account_spoken_provider_unknown_private_v1(text)'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 END LOOP;
END $pin_account_audio_provider_packet$;

CREATE FUNCTION learner_audio_producer_component_has_history_private_v1(p_owners TEXT[])
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM learner_audio_account_producer_captures WHERE owner_id=ANY(p_owners))
 OR EXISTS(SELECT 1 FROM learner_audio_upload_terminal_facts WHERE owner_id=ANY(p_owners))
 OR EXISTS(SELECT 1 FROM learner_audio_upload_cleanup_commands WHERE owner_id=ANY(p_owners))
 OR EXISTS(SELECT 1 FROM learner_audio_account_spoken_checkpoints WHERE owner_id=ANY(p_owners))
 OR EXISTS(SELECT 1 FROM learner_audio_account_provider_calls WHERE owner_id=ANY(p_owners))
$$;
DO $pin_account_audio_history$
DECLARE grantee_name TEXT; trusted_schema TEXT:=current_schema();
BEGIN
 EXECUTE format('ALTER FUNCTION learner_audio_producer_component_has_history_private_v1(text[]) SET search_path TO pg_catalog,%I,pg_temp',trusted_schema);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
  CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
  WHERE f.oid='learner_audio_producer_component_has_history_private_v1(text[])'::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION learner_audio_producer_component_has_history_private_v1(text[]) FROM %I',grantee_name); END LOOP;
END $pin_account_audio_history$;
REVOKE ALL ON FUNCTION learner_audio_producer_component_has_history_private_v1(text[]) FROM PUBLIC;

-- Read recovery is bound to original account/session/item and original submitted
-- bytes. It does not reload today's persona/post/learning lease or mint IDs.
CREATE FUNCTION find_account_spoken_success_private_v1(p_account TEXT,p_session TEXT,p_item TEXT,p_attempt INTEGER,
 p_key TEXT,p_digest TEXT,p_type TEXT,p_bytes BIGINT,p_duration INTEGER) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSONB;
BEGIN
 PERFORM lock_original_account_audio_source_private_v1(p_account);
 SELECT jsonb_build_object('capture',read_captured_learner_audio_private_v1(c.upload_attempt_id),'success',cp.successful_result)
 INTO result FROM learner_audio_account_producer_captures c JOIN learner_audio_account_spoken_checkpoints cp USING(upload_attempt_id)
 WHERE c.account_id=p_account AND c.session_id=p_session AND c.session_item_id=p_item AND c.attempt_number=p_attempt
  AND c.idempotency_key=p_key AND c.content_digest=p_digest AND c.content_type=p_type AND c.byte_size=p_bytes AND c.duration_ms=p_duration;
 RETURN result;
END $$;
CREATE FUNCTION load_account_spoken_success_private_v1(p_upload TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSONB;
BEGIN
 SELECT successful_result INTO STRICT result FROM learner_audio_account_spoken_checkpoints WHERE upload_attempt_id=p_upload;
 RETURN result;
END $$;
CREATE FUNCTION require_account_spoken_success_private_v1(p_upload TEXT,p_success JSONB) RETURNS BOOLEAN
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE captured learner_audio_account_producer_captures%ROWTYPE; command study_spoken_answer_commands%ROWTYPE;
BEGIN
 SELECT * INTO STRICT captured FROM learner_audio_account_producer_captures WHERE upload_attempt_id=p_upload AND source_kind='study';
 PERFORM lock_original_account_audio_source_private_v1(captured.account_id);
 IF load_account_spoken_success_private_v1(p_upload) IS DISTINCT FROM p_success THEN RAISE EXCEPTION 'accepted account result differs'; END IF;
 SELECT * INTO STRICT command FROM study_spoken_answer_commands WHERE command_id=captured.command_ref FOR UPDATE;
 IF command.participation_owner_id<>captured.owner_id OR command.account_id IS DISTINCT FROM captured.account_id
  OR command.session_id<>captured.session_id OR command.session_item_id<>captured.session_item_id
  OR command.lease_token<>captured.producer_generation OR command.request_hash<>captured.request_hash
  OR command.audio_digest<>captured.content_digest THEN RAISE EXCEPTION 'original account command differs'; END IF;
 RETURN TRUE;
END $$;
DO $pin_account_spoken_recovery$
DECLARE signature TEXT; schema_name TEXT; owner_id OID; namespace_id OID; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 FOREACH signature IN ARRAY ARRAY['find_account_spoken_success_private_v1(text,text,text,integer,text,text,text,bigint,integer)',
 'load_account_spoken_success_private_v1(text)','require_account_spoken_success_private_v1(text,jsonb)'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure AND f.pronamespace=namespace_id AND f.proowner=owner_id) THEN RAISE EXCEPTION 'account recovery function provenance differs'; END IF;
 EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 END LOOP;
END $pin_account_spoken_recovery$;
CREATE FUNCTION require_account_spoken_archive_private_v1(p_upload TEXT,p_state TEXT,p_ref TEXT) RETURNS VOID
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE capture JSONB; status JSONB;
BEGIN
 capture:=read_captured_learner_audio_private_v1(p_upload);
 IF capture->>'sourceKind'<>'study' OR NOT EXISTS(SELECT 1 FROM learner_audio_account_spoken_checkpoints WHERE upload_attempt_id=p_upload) THEN RAISE EXCEPTION 'accepted original account Study capture required'; END IF;
 status:=read_learner_audio_upload_status_private_v1(p_upload);
 IF status->>'ioState'<>'closed' THEN RAISE EXCEPTION 'archive disposition remains unknown'; END IF;
 IF (p_state='stored' AND (p_ref IS DISTINCT FROM capture->>'objectRef' OR (status->>'mayPublish')::BOOLEAN IS DISTINCT FROM TRUE))
  OR (p_state='failed' AND (p_ref IS NOT NULL OR (status->>'mayPublish')::BOOLEAN IS TRUE))
  OR p_state IS NULL OR p_state NOT IN('stored','failed') THEN RAISE EXCEPTION 'account archive result differs from actual fence'; END IF;
END $$;
DO $pin_account_archive_result$
DECLARE schema_name TEXT; owner_id OID; namespace_id OID; grantee_name TEXT; signature TEXT:='require_account_spoken_archive_private_v1(text,text,text)';
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure AND f.pronamespace=namespace_id AND f.proowner=owner_id) THEN RAISE EXCEPTION 'account archive result provenance differs'; END IF;
 EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
END $pin_account_archive_result$;

CREATE FUNCTION prepare_account_audio_delete_private_v1(p_original_account TEXT,p_maximum INTEGER) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE sources TEXT[]; active_ids TEXT[]; command learner_audio_delete_commands%ROWTYPE; batch_id TEXT;
 source_id TEXT; fresh_command TEXT; fresh_key TEXT; digest TEXT;
BEGIN
 IF p_maximum<>1000 THEN RAISE EXCEPTION 'ordinary batch maximum must remain1000'; END IF;
 sources:=lock_account_audio_group_private_v1(p_original_account);
 SELECT array_agg(DISTINCT active_delete_command_id) FILTER(WHERE active_delete_command_id IS NOT NULL) INTO active_ids
  FROM learner_audio_owner_fences WHERE owner_id=ANY(sources);
 IF cardinality(active_ids)>1 THEN RAISE EXCEPTION 'account group has conflicting captured deletions'; END IF;
 IF cardinality(active_ids)=1 THEN
  SELECT * INTO STRICT command FROM learner_audio_delete_commands WHERE command_id=active_ids[1];
  source_id:=command.source_owner_id;fresh_command:=command.command_id;fresh_key:=command.idempotency_key;digest:=command.request_hash;
 ELSE
  source_id:=require_existing_account_participation_owner_v1(p_original_account);
  fresh_command:='audio_delete_'||gen_random_uuid()::TEXT;fresh_key:=fresh_command;
  digest:=encode(sha256(convert_to(jsonb_build_array('account_audio_deletion_v1',source_id,to_jsonb(sources))::TEXT,'UTF8')),'hex');
 END IF;
 batch_id:=prepare_learner_audio_delete_private_v1(source_id,fresh_key,digest,fresh_command,sources,
  'audio_batch_'||gen_random_uuid()::TEXT,1000,'unknown');
 IF batch_id IS NULL THEN RAISE EXCEPTION 'completed deletion has no active prepared batch'; END IF;
 RETURN jsonb_build_object('batchId',batch_id,'fenceRevision',(SELECT revision FROM learner_audio_delete_batches WHERE learner_audio_delete_batches.batch_id=prepare_account_audio_delete_private_v1.batch_id),
 'objectRefs',COALESCE((SELECT jsonb_agg(object_ref ORDER BY ordinal) FROM learner_audio_delete_batch_items WHERE learner_audio_delete_batch_items.batch_id=prepare_account_audio_delete_private_v1.batch_id),'[]'::JSONB));
END $$;
CREATE FUNCTION confirm_account_audio_delete_private_v1(p_batch TEXT,p_revision BIGINT,p_deleted_at TIMESTAMPTZ) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE complete BOOLEAN; command_id TEXT; deleted_count BIGINT; remaining_count BIGINT; latest TIMESTAMPTZ;
 original_command TEXT; original_source TEXT; original_account TEXT;
 source_ids TEXT[]; captured_sources TEXT[];
 batch_row learner_audio_delete_batches%ROWTYPE;
 command_row learner_audio_delete_commands%ROWTYPE;
BEGIN
 -- Establish topology before reading/locking source authority. This initial
 -- immutable identity read takes NO owner, account, batch or command row lock.
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 PERFORM require_guest_practice_only_schema_phase_v1();
 IF p_batch IS NULL OR char_length(p_batch) NOT BETWEEN 1 AND 128
  OR p_revision IS NULL OR p_revision NOT BETWEEN 1 AND 9007199254740991 THEN
  RAISE EXCEPTION 'captured Account batch identity required'; END IF;
 SELECT b.command_id,c.source_owner_id,o.account_id
  INTO original_command,original_source,original_account
  FROM learner_audio_delete_batches b
  JOIN learner_audio_delete_commands c ON c.command_id=b.command_id
  JOIN participation_owners o ON o.owner_id=c.source_owner_id
  WHERE b.batch_id=p_batch AND o.kind='account';
 IF NOT FOUND OR original_account IS NULL THEN
  RAISE EXCEPTION 'captured Account deletion source required'; END IF;
 -- Reviewed77c1 helper stabilizes aliases and locks users, then the full source
 -- component in raw UTF8 owner order, before any batch/command row lock.
 source_ids:=lock_account_audio_group_private_v1(original_account);
 SELECT array_agg(owner_id ORDER BY convert_to(owner_id,'UTF8')) INTO captured_sources
  FROM learner_audio_delete_sources WHERE command_id=original_command;
 IF source_ids IS NULL OR captured_sources IS NULL
  OR captured_sources IS DISTINCT FROM source_ids
  OR NOT original_source=ANY(source_ids)
  OR EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=ANY(captured_sources)
    AND (kind<>'account' OR account_id IS NULL)) THEN
  RAISE EXCEPTION 'captured Account deletion group differs'; END IF;
 SELECT * INTO STRICT batch_row FROM learner_audio_delete_batches WHERE batch_id=p_batch FOR UPDATE;
 SELECT * INTO STRICT command_row FROM learner_audio_delete_commands
  WHERE command_id=batch_row.command_id FOR UPDATE;
 IF batch_row.command_id IS DISTINCT FROM original_command
  OR command_row.source_owner_id IS DISTINCT FROM original_source
  OR batch_row.revision IS DISTINCT FROM p_revision
  OR command_row.revision IS DISTINCT FROM p_revision THEN
  RAISE EXCEPTION 'captured Account deletion revision differs'; END IF;
 -- An old positively completed command has no active fence to reacquire.
 -- A confirmed batch in a pending command still reconciles genuine late writer
 -- facts through native253 below; do not replace that with unknown's no-op.
 IF command_row.state='completed' THEN
  IF batch_row.state<>'confirmed' THEN
   RAISE EXCEPTION 'completed Account deletion has no confirmed batch'; END IF;
 ELSIF command_row.state<>'pending'
  OR EXISTS(SELECT 1 FROM unnest(source_ids) AS sources(owner_id)
    LEFT JOIN learner_audio_owner_fences f ON f.owner_id=sources.owner_id
    WHERE f.owner_id IS NULL OR f.revision IS DISTINCT FROM p_revision
      OR f.active_delete_command_id IS DISTINCT FROM command_row.command_id) THEN
  RAISE EXCEPTION 'captured Account deletion fence differs'; END IF;
 complete:=confirm_learner_audio_delete_private_v1(p_batch,p_revision,'deleted',p_deleted_at);
 SELECT b.command_id INTO STRICT command_id FROM learner_audio_delete_batches b WHERE batch_id=p_batch;
 SELECT count(*) FILTER(WHERE a.recording_state='deleted' OR (a.learner_audio_artifact_id IS NULL AND r.state='deleted')),
  count(*) FILTER(WHERE COALESCE(a.recording_state,r.state,'unpublished')<>'deleted')
 INTO deleted_count,remaining_count FROM learner_audio_delete_target_artifacts target
 LEFT JOIN learner_audio_artifacts a ON a.learner_audio_artifact_id=target.artifact_id AND a.participation_owner_id=target.owner_id
 LEFT JOIN karaoke_recordings r ON target.source_kind='karaoke' AND r.artifact_id=target.artifact_id
 WHERE target.command_id=confirm_account_audio_delete_private_v1.command_id;
 IF NOT complete AND deleted_count=0 THEN RAISE EXCEPTION 'audio producers remain unresolved' USING ERRCODE='GA001'; END IF;
 SELECT max(a.deleted_at) INTO latest FROM learner_audio_artifacts a JOIN learner_audio_delete_sources s ON s.owner_id=a.participation_owner_id
  WHERE s.command_id=confirm_account_audio_delete_private_v1.command_id;
 RETURN jsonb_build_object('object','learner_audio_deletion','deleted_count',deleted_count,'remaining_count',remaining_count,
  'last_deleted_at',CASE WHEN latest IS NULL THEN NULL ELSE to_char(latest AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
END $$;
DO $pin_account_delete_bridge$
DECLARE signature TEXT; schema_name TEXT; owner_id OID; namespace_id OID; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 FOREACH signature IN ARRAY ARRAY['prepare_account_audio_delete_private_v1(text,integer)','confirm_account_audio_delete_private_v1(text,bigint,timestamptz)'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure AND f.pronamespace=namespace_id AND f.proowner=owner_id) THEN RAISE EXCEPTION 'account delete bridge provenance differs'; END IF;
 EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 END LOOP;
END $pin_account_delete_bridge$;

CREATE FUNCTION guard_captured_audio_cleanup_private_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'cleanup evidence is retained'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM learner_audio_upload_attempts u WHERE u.upload_attempt_id=NEW.upload_attempt_id AND u.owner_id=NEW.owner_id AND u.object_ref=NEW.object_ref AND u.io_state='closed' AND u.cleanup_required) THEN RAISE EXCEPTION 'cleanup source tuple differs'; END IF;
  RETURN NEW; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','completed_at'])
  OR (OLD.state='completed' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
  OR (OLD.state='pending' AND NEW.state NOT IN('pending','completed')) THEN RAISE EXCEPTION 'cleanup command identity/terminal state differs'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER learner_audio_upload_cleanup_guard BEFORE INSERT OR UPDATE OR DELETE ON learner_audio_upload_cleanup_commands
 FOR EACH ROW EXECUTE FUNCTION guard_captured_audio_cleanup_private_v1();
CREATE FUNCTION prepare_captured_audio_cleanup_private_v1(p_capture JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT; upload learner_audio_upload_attempts%ROWTYPE; command learner_audio_upload_cleanup_commands%ROWTYPE;
BEGIN
 upload_id:=require_captured_learner_audio_private_v1(p_capture);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=upload_id;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[upload.owner_id]);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=upload_id FOR UPDATE;
 IF upload.io_state<>'closed' OR NOT upload.cleanup_required THEN RAISE EXCEPTION 'closed cleanup-required original upload required'; END IF;
 IF EXISTS(SELECT 1 FROM learner_audio_upload_attempts u WHERE u.object_ref=upload.object_ref AND u.upload_attempt_id<>upload_id
  AND (u.created_at>=upload.created_at OR u.io_state<>'closed')) THEN RAISE EXCEPTION 'object generation closure is unavailable'; END IF;
 SELECT * INTO command FROM learner_audio_upload_cleanup_commands WHERE upload_attempt_id=upload_id;
 IF NOT FOUND THEN INSERT INTO learner_audio_upload_cleanup_commands VALUES('audio_cleanup_'||gen_random_uuid()::TEXT,upload_id,upload.owner_id,upload.object_ref,'pending',clock_timestamp(),NULL) RETURNING * INTO command; END IF;
 RETURN jsonb_build_object('cleanupId',command.cleanup_id,'uploadAttemptId',upload_id,'objectRef',upload.object_ref);
END $$;
CREATE FUNCTION confirm_captured_audio_cleanup_private_v1(p_cleanup TEXT,p_upload TEXT,p_ref TEXT,p_at TIMESTAMPTZ) RETURNS VOID
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command learner_audio_upload_cleanup_commands%ROWTYPE; upload learner_audio_upload_attempts%ROWTYPE;
BEGIN
 SELECT * INTO STRICT command FROM learner_audio_upload_cleanup_commands WHERE cleanup_id=p_cleanup;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[command.owner_id]);
 SELECT * INTO STRICT command FROM learner_audio_upload_cleanup_commands WHERE cleanup_id=p_cleanup FOR UPDATE;
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload FOR UPDATE;
 IF command.upload_attempt_id<>p_upload OR command.object_ref<>p_ref OR upload.owner_id<>command.owner_id
  OR upload.object_ref<>p_ref OR upload.io_state<>'closed' OR p_at IS NULL THEN RAISE EXCEPTION 'original cleanup command differs'; END IF;
 IF command.state='completed' THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM learner_audio_upload_attempts u WHERE u.object_ref=p_ref AND u.upload_attempt_id<>p_upload
  AND (u.created_at>=upload.created_at OR u.io_state<>'closed')) THEN RAISE EXCEPTION 'object generation closure changed'; END IF;
 UPDATE learner_audio_upload_cleanup_commands SET state='completed',completed_at=p_at WHERE cleanup_id=p_cleanup;
 UPDATE learner_audio_upload_attempts SET cleanup_required=FALSE WHERE upload_attempt_id=p_upload;
 -- Exact failed/late-upload cleanup retains namespace, checkpoint and original
 -- terminal upload fact. It is not an owner deletion or global absence receipt.
END $$;

-- Final finite packet provenance/ACL seal. Earlier helpers never become usable
-- between statements: root adopts everything in ONE owned transaction.
DO $seal_complete_private_audio_producer_packet$
DECLARE signature TEXT; relation_name TEXT; namespace_id OID; owner_id OID; schema_name TEXT; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF schema_name IS NULL OR schema_name='pg_catalog' OR schema_name ~ '^pg_temp' THEN RAISE EXCEPTION 'trusted audio producer schema required'; END IF;
 FOREACH relation_name IN ARRAY ARRAY['learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=relation_name::regclass AND c.relnamespace=namespace_id AND c.relowner=owner_id AND c.relkind='r') THEN RAISE EXCEPTION 'producer relation provenance differs'; END IF;
 EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',relation_name);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=relation_name::regclass AND a.grantee<>0 AND a.grantee<>c.relowner LOOP EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',relation_name,grantee_name); END LOOP;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['lock_account_audio_group_private_v1(text)','lock_original_account_audio_source_private_v1(text)','capture_account_study_audio_private_v1(text,text,text,text)','capture_account_karaoke_audio_private_v1(text,text,text)','note_learner_audio_multipart_id_private_v1(text,text)','close_unclaimed_learner_audio_private_v1(text)','persist_account_spoken_success_private_v1(text,jsonb)','settle_learner_audio_terminal_fact_private_v1(text,text,boolean,text,jsonb)','read_captured_learner_audio_private_v1(text)','require_captured_learner_audio_private_v1(jsonb)','read_learner_audio_upload_status_private_v1(text)','claim_captured_learner_audio_private_v1(jsonb)','continue_captured_learner_audio_private_v1(jsonb)','guard_account_audio_provider_call_private_v1()','begin_account_spoken_provider_private_v1(text)','mark_account_spoken_provider_unknown_private_v1(text)','learner_audio_producer_component_has_history_private_v1(text[])','find_account_spoken_success_private_v1(text,text,text,integer,text,text,text,bigint,integer)','load_account_spoken_success_private_v1(text)','require_account_spoken_success_private_v1(text,jsonb)','require_account_spoken_archive_private_v1(text,text,text)','prepare_account_audio_delete_private_v1(text,integer)','confirm_account_audio_delete_private_v1(text,bigint,timestamptz)','guard_captured_audio_cleanup_private_v1()','prepare_captured_audio_cleanup_private_v1(jsonb)','confirm_captured_audio_cleanup_private_v1(text,text,text,timestamptz)'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure AND f.pronamespace=namespace_id AND f.proowner=owner_id) THEN RAISE EXCEPTION 'producer function provenance differs'; END IF;
 EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 END LOOP;
END $seal_complete_private_audio_producer_packet$;

-- Privileged internal cron leaf only. No cookie, original-lease replacement,
-- fresh provider call, new IDs or raw application-role row grants.
CREATE FUNCTION list_closed_account_spoken_checkpoints_private_v1(p_maximum INTEGER) RETURNS JSONB
 LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
 IF p_maximum IS NULL OR p_maximum NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'recovery bound1..25 required'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('capture',read_captured_learner_audio_private_v1(c.upload_attempt_id),
  'success',cp.successful_result,'archive',jsonb_build_object('state',CASE WHEN (read_learner_audio_upload_status_private_v1(c.upload_attempt_id)->>'mayPublish')::BOOLEAN THEN 'stored' ELSE 'failed' END,
  'objectRef',CASE WHEN (read_learner_audio_upload_status_private_v1(c.upload_attempt_id)->>'mayPublish')::BOOLEAN THEN c.expected_object_ref ELSE NULL END)) ORDER BY cp.persisted_at,c.upload_attempt_id)
  FROM (SELECT c.upload_attempt_id FROM learner_audio_account_producer_captures c
   JOIN learner_audio_account_spoken_checkpoints cp USING(upload_attempt_id)
   JOIN learner_audio_upload_attempts u USING(upload_attempt_id)
   JOIN study_spoken_answer_commands command ON command.command_id=c.command_ref
   WHERE command.state='reserved' AND u.io_state='closed'
   ORDER BY cp.persisted_at,c.upload_attempt_id LIMIT p_maximum) ready
  JOIN learner_audio_account_producer_captures c USING(upload_attempt_id)
  JOIN learner_audio_account_spoken_checkpoints cp USING(upload_attempt_id)),'[]'::JSONB);
 -- Unknown/writing/registered uploads remain pending and never become failed
 -- through age or process loss. Filtering ready rows avoids queue starvation.
END $$;
DO $pin_account_closed_checkpoint_job_leaf$
DECLARE signature TEXT:='list_closed_account_spoken_checkpoints_private_v1(integer)';namespace_id OID;owner_id OID;schema_name TEXT;grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF schema_name IS NULL OR schema_name='pg_catalog' OR schema_name ~ '^pg_temp' OR NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure AND f.pronamespace=namespace_id AND f.proowner=owner_id) THEN RAISE EXCEPTION 'account recovery leaf provenance differs'; END IF;
 EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
END $pin_account_closed_checkpoint_job_leaf$;


-- Outside-source controlled Account callback proposal. No ordinal, grant or execution.
-- Append within the root-owned ordinary producer migration before its final native
-- signature/ACL inventory and positive v5 phase. Keep raw253 failure denied.
CREATE FUNCTION fail_account_audio_delete_private_v1(p_batch TEXT,p_revision BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE original_command TEXT; original_source TEXT; original_account TEXT;
 source_ids TEXT[]; captured_sources TEXT[];
 batch_row learner_audio_delete_batches%ROWTYPE;
 command_row learner_audio_delete_commands%ROWTYPE;
BEGIN
 -- Establish topology before reading/locking source authority. This initial
 -- immutable identity read takes NO owner, account, batch or command row lock.
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 PERFORM require_guest_practice_only_schema_phase_v1();
 IF p_batch IS NULL OR char_length(p_batch) NOT BETWEEN 1 AND 128
  OR p_revision IS NULL OR p_revision NOT BETWEEN 1 AND 9007199254740991 THEN
  RAISE EXCEPTION 'captured Account batch identity required'; END IF;
 SELECT b.command_id,c.source_owner_id,o.account_id
  INTO original_command,original_source,original_account
  FROM learner_audio_delete_batches b
  JOIN learner_audio_delete_commands c ON c.command_id=b.command_id
  JOIN participation_owners o ON o.owner_id=c.source_owner_id
  WHERE b.batch_id=p_batch AND o.kind='account';
 IF NOT FOUND OR original_account IS NULL THEN
  RAISE EXCEPTION 'captured Account deletion source required'; END IF;
 -- Reviewed77c1 helper stabilizes aliases and locks users, then the full source
 -- component in raw UTF8 owner order, before any batch/command row lock.
 source_ids:=lock_account_audio_group_private_v1(original_account);
 SELECT array_agg(owner_id ORDER BY convert_to(owner_id,'UTF8')) INTO captured_sources
  FROM learner_audio_delete_sources WHERE command_id=original_command;
 IF source_ids IS NULL OR captured_sources IS NULL
  OR captured_sources IS DISTINCT FROM source_ids
  OR NOT original_source=ANY(source_ids)
  OR EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=ANY(captured_sources)
    AND (kind<>'account' OR account_id IS NULL)) THEN
  RAISE EXCEPTION 'captured Account deletion group differs'; END IF;
 SELECT * INTO STRICT batch_row FROM learner_audio_delete_batches WHERE batch_id=p_batch FOR UPDATE;
 SELECT * INTO STRICT command_row FROM learner_audio_delete_commands
  WHERE command_id=batch_row.command_id FOR UPDATE;
 IF batch_row.command_id IS DISTINCT FROM original_command
  OR command_row.source_owner_id IS DISTINCT FROM original_source
  OR batch_row.revision IS DISTINCT FROM p_revision
  OR command_row.revision IS DISTINCT FROM p_revision THEN
  RAISE EXCEPTION 'captured Account deletion revision differs'; END IF;
 -- A positively confirmed exact batch never regresses because another DELETE
 -- acknowledgement is unavailable. This changes no prior confirmation/fence.
 IF batch_row.state='confirmed' THEN RETURN; END IF;
 IF command_row.state<>'pending'
  OR EXISTS(SELECT 1 FROM unnest(source_ids) AS sources(owner_id)
    LEFT JOIN learner_audio_owner_fences f ON f.owner_id=sources.owner_id
    WHERE f.owner_id IS NULL OR f.revision IS DISTINCT FROM p_revision
      OR f.active_delete_command_id IS DISTINCT FROM command_row.command_id) THEN
  RAISE EXCEPTION 'captured Account deletion fence differs'; END IF;
 -- Constant unresolved outcome only; no caller-selected terminal/deletion fact.
 -- Raw253 changes only the unconfirmed batch state, retaining command/provider,
 -- owner fence, upload, known-object and successful-checkpoint evidence.
 PERFORM fail_learner_audio_delete_private_v1(p_batch,'unknown');
END $$;

DO $bind_account_delete_unknown_callback$
DECLARE signature TEXT:='fail_account_audio_delete_private_v1(text,bigint)';
 trusted_namespace OID; trusted_owner OID; trusted_schema TEXT; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname
  INTO STRICT trusted_namespace,trusted_owner,trusted_schema
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.oid='participation_owners'::regclass;
 IF trusted_schema IS NULL OR trusted_schema='information_schema' OR trusted_schema LIKE 'pg_%'
  OR NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure
    AND f.pronamespace=trusted_namespace AND f.proowner=trusted_owner AND f.prosecdef) THEN
  RAISE EXCEPTION 'Account deletion callback custody differs'; END IF;
 EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
  FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
  WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
 END LOOP;
END $bind_account_delete_unknown_callback$;


-- Same private producer migration transaction; no ordinal/role activation.
CREATE FUNCTION read_account_karaoke_audio_capture_private_v1(p_account TEXT,p_session TEXT,p_attempt TEXT,p_artifact TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT;
BEGIN
 PERFORM lock_account_audio_group_private_v1(p_account);
 SELECT upload_attempt_id INTO STRICT upload_id FROM learner_audio_account_producer_captures
  WHERE account_id=p_account AND source_kind='karaoke' AND command_ref=p_session AND attempt_ref=p_attempt AND artifact_id=p_artifact;
 RETURN read_captured_learner_audio_private_v1(upload_id);
END $$;
CREATE FUNCTION require_captured_karaoke_recording_result_private_v1(p_account TEXT,p_session TEXT,p_attempt TEXT,p_artifact TEXT,p_result JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE capture JSONB; status JSONB; fact learner_audio_upload_terminal_facts%ROWTYPE;
BEGIN
 capture:=read_account_karaoke_audio_capture_private_v1(p_account,p_session,p_attempt,p_artifact);
 status:=read_learner_audio_upload_status_private_v1(capture->>'uploadAttemptId');
 IF status->>'ioState'<>'closed' THEN RAISE EXCEPTION 'Karaoke archive I/O remains unknown'; END IF;
 IF p_result->>'state'='stored' THEN
  SELECT * INTO STRICT fact FROM learner_audio_upload_terminal_facts WHERE upload_attempt_id=capture->>'uploadAttemptId';
  IF (status->>'mayPublish')::BOOLEAN IS DISTINCT FROM TRUE
   OR ROW(p_result->>'objectRef',p_result->>'contentSha256',(p_result->>'byteSize')::BIGINT,(p_result->>'durationMs')::INTEGER)
    IS DISTINCT FROM ROW(capture->>'objectRef',fact.content_digest,fact.byte_size,fact.duration_ms) THEN
   RAISE EXCEPTION 'Karaoke result differs from captured storage fact'; END IF;
 ELSIF p_result->>'state'='failed' THEN
  IF status->>'storageDisposition' NOT IN('absent','failed') THEN RAISE EXCEPTION 'known failed storage disposition required'; END IF;
 ELSE RAISE EXCEPTION 'Karaoke result shape differs'; END IF;
END $$;
CREATE FUNCTION require_captured_audio_deletion_stop_private_v1(p_capture JSONB) RETURNS VOID
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT; upload learner_audio_upload_attempts%ROWTYPE;
BEGIN
 upload_id:=require_captured_learner_audio_private_v1(p_capture);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=upload_id;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[upload.owner_id]);
 IF NOT EXISTS(SELECT 1 FROM learner_audio_owner_fences f JOIN learner_audio_delete_sources s
  ON s.command_id=f.active_delete_command_id AND s.owner_id=f.owner_id
  WHERE f.owner_id=upload.owner_id AND f.revision>upload.captured_revision) THEN RAISE EXCEPTION 'actual captured deletion fence required'; END IF;
END $$;
CREATE FUNCTION karaoke_audio_target_can_tombstone_private_v1(p_account TEXT,p_artifact TEXT,p_attempt TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM participation_owners o JOIN learner_audio_owner_fences f USING(owner_id)
  JOIN learner_audio_delete_target_artifacts t ON t.command_id=f.active_delete_command_id AND t.owner_id=o.owner_id
  WHERE o.kind='account' AND o.account_id=p_account AND t.artifact_id=p_artifact AND t.source_kind='karaoke' AND t.attempt_ref=p_attempt
   AND EXISTS(SELECT 1 FROM learner_audio_upload_attempts u WHERE u.owner_id=o.owner_id AND u.artifact_id=p_artifact)
   AND NOT EXISTS(SELECT 1 FROM learner_audio_upload_attempts u WHERE u.owner_id=o.owner_id AND u.artifact_id=p_artifact AND (u.io_state<>'closed' OR u.cleanup_required))
   AND NOT EXISTS(SELECT 1 FROM learner_audio_object_names n WHERE n.owner_id=o.owner_id AND n.artifact_id=p_artifact
    AND NOT EXISTS(SELECT 1 FROM learner_audio_deleted_objects d WHERE d.object_ref=n.object_ref)))
$$;
-- Preserve every original identity and terminal metadata. The ONLY extra
-- transition is exact pending/failed→deleted after durable source-owned closure.
CREATE OR REPLACE FUNCTION guard_karaoke_recording() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Karaoke recording rows cannot be deleted'; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.session_id,NEW.attempt_id,NEW.account_id,NEW.artifact_id,NEW.created_at) IS DISTINCT FROM
   ROW(OLD.session_id,OLD.attempt_id,OLD.account_id,OLD.artifact_id,OLD.created_at) THEN RAISE EXCEPTION 'Karaoke recording identity is immutable'; END IF;
  IF OLD.state='deleted' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'deleted Karaoke recording is immutable'; END IF;
  IF NEW.state='deleted' AND OLD.state IN('pending','failed','stored') THEN
   IF NEW.object_ref IS NOT NULL OR (to_jsonb(NEW)-ARRAY['state','object_ref','reconciled_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','object_ref','reconciled_at'])
    OR NOT karaoke_audio_target_can_tombstone_private_v1(OLD.account_id,OLD.artifact_id,OLD.attempt_id) THEN RAISE EXCEPTION 'Karaoke deletion requires exact source closure'; END IF;
  ELSIF NOT(OLD.state='pending' AND NEW.state IN('stored','failed')) AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Invalid Karaoke recording transition'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $pin_captured_karaoke_packet$
DECLARE signature TEXT; namespace_id OID; owner_id OID; schema_name TEXT; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 FOREACH signature IN ARRAY ARRAY['read_account_karaoke_audio_capture_private_v1(text,text,text,text)',
 'require_captured_karaoke_recording_result_private_v1(text,text,text,text,jsonb)','require_captured_audio_deletion_stop_private_v1(jsonb)',
 'karaoke_audio_target_can_tombstone_private_v1(text,text,text)','guard_karaoke_recording()'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure AND f.pronamespace=namespace_id AND f.proowner=owner_id) THEN RAISE EXCEPTION 'Karaoke function provenance differs'; END IF;
 EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 END LOOP;
END $pin_captured_karaoke_packet$;

-- Genuine current253 confirmation body with one source-owned tombstone addition.
CREATE OR REPLACE FUNCTION confirm_learner_audio_delete_private_v1(
 expected_batch TEXT,expected_revision BIGINT,external_fact TEXT,at_time TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE batch learner_audio_delete_batches%ROWTYPE; source_ids TEXT[]; command learner_audio_delete_commands%ROWTYPE;
BEGIN
 IF external_fact IS NULL OR external_fact NOT IN('deleted','absent') OR at_time IS NULL THEN
   RAISE EXCEPTION 'known exact batch storage outcome required'; END IF;
 SELECT * INTO STRICT batch FROM learner_audio_delete_batches WHERE batch_id=expected_batch;
 SELECT array_agg(owner_id ORDER BY convert_to(owner_id,'UTF8')) INTO source_ids
   FROM learner_audio_delete_sources WHERE command_id=batch.command_id;
 PERFORM lock_learner_audio_sources_private_v1(source_ids);
 SELECT * INTO STRICT batch FROM learner_audio_delete_batches WHERE batch_id=expected_batch FOR UPDATE;
 SELECT * INTO STRICT command FROM learner_audio_delete_commands WHERE command_id=batch.command_id FOR UPDATE;
 IF batch.revision<>expected_revision THEN RAISE EXCEPTION 'stale batch fence'; END IF;
 IF command.state='completed' THEN RETURN TRUE; END IF;
 IF EXISTS(SELECT 1 FROM learner_audio_owner_fences WHERE owner_id=ANY(source_ids)
   AND (revision<>batch.revision OR active_delete_command_id IS DISTINCT FROM batch.command_id)) THEN
   RAISE EXCEPTION 'source-group fence mismatch'; END IF;
 IF batch.state<>'confirmed' THEN
   UPDATE learner_audio_delete_batches SET state='confirmed',deleted_at=at_time WHERE batch_id=expected_batch;
   INSERT INTO learner_audio_deleted_objects(object_ref,batch_id,deleted_at)
     SELECT object_ref,expected_batch,at_time FROM learner_audio_delete_batch_items WHERE batch_id=expected_batch
     ON CONFLICT(object_ref) DO NOTHING;
   UPDATE learner_audio_upload_attempts u SET cleanup_required=FALSE
     WHERE u.io_state='closed' AND u.owner_id=ANY(source_ids)
       AND EXISTS(SELECT 1 FROM learner_audio_delete_batch_items i WHERE i.batch_id=expected_batch AND i.object_ref=u.object_ref);
 END IF;
 -- A cached old confirmation cannot restore absence evidence invalidated by
 -- a later PUT. Re-delete through a NEW immutable batch of the same command.
 -- Tombstone only after ALL known refs for an artifact are absent and no old
 -- writer can still publish it. No attempt/progress/provider/financial deletion.
 UPDATE learner_audio_artifacts a SET recording_state='deleted',object_ref=NULL,deleted_at=at_time
   WHERE a.participation_owner_id=ANY(source_ids) AND a.recording_state<>'deleted'
     AND EXISTS(SELECT 1 FROM learner_audio_delete_batch_items i JOIN learner_audio_delete_batches b USING(batch_id) WHERE b.command_id=command.command_id AND b.state='confirmed' AND i.artifact_id=a.learner_audio_artifact_id AND i.owner_id=a.participation_owner_id)
     AND NOT EXISTS(SELECT 1 FROM learner_audio_object_names n WHERE n.artifact_id=a.learner_audio_artifact_id
       AND NOT EXISTS(SELECT 1 FROM learner_audio_deleted_objects d WHERE d.object_ref=n.object_ref))
     AND NOT EXISTS(SELECT 1 FROM learner_audio_upload_attempts u WHERE u.artifact_id=a.learner_audio_artifact_id
       AND u.owner_id=a.participation_owner_id AND (u.io_state<>'closed' OR u.cleanup_required));
 -- Current guard permits stored->deleted. Pending/failed->deleted needs the
 -- separate narrow reviewed recording guard below/protocol, never DISABLE.
 UPDATE karaoke_recordings r SET state='deleted',object_ref=NULL,reconciled_at=at_time
   FROM learner_audio_artifacts a WHERE a.learner_audio_artifact_id=r.artifact_id
     AND a.participation_owner_id=ANY(source_ids) AND a.recording_state='deleted' AND r.state='stored';
 -- Source-owned exact closure also covers retained pending/failed recordings
 -- without a common artifact. Unknown legacy writers keep this predicate FALSE.
 UPDATE karaoke_recordings r SET state='deleted',object_ref=NULL,reconciled_at=at_time
  WHERE r.state IN('pending','failed') AND EXISTS(SELECT 1 FROM participation_owners o WHERE o.kind='account' AND o.account_id=r.account_id AND o.owner_id=ANY(source_ids))
   AND karaoke_audio_target_can_tombstone_private_v1(r.account_id,r.artifact_id,r.attempt_id);
 IF EXISTS(SELECT 1 FROM learner_audio_upload_attempts WHERE owner_id=ANY(source_ids)
     AND captured_revision<command.revision AND (io_state<>'closed' OR cleanup_required))
   OR EXISTS(SELECT 1 FROM learner_audio_object_names n WHERE n.owner_id=ANY(source_ids)
     AND NOT EXISTS(SELECT 1 FROM learner_audio_deleted_objects d WHERE d.object_ref=n.object_ref))
   OR EXISTS(SELECT 1 FROM learner_audio_artifacts WHERE participation_owner_id=ANY(source_ids) AND recording_state<>'deleted')
   -- No artifact JOIN: pending/failed recordings and delayed outbox callbacks
   -- remain retained targets. Until the separately accepted exact recording
   -- guard/producer-disposition packet can tombstone them, completion REFUSES.
   OR EXISTS(SELECT 1 FROM karaoke_recordings r JOIN participation_owners o ON o.kind='account' AND o.account_id=r.account_id
     WHERE o.owner_id=ANY(source_ids) AND r.state<>'deleted') THEN
   RETURN FALSE; END IF;
 UPDATE learner_audio_delete_commands SET state='completed',completed_at=at_time,
   final_result=jsonb_build_object('operation',jsonb_build_object('operation_kind','learner_audio_deletion',
      'idempotency_key',command.idempotency_key,'operation_id',command.command_id),
     'state','completed','deleted_count',(SELECT count(*) FROM learner_audio_delete_target_artifacts WHERE command_id=command.command_id),
     'remaining_count',0,'provider_disposition',provider_disposition)
   WHERE command_id=command.command_id;
 UPDATE learner_audio_owner_fences SET active_delete_command_id=NULL
   WHERE owner_id=ANY(source_ids) AND active_delete_command_id=command.command_id;
 RETURN TRUE;
END $$;



-- Atomic AFTER producer-binding.sql in the SAME owned migration transaction.
-- Genuine current255 copied SHA256 fb7e3519edf7df95ef8071aaeced8d22509c146edce2f2d0b85d146b06051a2b.
-- Adds exactly five source/control tables + five explicit FK targets; keeps
-- actual sequence dependency closure and financial denylist unchanged.
DO $require_prior_spoken_phase$
BEGIN
 IF (SELECT count(*) FROM guest_learning_schema_phase WHERE singleton AND phase='practice_only_owner_spoken_checkpoint_history_v4')<>1
 THEN RAISE EXCEPTION 'positive prior audio phase required'; END IF;
END $require_prior_spoken_phase$;
ALTER TABLE guest_learning_schema_phase DROP CONSTRAINT guest_learning_schema_phase_phase_check;
UPDATE guest_learning_schema_phase SET phase='practice_only_owner_audio_producer_history_v5' WHERE singleton AND phase='practice_only_owner_spoken_checkpoint_history_v4';
ALTER TABLE guest_learning_schema_phase ADD CONSTRAINT guest_learning_schema_phase_phase_check CHECK(phase='practice_only_owner_audio_producer_history_v5');
CREATE OR REPLACE FUNCTION require_guest_practice_only_schema_phase_v1()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE trusted_namespace OID; trusted_owner OID;
BEGIN
  SELECT relnamespace,relowner INTO STRICT trusted_namespace,trusted_owner
    FROM pg_class WHERE oid='participation_owners'::regclass;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='guest_learning_schema_phase'::regclass
      AND relnamespace=trusted_namespace AND relowner=trusted_owner)
    OR (SELECT count(*) FROM guest_learning_schema_phase
      WHERE singleton AND phase='practice_only_owner_audio_producer_history_v5')<>1
    OR EXISTS(SELECT 1 FROM unnest(ARRAY[
      'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks','guest_learning_preferences','guest_participation_operations','guest_secret_issuance_operations','guest_attachment_intents','study_sessions_v2','study_review_items','study_session_items_v2','study_spoken_answer_commands','learner_audio_artifacts','guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts','learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls'
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
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls'))
    OR EXISTS(SELECT 1 FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE fk.contype='f' AND fk.confrelid=ANY(ARRAY[
          'participation_owners'::regclass,'guest_credentials'::regclass,
          'guest_empty_owner_aliases'::regclass,'participation_owner_clocks'::regclass,
          'guest_learning_preferences'::regclass,'guest_participation_operations'::regclass,
          'guest_secret_issuance_operations'::regclass,'guest_attachment_intents'::regclass,
          'guest_resource_session_reservations'::regclass,'guest_resource_provider_calls'::regclass,
          'guest_resource_release_receipts'::regclass,
          'learner_audio_owner_fences'::regclass,'learner_audio_delete_commands'::regclass,'learner_audio_delete_sources'::regclass,'learner_audio_delete_target_artifacts'::regclass,'learner_audio_object_names'::regclass,'learner_audio_upload_attempts'::regclass,'learner_audio_delete_batches'::regclass,'learner_audio_delete_batch_items'::regclass,'learner_audio_deleted_objects'::regclass,'guest_study_spoken_captures'::regclass,'guest_study_spoken_checkpoints'::regclass,'learner_audio_account_producer_captures'::regclass,'learner_audio_upload_terminal_facts'::regclass,'learner_audio_upload_cleanup_commands'::regclass,'learner_audio_account_spoken_checkpoints'::regclass,'learner_audio_account_provider_calls'::regclass])
        AND c.relnamespace=trusted_namespace AND c.relname NOT IN (
          'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks',
          'guest_learning_preferences','guest_participation_operations',
          'guest_secret_issuance_operations','guest_attachment_intents',
          'study_sessions_v2','study_review_items','study_session_items_v2',
          'study_spoken_answer_commands','learner_audio_artifacts',
          'guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts',
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls'))
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
    AND NOT learner_audio_producer_component_has_history_private_v1(member_ids)
    AND NOT EXISTS(SELECT 1 FROM guest_participation_operations WHERE source_owner_id=ANY(member_ids)
      AND operation_kind IN ('study_start','study_answer','learning_retention','learner_audio_deletion')
      AND state<>'known_aborted')
    AND NOT EXISTS(SELECT 1 FROM guest_attachment_intents WHERE owner_id=ANY(member_ids)
      AND state IN ('awaiting_account','awaiting_confirmation') AND expires_at>clock_timestamp());
END $$;


DO $pin_audio_producer_phase$
DECLARE signature TEXT; schema_name TEXT; namespace_id OID; owner_id OID; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT namespace_id,owner_id,schema_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 FOREACH signature IN ARRAY ARRAY['require_guest_practice_only_schema_phase_v1()','guest_authority_component_is_empty_v1(text)'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure AND f.pronamespace=namespace_id AND f.proowner=owner_id) THEN RAISE EXCEPTION 'phase function owner/namespace differs'; END IF;
 EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 END LOOP;
END $pin_audio_producer_phase$;
SELECT require_guest_practice_only_schema_phase_v1();


CREATE OR REPLACE FUNCTION list_guest_practice_participations_v1(
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
 IF NOT FOUND OR phase_name IS DISTINCT FROM 'practice_only_owner_audio_producer_history_v5' THEN
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


-- CREATE OR REPLACE clears an omitted per-function SET clause. Re-establish
-- the genuine private frame for both replaced raw primitives before COMMIT.
DO $pin_replaced_audio_native_primitives$
DECLARE signature TEXT; trusted_namespace OID; trusted_owner OID;
 trusted_schema TEXT; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname
  INTO STRICT trusted_namespace,trusted_owner,trusted_schema
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.oid='participation_owners'::regclass;
 IF trusted_schema IS NULL OR trusted_schema='information_schema' OR trusted_schema LIKE 'pg_%'
  THEN RAISE EXCEPTION 'private audio primitive schema differs'; END IF;
 FOREACH signature IN ARRAY ARRAY[
  'register_learner_audio_upload_private_v1(text,text,text,text,text,text,text,text,bigint)',
  'confirm_learner_audio_delete_private_v1(text,bigint,text,timestamp with time zone)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure
   AND f.pronamespace=trusted_namespace AND f.proowner=trusted_owner AND f.prosecdef)
   THEN RAISE EXCEPTION 'private audio primitive provenance differs'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
   FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $pin_replaced_audio_native_primitives$;
