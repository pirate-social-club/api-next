-- Account audio deletion after the learning upgrade. 0253 and 0262 fenced
-- legacy producers but left no way to close them, so upgraded accounts could
-- not finish deleting audio. This additive successor preserves every applied
-- migration identity:
--  1. closes legacy Karaoke uploads whose own protocol proved completed I/O;
--  2. records unresolved legacy Study reservations as unknown producers;
--  3. adds the evidence-bound closure for the remaining legacy producers;
--  4. restores the ordinary account deletion responses.

-- 0253 imported every non-deleted legacy Karaoke recording as an unknown
-- upload, so an account holding a finished legacy recording could never
-- complete audio deletion. Close only the uploads whose genuine legacy
-- protocol already proved completed I/O, the exact object and no live writer:
--  * the legacy attempt object completed its single multipart upload, read the
--    object back and recorded state stored with that digest and size;
--  * the object is the canonical key the import registered for the recording;
--  * the common artifact written in the same transaction agrees on account,
--    key, digest, size and duration;
--  * the session itself completed, so no attempt host still accepts frames.
-- A stored label alone, lease or session expiry, or missing-object reads never
-- close an upload here. Pending, failed and every other legacy upload stay
-- unknown and fenced until a reviewed authoritative settlement closes them.
-- Object names, owners and import identities are unchanged.
UPDATE learner_audio_upload_attempts u
   SET io_state='closed',storage_disposition='stored',closed_at=r.reconciled_at
  FROM karaoke_recordings r
  JOIN participation_owners o ON o.kind='account' AND o.account_id=r.account_id
  JOIN karaoke_sessions s ON s.session_id=r.session_id AND s.attempt_id=r.attempt_id
   AND s.account_id=r.account_id
  JOIN learner_audio_artifacts a ON a.learner_audio_artifact_id=r.artifact_id
 WHERE u.upload_attempt_id='lau_legacy_'||encode(sha256(convert_to(
         jsonb_build_array(r.session_id,r.attempt_id,r.artifact_id)::TEXT,'UTF8')),'hex')
   AND u.owner_id=o.owner_id AND u.artifact_id=r.artifact_id
   AND u.source_kind='karaoke' AND u.attempt_ref=r.attempt_id
   AND u.command_ref=r.session_id AND u.reservation_ref=r.session_id
   AND u.captured_revision=0 AND u.io_state='unknown' AND u.multipart_upload_id IS NULL
   AND u.object_ref='karaoke/'||r.account_id||'/'||r.attempt_id||'.pcm'
   AND r.state='stored' AND r.object_ref=u.object_ref
   AND s.status='completed'
   AND a.account_id=r.account_id AND a.participation_owner_id=o.owner_id
   AND a.participation_owner_kind='account' AND a.source_kind='karaoke'
   AND a.attempt_ref=r.attempt_id AND a.recording_state='stored'
   AND a.object_ref=r.object_ref AND a.expected_object_ref=r.object_ref
   AND a.content_digest=r.content_sha256 AND a.byte_size=r.byte_size
   AND a.duration_ms=r.duration_ms;

-- A legacy Study answer wrote its audio with one PUT to the artifact's exact
-- expected key while it held the reservation lease. 0253 left reservations that
-- never resolved without a producer record, so nothing could ever settle them
-- and a reclaim could open a new generation while the legacy PUT might still
-- land. Record each one as an unknown producer of that exact key, identified by
-- its own reservation generation. Registration already refuses another write to
-- an unresolved key, and deletion waits for its closure.
INSERT INTO learner_audio_upload_attempts(upload_attempt_id,owner_id,artifact_id,object_ref,
  source_kind,attempt_ref,command_ref,reservation_ref,captured_revision,io_state,created_at)
SELECT 'lau_legacy_'||encode(sha256(convert_to(
         jsonb_build_array('study',c.command_id,c.lease_token,a.learner_audio_artifact_id)::TEXT,'UTF8')),'hex'),
       c.participation_owner_id,a.learner_audio_artifact_id,a.expected_object_ref,'study',c.attempt_id,
       c.command_id,jsonb_build_array('legacy_study_reservation_v1',c.command_id,c.lease_token)::TEXT,
       0,'unknown',c.reserved_at
  FROM study_spoken_answer_commands c
  JOIN learner_audio_artifacts a ON a.learner_audio_artifact_id=c.learner_audio_artifact_id
   AND a.participation_owner_id=c.participation_owner_id
 WHERE c.participation_owner_kind='account' AND c.state IN('reserved','retryable_failed')
   AND a.source_kind='study' AND a.attempt_ref=c.attempt_id AND a.recording_state<>'deleted'
   AND NOT EXISTS(SELECT 1 FROM learner_audio_upload_attempts u WHERE u.owner_id=c.participation_owner_id
     AND u.command_ref=c.command_id AND u.source_kind='study');

-- The authoritative closure for an imported legacy producer. No database fact
-- proves a retired Worker or attempt host stopped writing, so an operator
-- records the evidence: the exact key's HEAD and open multipart listing,
-- observed after every serving version predating producer capture was retired,
-- with the readback that shows it. The record is immutable and the upload
-- closes through the ordinary settlement, so a stored object is then deleted
-- by any active or later deletion.
-- Evidence is keyed by the immutable upload identity alone. It carries no
-- owner column or reference into owner history, so the reviewed practice-only
-- owner-history closure is unchanged; the settlement function proves the
-- upload exists and holds its owner's source lock.
CREATE TABLE learner_audio_legacy_settlements (
  upload_attempt_id TEXT PRIMARY KEY CHECK(upload_attempt_id ~ '^lau_legacy_[0-9a-f]{64}$'),
  disposition TEXT NOT NULL CHECK(disposition IN('stored','absent')),
  evidence JSONB NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  settled_at TIMESTAMPTZ NOT NULL
);
REVOKE ALL ON learner_audio_legacy_settlements FROM PUBLIC;

CREATE FUNCTION guard_learner_audio_legacy_settlement_private_v1() RETURNS TRIGGER
 LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'legacy producer settlement evidence is immutable';
END $$;
CREATE TRIGGER learner_audio_legacy_settlements_immutable BEFORE UPDATE OR DELETE
  ON learner_audio_legacy_settlements
  FOR EACH ROW EXECUTE FUNCTION guard_learner_audio_legacy_settlement_private_v1();

CREATE FUNCTION settle_legacy_learner_audio_upload_private_v1(p_upload TEXT,p_disposition TEXT,p_evidence JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload learner_audio_upload_attempts%ROWTYPE; prior learner_audio_legacy_settlements%ROWTYPE;
 digest TEXT; observed_at TIMESTAMPTZ; cutover_at TIMESTAMPTZ;
BEGIN
 IF p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object'
  OR NOT p_evidence ?& ARRAY['objectRef','headStatus','openMultipartUploads','servingCutoverAt','observedAt','readbackRef']
  OR p_evidence-ARRAY['objectRef','headStatus','openMultipartUploads','servingCutoverAt','observedAt','readbackRef']<>'{}'::JSONB
  OR jsonb_typeof(p_evidence->'objectRef')<>'string' OR jsonb_typeof(p_evidence->'readbackRef')<>'string'
  OR char_length(p_evidence->>'readbackRef') NOT BETWEEN 1 AND 256
  OR p_evidence->'headStatus' NOT IN('"present"'::JSONB,'"absent"'::JSONB)
  OR p_evidence->'openMultipartUploads' IS DISTINCT FROM '0'::JSONB
  OR jsonb_typeof(p_evidence->'servingCutoverAt')<>'string' OR jsonb_typeof(p_evidence->'observedAt')<>'string' THEN
  RAISE EXCEPTION 'legacy producer settlement evidence required'; END IF;
 observed_at:=(p_evidence->>'observedAt')::TIMESTAMPTZ;
 cutover_at:=(p_evidence->>'servingCutoverAt')::TIMESTAMPTZ;
 IF observed_at<=cutover_at OR observed_at>clock_timestamp() THEN
  RAISE EXCEPTION 'legacy producer must be observed after serving cutover'; END IF;
 IF p_disposition IS DISTINCT FROM (CASE p_evidence->>'headStatus' WHEN 'present' THEN 'stored' ELSE 'absent' END) THEN
  RAISE EXCEPTION 'legacy settlement disposition differs from the observed object'; END IF;
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[upload.owner_id]);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload FOR UPDATE;
 digest:=encode(sha256(convert_to(p_evidence::TEXT,'UTF8')),'hex');
 SELECT * INTO prior FROM learner_audio_legacy_settlements WHERE upload_attempt_id=p_upload;
 IF FOUND THEN
  IF prior.disposition<>p_disposition OR prior.evidence_sha256<>digest THEN
   RAISE EXCEPTION 'legacy settlement already recorded differently'; END IF;
  RETURN FALSE; END IF;
 IF upload.upload_attempt_id NOT LIKE 'lau\_legacy\_%' OR upload.captured_revision<>0
  OR upload.io_state<>'unknown' OR upload.object_ref IS DISTINCT FROM p_evidence->>'objectRef' THEN
  RAISE EXCEPTION 'only an unknown imported legacy producer of this key can be settled'; END IF;
 INSERT INTO learner_audio_legacy_settlements(upload_attempt_id,disposition,evidence,evidence_sha256,settled_at)
  VALUES(p_upload,p_disposition,p_evidence,digest,clock_timestamp());
 RETURN settle_learner_audio_upload_private_v1(p_upload,p_disposition,TRUE,NULL);
END $$;

-- Two narrow preparation corrections; the fence and every other error are
-- unchanged. An unresolved legacy producer is the account contract's in-flight
-- state, not a store failure, so that refusal gains the unresolved-producer
-- state confirmation already raises. A repeated deletion no longer re-marks a
-- closed writer whose object an earlier batch already deleted, which left the
-- new command waiting forever on cleanup no batch could perform.
CREATE OR REPLACE FUNCTION prepare_learner_audio_delete_private_v1(
 expected_source TEXT,expected_key TEXT,expected_hash TEXT,new_command TEXT,
 authorized_sources TEXT[],new_batch TEXT,maximum_artifacts INTEGER,provider_fact TEXT
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command learner_audio_delete_commands%ROWTYPE; source_id TEXT; next_revision BIGINT; active_batch TEXT;
BEGIN
 IF maximum_artifacts IS NULL OR maximum_artifacts NOT BETWEEN 1 AND 1000 THEN
   RAISE EXCEPTION 'audio batch bound1..1000 required'; END IF;
 IF expected_source IS NULL OR authorized_sources IS NULL OR NOT expected_source=ANY(authorized_sources) THEN RAISE EXCEPTION 'operation source outside authorized group'; END IF;
 PERFORM lock_learner_audio_sources_private_v1(authorized_sources);
 authorized_sources:=learner_audio_source_component_private_v1(authorized_sources);
 SELECT * INTO command FROM learner_audio_delete_commands
   WHERE source_owner_id=expected_source AND idempotency_key=expected_key FOR UPDATE;
 IF FOUND THEN
   IF command.request_hash<>expected_hash OR EXISTS(
     (SELECT owner_id FROM learner_audio_delete_sources WHERE command_id=command.command_id)
     EXCEPT (SELECT unnest(authorized_sources))) OR EXISTS(
     (SELECT unnest(authorized_sources)) EXCEPT
     (SELECT owner_id FROM learner_audio_delete_sources WHERE command_id=command.command_id)) THEN
     RAISE EXCEPTION 'idempotency-conflict'; END IF;
   IF command.state='completed' THEN RETURN NULL; END IF;
 ELSE
   IF NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=expected_source
     AND state IN('empty','established')) THEN RAISE EXCEPTION 'active deletion source required'; END IF;
   INSERT INTO learner_audio_owner_fences(owner_id) SELECT unnest(authorized_sources) ON CONFLICT DO NOTHING;
   IF EXISTS(SELECT 1 FROM learner_audio_owner_fences WHERE owner_id=ANY(authorized_sources)
     AND active_delete_command_id IS NOT NULL) THEN RAISE EXCEPTION 'deletion-in-progress'; END IF;
   IF EXISTS(SELECT 1 FROM study_spoken_answer_commands c
     WHERE c.participation_owner_id=ANY(authorized_sources) AND c.state IN('reserved','retryable_failed')
       AND NOT EXISTS(SELECT 1 FROM learner_audio_upload_attempts u
         WHERE u.owner_id=c.participation_owner_id AND u.command_ref=c.command_id AND u.source_kind='study'))
     OR EXISTS(SELECT 1 FROM karaoke_recordings r JOIN participation_owners o ON o.kind='account' AND o.account_id=r.account_id
       WHERE o.owner_id=ANY(authorized_sources) AND r.state IN('pending','failed')
         AND NOT EXISTS(SELECT 1 FROM learner_audio_upload_attempts u WHERE u.owner_id=o.owner_id
           AND u.attempt_ref=r.attempt_id AND u.source_kind='karaoke')) THEN
     RAISE EXCEPTION 'untracked legacy producer requires durable disposition' USING ERRCODE='GA001'; END IF;
   next_revision:=nextval('learner_audio_fence_revision_v1');
   INSERT INTO learner_audio_delete_commands(command_id,source_owner_id,idempotency_key,request_hash,
     revision,state,provider_disposition,created_at)
     VALUES(new_command,expected_source,expected_key,expected_hash,next_revision,'pending',provider_fact,clock_timestamp())
     RETURNING * INTO command;
   INSERT INTO learner_audio_delete_sources SELECT command.command_id,unnest(authorized_sources);
   INSERT INTO learner_audio_delete_target_artifacts(command_id,artifact_id,owner_id,original_state,source_kind,attempt_ref)
     SELECT command.command_id,learner_audio_artifact_id,participation_owner_id,recording_state,source_kind,attempt_ref
       FROM learner_audio_artifacts WHERE participation_owner_id=ANY(authorized_sources) AND recording_state<>'deleted';
   INSERT INTO learner_audio_delete_target_artifacts(command_id,artifact_id,owner_id,original_state,source_kind,attempt_ref)
     SELECT DISTINCT command.command_id,artifact_id,owner_id,'unpublished',source_kind,attempt_ref FROM learner_audio_upload_attempts
       WHERE owner_id=ANY(authorized_sources) AND (io_state<>'closed' OR cleanup_required)
     ON CONFLICT(command_id,artifact_id) DO NOTHING;
   -- Recording targets are retained even without a common audio artifact.
   INSERT INTO learner_audio_delete_target_artifacts(command_id,artifact_id,owner_id,original_state,source_kind,attempt_ref)
     SELECT command.command_id,r.artifact_id,o.owner_id,r.state,'karaoke',r.attempt_id
       FROM karaoke_recordings r JOIN participation_owners o ON o.kind='account' AND o.account_id=r.account_id
       WHERE o.owner_id=ANY(authorized_sources) AND r.state<>'deleted'
     ON CONFLICT(command_id,artifact_id) DO NOTHING;
   UPDATE participation_owners SET state='established' WHERE owner_id=expected_source AND state='empty';
   UPDATE learner_audio_owner_fences SET revision=next_revision,active_delete_command_id=command.command_id
     WHERE owner_id=ANY(authorized_sources);
   -- A closed writer whose exact object is already recorded deleted has
   -- nothing left to clean; a later stored write removes that record first.
   UPDATE learner_audio_upload_attempts u SET cleanup_required=TRUE WHERE u.owner_id=ANY(authorized_sources)
     AND u.captured_revision<next_revision
     AND NOT (u.io_state='closed' AND EXISTS(SELECT 1 FROM learner_audio_deleted_objects d
       WHERE d.object_ref=u.object_ref));
   -- Claim is serialized by the same owner lock and is mandatory before I/O.
   -- Still-registered intents therefore have a positive no-I/O witness and may
   -- close atomically. Writing/unknown intents NEVER close through this path.
   UPDATE learner_audio_upload_attempts SET io_state='closed',storage_disposition='absent',
     closed_at=clock_timestamp() WHERE owner_id=ANY(authorized_sources)
       AND captured_revision<next_revision AND io_state='registered';
 END IF;
 SELECT batch_id INTO active_batch FROM learner_audio_delete_batches
   WHERE command_id=command.command_id AND state<>'confirmed' ORDER BY created_at,batch_id LIMIT 1;
 IF active_batch IS NOT NULL THEN RETURN active_batch; END IF;
 INSERT INTO learner_audio_delete_batches(batch_id,command_id,revision,state,created_at)
   VALUES(new_batch,command.command_id,command.revision,'prepared',clock_timestamp());
 INSERT INTO learner_audio_delete_batch_items(batch_id,ordinal,owner_id,artifact_id,object_ref)
   SELECT new_batch,row_number() OVER(ORDER BY convert_to(n.object_ref,'UTF8'))::INTEGER,
     n.owner_id,n.artifact_id,n.object_ref FROM learner_audio_object_names n
   WHERE n.owner_id=ANY(authorized_sources)
     AND NOT EXISTS(SELECT 1 FROM learner_audio_deleted_objects d WHERE d.object_ref=n.object_ref)
   ORDER BY convert_to(n.object_ref,'UTF8') LIMIT maximum_artifacts;
 -- Empty batches are still durable. If old IO remains unknown, return pending
 -- rather than taking repeated head()==NULL as a terminal producer witness.
 RETURN new_batch;
END $$;

-- The ordinary account response counts the artifacts deleted by this request,
-- as before the shared fence; a request that deletes nothing while producers
-- remain unresolved is in flight even after earlier batches made progress.
CREATE OR REPLACE FUNCTION confirm_account_audio_delete_private_v1(p_batch TEXT,p_revision BIGINT,p_deleted_at TIMESTAMPTZ) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE complete BOOLEAN; resolved_command_id TEXT; deleted_count BIGINT; remaining_count BIGINT; latest TIMESTAMPTZ;
 previously_deleted BIGINT;
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
 -- The account contract reports what THIS request deleted, as before.
 SELECT count(*) FILTER(WHERE a.recording_state='deleted' OR (a.learner_audio_artifact_id IS NULL AND r.state='deleted'))
 INTO previously_deleted FROM learner_audio_delete_target_artifacts target
 LEFT JOIN learner_audio_artifacts a ON a.learner_audio_artifact_id=target.artifact_id AND a.participation_owner_id=target.owner_id
 LEFT JOIN karaoke_recordings r ON target.source_kind='karaoke' AND r.artifact_id=target.artifact_id
 WHERE target.command_id=original_command;
 complete:=confirm_learner_audio_delete_private_v1(p_batch,p_revision,'deleted',p_deleted_at);
 SELECT b.command_id INTO STRICT resolved_command_id FROM learner_audio_delete_batches b WHERE batch_id=p_batch;
 SELECT count(*) FILTER(WHERE a.recording_state='deleted' OR (a.learner_audio_artifact_id IS NULL AND r.state='deleted')),
  count(*) FILTER(WHERE COALESCE(a.recording_state,r.state,'unpublished')<>'deleted')
 INTO deleted_count,remaining_count FROM learner_audio_delete_target_artifacts target
 LEFT JOIN learner_audio_artifacts a ON a.learner_audio_artifact_id=target.artifact_id AND a.participation_owner_id=target.owner_id
 LEFT JOIN karaoke_recordings r ON target.source_kind='karaoke' AND r.artifact_id=target.artifact_id
 WHERE target.command_id=resolved_command_id;
 deleted_count:=deleted_count-previously_deleted;
 IF NOT complete AND deleted_count=0 THEN RAISE EXCEPTION 'audio producers remain unresolved' USING ERRCODE='GA001'; END IF;
 SELECT max(a.deleted_at) INTO latest FROM learner_audio_artifacts a JOIN learner_audio_delete_sources s ON s.owner_id=a.participation_owner_id
  WHERE s.command_id=resolved_command_id;
 RETURN jsonb_build_object('object','learner_audio_deletion','deleted_count',deleted_count,'remaining_count',remaining_count,
  'last_deleted_at',CASE WHEN latest IS NULL THEN NULL ELSE to_char(latest AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
END $$;

DO $repin_audio_delete_preparation$
DECLARE signature TEXT; trusted_namespace OID; trusted_owner OID; trusted_schema TEXT; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT trusted_namespace,trusted_owner,trusted_schema
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF trusted_schema='information_schema' OR trusted_schema LIKE 'pg_%' THEN
  RAISE EXCEPTION 'trusted audio deletion namespace required'; END IF;
 FOREACH signature IN ARRAY ARRAY[
  'prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)',
  'confirm_account_audio_delete_private_v1(text,bigint,timestamptz)',
  'settle_legacy_learner_audio_upload_private_v1(text,text,jsonb)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure
   AND f.pronamespace=trusted_namespace AND f.proowner=trusted_owner AND f.prosecdef) THEN
   RAISE EXCEPTION 'audio deletion routine custody differs'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
   FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
 EXECUTE format('ALTER FUNCTION guard_learner_audio_legacy_settlement_private_v1() SET search_path TO pg_catalog,%I,pg_temp',trusted_schema);
 EXECUTE 'REVOKE ALL ON FUNCTION guard_learner_audio_legacy_settlement_private_v1() FROM PUBLIC';
END $repin_audio_delete_preparation$;
