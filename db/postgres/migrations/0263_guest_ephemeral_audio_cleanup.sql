-- Outside proposal. No ordinal/grant/activation. Root-owned atomic successor.
SELECT pg_advisory_xact_lock(83000003,1);
ALTER TABLE guest_study_spoken_captures ADD COLUMN captured_platform_retention TEXT;
ALTER TABLE guest_study_spoken_captures ADD COLUMN captured_retention_expires_at TIMESTAMPTZ;
ALTER TABLE guest_study_spoken_captures ADD CONSTRAINT guest_capture_retention_shape CHECK ((
 (captured_platform_retention IS NULL AND captured_retention_expires_at IS NULL)
 OR (captured_platform_retention IN('private_learning','ephemeral')
  AND captured_retention_expires_at IS NOT NULL
  AND captured_retention_expires_at>created_at
  AND (captured_platform_retention<>'ephemeral'
   OR captured_retention_expires_at<=created_at+INTERVAL '24 hours'))) IS TRUE);
-- Historical captures remain NULL: no claimed old preference/backfill.
-- Existing capture UPDATE/DELETE immutable trigger also covers these columns.
CREATE FUNCTION capture_guest_audio_retention_private_v1() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE artifact learner_audio_artifacts%ROWTYPE; command study_spoken_answer_commands%ROWTYPE;
BEGIN
 SELECT * INTO STRICT artifact FROM learner_audio_artifacts
  WHERE learner_audio_artifact_id=NEW.artifact_id AND participation_owner_id=NEW.source_owner_id
   AND participation_owner_kind='guest' AND account_id IS NULL;
 SELECT * INTO STRICT command FROM study_spoken_answer_commands
  WHERE command_id=NEW.command_id AND participation_owner_id=NEW.source_owner_id
   AND participation_owner_kind='guest' AND account_id IS NULL;
 IF command.learner_audio_artifact_id IS DISTINCT FROM NEW.artifact_id
  OR command.lease_token IS DISTINCT FROM NEW.original_lease_token
  OR command.state IS DISTINCT FROM 'reserved'
  OR artifact.platform_retention NOT IN('private_learning','ephemeral')
  OR artifact.expires_at IS DISTINCT FROM command.reserved_at+
    CASE WHEN artifact.platform_retention='ephemeral' THEN INTERVAL '24 hours' ELSE INTERVAL '24 months' END
  OR (NEW.captured_platform_retention IS NOT NULL AND NEW.captured_platform_retention IS DISTINCT FROM artifact.platform_retention)
  OR (NEW.captured_retention_expires_at IS NOT NULL AND NEW.captured_retention_expires_at IS DISTINCT FROM artifact.expires_at) THEN
  RAISE EXCEPTION 'actual future Guest retention capture required'; END IF;
 NEW.captured_platform_retention:=artifact.platform_retention;
 NEW.captured_retention_expires_at:=artifact.expires_at;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_audio_retention_capture BEFORE INSERT ON guest_study_spoken_captures
 FOR EACH ROW EXECUTE FUNCTION capture_guest_audio_retention_private_v1();

CREATE FUNCTION guest_ephemeral_object_closed_private_v1(p_ref TEXT) RETURNS BOOLEAN
 LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM learner_audio_upload_cleanup_commands cleanup
  JOIN guest_study_spoken_captures cap ON cap.upload_attempt_id=cleanup.upload_attempt_id
   AND cap.source_owner_id=cleanup.owner_id
  WHERE cleanup.object_ref=p_ref AND cleanup.state='completed'
   AND cap.captured_platform_retention='ephemeral')
$$;

-- Read-only eligibility seam shared by selection and locked recheck.
-- It does not grant provider/storage authority or declare any absence.
CREATE FUNCTION guest_ephemeral_upload_ready_private_v1(p_upload TEXT) RETURNS BOOLEAN
 LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM guest_study_spoken_captures cap
  JOIN guest_study_spoken_checkpoints cp USING(capture_id)
  JOIN guest_resource_provider_calls call_row ON call_row.call_id=cap.provider_call_id
  JOIN guest_participation_operations operation ON operation.operation_id=cap.operation_id
  JOIN study_spoken_answer_commands command ON command.command_id=cap.command_id
  JOIN learner_audio_upload_attempts upload ON upload.upload_attempt_id=cap.upload_attempt_id
  JOIN learner_audio_artifacts artifact ON artifact.learner_audio_artifact_id=cap.artifact_id
  JOIN participation_owners owner ON owner.owner_id=cap.source_owner_id
  WHERE cap.upload_attempt_id=p_upload AND cap.captured_platform_retention='ephemeral'
   -- Begin eligible cleanup five minutes BEFORE the immutable maximum lifetime.
   AND cap.captured_retention_expires_at<=clock_timestamp()+INTERVAL '5 minutes'
   AND owner.kind='guest' AND owner.state='established' AND owner.account_id IS NULL
   AND operation.source_owner_id=cap.source_owner_id AND operation.operation_kind='study_answer'
   AND operation.state='completed' AND operation.result_snapshot IS NOT NULL
   AND command.participation_owner_id=cap.source_owner_id AND command.account_id IS NULL
   AND command.state='completed' AND command.result_snapshot IS NOT NULL
   AND command.learner_audio_artifact_id=cap.artifact_id
   AND call_row.source_owner_id=cap.source_owner_id AND call_row.disposition='completed'
   AND call_row.checkpoint_id=cp.checkpoint_id AND cp.source_owner_id=cap.source_owner_id
   AND upload.owner_id=cap.source_owner_id AND upload.artifact_id=cap.artifact_id
   AND upload.command_ref=cap.command_id AND upload.reservation_ref=cap.resource_reservation_id
   AND upload.captured_revision=cap.deletion_fence_revision
   AND cap.attempt_id ~ '^[A-Za-z0-9_-]{1,128}$'
   AND upload.object_ref='learner-audio/study/'||cap.attempt_id||'/'||cap.audio_digest
   AND upload.io_state='closed' AND upload.storage_disposition='stored'
   AND artifact.participation_owner_id=cap.source_owner_id AND artifact.account_id IS NULL
   AND artifact.platform_retention='ephemeral'
   AND artifact.expires_at=cap.captured_retention_expires_at
   AND artifact.recording_state='stored' AND artifact.object_ref=upload.object_ref
   AND artifact.content_digest=cap.audio_digest
   AND NOT guest_ephemeral_object_closed_private_v1(upload.object_ref)
   AND NOT EXISTS(SELECT 1 FROM learner_audio_upload_attempts other
    WHERE other.object_ref=upload.object_ref AND other.upload_attempt_id<>upload.upload_attempt_id
     AND (other.created_at>=upload.created_at OR other.io_state<>'closed' OR other.cleanup_required)))
$$;

-- Positive native owner-delete evidence for this EXACT original object only.
-- It is never inferred from a tombstone, deadline, pending command or null GET.
CREATE FUNCTION guest_ephemeral_owner_delete_witness_private_v1(p_upload TEXT) RETURNS BOOLEAN
 LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM guest_study_spoken_captures cap
  JOIN learner_audio_upload_attempts upload ON upload.upload_attempt_id=cap.upload_attempt_id
  JOIN learner_audio_deleted_objects deleted ON deleted.object_ref=upload.object_ref
  JOIN learner_audio_delete_batches batch ON batch.batch_id=deleted.batch_id
  JOIN learner_audio_delete_commands command ON command.command_id=batch.command_id
  JOIN learner_audio_delete_sources source ON source.command_id=command.command_id
   AND source.owner_id=cap.source_owner_id
  JOIN learner_audio_delete_batch_items item ON item.batch_id=batch.batch_id
   AND item.object_ref=upload.object_ref AND item.owner_id=cap.source_owner_id AND item.artifact_id=cap.artifact_id
  JOIN learner_audio_object_names namespace ON namespace.object_ref=upload.object_ref
   AND namespace.owner_id=cap.source_owner_id AND namespace.artifact_id=cap.artifact_id
  WHERE cap.upload_attempt_id=p_upload AND cap.captured_platform_retention='ephemeral'
   AND upload.owner_id=cap.source_owner_id AND upload.artifact_id=cap.artifact_id
   AND upload.object_ref='learner-audio/study/'||cap.attempt_id||'/'||cap.audio_digest
   AND batch.state='confirmed' AND batch.deleted_at IS NOT NULL
   AND deleted.deleted_at=batch.deleted_at AND command.revision=batch.revision)
$$;

-- Recovery of an ALREADY admitted exact cleanup. Completed original CP,
-- provider and writer proofs remain mandatory. A positive owner-delete witness
-- can replace current stored/ref state; no absence inference or new authority.
CREATE FUNCTION guest_ephemeral_pending_cleanup_ready_private_v1(p_cleanup TEXT) RETURNS BOOLEAN
 LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM guest_study_spoken_captures cap
  JOIN learner_audio_upload_cleanup_commands cleanup ON cleanup.upload_attempt_id=cap.upload_attempt_id
   AND cleanup.owner_id=cap.source_owner_id
  JOIN guest_study_spoken_checkpoints cp USING(capture_id)
  JOIN guest_resource_provider_calls call_row ON call_row.call_id=cap.provider_call_id
  JOIN guest_participation_operations operation ON operation.operation_id=cap.operation_id
  JOIN study_spoken_answer_commands command ON command.command_id=cap.command_id
  JOIN learner_audio_upload_attempts upload ON upload.upload_attempt_id=cap.upload_attempt_id
  JOIN learner_audio_artifacts artifact ON artifact.learner_audio_artifact_id=cap.artifact_id
  JOIN participation_owners owner ON owner.owner_id=cap.source_owner_id
  WHERE cleanup.cleanup_id=p_cleanup AND cleanup.state='pending'
   AND cleanup.object_ref=upload.object_ref AND cap.captured_platform_retention='ephemeral'
   -- Original admitted deadline evidence, not a fresh clock/preference lookup.
   AND cleanup.created_at>=cap.captured_retention_expires_at-INTERVAL '5 minutes'
   AND (upload.cleanup_required OR guest_ephemeral_owner_delete_witness_private_v1(upload.upload_attempt_id))
   AND owner.kind='guest' AND owner.state='established' AND owner.account_id IS NULL
   AND operation.source_owner_id=cap.source_owner_id AND operation.operation_kind='study_answer'
   AND operation.state='completed' AND operation.result_snapshot IS NOT NULL
   AND command.participation_owner_id=cap.source_owner_id AND command.account_id IS NULL
   AND command.state='completed' AND command.result_snapshot IS NOT NULL
   AND command.learner_audio_artifact_id=cap.artifact_id
   AND call_row.source_owner_id=cap.source_owner_id AND call_row.disposition='completed'
   AND call_row.checkpoint_id=cp.checkpoint_id AND cp.source_owner_id=cap.source_owner_id
   AND upload.owner_id=cap.source_owner_id AND upload.artifact_id=cap.artifact_id
   AND upload.command_ref=cap.command_id AND upload.reservation_ref=cap.resource_reservation_id
   AND upload.captured_revision=cap.deletion_fence_revision
   AND cap.attempt_id ~ '^[A-Za-z0-9_-]{1,128}$'
   AND upload.object_ref='learner-audio/study/'||cap.attempt_id||'/'||cap.audio_digest
   AND upload.io_state='closed' AND upload.storage_disposition='stored'
   AND artifact.participation_owner_id=cap.source_owner_id AND artifact.account_id IS NULL
   AND artifact.platform_retention='ephemeral'
   AND artifact.expires_at=cap.captured_retention_expires_at
   AND ((artifact.recording_state='stored' AND artifact.object_ref=upload.object_ref)
    OR (artifact.recording_state='deleted' AND artifact.object_ref IS NULL AND artifact.deleted_at IS NOT NULL
     AND guest_ephemeral_owner_delete_witness_private_v1(upload.upload_attempt_id)))
   AND artifact.content_digest=cap.audio_digest
   AND NOT guest_ephemeral_object_closed_private_v1(upload.object_ref)
   AND NOT EXISTS(SELECT 1 FROM learner_audio_upload_attempts other
    WHERE other.object_ref=upload.object_ref AND other.upload_attempt_id<>upload.upload_attempt_id
     AND (other.created_at>=upload.created_at OR other.io_state<>'closed' OR other.cleanup_required)))
$$;

-- Exact native262 cleanup mechanics; the immutable capture validator is Guest-owned.
-- Private helper only: no direct runtime or cron EXECUTE authority.
CREATE FUNCTION prepare_guest_captured_audio_cleanup_private_v1(p_capture JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT; upload learner_audio_upload_attempts%ROWTYPE; command learner_audio_upload_cleanup_commands%ROWTYPE;
BEGIN
 upload_id:=require_guest_audio_io_capture_private_v1(p_capture);
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

CREATE FUNCTION prepare_next_guest_ephemeral_audio_cleanup_private_v1() RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE chosen TEXT; original_owner TEXT; prepared JSONB;
 original_cleanup learner_audio_upload_cleanup_commands%ROWTYPE;
 original_capture guest_study_spoken_captures%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 PERFORM require_guest_practice_only_schema_phase_v1();
 SELECT cap.upload_attempt_id,cap.source_owner_id INTO chosen,original_owner
  FROM guest_study_spoken_captures cap
  LEFT JOIN learner_audio_upload_cleanup_commands cleanup ON cleanup.upload_attempt_id=cap.upload_attempt_id
  WHERE (cleanup.cleanup_id IS NULL AND guest_ephemeral_upload_ready_private_v1(cap.upload_attempt_id))
   OR (cleanup.state='pending' AND guest_ephemeral_pending_cleanup_ready_private_v1(cleanup.cleanup_id))
  ORDER BY (cleanup.state='pending') DESC NULLS LAST,
   cap.captured_retention_expires_at,cap.upload_attempt_id COLLATE "C" LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','idle'); END IF;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[original_owner]);
 SELECT * INTO STRICT original_capture FROM guest_study_spoken_captures WHERE upload_attempt_id=chosen;
 SELECT * INTO original_cleanup FROM learner_audio_upload_cleanup_commands WHERE upload_attempt_id=chosen;
 IF FOUND THEN
  -- Recovery uses original durable authority, not NEW admission or preferences.
  IF original_cleanup.state<>'pending'
    OR NOT guest_ephemeral_pending_cleanup_ready_private_v1(original_cleanup.cleanup_id) THEN
   RETURN jsonb_build_object('state','idle'); END IF;
  prepared:=jsonb_build_object('cleanupId',original_cleanup.cleanup_id,
   'uploadAttemptId',original_cleanup.upload_attempt_id,'objectRef',original_cleanup.object_ref);
 ELSE
  IF NOT guest_ephemeral_upload_ready_private_v1(chosen) THEN
   RETURN jsonb_build_object('state','idle'); END IF;
 -- Close this exact terminal upload's publication while external DELETE waits.
 -- This does not change the owner's durable deletion fence or provider facts.
  UPDATE learner_audio_upload_attempts SET cleanup_required=TRUE WHERE upload_attempt_id=chosen;
  prepared:=prepare_guest_captured_audio_cleanup_private_v1(read_guest_audio_io_capture_private_v1(chosen));
 END IF;
 -- Closed, original capture witnesses let the SDK reject foreign keys before I/O.
 RETURN jsonb_build_object('state','prepared','cleanup',prepared||jsonb_build_object(
  'attemptId',original_capture.attempt_id,'contentDigest',original_capture.audio_digest));
END $$;

CREATE FUNCTION confirm_guest_ephemeral_audio_cleanup_private_v1(
 p_cleanup TEXT,p_upload TEXT,p_ref TEXT,p_at TIMESTAMPTZ) RETURNS VOID
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE original_owner TEXT; original_artifact TEXT; cleanup learner_audio_upload_cleanup_commands%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 PERFORM require_guest_practice_only_schema_phase_v1();
 SELECT cap.source_owner_id,cap.artifact_id INTO STRICT original_owner,original_artifact
  FROM guest_study_spoken_captures cap
  JOIN learner_audio_upload_cleanup_commands c ON c.upload_attempt_id=cap.upload_attempt_id
   AND c.owner_id=cap.source_owner_id
  WHERE cap.upload_attempt_id=p_upload AND cap.captured_platform_retention='ephemeral'
   AND c.cleanup_id=p_cleanup AND c.object_ref=p_ref;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[original_owner]);
 SELECT * INTO STRICT cleanup FROM learner_audio_upload_cleanup_commands WHERE cleanup_id=p_cleanup;
 IF p_at IS NULL OR cleanup.upload_attempt_id IS DISTINCT FROM p_upload
  OR cleanup.owner_id IS DISTINCT FROM original_owner OR cleanup.object_ref IS DISTINCT FROM p_ref THEN
  RAISE EXCEPTION 'exact ephemeral cleanup identity required'; END IF;
 IF cleanup.state='completed' THEN RETURN; END IF;
 IF NOT guest_ephemeral_pending_cleanup_ready_private_v1(p_cleanup) THEN
  RAISE EXCEPTION 'original ephemeral continuation remains held'; END IF;
 PERFORM confirm_captured_audio_cleanup_private_v1(p_cleanup,p_upload,p_ref,p_at);
 -- The completed cleanup row permanently closes only this namespace. Keep the
 -- original stored terminal fact, CP, graded answer and financial facts intact.
 UPDATE learner_audio_artifacts SET recording_state='deleted',object_ref=NULL,deleted_at=p_at
  WHERE learner_audio_artifact_id=original_artifact AND participation_owner_id=original_owner
   AND participation_owner_kind='guest' AND account_id IS NULL
   AND recording_state='stored' AND object_ref=p_ref;
 IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM learner_audio_artifacts
   WHERE learner_audio_artifact_id=original_artifact AND participation_owner_id=original_owner
    AND participation_owner_kind='guest' AND account_id IS NULL
    AND recording_state='deleted' AND object_ref IS NULL AND deleted_at IS NOT NULL)
  THEN RAISE EXCEPTION 'original ephemeral artifact differs'; END IF;
 -- A prior positively witnessed owner tombstone retains its original deleted_at.
END $$;

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
 IF guest_ephemeral_object_closed_private_v1(expected_object_ref) THEN
  RAISE EXCEPTION 'ephemeral original object namespace is permanently closed'; END IF;
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

CREATE OR REPLACE FUNCTION claim_guest_audio_io_private_v1(p_capture JSONB) RETURNS JSONB
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
   AND NOT guest_ephemeral_object_closed_private_v1(upload.object_ref)
   AND fence.revision=upload.captured_revision AND fence.active_delete_command_id IS NULL);
END $$;
CREATE OR REPLACE FUNCTION settle_guest_audio_io_private_v1(p_capture JSONB,p_disposition TEXT,p_known BOOLEAN) RETURNS BOOLEAN
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload_id TEXT; allowed BOOLEAN;
BEGIN
 upload_id:=require_guest_audio_io_capture_private_v1(p_capture);
 allowed:=settle_learner_audio_upload_private_v1(upload_id,p_disposition,p_known,NULL);
 RETURN allowed AND NOT guest_ephemeral_object_closed_private_v1(p_capture->>'objectRef');
END $$;

DO $bind_guest_ephemeral_packet$
DECLARE signature TEXT; trusted_namespace OID; trusted_owner OID; trusted_schema TEXT; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT trusted_namespace,trusted_owner,trusted_schema
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF trusted_schema='information_schema' OR trusted_schema LIKE 'pg_%' THEN
  RAISE EXCEPTION 'trusted ephemeral namespace required'; END IF;
 FOREACH signature IN ARRAY ARRAY['capture_guest_audio_retention_private_v1()','guest_ephemeral_object_closed_private_v1(text)','guest_ephemeral_upload_ready_private_v1(text)','guest_ephemeral_owner_delete_witness_private_v1(text)','guest_ephemeral_pending_cleanup_ready_private_v1(text)','prepare_guest_captured_audio_cleanup_private_v1(jsonb)','prepare_next_guest_ephemeral_audio_cleanup_private_v1()','confirm_guest_ephemeral_audio_cleanup_private_v1(text,text,text,timestamptz)','register_learner_audio_upload_private_v1(text,text,text,text,text,text,text,text,bigint)','claim_guest_audio_io_private_v1(jsonb)','settle_guest_audio_io_private_v1(jsonb,text,boolean)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure
   AND f.pronamespace=trusted_namespace AND f.proowner=trusted_owner AND f.prosecdef) THEN
   RAISE EXCEPTION 'ephemeral routine custody differs'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
   FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $bind_guest_ephemeral_packet$;
