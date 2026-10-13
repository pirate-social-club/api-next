-- Expand and preserve existing account Study/audio source ownership.
-- Atomic migration, restored historical guards; guest/null-account composition stays unavailable.
SELECT pg_advisory_xact_lock(83000003,1);
LOCK TABLE users,account_aliases IN SHARE MODE;
LOCK TABLE study_sessions_v2,study_review_items,study_session_items_v2,
  study_spoken_answer_commands,learner_audio_artifacts,
  study_attempts_v2,study_presentations_v2,study_lesson_item_state_v2
  IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE guest_populated_preservation_v1(
  table_name TEXT NOT NULL,row_id TEXT NOT NULL,original_hash BYTEA NOT NULL,
  PRIMARY KEY(table_name,row_id)
) ON COMMIT DROP;
CREATE TEMP TABLE guest_original_backfill_guards_v1(
  name TEXT PRIMARY KEY,definition TEXT NOT NULL,bits INTEGER,enabled "char",function_id OID
) ON COMMIT DROP;
DO $record_original_rows_and_guards$
DECLARE spec TEXT[]; relation_name TEXT; pk TEXT;
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ARRAY['study_sessions_v2','session_id'],ARRAY['study_review_items','review_item_id'],
    ARRAY['study_session_items_v2','session_item_id'],ARRAY['study_spoken_answer_commands','command_id'],
    ARRAY['learner_audio_artifacts','learner_audio_artifact_id']
  ] LOOP
    relation_name:=spec[1];pk:=spec[2];
    EXECUTE format('INSERT INTO guest_populated_preservation_v1 SELECT %L,%I::text,sha256(convert_to(to_jsonb(row_source)::text,''UTF8'')) FROM %I row_source',relation_name,pk,relation_name);
  END LOOP;
  INSERT INTO guest_original_backfill_guards_v1(name,definition,function_id)
    SELECT 'session_authority_function',pg_get_functiondef(oid),oid
      FROM pg_proc WHERE oid='guard_study_v2_activity_authority()'::regprocedure;
  INSERT INTO guest_original_backfill_guards_v1(name,definition,bits,enabled,function_id)
    SELECT tgname,pg_get_triggerdef(oid),tgtype::int,tgenabled,tgfoid FROM pg_trigger
     WHERE tgrelid IN ('study_sessions_v2'::regclass,'study_session_items_v2'::regclass)
       AND tgname IN ('study_sessions_v2_activity_authority','study_session_items_v2_immutable');
  IF (SELECT count(*) FROM guest_original_backfill_guards_v1)<>3 THEN
    RAISE EXCEPTION 'expected original Study guard packet missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM guest_original_backfill_guards_v1
       WHERE name='study_session_items_v2_immutable' AND bits=27 AND enabled='O'
         AND function_id='reject_localization_immutable_mutation()'::regprocedure)
     OR NOT EXISTS(SELECT 1 FROM guest_original_backfill_guards_v1
       WHERE name='study_sessions_v2_activity_authority' AND bits=23 AND enabled='O'
         AND function_id='guard_study_v2_activity_authority()'::regprocedure) THEN
    RAISE EXCEPTION 'Study guard packet differs from reviewed baseline';
  END IF;
END;
$record_original_rows_and_guards$;

-- Reject invalid existing relationships; never fix them or drop them through JOIN.
DO $existing_source_preflight$
BEGIN
  IF EXISTS(SELECT 1 FROM study_session_items_v2 i
     LEFT JOIN study_sessions_v2 s ON s.session_id=i.session_id
     LEFT JOIN study_review_items r ON r.review_item_id=i.review_item_id
     WHERE s.session_id IS NULL OR r.review_item_id IS NULL
       OR i.account_id IS DISTINCT FROM s.account_id OR i.account_id IS DISTINCT FROM r.account_id
       OR i.exercise_review_key IS DISTINCT FROM r.exercise_review_key)
    OR EXISTS(SELECT 1 FROM study_spoken_answer_commands c
      LEFT JOIN study_session_items_v2 i ON i.session_item_id=c.session_item_id
      LEFT JOIN study_sessions_v2 s ON s.session_id=c.session_id
      LEFT JOIN learner_audio_artifacts a ON a.learner_audio_artifact_id=c.learner_audio_artifact_id
      WHERE i.session_item_id IS NULL OR s.session_id IS NULL OR a.learner_audio_artifact_id IS NULL
        OR i.session_id IS DISTINCT FROM c.session_id OR c.account_id IS DISTINCT FROM i.account_id
        OR c.account_id IS DISTINCT FROM s.account_id OR c.account_id IS DISTINCT FROM a.account_id
        OR a.source_kind<>'study' OR a.attempt_ref IS DISTINCT FROM c.attempt_id
        OR a.content_digest IS DISTINCT FROM c.audio_digest OR a.content_type IS DISTINCT FROM c.audio_content_type
        OR a.byte_size IS DISTINCT FROM c.audio_byte_size OR a.duration_ms IS DISTINCT FROM c.audio_duration_ms)
    OR EXISTS(SELECT 1 FROM study_presentations_v2 p JOIN study_session_items_v2 i USING(session_item_id)
       WHERE p.session_id IS DISTINCT FROM i.session_id)
    OR EXISTS(SELECT 1 FROM study_lesson_item_state_v2 l JOIN study_session_items_v2 i USING(session_item_id)
       WHERE l.session_id IS DISTINCT FROM i.session_id)
    OR EXISTS(SELECT 1 FROM study_sessions_v2 s
       LEFT JOIN study_lesson_item_state_v2 l ON l.session_item_id=s.current_session_item_id
       WHERE s.current_session_item_id IS NOT NULL
         AND (l.session_item_id IS NULL OR l.session_id IS DISTINCT FROM s.session_id))
    OR EXISTS(SELECT 1 FROM study_attempts_v2 t
       JOIN study_session_items_v2 i USING(session_item_id)
       LEFT JOIN learner_audio_artifacts a ON a.learner_audio_artifact_id=t.learner_audio_artifact_id
       WHERE t.submission_kind='raw_audio' AND
         (a.learner_audio_artifact_id IS NULL OR a.account_id IS DISTINCT FROM i.account_id
           OR a.source_kind<>'study' OR a.attempt_ref IS DISTINCT FROM t.attempt_id
           OR a.content_digest IS DISTINCT FROM (t.submission_evidence->>'audio_digest')
           OR a.learner_audio_artifact_id IS DISTINCT FROM (t.submission_evidence->>'learner_audio_artifact_id')
           OR a.byte_size IS DISTINCT FROM t.audio_byte_size OR a.duration_ms IS DISTINCT FROM t.audio_duration_ms)) THEN
    RAISE EXCEPTION 'historical Study/audio source identity requires separate disposition';
  END IF;
END;
$existing_source_preflight$;

-- Historical mapping keeps ORIGINAL raw account IDs, including inactive/alias
-- accounts. New admission uses separate active-canonical provisioning below.
-- Map every existing user so ordinary first activity on an existing account works.
INSERT INTO participation_owners(owner_id,kind,account_id,state,created_at)
 SELECT 'owner_'||gen_random_uuid()::text,'account',u.user_id,'empty',clock_timestamp()
   FROM users u WHERE NOT EXISTS(SELECT 1 FROM participation_owners o WHERE o.account_id=u.user_id)
 ON CONFLICT(account_id) DO NOTHING;
UPDATE participation_owners o SET state='established'
 WHERE o.kind='account' AND o.state='empty' AND (
   EXISTS(SELECT 1 FROM study_sessions_v2 s WHERE s.account_id=o.account_id)
   OR EXISTS(SELECT 1 FROM study_review_items r WHERE r.account_id=o.account_id)
   OR EXISTS(SELECT 1 FROM study_session_items_v2 i WHERE i.account_id=o.account_id)
   OR EXISTS(SELECT 1 FROM study_spoken_answer_commands c WHERE c.account_id=o.account_id)
   OR EXISTS(SELECT 1 FROM learner_audio_artifacts a WHERE a.account_id=o.account_id));

-- EXPAND: nullable columns first, with account_id/persona_id still NOT NULL.
ALTER TABLE study_sessions_v2 ADD COLUMN participation_owner_id TEXT;
ALTER TABLE study_sessions_v2 ADD COLUMN participation_owner_kind TEXT;
ALTER TABLE study_sessions_v2 ADD COLUMN guest_reward_mode TEXT;
ALTER TABLE study_sessions_v2 ADD COLUMN guest_reward_terms JSONB;
ALTER TABLE study_sessions_v2 ADD COLUMN guest_start_operation_id TEXT;
ALTER TABLE study_sessions_v2 ADD COLUMN guest_disclosure_version TEXT;
ALTER TABLE study_sessions_v2 ADD COLUMN guest_disclosure_accepted BOOLEAN;
ALTER TABLE study_review_items ADD COLUMN participation_owner_id TEXT;
ALTER TABLE study_review_items ADD COLUMN participation_owner_kind TEXT;
ALTER TABLE study_session_items_v2 ADD COLUMN participation_owner_id TEXT;
ALTER TABLE study_session_items_v2 ADD COLUMN participation_owner_kind TEXT;
ALTER TABLE study_spoken_answer_commands ADD COLUMN participation_owner_id TEXT;
ALTER TABLE study_spoken_answer_commands ADD COLUMN participation_owner_kind TEXT;
ALTER TABLE learner_audio_artifacts ADD COLUMN participation_owner_id TEXT;
ALTER TABLE learner_audio_artifacts ADD COLUMN participation_owner_kind TEXT;


-- Temporary owner-only enrichment guards. Tables are locked for the entire
-- atomic transaction. No runtime UPDATE/DELETE or arbitrary owner mutation is
-- allowed; the exact original function/trigger are restored before commit.
CREATE FUNCTION guest_migration_only_item_enrichment_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE'
   AND current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
   AND OLD.participation_owner_id IS NULL AND OLD.participation_owner_kind IS NULL
   AND NEW.participation_owner_kind='account' AND NEW.participation_owner_id IS NOT NULL
   AND (to_jsonb(NEW)-ARRAY['participation_owner_id','participation_owner_kind'])
     IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['participation_owner_id','participation_owner_kind'])
   AND EXISTS(SELECT 1 FROM participation_owners o WHERE o.owner_id=NEW.participation_owner_id
     AND o.kind='account' AND o.account_id=OLD.account_id) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'migration permits only unchanged-row account owner enrichment';
END $$;
REVOKE ALL ON FUNCTION guest_migration_only_item_enrichment_v1() FROM PUBLIC;
DO $revoke_temporary_enrichment_execute$
DECLARE grantee_name TEXT;
BEGIN
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
  CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
  WHERE f.oid='guest_migration_only_item_enrichment_v1()'::regprocedure
    AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION guest_migration_only_item_enrichment_v1() FROM %I',grantee_name);
 END LOOP;
END;
$revoke_temporary_enrichment_execute$;
DROP TRIGGER study_session_items_v2_immutable ON study_session_items_v2;
CREATE TRIGGER study_session_items_v2_immutable BEFORE UPDATE OR DELETE ON study_session_items_v2
 FOR EACH ROW EXECUTE FUNCTION guest_migration_only_item_enrichment_v1();
CREATE OR REPLACE FUNCTION guard_study_v2_activity_authority() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='study_sessions_v2'
   AND current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
   AND OLD.participation_owner_id IS NULL AND OLD.participation_owner_kind IS NULL
   AND NEW.participation_owner_kind='account' AND NEW.participation_owner_id IS NOT NULL
   AND (to_jsonb(NEW)-ARRAY['participation_owner_id','participation_owner_kind'])
     IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['participation_owner_id','participation_owner_kind'])
   AND EXISTS(SELECT 1 FROM participation_owners o WHERE o.owner_id=NEW.participation_owner_id
     AND o.kind='account' AND o.account_id=OLD.account_id) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'migration permits only unchanged-row account owner enrichment';
END $$;

DO $bounded_source_enrichment$
DECLARE relation_name TEXT; pk TEXT; spec TEXT[]; changed BIGINT;
BEGIN
 FOREACH spec SLICE 1 IN ARRAY ARRAY[
   ARRAY['study_sessions_v2','session_id'],ARRAY['study_review_items','review_item_id'],
   ARRAY['learner_audio_artifacts','learner_audio_artifact_id'],
   ARRAY['study_session_items_v2','session_item_id'],ARRAY['study_spoken_answer_commands','command_id']
 ] LOOP
  relation_name:=spec[1];pk:=spec[2];
  LOOP
   EXECUTE format('WITH batch AS (SELECT %I FROM %I WHERE participation_owner_id IS NULL ORDER BY %I COLLATE "C" LIMIT 1000)
      UPDATE %I t SET participation_owner_id=o.owner_id,participation_owner_kind=''account''
      FROM batch b,participation_owners o WHERE t.%I=b.%I AND o.kind=''account'' AND o.account_id=t.account_id',
      pk,relation_name,pk,relation_name,pk,pk);
   GET DIAGNOSTICS changed=ROW_COUNT;
   IF changed=0 THEN EXIT; END IF;
  END LOOP;
  EXECUTE format('SELECT count(*) FROM %I WHERE participation_owner_id IS NULL OR participation_owner_kind IS NULL',relation_name) INTO changed;
  IF changed<>0 THEN RAISE EXCEPTION 'owner backfill was not exhaustive'; END IF;
 END LOOP;
END;
$bounded_source_enrichment$;

DO $restore_original_guard_packet$
DECLARE original RECORD; current_guard RECORD;
BEGIN
 SELECT * INTO STRICT original FROM guest_original_backfill_guards_v1 WHERE name='session_authority_function';
 EXECUTE original.definition;
 DROP TRIGGER study_session_items_v2_immutable ON study_session_items_v2;
 SELECT * INTO STRICT original FROM guest_original_backfill_guards_v1 WHERE name='study_session_items_v2_immutable';
 EXECUTE original.definition;
 FOR original IN SELECT * FROM guest_original_backfill_guards_v1 WHERE bits IS NOT NULL LOOP
   SELECT tgtype::int AS bits,tgenabled AS enabled,tgfoid AS function_id,pg_get_triggerdef(oid) AS definition
    INTO STRICT current_guard FROM pg_trigger WHERE tgname=original.name
     AND tgrelid IN('study_sessions_v2'::regclass,'study_session_items_v2'::regclass);
   IF ROW(current_guard.bits,current_guard.enabled,current_guard.function_id,current_guard.definition)
      IS DISTINCT FROM ROW(original.bits,original.enabled,original.function_id,original.definition) THEN
     RAISE EXCEPTION 'original Study guard packet was not restored'; END IF;
 END LOOP;
 IF pg_get_functiondef('guard_study_v2_activity_authority()'::regprocedure)
    IS DISTINCT FROM (SELECT definition FROM guest_original_backfill_guards_v1 WHERE name='session_authority_function') THEN
   RAISE EXCEPTION 'original account authority function was not restored'; END IF;
END;
$restore_original_guard_packet$;
DROP FUNCTION guest_migration_only_item_enrichment_v1();

-- The following FINALIZE statements are permitted only after zero missing
-- provenance, restored immutable guard and version-aware writer evidence.
ALTER TABLE study_sessions_v2 ALTER COLUMN participation_owner_id SET NOT NULL;
ALTER TABLE study_sessions_v2 ALTER COLUMN participation_owner_kind SET NOT NULL;
ALTER TABLE study_review_items ALTER COLUMN participation_owner_id SET NOT NULL;
ALTER TABLE study_review_items ALTER COLUMN participation_owner_kind SET NOT NULL;
ALTER TABLE study_session_items_v2 ALTER COLUMN participation_owner_id SET NOT NULL;
ALTER TABLE study_session_items_v2 ALTER COLUMN participation_owner_kind SET NOT NULL;
ALTER TABLE study_spoken_answer_commands ALTER COLUMN participation_owner_id SET NOT NULL;
ALTER TABLE study_spoken_answer_commands ALTER COLUMN participation_owner_kind SET NOT NULL;
ALTER TABLE learner_audio_artifacts ALTER COLUMN participation_owner_id SET NOT NULL;
ALTER TABLE learner_audio_artifacts ALTER COLUMN participation_owner_kind SET NOT NULL;

-- NONNULL kind/owner references close guest NULL composite-FK bypass.
ALTER TABLE study_sessions_v2 ADD CONSTRAINT study_session_owner_kind_fk
  FOREIGN KEY(participation_owner_id,participation_owner_kind) REFERENCES participation_owners(owner_id,kind);
ALTER TABLE study_sessions_v2 ADD CONSTRAINT study_session_owner_account_fk
  FOREIGN KEY(participation_owner_id,account_id) REFERENCES participation_owners(owner_id,account_id);
ALTER TABLE study_review_items ADD CONSTRAINT study_review_owner_kind_fk
  FOREIGN KEY(participation_owner_id,participation_owner_kind) REFERENCES participation_owners(owner_id,kind);
ALTER TABLE study_review_items ADD CONSTRAINT study_review_owner_account_fk
  FOREIGN KEY(participation_owner_id,account_id) REFERENCES participation_owners(owner_id,account_id);
ALTER TABLE study_session_items_v2 ADD CONSTRAINT study_item_owner_kind_fk
  FOREIGN KEY(participation_owner_id,participation_owner_kind) REFERENCES participation_owners(owner_id,kind);
ALTER TABLE study_session_items_v2 ADD CONSTRAINT study_item_owner_account_fk
  FOREIGN KEY(participation_owner_id,account_id) REFERENCES participation_owners(owner_id,account_id);
ALTER TABLE study_spoken_answer_commands ADD CONSTRAINT study_command_owner_kind_fk
  FOREIGN KEY(participation_owner_id,participation_owner_kind) REFERENCES participation_owners(owner_id,kind);
ALTER TABLE study_spoken_answer_commands ADD CONSTRAINT study_command_owner_account_fk
  FOREIGN KEY(participation_owner_id,account_id) REFERENCES participation_owners(owner_id,account_id);
ALTER TABLE learner_audio_artifacts ADD CONSTRAINT learner_artifact_owner_kind_fk
  FOREIGN KEY(participation_owner_id,participation_owner_kind) REFERENCES participation_owners(owner_id,kind);
ALTER TABLE learner_audio_artifacts ADD CONSTRAINT learner_artifact_owner_account_fk
  FOREIGN KEY(participation_owner_id,account_id) REFERENCES participation_owners(owner_id,account_id);

ALTER TABLE study_sessions_v2 ADD CONSTRAINT study_session_source_shape CHECK (
  (participation_owner_kind='account' AND account_id IS NOT NULL AND persona_id IS NOT NULL
    AND guest_reward_mode IS NULL AND guest_reward_terms IS NULL AND guest_start_operation_id IS NULL
    AND guest_disclosure_version IS NULL AND guest_disclosure_accepted IS NULL)
  OR
  (participation_owner_kind='guest' AND account_id IS NULL AND persona_id IS NULL
    AND guest_reward_mode='practice_only' AND guest_reward_terms IS NULL
    AND guest_start_operation_id IS NOT NULL AND guest_disclosure_version IS NOT NULL
    AND guest_disclosure_accepted IS NOT NULL AND telegram_practice_only IS FALSE)
);
-- Persist exact disclosure consent. No spoken reservation/capture/provider call
-- can proceed unless accepted IS TRUE for the current frozen disclosure version.
-- CHECK must use IS TRUE/IS NULL and explicit nonnull mode; do not let SQL UNKNOWN pass.
ALTER TABLE study_sessions_v2 ADD CONSTRAINT study_guest_reward_mode_present
  CHECK (participation_owner_kind<>'guest' OR guest_reward_mode IS NOT NULL);
ALTER TABLE study_sessions_v2 ADD CONSTRAINT study_guest_start_operation_fk
  FOREIGN KEY(guest_start_operation_id,participation_owner_id)
  REFERENCES guest_participation_operations(operation_id,source_owner_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE study_review_items ADD CONSTRAINT study_review_source_shape CHECK (
  (participation_owner_kind='account' AND account_id IS NOT NULL)
  OR (participation_owner_kind='guest' AND account_id IS NULL));
ALTER TABLE study_session_items_v2 ADD CONSTRAINT study_item_source_shape CHECK (
  (participation_owner_kind='account' AND account_id IS NOT NULL)
  OR (participation_owner_kind='guest' AND account_id IS NULL));
ALTER TABLE study_spoken_answer_commands ADD CONSTRAINT study_command_source_shape CHECK (
  (participation_owner_kind='account' AND account_id IS NOT NULL)
  OR (participation_owner_kind='guest' AND account_id IS NULL));
ALTER TABLE learner_audio_artifacts ADD CONSTRAINT learner_artifact_source_shape CHECK (
  (participation_owner_kind='account' AND account_id IS NOT NULL)
  OR (participation_owner_kind='guest' AND account_id IS NULL AND source_kind='study'));
-- Guest Karaoke remains absent. Existing account Karaoke artifacts are mapped.

ALTER TABLE study_sessions_v2 ADD CONSTRAINT study_session_owner_identity_unique
  UNIQUE(session_id,participation_owner_id,participation_owner_kind);
ALTER TABLE study_sessions_v2 ADD CONSTRAINT study_session_owner_idempotency_unique
  UNIQUE(participation_owner_id,post_id,idempotency_key);
ALTER TABLE study_review_items ADD CONSTRAINT study_review_item_owner_identity_unique
  UNIQUE(review_item_id,participation_owner_id,exercise_review_key);
ALTER TABLE study_review_items ADD CONSTRAINT study_review_owner_exercise_key_unique
  UNIQUE(participation_owner_id,exercise_review_key);
ALTER TABLE study_review_items ADD CONSTRAINT study_review_owner_identity_v1
  UNIQUE NULLS NOT DISTINCT(participation_owner_id,post_id,study_unit_id,exercise_kind,learning_language,target_language,learner_band);
ALTER TABLE study_session_items_v2 ADD CONSTRAINT study_item_session_owner_unique
  UNIQUE(session_item_id,session_id,participation_owner_id);
ALTER TABLE learner_audio_artifacts ADD CONSTRAINT learner_artifact_owner_identity_unique
  UNIQUE(learner_audio_artifact_id,participation_owner_id);

ALTER TABLE study_session_items_v2 ADD CONSTRAINT study_item_review_owner_fk
  FOREIGN KEY(review_item_id,participation_owner_id,exercise_review_key)
  REFERENCES study_review_items(review_item_id,participation_owner_id,exercise_review_key);
ALTER TABLE study_session_items_v2 ADD CONSTRAINT study_item_session_owner_fk
  FOREIGN KEY(session_id,participation_owner_id,participation_owner_kind)
  REFERENCES study_sessions_v2(session_id,participation_owner_id,participation_owner_kind);
ALTER TABLE study_spoken_answer_commands ADD CONSTRAINT study_command_item_session_owner_fk
  FOREIGN KEY(session_item_id,session_id,participation_owner_id)
  REFERENCES study_session_items_v2(session_item_id,session_id,participation_owner_id);
ALTER TABLE study_spoken_answer_commands ADD CONSTRAINT study_command_artifact_owner_fk
  FOREIGN KEY(learner_audio_artifact_id,participation_owner_id)
  REFERENCES learner_audio_artifacts(learner_audio_artifact_id,participation_owner_id)
  DEFERRABLE INITIALLY DEFERRED;

-- CRITICAL: old NULLS NOT DISTINCT identity would merge different guest owners.
ALTER TABLE study_review_items DROP CONSTRAINT study_review_identity_v2;
-- Keep ordinary account/key uniqueness temporarily for the existing account
-- ON CONFLICT(account_id,exercise_review_key) target. Its default NULL-distinct
-- semantics do not replace or weaken the required new NONNULL owner uniqueness.
-- Coordinator may retire redundant account-only keys after all account consumers
-- use owner conflict targets; no old account wire behavior changes.
ALTER TABLE study_session_items_v2 DROP CONSTRAINT study_session_item_review_identity_fk;
ALTER TABLE study_session_items_v2 DROP CONSTRAINT study_session_item_session_account_fk;
-- Replaced by required NONNULL owner FKs, not merely dropped.

-- Pair descendants to their exact item/session; no new nullable account column.
ALTER TABLE study_session_items_v2 ADD CONSTRAINT study_item_exact_session_identity_unique
  UNIQUE(session_item_id,session_id);
ALTER TABLE study_presentations_v2 ADD CONSTRAINT study_presentation_exact_session_item_fk
  FOREIGN KEY(session_item_id,session_id) REFERENCES study_session_items_v2(session_item_id,session_id);
ALTER TABLE study_lesson_item_state_v2 ADD CONSTRAINT study_lesson_exact_session_item_fk
  FOREIGN KEY(session_item_id,session_id) REFERENCES study_session_items_v2(session_item_id,session_id);
-- Preserve deferred current-item reference; add an exact session/current-item
-- guard or composite target so one session cannot point at another's lesson state.
-- Attempt audio guard resolves item->session->owner and verifies artifact owner,
-- source_kind='study', attempt_ref=attempt_id and digest/provenance equality.

CREATE INDEX study_sessions_owner_active ON study_sessions_v2(participation_owner_id,expires_at)
  WHERE status='active';
CREATE INDEX study_review_owner_due ON study_review_items
  (participation_owner_id,post_id,exercise_kind,lifecycle_status,due_at,created_at);
CREATE INDEX study_spoken_owner_recovery ON study_spoken_answer_commands
  (participation_owner_id,lease_expires_at) WHERE state='reserved';
CREATE INDEX learner_audio_owner_stored ON learner_audio_artifacts
  (participation_owner_id,created_at,learner_audio_artifact_id) WHERE recording_state='stored';


-- Exact current-item closure remains DEFERRED to preserve the existing start
-- order: session first, item/review and lesson state afterward in one transaction.
ALTER TABLE study_lesson_item_state_v2 ADD CONSTRAINT study_lesson_exact_current_target_v1
 UNIQUE(session_id,session_item_id);
ALTER TABLE study_sessions_v2 ADD CONSTRAINT study_session_exact_current_item_fk
 FOREIGN KEY(session_id,current_session_item_id)
 REFERENCES study_lesson_item_state_v2(session_id,session_item_id) DEFERRABLE INITIALLY DEFERRED;
-- Keep existing study_session_current_item_fk; never remove its deferred behavior.
ALTER TABLE learner_audio_artifacts ADD CONSTRAINT learner_artifact_exact_command_identity_v1
 UNIQUE(learner_audio_artifact_id,participation_owner_id,attempt_ref,content_digest);
ALTER TABLE study_spoken_answer_commands ADD CONSTRAINT study_spoken_exact_artifact_owner_attempt_digest_fk
 FOREIGN KEY(learner_audio_artifact_id,participation_owner_id,attempt_id,audio_digest)
 REFERENCES learner_audio_artifacts(learner_audio_artifact_id,participation_owner_id,attempt_ref,content_digest)
 DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION provision_account_participation_owner_v1(expected_account_id TEXT) RETURNS TEXT
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE mapped_owner TEXT;
BEGIN
 PERFORM pg_advisory_xact_lock(83000003,1);
 PERFORM 1 FROM users u WHERE u.user_id=expected_account_id AND u.status='active'
   AND NOT EXISTS(SELECT 1 FROM account_aliases a WHERE a.source_user_id=u.user_id AND
    ((a.kind='alias' AND a.status='active') OR (a.kind='merge' AND a.status IN('finalizing','completed'))))
   FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'active canonical account required'; END IF;
 SELECT owner_id INTO mapped_owner FROM participation_owners WHERE kind='account' AND account_id=expected_account_id FOR UPDATE;
 IF NOT FOUND THEN
   INSERT INTO participation_owners(owner_id,kind,account_id,state,created_at)
     VALUES('owner_'||gen_random_uuid()::text,'account',expected_account_id,'empty',clock_timestamp())
     RETURNING owner_id INTO mapped_owner;
 END IF;
 RETURN mapped_owner;
END $$;

CREATE FUNCTION require_existing_account_participation_owner_v1(expected_account_id TEXT) RETURNS TEXT
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE mapped_owner TEXT;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 -- This is original-source bookkeeping, not new account admission authority.
 -- Do not reparent historical aliases or refuse accepted recovery on status change.
 SELECT owner_id INTO mapped_owner FROM participation_owners
   WHERE kind='account' AND account_id=expected_account_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'account owner must be provisioned before activity'; END IF;
 RETURN mapped_owner;
END $$;

-- Runtime legacy account INSERT can only use its existing immutable account map.
-- This does not provision late, obtain the topology barrier late, accept guests,
-- resolve/reparent historical account aliases or expose private owner tables.
CREATE FUNCTION map_existing_account_learning_source_v1() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE mapped_owner TEXT;
BEGIN
 IF NEW.account_id IS NULL THEN RAISE EXCEPTION 'guest source composition is unavailable'; END IF;
 SELECT owner_id INTO mapped_owner FROM participation_owners
   WHERE kind='account' AND account_id=NEW.account_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'account owner must be provisioned before activity'; END IF;
 IF (NEW.participation_owner_id IS NOT NULL AND NEW.participation_owner_id<>mapped_owner)
    OR (NEW.participation_owner_kind IS NOT NULL AND NEW.participation_owner_kind<>'account') THEN
   RAISE EXCEPTION 'account source owner mismatch'; END IF;
 NEW.participation_owner_id:=mapped_owner;NEW.participation_owner_kind:='account';
 UPDATE participation_owners SET state='established' WHERE owner_id=mapped_owner AND state='empty';
 RETURN NEW;
END $$;
CREATE FUNCTION preserve_learning_source_identity_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.participation_owner_id,NEW.participation_owner_kind,NEW.account_id)
    IS DISTINCT FROM ROW(OLD.participation_owner_id,OLD.participation_owner_kind,OLD.account_id) THEN
   RAISE EXCEPTION 'learning source provenance is immutable'; END IF;
 IF TG_TABLE_NAME='study_sessions_v2' THEN
   IF ROW(to_jsonb(NEW)->'session_id',to_jsonb(NEW)->'persona_id',to_jsonb(NEW)->'community_id',
      to_jsonb(NEW)->'post_id',to_jsonb(NEW)->'idempotency_key',to_jsonb(NEW)->'request_hash')
       IS DISTINCT FROM ROW(to_jsonb(OLD)->'session_id',to_jsonb(OLD)->'persona_id',to_jsonb(OLD)->'community_id',
      to_jsonb(OLD)->'post_id',to_jsonb(OLD)->'idempotency_key',to_jsonb(OLD)->'request_hash') THEN
     RAISE EXCEPTION 'session source and original start identity are immutable'; END IF;
 ELSIF TG_TABLE_NAME='study_spoken_answer_commands' THEN
   IF OLD.state='completed' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
     RAISE EXCEPTION 'completed spoken outcome is immutable'; END IF;
   IF ROW(to_jsonb(NEW)->'command_id',to_jsonb(NEW)->'session_id',to_jsonb(NEW)->'session_item_id',
      to_jsonb(NEW)->'attempt_id',to_jsonb(NEW)->'attempt_number',to_jsonb(NEW)->'learner_audio_artifact_id')
       IS DISTINCT FROM ROW(to_jsonb(OLD)->'command_id',to_jsonb(OLD)->'session_id',to_jsonb(OLD)->'session_item_id',
      to_jsonb(OLD)->'attempt_id',to_jsonb(OLD)->'attempt_number',to_jsonb(OLD)->'learner_audio_artifact_id') THEN
     RAISE EXCEPTION 'command source and attempt identity are immutable'; END IF;
   -- Account retry may change command key/hash/audio/lease/reserved_at according
   -- to the existing repository. Final current command is checked below.
 ELSIF TG_TABLE_NAME='learner_audio_artifacts' THEN
   IF OLD.source_kind='karaoke' AND OLD.recording_state IN('stored','deleted') THEN
     IF NOT ((OLD.recording_state='stored' AND NEW.recording_state='stored'
              AND NEW.object_ref IS NOT DISTINCT FROM OLD.object_ref)
          OR (OLD.recording_state='stored' AND NEW.recording_state='deleted'
              AND NEW.object_ref IS NULL)
          OR (OLD.recording_state='deleted' AND NEW.recording_state='deleted'
              AND NEW.object_ref IS NULL AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at)) THEN
       RAISE EXCEPTION 'accepted Karaoke archive state and reference are retained'; END IF;
   END IF;
   IF ROW(to_jsonb(NEW)->'learner_audio_artifact_id',to_jsonb(NEW)->'source_kind',to_jsonb(NEW)->'attempt_ref')
       IS DISTINCT FROM ROW(to_jsonb(OLD)->'learner_audio_artifact_id',to_jsonb(OLD)->'source_kind',to_jsonb(OLD)->'attempt_ref') THEN
     RAISE EXCEPTION 'artifact owner/source/attempt identity is immutable'; END IF;
   IF ROW(to_jsonb(NEW)->'content_digest',to_jsonb(NEW)->'expected_object_ref',to_jsonb(NEW)->'content_type',
      to_jsonb(NEW)->'byte_size',to_jsonb(NEW)->'duration_ms')
       IS DISTINCT FROM ROW(to_jsonb(OLD)->'content_digest',to_jsonb(OLD)->'expected_object_ref',to_jsonb(OLD)->'content_type',
      to_jsonb(OLD)->'byte_size',to_jsonb(OLD)->'duration_ms') THEN
     -- Existing account reclaim changes expected audio before any accepted
     -- attempt. Never rewrite completed provider/attempt evidence.
     IF OLD.source_kind<>'study' OR OLD.recording_state NOT IN('pending','failed') OR NEW.recording_state<>'pending'
       OR EXISTS(SELECT 1 FROM study_attempts_v2 WHERE learner_audio_artifact_id=OLD.learner_audio_artifact_id)
       OR EXISTS(SELECT 1 FROM study_spoken_answer_commands
          WHERE learner_audio_artifact_id=OLD.learner_audio_artifact_id AND state='completed') THEN
       RAISE EXCEPTION 'accepted audio evidence is immutable'; END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;

-- Deferred because current account producer inserts command before its artifact.
CREATE FUNCTION validate_study_command_audio_source_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE command_record study_spoken_answer_commands%ROWTYPE;
BEGIN
 -- A deferred event may carry an older digest from an earlier update. Validate
 -- the final retained row, consistent with deferred FK behavior.
 SELECT * INTO command_record FROM study_spoken_answer_commands WHERE command_id=NEW.command_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM learner_audio_artifacts a WHERE
   a.learner_audio_artifact_id=command_record.learner_audio_artifact_id
   AND a.participation_owner_id=command_record.participation_owner_id
   AND a.source_kind='study' AND a.attempt_ref=command_record.attempt_id
   AND a.content_digest=command_record.audio_digest AND a.content_type=command_record.audio_content_type
   AND a.byte_size=command_record.audio_byte_size AND a.duration_ms=command_record.audio_duration_ms) THEN
   RAISE EXCEPTION 'spoken command and original audio provenance disagree'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER study_command_audio_source_closure_v1
 AFTER INSERT OR UPDATE ON study_spoken_answer_commands
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_study_command_audio_source_v1();

CREATE FUNCTION validate_study_attempt_audio_source_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.submission_kind='raw_audio' AND NOT EXISTS(
   SELECT 1 FROM study_session_items_v2 i JOIN learner_audio_artifacts a
      ON a.learner_audio_artifact_id=NEW.learner_audio_artifact_id
    WHERE i.session_item_id=NEW.session_item_id AND a.participation_owner_id=i.participation_owner_id
      AND a.source_kind='study' AND a.attempt_ref=NEW.attempt_id
      AND a.content_digest IS NOT DISTINCT FROM (NEW.submission_evidence->>'audio_digest')
      AND a.learner_audio_artifact_id IS NOT DISTINCT FROM (NEW.submission_evidence->>'learner_audio_artifact_id')
      AND a.byte_size=NEW.audio_byte_size AND a.duration_ms=NEW.audio_duration_ms
 ) THEN RAISE EXCEPTION 'attempt and original audio provenance disagree'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER study_attempt_audio_source_guard_v1 BEFORE INSERT ON study_attempts_v2
 FOR EACH ROW EXECUTE FUNCTION validate_study_attempt_audio_source_v1();

DO $install_and_bind_account_source_packet$
DECLARE relation_name TEXT; signature TEXT; grantee_name TEXT; trusted_schema TEXT:=current_schema();
BEGIN
 IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
   RAISE EXCEPTION 'trusted migration schema required'; END IF;
 FOREACH relation_name IN ARRAY ARRAY['study_sessions_v2','study_review_items','study_session_items_v2','study_spoken_answer_commands','learner_audio_artifacts'] LOOP
   EXECUTE format('CREATE TRIGGER a00_existing_account_source_mapping_v1 BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION map_existing_account_learning_source_v1()',relation_name);
   EXECUTE format('CREATE TRIGGER a01_learning_source_immutable_v1 BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION preserve_learning_source_identity_v1()',relation_name);
 END LOOP;
 FOREACH signature IN ARRAY ARRAY[
  'provision_account_participation_owner_v1(text)','require_existing_account_participation_owner_v1(text)',
  'map_existing_account_learning_source_v1()','preserve_learning_source_identity_v1()',
  'validate_study_command_audio_source_v1()','validate_study_attempt_audio_source_v1()'
 ] LOOP
   EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
   FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
    CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
    WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
   END LOOP;
 END LOOP;
END;
$install_and_bind_account_source_packet$;
-- No role grant inferred. Root separately binds exact current migration owner,
-- approved runtime EXECUTE and denial of runtime CREATE/SET ROLE. New guest core
-- raw table grants remain denied. Current account role table grants stay intact.

DO $prove_original_row_preservation$
DECLARE spec TEXT[]; relation_name TEXT;pk TEXT; excluded TEXT[]; mismatch BIGINT; original_count BIGINT; current_count BIGINT;
BEGIN
 FOREACH spec SLICE 1 IN ARRAY ARRAY[
   ARRAY['study_sessions_v2','session_id'],ARRAY['study_review_items','review_item_id'],
   ARRAY['study_session_items_v2','session_item_id'],ARRAY['study_spoken_answer_commands','command_id'],
   ARRAY['learner_audio_artifacts','learner_audio_artifact_id']
 ] LOOP
  relation_name:=spec[1];pk:=spec[2];
  excluded:=ARRAY['participation_owner_id','participation_owner_kind'];
  IF relation_name='study_sessions_v2' THEN excluded:=excluded||ARRAY['guest_reward_mode','guest_reward_terms','guest_start_operation_id','guest_disclosure_version','guest_disclosure_accepted']; END IF;
  SELECT count(*) INTO original_count FROM guest_populated_preservation_v1 WHERE table_name=relation_name;
  EXECUTE format('SELECT count(*) FROM %I',relation_name) INTO current_count;
  EXECUTE format('SELECT count(*) FROM %I t FULL JOIN guest_populated_preservation_v1 e ON e.table_name=%L AND e.row_id=t.%I::text
    WHERE (e.table_name=%L OR e.table_name IS NULL) AND (e.row_id IS NULL OR t.%I IS NULL OR e.original_hash IS DISTINCT FROM sha256(convert_to((to_jsonb(t)-$1)::text,''UTF8'')))',
    relation_name,relation_name,pk,relation_name,pk) INTO mismatch USING excluded;
  IF current_count<>original_count OR mismatch<>0 THEN RAISE EXCEPTION 'original populated row preservation failed'; END IF;
 END LOOP;
END;
$prove_original_row_preservation$;

-- Intentionally retain account_id/persona_id NOT NULL and original account
-- authority. No guest rows can be inserted by this packet. A later independently
-- reviewed source/serving packet relaxes those fields with its controlled guest
-- admission, owner-aware recovery and unchanged ordinary account policy.
