-- Account audio deletion after the learning upgrade. 0253 and 0262 fenced
-- legacy producers as unknown, but closing one took an owner call that binds no
-- storage evidence, so upgraded accounts could not finish deleting audio on a
-- reviewed basis. This additive successor preserves every applied migration
-- identity:
--  1. closes legacy Karaoke uploads whose own protocol proved completed I/O;
--  2. records unresolved legacy Study reservations as unknown producers;
--  3. adds the evidence-bound closure for the remaining legacy producers;
--  4. answers an untracked legacy producer as in flight.

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
-- Each imported producer's source needs its audio fence, as 0253 established
-- for legacy Karaoke owners. An existing revision or active deletion is kept.
INSERT INTO learner_audio_owner_fences(owner_id)
 SELECT DISTINCT owner_id FROM learner_audio_upload_attempts
  WHERE upload_attempt_id LIKE 'lau\_legacy\_%' AND source_kind='study'
 ON CONFLICT DO NOTHING;

-- The authoritative closure for an imported legacy producer. No database fact
-- proves that a retired version or attempt host stopped writing, so the
-- operator ceremony in docs/runbooks/legacy-learner-audio-settlement.md
-- supplies storage-level evidence bound to sanitized receipts and to the exact
-- serving artifacts, and only where that evidence is terminal for the producer:
--  * Karaoke attempt hosts wrote through one multipart upload. After capture-era
--    versions alone serve, every open upload for the key is aborted and an
--    exhausted listing shows none; no completion can then create the object,
--    so the observed HEAD (present or absent) is final.
--  * A Study answer wrote with one PUT. Only an object present with the exact
--    digest named by its key proves that PUT completed; an absent object never
--    proves an issued PUT will not still land, so it stays unknown.
-- Everything else keeps the producer unknown and deletion in flight.

-- Admit the evidence relation to the practice-only owner history explicitly.
DO $require_prior_audio_producer_phase$
BEGIN
 IF (SELECT count(*) FROM guest_learning_schema_phase WHERE singleton
   AND phase='practice_only_owner_audio_producer_history_v5')<>1
 THEN RAISE EXCEPTION 'positive prior audio producer phase required'; END IF;
END $require_prior_audio_producer_phase$;
ALTER TABLE guest_learning_schema_phase DROP CONSTRAINT guest_learning_schema_phase_phase_check;
UPDATE guest_learning_schema_phase SET phase='practice_only_owner_legacy_audio_settlement_history_v6'
 WHERE singleton AND phase='practice_only_owner_audio_producer_history_v5';
ALTER TABLE guest_learning_schema_phase ADD CONSTRAINT guest_learning_schema_phase_phase_check
 CHECK(phase='practice_only_owner_legacy_audio_settlement_history_v6');

CREATE TABLE learner_audio_legacy_settlements (
  upload_attempt_id TEXT PRIMARY KEY CHECK(upload_attempt_id ~ '^lau_legacy_[0-9a-f]{64}$'),
  owner_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN('stored','absent')),
  evidence JSONB NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  settled_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY(upload_attempt_id,owner_id)
    REFERENCES learner_audio_upload_attempts(upload_attempt_id,owner_id)
);

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
DECLARE upload learner_audio_upload_attempts%ROWTYPE; artifact learner_audio_artifacts%ROWTYPE;
 prior learner_audio_legacy_settlements%ROWTYPE; owner_kind TEXT; digest TEXT;
 observed_at TIMESTAMPTZ; cutover_at TIMESTAMPTZ; keys TEXT[]; receipt_keys TEXT[]; version JSONB;
BEGIN
 IF p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object' THEN
  RAISE EXCEPTION 'legacy producer settlement evidence required'; END IF;
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[upload.owner_id]);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=p_upload FOR UPDATE;
 digest:=encode(sha256(convert_to(p_evidence::TEXT,'UTF8')),'hex');
 SELECT * INTO prior FROM learner_audio_legacy_settlements WHERE upload_attempt_id=p_upload;
 IF FOUND THEN
  IF prior.disposition<>p_disposition OR prior.evidence_sha256<>digest THEN
   RAISE EXCEPTION 'legacy settlement already recorded differently'; END IF;
  RETURN FALSE; END IF;
 SELECT kind INTO STRICT owner_kind FROM participation_owners WHERE owner_id=upload.owner_id;
 IF upload.upload_attempt_id NOT LIKE 'lau\_legacy\_%' OR upload.captured_revision<>0
  OR upload.io_state<>'unknown' OR owner_kind<>'account'
  OR upload.object_ref IS DISTINCT FROM p_evidence->>'objectRef' THEN
  RAISE EXCEPTION 'only an unknown imported legacy producer of this key can be settled'; END IF;
 keys:=ARRAY['objectRef','headStatus','openMultipartUploads','servingCutoverAt','observedAt',
  'servingVersions','receipts'];
 receipt_keys:=ARRAY['servingReadback','head','listing'];
 IF upload.source_kind='karaoke' THEN
  keys:=array_append(keys,'abortedMultipartUploadIds');
  receipt_keys:=array_append(receipt_keys,'abort');
 ELSE keys:=array_append(keys,'contentSha256'); END IF;
 IF NOT p_evidence ?& keys OR p_evidence-keys<>'{}'::JSONB
  OR jsonb_typeof(p_evidence->'receipts')<>'object'
  OR NOT (p_evidence->'receipts') ?& receipt_keys OR (p_evidence->'receipts')-receipt_keys<>'{}'::JSONB
  OR EXISTS(SELECT 1 FROM jsonb_each(p_evidence->'receipts') r
    WHERE jsonb_typeof(r.value)<>'string' OR r.value#>>'{}' !~ '^[0-9a-f]{64}$')
  OR jsonb_typeof(p_evidence->'servingVersions')<>'array'
  OR jsonb_array_length(p_evidence->'servingVersions') NOT BETWEEN 1 AND 16
  OR p_evidence->'headStatus' NOT IN('"present"'::JSONB,'"absent"'::JSONB)
  OR p_evidence->'openMultipartUploads' IS DISTINCT FROM '0'::JSONB
  OR jsonb_typeof(p_evidence->'servingCutoverAt')<>'string' OR jsonb_typeof(p_evidence->'observedAt')<>'string' THEN
  RAISE EXCEPTION 'legacy producer settlement evidence required'; END IF;
 FOR version IN SELECT value FROM jsonb_array_elements(p_evidence->'servingVersions') LOOP
  IF jsonb_typeof(version)<>'object' OR NOT version ?& ARRAY['script','versionId','sourceCommit','artifactSha256']
   OR version-ARRAY['script','versionId','sourceCommit','artifactSha256']<>'{}'::JSONB
   OR jsonb_typeof(version->'script')<>'string' OR char_length(version->>'script') NOT BETWEEN 1 AND 128
   OR jsonb_typeof(version->'versionId')<>'string' OR char_length(version->>'versionId') NOT BETWEEN 1 AND 128
   OR jsonb_typeof(version->'sourceCommit')<>'string' OR version->>'sourceCommit' !~ '^[0-9a-f]{40}$'
   OR jsonb_typeof(version->'artifactSha256')<>'string' OR version->>'artifactSha256' !~ '^[0-9a-f]{64}$' THEN
   RAISE EXCEPTION 'legacy producer settlement evidence required'; END IF;
 END LOOP;
 observed_at:=(p_evidence->>'observedAt')::TIMESTAMPTZ;
 cutover_at:=(p_evidence->>'servingCutoverAt')::TIMESTAMPTZ;
 IF observed_at<=cutover_at OR observed_at>clock_timestamp() THEN
  RAISE EXCEPTION 'legacy producer must be observed after serving cutover'; END IF;
 IF p_disposition IS DISTINCT FROM (CASE p_evidence->>'headStatus' WHEN 'present' THEN 'stored' ELSE 'absent' END) THEN
  RAISE EXCEPTION 'legacy settlement disposition differs from the observed object'; END IF;
 IF upload.source_kind='karaoke' THEN
  IF jsonb_typeof(p_evidence->'abortedMultipartUploadIds')<>'array'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'abortedMultipartUploadIds') a
     WHERE jsonb_typeof(a.value)<>'string' OR char_length(a.value#>>'{}') NOT BETWEEN 1 AND 2048) THEN
   RAISE EXCEPTION 'legacy producer settlement evidence required'; END IF;
 ELSE
  SELECT * INTO STRICT artifact FROM learner_audio_artifacts
   WHERE learner_audio_artifact_id=upload.artifact_id AND participation_owner_id=upload.owner_id;
  IF p_disposition<>'stored' THEN
   RAISE EXCEPTION 'an absent legacy Study object does not prove its write ended'; END IF;
  IF jsonb_typeof(p_evidence->'contentSha256')<>'string'
   OR p_evidence->>'contentSha256' IS DISTINCT FROM artifact.content_digest
   OR upload.object_ref IS DISTINCT FROM 'learner-audio/study/'||upload.attempt_ref||'/'||artifact.content_digest THEN
   RAISE EXCEPTION 'legacy Study object differs from its reserved content'; END IF;
 END IF;
 INSERT INTO learner_audio_legacy_settlements(upload_attempt_id,owner_id,disposition,evidence,evidence_sha256,settled_at)
  VALUES(p_upload,upload.owner_id,p_disposition,p_evidence,digest,clock_timestamp());
 RETURN settle_learner_audio_upload_private_v1(p_upload,p_disposition,TRUE,NULL);
END $$;

CREATE OR REPLACE FUNCTION require_guest_practice_only_schema_phase_v1()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE trusted_namespace OID; trusted_owner OID;
BEGIN
  SELECT relnamespace,relowner INTO STRICT trusted_namespace,trusted_owner
    FROM pg_class WHERE oid='participation_owners'::regclass;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='guest_learning_schema_phase'::regclass
      AND relnamespace=trusted_namespace AND relowner=trusted_owner)
    OR (SELECT count(*) FROM guest_learning_schema_phase
      WHERE singleton AND phase='practice_only_owner_legacy_audio_settlement_history_v6')<>1
    OR EXISTS(SELECT 1 FROM unnest(ARRAY[
      'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks','guest_learning_preferences','guest_participation_operations','guest_secret_issuance_operations','guest_attachment_intents','study_sessions_v2','study_review_items','study_session_items_v2','study_spoken_answer_commands','learner_audio_artifacts','guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts','learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls','learner_audio_legacy_settlements'
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
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls','learner_audio_legacy_settlements'))
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
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls','learner_audio_legacy_settlements'))
    -- Legacy producer settlements are account history only; a guest owner can
    -- never hold one, so admitting the relation adds no guest liability.
    OR EXISTS(SELECT 1 FROM learner_audio_legacy_settlements s JOIN participation_owners o USING(owner_id)
      WHERE o.kind<>'account')
    OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=trusted_namespace
      AND relname IN ('guest_owner_associations','participation_eligibility_decisions',
        'megapot_owner_shares','megapot_owner_snapshot_leaves','megapot_owner_allocations',
        'reward_credit_persona_bindings','reward_credit_recipient_selections'))
  THEN RAISE EXCEPTION 'owner history closure unavailable' USING ERRCODE='GP003'; END IF;
END $$;

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
 IF NOT FOUND OR phase_name IS DISTINCT FROM 'practice_only_owner_legacy_audio_settlement_history_v6' THEN
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


-- One narrow preparation correction; the fence and every other error are
-- unchanged. An unresolved legacy producer is the account contract's in-flight
-- state, not a store failure, so that refusal gains the unresolved-producer
-- state confirmation already raises.
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
   UPDATE learner_audio_upload_attempts SET cleanup_required=TRUE WHERE owner_id=ANY(authorized_sources)
     AND captured_revision<next_revision
     AND (io_state<>'closed' OR NOT EXISTS(
       SELECT 1 FROM learner_audio_deleted_objects deleted
        WHERE deleted.object_ref=learner_audio_upload_attempts.object_ref));
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

DO $repin_audio_delete_preparation$
DECLARE signature TEXT; trusted_namespace OID; trusted_owner OID; trusted_schema TEXT; grantee_name TEXT;
BEGIN
 SELECT c.relnamespace,c.relowner,n.nspname INTO STRICT trusted_namespace,trusted_owner,trusted_schema
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF trusted_schema='information_schema' OR trusted_schema LIKE 'pg_%' THEN
  RAISE EXCEPTION 'trusted audio deletion namespace required'; END IF;
 -- Private routines: owner-only, whatever default privileges granted at creation.
 FOREACH signature IN ARRAY ARRAY[
  'prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)',
  'settle_legacy_learner_audio_upload_private_v1(text,text,jsonb)',
  'guard_learner_audio_legacy_settlement_private_v1()'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure
   AND f.pronamespace=trusted_namespace AND f.proowner=trusted_owner) THEN
   RAISE EXCEPTION 'audio deletion routine custody differs'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
   FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
 -- Replaced phase routines keep their reviewed grants; only their path is re-pinned.
 FOREACH signature IN ARRAY ARRAY['require_guest_practice_only_schema_phase_v1()',
  'list_guest_practice_participations_v1(jsonb,text,integer)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=signature::regprocedure
   AND f.pronamespace=trusted_namespace AND f.proowner=trusted_owner AND f.prosecdef) THEN
   RAISE EXCEPTION 'phase routine custody differs'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
 END LOOP;
 -- The evidence relation is owner-only: no PUBLIC, inherited or default grant.
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='learner_audio_legacy_settlements'::regclass
  AND c.relnamespace=trusted_namespace AND c.relowner=trusted_owner AND c.relkind='r') THEN
  RAISE EXCEPTION 'legacy settlement relation custody differs'; END IF;
 REVOKE ALL ON learner_audio_legacy_settlements FROM PUBLIC;
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
  FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.oid='learner_audio_legacy_settlements'::regclass AND a.grantee<>0 AND a.grantee<>c.relowner LOOP
  EXECUTE format('REVOKE ALL ON learner_audio_legacy_settlements FROM %I',grantee_name);
 END LOOP;
END $repin_audio_delete_preparation$;
