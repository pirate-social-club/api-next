-- PRIVATE SUCCESSOR V2 CANDIDATE; NOT PARSED OR EXECUTED.
-- Original505-line FILE stays unchanged; this successor changes its content and adds atomic closure.
-- No ordinal reserved. Root owns adoption, privilege binding and PG17 evidence.
-- Requires accepted owner/composite foundation. All routines below are private;
-- authenticated wrappers MUST derive the entire source group from trusted
-- recovery/account authority under topology locks. Never grant these primitives
-- directly to browser-facing roles or accept body owner arrays as authorization.
-- One outer migration transaction. No R2/provider I/O exists in this file.

SELECT pg_advisory_xact_lock(83000003,1);

CREATE SEQUENCE learner_audio_fence_revision_v1 MAXVALUE 9007199254740991;
CREATE TABLE learner_audio_owner_fences (
  owner_id TEXT PRIMARY KEY REFERENCES participation_owners(owner_id),
  revision BIGINT NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
  active_delete_command_id TEXT
);
CREATE TABLE learner_audio_delete_commands (
  command_id TEXT PRIMARY KEY CHECK(char_length(command_id) BETWEEN 1 AND 128),
  source_owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
  operation_kind TEXT GENERATED ALWAYS AS ('learner_audio_deletion'::TEXT) STORED,
  idempotency_key TEXT NOT NULL CHECK(char_length(idempotency_key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  revision BIGINT NOT NULL UNIQUE CHECK(revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN('pending','completed')),
  provider_disposition TEXT NOT NULL CHECK(provider_disposition IN
    ('not_stored','deletion_confirmed','pending','unknown','unavailable')),
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  final_result JSONB,
  UNIQUE(source_owner_id,idempotency_key),
  UNIQUE(command_id,revision),
  CHECK((state='pending' AND completed_at IS NULL AND final_result IS NULL)
    OR (state='completed' AND completed_at IS NOT NULL AND final_result IS NOT NULL)),
  CHECK(final_result IS NULL OR (jsonb_typeof(final_result)='object'
    AND octet_length(final_result::TEXT)<=131072))
);
ALTER TABLE learner_audio_owner_fences ADD CONSTRAINT learner_audio_active_delete_fk
  FOREIGN KEY(active_delete_command_id) REFERENCES learner_audio_delete_commands(command_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE learner_audio_delete_sources (
  command_id TEXT NOT NULL REFERENCES learner_audio_delete_commands(command_id),
  owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
  PRIMARY KEY(command_id,owner_id)
);
CREATE TABLE learner_audio_delete_target_artifacts (
  command_id TEXT NOT NULL REFERENCES learner_audio_delete_commands(command_id),
  artifact_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
  original_state TEXT NOT NULL CHECK(original_state IN('pending','stored','failed','unpublished')),
  source_kind TEXT NOT NULL CHECK(source_kind IN('study','karaoke')),
  attempt_ref TEXT NOT NULL,
  PRIMARY KEY(command_id,artifact_id)
);

-- One immutable object namespace belongs to one original owner/artifact. Keys
-- cannot be reused by a different artifact, including after a deletion fence.
-- Existing stored keys are imported only by explicit migration/source lineage
-- validation. No assumption that a stored row proves all old workers are dead.
CREATE TABLE learner_audio_object_names (
  object_ref TEXT PRIMARY KEY CHECK(octet_length(object_ref) BETWEEN 1 AND 2048),
  owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
  artifact_id TEXT NOT NULL CHECK(char_length(artifact_id) BETWEEN 1 AND 256),
  source_kind TEXT NOT NULL CHECK(source_kind IN('study','karaoke')),
  attempt_ref TEXT NOT NULL,
  UNIQUE(object_ref,owner_id,artifact_id)
);
CREATE TABLE learner_audio_upload_attempts (
  upload_attempt_id TEXT PRIMARY KEY CHECK(char_length(upload_attempt_id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
  artifact_id TEXT NOT NULL,
  object_ref TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN('study','karaoke')),
  attempt_ref TEXT NOT NULL,
  command_ref TEXT NOT NULL,
  reservation_ref TEXT NOT NULL,
  captured_revision BIGINT NOT NULL CHECK(captured_revision BETWEEN 0 AND 9007199254740991),
  io_state TEXT NOT NULL CHECK(io_state IN('registered','writing','unknown','closed')),
  storage_disposition TEXT CHECK(storage_disposition IN('stored','absent','failed')),
  multipart_upload_id TEXT,
  cleanup_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  FOREIGN KEY(object_ref,owner_id,artifact_id)
    REFERENCES learner_audio_object_names(object_ref,owner_id,artifact_id),
  CHECK((io_state='closed' AND closed_at IS NOT NULL AND storage_disposition IS NOT NULL)
    OR (io_state<>'closed' AND closed_at IS NULL AND storage_disposition IS NULL)),
  UNIQUE(upload_attempt_id,owner_id)
);
CREATE INDEX learner_audio_open_uploads_v1
  ON learner_audio_upload_attempts(owner_id,captured_revision,upload_attempt_id)
  WHERE io_state<>'closed' OR cleanup_required;

CREATE TABLE learner_audio_delete_batches (
  batch_id TEXT PRIMARY KEY CHECK(char_length(batch_id) BETWEEN 1 AND 128),
  command_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('prepared','failed','unknown','confirmed')),
  created_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  FOREIGN KEY(command_id,revision) REFERENCES learner_audio_delete_commands(command_id,revision),
  CHECK((state='confirmed')=(deleted_at IS NOT NULL))
);
CREATE TABLE learner_audio_delete_batch_items (
  batch_id TEXT NOT NULL REFERENCES learner_audio_delete_batches(batch_id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 1000),
  owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
  artifact_id TEXT NOT NULL,
  object_ref TEXT NOT NULL,
  PRIMARY KEY(batch_id,ordinal), UNIQUE(batch_id,object_ref),
  FOREIGN KEY(object_ref,owner_id,artifact_id)
    REFERENCES learner_audio_object_names(object_ref,owner_id,artifact_id)
);
CREATE TABLE learner_audio_deleted_objects (
  object_ref TEXT PRIMARY KEY REFERENCES learner_audio_object_names(object_ref),
  batch_id TEXT NOT NULL REFERENCES learner_audio_delete_batches(batch_id),
  deleted_at TIMESTAMPTZ NOT NULL
);

-- Import genuine common-artifact names AND original Karaoke recording names.
-- The recording owns artifact_id even before common artifact publication. Never
-- use an inner JOIN to common artifacts that drops pending/failed recordings.
CREATE TEMP TABLE learner_audio_legacy_names_v2 ON COMMIT DROP AS
 SELECT expected_object_ref AS object_ref,participation_owner_id AS owner_id,
   learner_audio_artifact_id AS artifact_id,source_kind,attempt_ref
 FROM learner_audio_artifacts
 UNION SELECT object_ref,participation_owner_id,learner_audio_artifact_id,source_kind,attempt_ref
   FROM learner_audio_artifacts WHERE object_ref IS NOT NULL
 UNION SELECT 'karaoke/'||r.account_id||'/'||r.attempt_id||'.pcm',o.owner_id,r.artifact_id,'karaoke',r.attempt_id
   FROM karaoke_recordings r JOIN participation_owners o ON o.kind='account' AND o.account_id=r.account_id
 UNION SELECT r.object_ref,o.owner_id,r.artifact_id,'karaoke',r.attempt_id
   FROM karaoke_recordings r JOIN participation_owners o ON o.kind='account' AND o.account_id=r.account_id
   WHERE r.object_ref IS NOT NULL;
DO $validate_legacy_audio_names$
BEGIN
 IF EXISTS(SELECT 1 FROM karaoke_recordings r LEFT JOIN participation_owners o
   ON o.kind='account' AND o.account_id=r.account_id WHERE o.owner_id IS NULL) THEN
   RAISE EXCEPTION 'historical recording account source missing'; END IF;
 IF EXISTS(SELECT object_ref FROM learner_audio_legacy_names_v2 GROUP BY object_ref
   HAVING count(DISTINCT ROW(owner_id,artifact_id,source_kind,attempt_ref))>1) THEN
   RAISE EXCEPTION 'historical audio object ownership needs separate disposition'; END IF;
 IF EXISTS(SELECT 1 FROM karaoke_recordings r JOIN learner_audio_artifacts a
   ON a.learner_audio_artifact_id=r.artifact_id
   WHERE a.account_id IS DISTINCT FROM r.account_id OR a.source_kind<>'karaoke'
     OR a.attempt_ref IS DISTINCT FROM r.attempt_id) THEN
   RAISE EXCEPTION 'historical recording artifact source differs'; END IF;
END;
$validate_legacy_audio_names$;
INSERT INTO learner_audio_object_names(object_ref,owner_id,artifact_id,source_kind,attempt_ref)
 SELECT object_ref,owner_id,artifact_id,source_kind,attempt_ref FROM learner_audio_legacy_names_v2;
-- Unknown is deliberately durable even when recording state failed or session
-- lease expired. These IDs are synthetic ledger locators, never provider tokens
-- or authority grants. No legacy worker is imported as registered/no-I/O.
INSERT INTO learner_audio_owner_fences(owner_id)
 SELECT DISTINCT o.owner_id FROM karaoke_recordings r JOIN participation_owners o
 ON o.kind='account' AND o.account_id=r.account_id WHERE r.state<>'deleted';
INSERT INTO learner_audio_upload_attempts(upload_attempt_id,owner_id,artifact_id,object_ref,
 source_kind,attempt_ref,command_ref,reservation_ref,captured_revision,io_state,created_at)
 SELECT 'lau_legacy_'||encode(sha256(convert_to(jsonb_build_array(r.session_id,r.attempt_id,r.artifact_id)::TEXT,'UTF8')),'hex'),
   o.owner_id,r.artifact_id,'karaoke/'||r.account_id||'/'||r.attempt_id||'.pcm','karaoke',r.attempt_id,
   r.session_id,r.session_id,0,'unknown',r.created_at
 FROM karaoke_recordings r JOIN participation_owners o ON o.kind='account' AND o.account_id=r.account_id
 WHERE r.state<>'deleted';
-- Legacy Study reservations also require positively captured unknown/drain
-- disposition. The preparation preflight still refuses their absent inventory;
-- this foundation does not invent an invocation identity from artifact absence.

-- Successful provider checkpoints remain owned by the shared grading/resource
-- packet; this audio module does not duplicate or erase that store. Its protocol
-- persists accepted results before archive/finalization, with captured immutable
-- source/command/reservation authority, independently of current browser proof.

CREATE FUNCTION learner_audio_source_component_private_v1(seed_owners TEXT[]) RETURNS TEXT[]
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE component_ids TEXT[];
BEGIN
 IF seed_owners IS NULL OR cardinality(seed_owners)=0
   OR array_position(seed_owners,NULL) IS NOT NULL
   OR cardinality(seed_owners)<>(SELECT count(DISTINCT x) FROM unnest(seed_owners)x)
   OR cardinality(seed_owners)<>(SELECT count(*) FROM participation_owners WHERE owner_id=ANY(seed_owners)) THEN
   RAISE EXCEPTION 'invalid complete source group'; END IF;
 WITH RECURSIVE roots(owner_id) AS (
   SELECT DISTINCT CASE WHEN o.kind='guest' THEN resolve_guest_empty_owner_root_v1(o.owner_id)
     ELSE o.owner_id END FROM participation_owners o WHERE o.owner_id=ANY(seed_owners)
 ), component(owner_id) AS (
   SELECT owner_id FROM roots UNION SELECT a.source_owner_id FROM guest_empty_owner_aliases a
     JOIN component c ON a.canonical_owner_id=c.owner_id
 ) SELECT array_agg(owner_id ORDER BY convert_to(owner_id,'UTF8')) INTO component_ids FROM component;
 RETURN component_ids;
END $$;

CREATE FUNCTION lock_learner_audio_sources_private_v1(expected_owners TEXT[]) RETURNS VOID
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id TEXT; component_ids TEXT[];
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 -- Caller may first lock separate account-authority rows in raw UTF8 order.
 -- Never pre-lock an incomplete owner singleton: this helper expands the whole
 -- owner component before taking any owner row; an already locked component
 -- must have been complete and acquired in the same raw UTF8 order.
 component_ids:=learner_audio_source_component_private_v1(expected_owners);
 FOR source_id IN SELECT owner_id FROM participation_owners WHERE owner_id=ANY(component_ids)
   ORDER BY convert_to(owner_id,'UTF8') FOR UPDATE LOOP
   -- Actual aliased_empty children are legitimate immutable lock targets. Their
   -- resolved canonical root is already in component_ids; do not reparent them.
   IF EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=source_id AND state='aliased_empty')
      AND NOT resolve_guest_empty_owner_root_v1(source_id)=ANY(component_ids) THEN
     RAISE EXCEPTION 'alias root missing from locked component'; END IF;
   PERFORM pg_advisory_xact_lock(hashtextextended(source_id,83000004));
 END LOOP;
 -- Pure locking/reads create NO fence row and establish NO owner. New history
 -- creation below validates only its active source and persists its own fence.
END $$;

CREATE FUNCTION register_learner_audio_upload_private_v1(
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
   AND io_state<>'closed') THEN RAISE EXCEPTION 'prior object write is unresolved'; END IF;
 IF EXISTS(SELECT 1 FROM learner_audio_deleted_objects WHERE object_ref=expected_object_ref) THEN
   RAISE EXCEPTION 'deleted object namespace cannot be reused'; END IF;
 INSERT INTO learner_audio_upload_attempts(upload_attempt_id,owner_id,artifact_id,object_ref,
   source_kind,attempt_ref,command_ref,reservation_ref,captured_revision,io_state,created_at)
   VALUES(upload_id,expected_owner,expected_artifact,expected_object_ref,expected_kind,expected_attempt,
     expected_command,expected_reservation,fence.revision,'registered',clock_timestamp());
 UPDATE participation_owners SET state='established' WHERE owner_id=expected_owner AND state='empty';
 RETURN fence.revision;
END $$;

CREATE FUNCTION claim_learner_audio_upload_private_v1(expected_upload TEXT) RETURNS BOOLEAN
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload learner_audio_upload_attempts%ROWTYPE; fence learner_audio_owner_fences%ROWTYPE;
BEGIN
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=expected_upload;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[upload.owner_id]);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=expected_upload FOR UPDATE;
 SELECT * INTO STRICT fence FROM learner_audio_owner_fences WHERE owner_id=upload.owner_id FOR UPDATE;
 IF upload.io_state<>'registered' THEN RETURN FALSE; END IF;
 IF fence.active_delete_command_id IS NOT NULL OR fence.revision<>upload.captured_revision THEN
   UPDATE learner_audio_upload_attempts SET io_state='closed',storage_disposition='absent',
     closed_at=clock_timestamp(),cleanup_required=NOT EXISTS(SELECT 1 FROM learner_audio_deleted_objects d WHERE d.object_ref=upload.object_ref)
     WHERE upload_attempt_id=expected_upload;
   RETURN FALSE; END IF;
 UPDATE learner_audio_upload_attempts SET io_state='writing' WHERE upload_attempt_id=expected_upload;
 RETURN TRUE;
END $$;

CREATE FUNCTION settle_learner_audio_upload_private_v1(
 expected_upload TEXT,disposition TEXT,known_no_more_io BOOLEAN,multipart_id TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE upload learner_audio_upload_attempts%ROWTYPE; fence learner_audio_owner_fences%ROWTYPE; publish_allowed BOOLEAN;
BEGIN
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=expected_upload;
 PERFORM lock_learner_audio_sources_private_v1(ARRAY[upload.owner_id]);
 SELECT * INTO STRICT upload FROM learner_audio_upload_attempts WHERE upload_attempt_id=expected_upload FOR UPDATE;
 SELECT * INTO STRICT fence FROM learner_audio_owner_fences WHERE owner_id=upload.owner_id FOR UPDATE;
 IF upload.io_state='closed' THEN
   IF upload.storage_disposition<>disposition THEN RAISE EXCEPTION 'terminal upload result conflict'; END IF;
   RETURN disposition='stored' AND NOT upload.cleanup_required
     AND fence.revision=upload.captured_revision AND fence.active_delete_command_id IS NULL;
 END IF;
 IF known_no_more_io IS DISTINCT FROM TRUE THEN
   UPDATE learner_audio_upload_attempts SET io_state='unknown',multipart_upload_id=COALESCE(multipart_upload_id,multipart_id),
     cleanup_required=cleanup_required OR fence.revision<>captured_revision OR fence.active_delete_command_id IS NOT NULL
     WHERE upload_attempt_id=expected_upload;
   RETURN FALSE; END IF;
 IF disposition IS NULL OR disposition NOT IN('stored','absent','failed') THEN RAISE EXCEPTION 'invalid terminal IO fact'; END IF;
 publish_allowed:=disposition='stored' AND fence.revision=upload.captured_revision AND fence.active_delete_command_id IS NULL;
 UPDATE learner_audio_upload_attempts SET io_state='closed',storage_disposition=disposition,
   closed_at=clock_timestamp(),multipart_upload_id=COALESCE(multipart_upload_id,multipart_id),
   cleanup_required=CASE WHEN disposition='absent' AND EXISTS(SELECT 1 FROM learner_audio_deleted_objects d WHERE d.object_ref=upload.object_ref) THEN FALSE ELSE cleanup_required OR NOT publish_allowed END
   WHERE upload_attempt_id=expected_upload;
 -- A later stored object invalidates earlier absence/deletion evidence for the
 -- same key. Its old command stays pending until another exact deletion.
 IF disposition<>'absent' AND NOT publish_allowed THEN
   DELETE FROM learner_audio_deleted_objects WHERE object_ref=upload.object_ref;
 END IF;
 RETURN publish_allowed;
END $$;

CREATE FUNCTION prepare_learner_audio_delete_private_v1(
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
     RAISE EXCEPTION 'untracked legacy producer requires durable disposition'; END IF;
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
     AND captured_revision<next_revision;
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

CREATE FUNCTION confirm_learner_audio_delete_private_v1(
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

CREATE FUNCTION fail_learner_audio_delete_private_v1(expected_batch TEXT,external_fact TEXT) RETURNS VOID
 LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF external_fact IS NULL OR external_fact NOT IN('failed','unknown') THEN RAISE EXCEPTION 'invalid unresolved storage fact'; END IF;
 UPDATE learner_audio_delete_batches SET state=external_fact WHERE batch_id=expected_batch AND state<>'confirmed';
 -- This never releases the durable owner fence, expires an old upload or
 -- changes provider disposition into a claimed confirmed provider deletion.
END $$;

CREATE FUNCTION retain_learner_audio_immutable_private_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'audio control/source evidence cannot be physically deleted'; END IF;
 RAISE EXCEPTION 'immutable audio control/source evidence';
END $$;
CREATE FUNCTION guard_learner_audio_control_state_private_v1() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE mutable TEXT[]; identity_new JSONB; identity_old JSONB;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'durable audio control rows cannot be deleted'; END IF;
 identity_new:=to_jsonb(NEW);identity_old:=to_jsonb(OLD);
 IF TG_TABLE_NAME='learner_audio_delete_commands' THEN
   -- Stored GENERATED ALWAYS values are unavailable in a BEFORE row frame.
   -- PostgreSQL owns this constant and refuses explicit operation-kind writes.
   -- Compare every application-owned identity field, excluding only that value.
   identity_new:=identity_new-'operation_kind';identity_old:=identity_old-'operation_kind';
   mutable:=ARRAY['state','provider_disposition','completed_at','final_result'];
   IF OLD.state='completed' AND identity_new IS DISTINCT FROM identity_old THEN
     RAISE EXCEPTION 'completed deletion fact is immutable'; END IF;
   IF NEW.state NOT IN('pending','completed') THEN RAISE EXCEPTION 'invalid deletion state'; END IF;
 ELSIF TG_TABLE_NAME='learner_audio_upload_attempts' THEN
   mutable:=ARRAY['io_state','storage_disposition','multipart_upload_id','cleanup_required','closed_at'];
   IF OLD.multipart_upload_id IS NOT NULL AND NEW.multipart_upload_id IS DISTINCT FROM OLD.multipart_upload_id THEN
     RAISE EXCEPTION 'multipart identity is immutable'; END IF;
   IF OLD.io_state='closed' AND (to_jsonb(NEW)-'cleanup_required') IS DISTINCT FROM (to_jsonb(OLD)-'cleanup_required') THEN
     RAISE EXCEPTION 'closed producer cannot reopen or replace its terminal fact'; END IF;
   IF NOT ((OLD.io_state='registered' AND NEW.io_state IN('registered','writing','closed'))
     OR (OLD.io_state='writing' AND NEW.io_state IN('writing','unknown','closed'))
     OR (OLD.io_state='unknown' AND NEW.io_state IN('unknown','closed'))
     OR (OLD.io_state='closed' AND NEW.io_state='closed')) THEN RAISE EXCEPTION 'invalid IO transition'; END IF;
 ELSIF TG_TABLE_NAME='learner_audio_delete_batches' THEN
   mutable:=ARRAY['state','deleted_at'];
   IF OLD.state='confirmed' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
     RAISE EXCEPTION 'confirmed exact batch is immutable'; END IF;
 ELSIF TG_TABLE_NAME='learner_audio_owner_fences' THEN
   mutable:=ARRAY['revision','active_delete_command_id'];
   IF NEW.revision<OLD.revision THEN RAISE EXCEPTION 'audio fence revision cannot decrease'; END IF;
   IF OLD.active_delete_command_id IS NOT NULL AND NEW.active_delete_command_id IS DISTINCT FROM OLD.active_delete_command_id
     AND (NEW.active_delete_command_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM learner_audio_delete_commands
       WHERE command_id=OLD.active_delete_command_id AND state='completed')) THEN
     RAISE EXCEPTION 'live deletion fence cannot be replaced or released'; END IF;
 ELSE RAISE EXCEPTION 'unexpected audio control table'; END IF;
 IF (identity_new-mutable) IS DISTINCT FROM (identity_old-mutable) THEN
   RAISE EXCEPTION 'audio command/source identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER learner_audio_delete_command_state BEFORE UPDATE OR DELETE ON learner_audio_delete_commands
 FOR EACH ROW EXECUTE FUNCTION guard_learner_audio_control_state_private_v1();
CREATE TRIGGER learner_audio_upload_state BEFORE UPDATE OR DELETE ON learner_audio_upload_attempts
 FOR EACH ROW EXECUTE FUNCTION guard_learner_audio_control_state_private_v1();
CREATE TRIGGER learner_audio_delete_batch_state BEFORE UPDATE OR DELETE ON learner_audio_delete_batches
 FOR EACH ROW EXECUTE FUNCTION guard_learner_audio_control_state_private_v1();
CREATE TRIGGER learner_audio_owner_fence_state BEFORE UPDATE OR DELETE ON learner_audio_owner_fences
 FOR EACH ROW EXECUTE FUNCTION guard_learner_audio_control_state_private_v1();
CREATE TRIGGER learner_audio_delete_sources_immutable BEFORE UPDATE OR DELETE ON learner_audio_delete_sources
 FOR EACH ROW EXECUTE FUNCTION retain_learner_audio_immutable_private_v1();
CREATE TRIGGER learner_audio_delete_targets_immutable BEFORE UPDATE OR DELETE ON learner_audio_delete_target_artifacts
 FOR EACH ROW EXECUTE FUNCTION retain_learner_audio_immutable_private_v1();
CREATE TRIGGER learner_audio_object_names_immutable BEFORE UPDATE OR DELETE ON learner_audio_object_names
 FOR EACH ROW EXECUTE FUNCTION retain_learner_audio_immutable_private_v1();
CREATE TRIGGER learner_audio_delete_batch_items_immutable BEFORE UPDATE OR DELETE ON learner_audio_delete_batch_items
 FOR EACH ROW EXECUTE FUNCTION retain_learner_audio_immutable_private_v1();

-- Do not attach producer publication/tombstone guards until all named old and
-- new producers, recovery jobs and DO archive callbacks are converted and
-- independently accepted. See companion protocol for exact guard predicates,
-- source-state transition guards, checkpoint capture and role/phase activation.
-- This foundation alone cannot claim durable deletion serving readiness.

DO $pin_private_audio_packet$
DECLARE relation_name TEXT; signature TEXT; grantee_name TEXT; trusted_schema TEXT:=current_schema();
BEGIN
 IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
   RAISE EXCEPTION 'trusted migration schema required'; END IF;
 FOREACH relation_name IN ARRAY ARRAY['learner_audio_owner_fences','learner_audio_delete_commands',
  'learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts',
  'learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',relation_name);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c
   CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid=relation_name::regclass AND a.grantee<>0 AND a.grantee<>c.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',relation_name,grantee_name); END LOOP;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY[
  'learner_audio_source_component_private_v1(text[])',
  'lock_learner_audio_sources_private_v1(text[])',
  'register_learner_audio_upload_private_v1(text,text,text,text,text,text,text,text,bigint)',
  'claim_learner_audio_upload_private_v1(text)',
  'settle_learner_audio_upload_private_v1(text,text,boolean,text)',
  'prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)',
  'confirm_learner_audio_delete_private_v1(text,bigint,text,timestamp with time zone)',
  'fail_learner_audio_delete_private_v1(text,text)',
  'retain_learner_audio_immutable_private_v1()',
  'guard_learner_audio_control_state_private_v1()'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
 END LOOP;
 REVOKE ALL ON SEQUENCE learner_audio_fence_revision_v1 FROM PUBLIC;
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('S',c.relowner))) a
  WHERE c.oid='learner_audio_fence_revision_v1'::regclass AND a.grantee<>0 AND a.grantee<>c.relowner LOOP
  EXECUTE format('REVOKE ALL ON SEQUENCE learner_audio_fence_revision_v1 FROM %I',grantee_name); END LOOP;
END;
$pin_private_audio_packet$;
-- No runtime grants inferred. Exact trusted wrapper/worker role binding,
-- source-version release inventory and full protocol gates are prerequisites.

-- ATOMIC PHASE SUCCESSOR: must be in this same migration transaction.
-- Explicit eleven existing FK targets plus all nine audio/control FK targets.
-- Shared predicate covers convergence, pointer repair and empty-only cleanup.
DO $require_prior_audio_phase_v2$
BEGIN
 IF (SELECT count(*) FROM guest_learning_schema_phase WHERE singleton
   AND phase='practice_only_owner_resource_history_v2')<>1 THEN
   RAISE EXCEPTION 'positive prior resource schema phase required'; END IF;
END $require_prior_audio_phase_v2$;
ALTER TABLE guest_learning_schema_phase DROP CONSTRAINT guest_learning_schema_phase_phase_check;
UPDATE guest_learning_schema_phase SET phase='practice_only_owner_audio_history_v3'
 WHERE singleton AND phase='practice_only_owner_resource_history_v2';
ALTER TABLE guest_learning_schema_phase ADD CONSTRAINT guest_learning_schema_phase_phase_check
 CHECK(phase='practice_only_owner_audio_history_v3');
CREATE FUNCTION learner_audio_component_has_history_private_v1(component_ids TEXT[])
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM learner_audio_owner_fences WHERE owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM learner_audio_delete_commands WHERE source_owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM learner_audio_delete_sources WHERE owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM learner_audio_delete_target_artifacts WHERE owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM learner_audio_object_names WHERE owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM learner_audio_upload_attempts WHERE owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM learner_audio_delete_batches b JOIN learner_audio_delete_commands c USING(command_id)
   WHERE c.source_owner_id=ANY(component_ids) OR EXISTS(SELECT 1 FROM learner_audio_delete_sources s
     WHERE s.command_id=b.command_id AND s.owner_id=ANY(component_ids)))
 OR EXISTS(SELECT 1 FROM learner_audio_delete_batch_items WHERE owner_id=ANY(component_ids))
 OR EXISTS(SELECT 1 FROM learner_audio_deleted_objects d JOIN learner_audio_object_names n USING(object_ref)
   WHERE n.owner_id=ANY(component_ids))
$$;

CREATE OR REPLACE FUNCTION require_guest_practice_only_schema_phase_v1()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE trusted_namespace OID; trusted_owner OID;
BEGIN
  SELECT relnamespace,relowner INTO STRICT trusted_namespace,trusted_owner
    FROM pg_class WHERE oid='participation_owners'::regclass;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='guest_learning_schema_phase'::regclass
      AND relnamespace=trusted_namespace AND relowner=trusted_owner)
    OR (SELECT count(*) FROM guest_learning_schema_phase
      WHERE singleton AND phase='practice_only_owner_audio_history_v3')<>1
    OR EXISTS(SELECT 1 FROM unnest(ARRAY[
      'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks','guest_learning_preferences','guest_participation_operations','guest_secret_issuance_operations','guest_attachment_intents','study_sessions_v2','study_review_items','study_session_items_v2','study_spoken_answer_commands','learner_audio_artifacts','guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts','learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects'
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
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects'))
    OR EXISTS(SELECT 1 FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE fk.contype='f' AND fk.confrelid=ANY(ARRAY[
          'participation_owners'::regclass,'guest_credentials'::regclass,
          'guest_empty_owner_aliases'::regclass,'participation_owner_clocks'::regclass,
          'guest_learning_preferences'::regclass,'guest_participation_operations'::regclass,
          'guest_secret_issuance_operations'::regclass,'guest_attachment_intents'::regclass,
          'guest_resource_session_reservations'::regclass,'guest_resource_provider_calls'::regclass,
          'guest_resource_release_receipts'::regclass,
          'learner_audio_owner_fences'::regclass,'learner_audio_delete_commands'::regclass,'learner_audio_delete_sources'::regclass,'learner_audio_delete_target_artifacts'::regclass,'learner_audio_object_names'::regclass,'learner_audio_upload_attempts'::regclass,'learner_audio_delete_batches'::regclass,'learner_audio_delete_batch_items'::regclass,'learner_audio_deleted_objects'::regclass])
        AND c.relnamespace=trusted_namespace AND c.relname NOT IN (
          'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks',
          'guest_learning_preferences','guest_participation_operations',
          'guest_secret_issuance_operations','guest_attachment_intents',
          'study_sessions_v2','study_review_items','study_session_items_v2',
          'study_spoken_answer_commands','learner_audio_artifacts',
          'guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts',
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects'))
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
    AND NOT EXISTS(SELECT 1 FROM guest_participation_operations WHERE source_owner_id=ANY(member_ids)
      AND operation_kind IN ('study_start','study_answer','learning_retention','learner_audio_deletion')
      AND state<>'known_aborted')
    AND NOT EXISTS(SELECT 1 FROM guest_attachment_intents WHERE owner_id=ANY(member_ids)
      AND state IN ('awaiting_account','awaiting_confirmation') AND expires_at>clock_timestamp());
END $$;

CREATE OR REPLACE FUNCTION converge_proved_empty_guest_sources_v1(expected_origin TEXT,proved_ids TEXT[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE roots TEXT[]; canonical TEXT; source_id TEXT;
BEGIN
  SELECT array_agg(DISTINCT resolve_guest_empty_owner_root_v1(c.owner_id)) INTO roots
    FROM guest_credentials c WHERE c.credential_id=ANY(proved_ids) AND c.origin=expected_origin
      AND (c.state='confirmed' OR
        (c.state IN ('pending_bootstrap','pending_successor') AND c.pending_expires_at>clock_timestamp()));
  IF COALESCE(cardinality(roots),0)<=1 THEN RETURN; END IF;
  FOR source_id IN SELECT unnest(roots) LOOP
    IF NOT guest_authority_component_is_empty_v1(source_id) THEN
      RAISE EXCEPTION 'authority-conflict' USING ERRCODE='GP003'; END IF;
  END LOOP;
  SELECT owner_id INTO STRICT canonical FROM participation_owners WHERE owner_id=ANY(roots)
    ORDER BY created_at,owner_id COLLATE "C" LIMIT 1;
  FOR source_id IN SELECT owner_id FROM participation_owners WHERE owner_id=ANY(roots) AND owner_id<>canonical
      ORDER BY owner_id COLLATE "C" LOOP
    INSERT INTO guest_empty_owner_aliases(source_owner_id,canonical_owner_id,origin,created_at)
      VALUES(source_id,canonical,expected_origin,clock_timestamp());
    UPDATE participation_owners SET state='aliased_empty' WHERE owner_id=source_id;
  END LOOP;
END $$;
DO $pin_audio_phase_closure_v2$
DECLARE signature TEXT; grantee_name TEXT; trusted_schema TEXT:=current_schema();
BEGIN
 IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
   RAISE EXCEPTION 'trusted audio schema required'; END IF;
 FOREACH signature IN ARRAY ARRAY['learner_audio_component_has_history_private_v1(text[])',
  'require_guest_practice_only_schema_phase_v1()',
  'guest_authority_component_is_empty_v1(text)',
  'converge_proved_empty_guest_sources_v1(text,text[])'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $pin_audio_phase_closure_v2$;
-- Reject unknown relations before committing the positive witness. No runtime
-- grants, producer conversion, RLS bypass or I/O activation is performed here.
SELECT require_guest_practice_only_schema_phase_v1();
