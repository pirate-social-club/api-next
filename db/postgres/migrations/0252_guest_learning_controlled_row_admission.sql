-- Private review proposal after actual0249 and0251. NOT an ordinal reservation,
-- migration application, role grant or endpoint activation. Root sole writer.
-- Real row security gates raw runtime access. No current_user/GUC/client boolean
-- is an SQL privilege witness. Controlled guest writes require migration-owner
-- SECURITY DEFINER routines whose exact EXECUTE grants are a later packet.
SELECT pg_advisory_xact_lock(83000003,1);
LOCK TABLE study_sessions_v2,study_review_items,study_session_items_v2,
 study_spoken_answer_commands,learner_audio_artifacts,
 study_attempts_v2,study_presentations_v2,study_lesson_item_state_v2
 IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE guest_row_original_account_guard_v1(definition TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO guest_row_original_account_guard_v1
 SELECT pg_get_functiondef('guard_study_v2_activity_authority()'::regprocedure);
DO $preflight_guest_row_boundary$
DECLARE relation_name TEXT; expected_owner OID;
BEGIN
 SELECT relowner INTO STRICT expected_owner FROM pg_class WHERE oid='participation_owners'::regclass;
 FOREACH relation_name IN ARRAY ARRAY[
  'study_sessions_v2','study_review_items','study_session_items_v2',
  'study_spoken_answer_commands','learner_audio_artifacts',
  'study_attempts_v2','study_presentations_v2','study_lesson_item_state_v2'
 ] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(relation_name)
      AND relowner=expected_owner AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass(relation_name)) THEN
    RAISE EXCEPTION 'learning relation owner/RLS requires explicit reconciliation'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM study_sessions_v2 WHERE participation_owner_kind<>'account')
   OR EXISTS(SELECT 1 FROM study_review_items WHERE participation_owner_kind<>'account')
   OR EXISTS(SELECT 1 FROM study_session_items_v2 WHERE participation_owner_kind<>'account')
   OR EXISTS(SELECT 1 FROM study_spoken_answer_commands WHERE participation_owner_kind<>'account')
   OR EXISTS(SELECT 1 FROM learner_audio_artifacts WHERE participation_owner_kind<>'account') THEN
   RAISE EXCEPTION 'guest rows already exist before reviewed row admission'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='study_sessions_v2'::regclass
    AND tgname='study_sessions_v2_activity_authority' AND tgfoid='guard_study_v2_activity_authority()'::regprocedure
    AND tgtype=23 AND tgenabled='O') THEN
    RAISE EXCEPTION 'original account authority trigger differs'; END IF;
END $preflight_guest_row_boundary$;

-- Internal full resource identity, not a truncated hash or client privilege.
-- New start routines store this exact canonical representation on the operation.
CREATE FUNCTION guest_study_start_resource_scope_v1(p_community TEXT,p_post TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_array('guest_study_start_v1',p_community,p_post)::TEXT
$$;

ALTER TABLE study_sessions_v2 ADD COLUMN guest_resource_reservation_id TEXT;
ALTER TABLE study_sessions_v2 ADD CONSTRAINT study_guest_resource_source_shape_v1 CHECK(
 (participation_owner_kind='account' AND guest_resource_reservation_id IS NULL)
 OR (participation_owner_kind='guest' AND guest_resource_reservation_id IS NOT NULL));
ALTER TABLE study_sessions_v2 ADD CONSTRAINT study_guest_resource_exact_source_session_fk_v1
 FOREIGN KEY(guest_resource_reservation_id,participation_owner_id,session_id)
 REFERENCES guest_resource_session_reservations(reservation_id,source_owner_id,session_id);
-- Existing mandatory owner/kind FKs, exact item/review/command/audio relationships,
-- original start owner FK and every ordinary account/user/persona FK remain.
ALTER TABLE study_sessions_v2 ADD CONSTRAINT study_guest_disclosure_true_v1 CHECK(
 participation_owner_kind<>'guest' OR (guest_disclosure_accepted IS TRUE
  AND char_length(guest_disclosure_version) BETWEEN 1 AND 128
  AND guest_disclosure_version !~ '[[:space:][:cntrl:]]'));

-- RLS is enabled with a single restrictive AND gate and a permissive account
-- gate. Even a future permissive policy cannot expose guest rows to a raw role.
-- Owner bypass is INTENTIONAL for real controlled SECURITY DEFINER routines;
-- FORCE RLS would also reject the migration owner's legitimate guest routines.
DO $install_guest_row_security$
DECLARE relation_name TEXT;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY[
  'study_sessions_v2','study_review_items','study_session_items_v2',
  'study_spoken_answer_commands','learner_audio_artifacts'
 ] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('CREATE POLICY guest_raw_account_gate_v1 ON %I AS RESTRICTIVE FOR ALL TO PUBLIC
    USING(participation_owner_kind=''account'') WITH CHECK(participation_owner_kind=''account'')',relation_name);
  EXECUTE format('CREATE POLICY legacy_account_access_v1 ON %I AS PERMISSIVE FOR ALL TO PUBLIC
    USING(participation_owner_kind=''account'') WITH CHECK(participation_owner_kind=''account'')',relation_name);
 END LOOP;
 FOREACH relation_name IN ARRAY ARRAY['study_attempts_v2','study_presentations_v2','study_lesson_item_state_v2'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('CREATE POLICY guest_raw_account_child_gate_v1 ON %I AS RESTRICTIVE FOR ALL TO PUBLIC
    USING(EXISTS(SELECT 1 FROM study_session_items_v2 i WHERE i.session_item_id=%I.session_item_id
      AND i.participation_owner_kind=''account''))
    WITH CHECK(EXISTS(SELECT 1 FROM study_session_items_v2 i WHERE i.session_item_id=%I.session_item_id
      AND i.participation_owner_kind=''account''))',relation_name,relation_name,relation_name);
  EXECUTE format('CREATE POLICY legacy_account_child_access_v1 ON %I AS PERMISSIVE FOR ALL TO PUBLIC
    USING(EXISTS(SELECT 1 FROM study_session_items_v2 i WHERE i.session_item_id=%I.session_item_id
      AND i.participation_owner_kind=''account''))
    WITH CHECK(EXISTS(SELECT 1 FROM study_session_items_v2 i WHERE i.session_item_id=%I.session_item_id
      AND i.participation_owner_kind=''account''))',relation_name,relation_name,relation_name);
 END LOOP;
END $install_guest_row_security$;
-- RLS covers row CRUD, never TRUNCATE. Preserve every ordinary row privilege
-- while removing destructive bulk bypass from PUBLIC and all direct nonowners.
DO $deny_raw_guest_learning_truncate$
DECLARE relation_name TEXT; grantee_name TEXT;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY[
  'study_sessions_v2','study_review_items','study_session_items_v2',
  'study_spoken_answer_commands','learner_audio_artifacts',
  'study_attempts_v2','study_presentations_v2','study_lesson_item_state_v2'
 ] LOOP
  EXECUTE format('REVOKE TRUNCATE ON TABLE %I FROM PUBLIC',relation_name);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c
   CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid=to_regclass(relation_name) AND a.grantee<>0 AND a.grantee<>c.relowner
    AND a.privilege_type='TRUNCATE' LOOP
   EXECUTE format('REVOKE TRUNCATE ON TABLE %I FROM %I',relation_name,grantee_name);
  END LOOP;
 END LOOP;
END $deny_raw_guest_learning_truncate$;

CREATE FUNCTION map_controlled_guest_learning_source_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.account_id IS NOT NULL OR NEW.participation_owner_kind IS DISTINCT FROM 'guest'
   OR NEW.participation_owner_id IS NULL THEN
   RAISE EXCEPTION 'guest source shape required' USING ERRCODE='GP002'; END IF;
 -- INVOKER private reads occur only within a real controlled owner frame;
 -- ordinary raw guest INSERT remains denied by ACL and independently by RLS.
 IF NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=NEW.participation_owner_id
     AND kind='guest' AND state IN('empty','established')
     AND resolve_guest_empty_owner_root_v1(owner_id)=owner_id) THEN
   RAISE EXCEPTION 'canonical original guest source required' USING ERRCODE='GP002'; END IF;
 UPDATE participation_owners SET state='established'
   WHERE owner_id=NEW.participation_owner_id AND state='empty';
 RETURN NEW;
END $$;
DO $narrow_account_source_mapping$
DECLARE relation_name TEXT;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY[
  'study_sessions_v2','study_review_items','study_session_items_v2',
  'study_spoken_answer_commands','learner_audio_artifacts'
 ] LOOP
  EXECUTE format('DROP TRIGGER a00_existing_account_source_mapping_v1 ON %I',relation_name);
  EXECUTE format('CREATE TRIGGER a00_existing_account_source_mapping_v1 BEFORE INSERT ON %I
   FOR EACH ROW WHEN(NEW.account_id IS NOT NULL) EXECUTE FUNCTION map_existing_account_learning_source_v1()',relation_name);
  EXECUTE format('CREATE TRIGGER a00_controlled_guest_source_mapping_v1 BEFORE INSERT ON %I
   FOR EACH ROW WHEN(NEW.account_id IS NULL) EXECUTE FUNCTION map_controlled_guest_learning_source_v1()',relation_name);
 END LOOP;
END $narrow_account_source_mapping$;

-- Preserve the actual original account guard FUNCTION byte for byte. Scope its
-- existing trigger to account rows; separate guest guard handles the guest case.
DROP TRIGGER study_sessions_v2_activity_authority ON study_sessions_v2;
CREATE TRIGGER study_sessions_v2_activity_authority BEFORE INSERT OR UPDATE ON study_sessions_v2
 FOR EACH ROW WHEN(NEW.participation_owner_kind='account') EXECUTE FUNCTION guard_study_v2_activity_authority();

CREATE FUNCTION guard_controlled_guest_study_session_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation guest_participation_operations%ROWTYPE;
 reservation guest_resource_session_reservations%ROWTYPE;
BEGIN
 IF NEW.participation_owner_kind IS DISTINCT FROM 'guest' OR NEW.account_id IS NOT NULL
   OR NEW.persona_id IS NOT NULL OR NEW.guest_reward_mode IS DISTINCT FROM 'practice_only'
   OR NEW.guest_reward_terms IS NOT NULL OR NEW.guest_disclosure_accepted IS NOT TRUE
   OR NEW.telegram_practice_only IS NOT FALSE THEN
   RAISE EXCEPTION 'closed guest practice source required' USING ERRCODE='GP003'; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.community_id,NEW.post_id,NEW.audio_revision,NEW.lyrics_revision,NEW.learning_language,
      NEW.target_language,NEW.learner_band,NEW.study_profile_revision,NEW.source_set_revision,
      NEW.selection_policy_revision,NEW.qualification_policy_revision,NEW.timezone,
      NEW.language_profile_revision,NEW.created_at,NEW.expires_at,
      NEW.guest_reward_mode,NEW.guest_reward_terms,NEW.guest_start_operation_id,
      NEW.guest_disclosure_version,NEW.guest_disclosure_accepted,NEW.guest_resource_reservation_id)
    IS DISTINCT FROM ROW(OLD.community_id,OLD.post_id,OLD.audio_revision,OLD.lyrics_revision,OLD.learning_language,
      OLD.target_language,OLD.learner_band,OLD.study_profile_revision,OLD.source_set_revision,
      OLD.selection_policy_revision,OLD.qualification_policy_revision,OLD.timezone,
      OLD.language_profile_revision,OLD.created_at,OLD.expires_at,
      OLD.guest_reward_mode,OLD.guest_reward_terms,OLD.guest_start_operation_id,
      OLD.guest_disclosure_version,OLD.guest_disclosure_accepted,OLD.guest_resource_reservation_id) THEN
    RAISE EXCEPTION 'captured guest session admission is immutable' USING ERRCODE='GP003'; END IF;
  -- Do not recheck current public visibility, proof lease/revocation or resource
  -- liveness while recording an already accepted provider/grade checkpoint.
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT operation FROM guest_participation_operations WHERE operation_id=NEW.guest_start_operation_id;
 SELECT * INTO STRICT reservation FROM guest_resource_session_reservations WHERE reservation_id=NEW.guest_resource_reservation_id;
 IF ROW(operation.source_owner_id,operation.operation_kind,operation.idempotency_key,operation.request_hash,operation.resource_scope)
   IS DISTINCT FROM ROW(NEW.participation_owner_id,'study_start'::TEXT,NEW.idempotency_key,NEW.request_hash,
    guest_study_start_resource_scope_v1(NEW.community_id,NEW.post_id))
   OR operation.state NOT IN('reserved','completed')
   OR ROW(reservation.source_owner_id,reservation.operation_kind,reservation.session_id,reservation.idempotency_key,reservation.request_hash)
     IS DISTINCT FROM ROW(NEW.participation_owner_id,'study_start'::TEXT,NEW.session_id,NEW.idempotency_key,NEW.request_hash)
   OR reservation.state<>'active' OR reservation.reservation_expires_at<=clock_timestamp()
   OR NEW.created_at IS DISTINCT FROM reservation.created_at
   OR NEW.expires_at IS DISTINCT FROM reservation.reservation_expires_at
   OR NOT can_guest_access_activity_song_v1(NEW.community_id,NEW.post_id) THEN
   RAISE EXCEPTION 'captured guest start/resource source mismatch' USING ERRCODE='GP003'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER study_sessions_v2_controlled_guest_authority_v1 BEFORE INSERT OR UPDATE ON study_sessions_v2
 FOR EACH ROW WHEN(NEW.participation_owner_kind='guest') EXECUTE FUNCTION guard_controlled_guest_study_session_v1();

-- Exhaustive existing account/guest shape constraints are already installed by
--0249; new STRICT true disclosure and resource FK above close the guest branch.
-- All owner/kind columns remain NOT NULL. Nullable accounts are NEVER a source.
ALTER TABLE study_sessions_v2 ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE study_sessions_v2 ALTER COLUMN persona_id DROP NOT NULL;
ALTER TABLE study_review_items ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE study_session_items_v2 ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE study_spoken_answer_commands ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE learner_audio_artifacts ALTER COLUMN account_id DROP NOT NULL;

CREATE FUNCTION require_guest_learning_runtime_role_v1(p_runtime REGROLE)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE relation_name TEXT; table_owner OID; namespace_id OID;
BEGIN
 -- PostgreSQL17 SET reachability includes indirect and NOINHERIT memberships.
 -- Effective privileges of p_runtime alone cannot rule out explicit SET ROLE.
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=p_runtime)
   OR EXISTS(SELECT 1 FROM pg_roles candidate
     WHERE pg_has_role(p_runtime::OID,candidate.oid,'SET')
       AND (candidate.rolsuper OR candidate.rolbypassrls
         OR candidate.rolcreaterole OR candidate.rolreplication)) THEN
   RAISE EXCEPTION 'runtime row-security role unavailable' USING ERRCODE='42501'; END IF;
 FOREACH relation_name IN ARRAY ARRAY[
  'study_sessions_v2','study_review_items','study_session_items_v2',
  'study_spoken_answer_commands','learner_audio_artifacts',
  'study_attempts_v2','study_presentations_v2','study_lesson_item_state_v2'
 ] LOOP
  SELECT relowner,relnamespace INTO STRICT table_owner,namespace_id FROM pg_class WHERE oid=to_regclass(relation_name);
  -- Owner RLS exemption also follows inherited owner privileges, even when
  -- membership SET is FALSE. Retain conservative owner-membership exclusion.
  IF p_runtime::OID=table_owner OR pg_has_role(p_runtime::OID,table_owner,'MEMBER')
     OR EXISTS(SELECT 1 FROM pg_roles candidate
       WHERE pg_has_role(p_runtime::OID,candidate.oid,'SET')
         AND (candidate.oid=table_owner
           OR has_schema_privilege(candidate.oid,namespace_id,'CREATE')
           OR has_table_privilege(candidate.oid,to_regclass(relation_name),'TRUNCATE'))) THEN
    RAISE EXCEPTION 'runtime can bypass controlled guest rows' USING ERRCODE='42501'; END IF;
 END LOOP;
END $$;

DO $bind_guest_learning_row_guards$
DECLARE signature TEXT; grantee_name TEXT; trusted_schema TEXT:=current_schema();
BEGIN
 IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
   RAISE EXCEPTION 'trusted migration schema required'; END IF;
 FOREACH signature IN ARRAY ARRAY[
  'guest_study_start_resource_scope_v1(text,text)',
  'map_controlled_guest_learning_source_v1()',
  'guard_controlled_guest_study_session_v1()',
  'require_guest_learning_runtime_role_v1(regrole)'
 ] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
 IF pg_get_functiondef('guard_study_v2_activity_authority()'::regprocedure)
   IS DISTINCT FROM (SELECT definition FROM guest_row_original_account_guard_v1) THEN
   RAISE EXCEPTION 'original account authority function changed'; END IF;
END $bind_guest_learning_row_guards$;
-- No controlled guest start/read/answer procedure is installed here. Those must
-- own proof/resource/DB/provider/deletion transactions and only their actual
-- approved names receive runtime EXECUTE. Private runtime role check itself
-- remains ungranted, run by the coordinator during actual role binding.

-- Outside-source review amendment, not an applied migration or serving grant.
-- Adopt inside the same topology-first atomic row-admission transaction.
DO $pin_guest_deferred_closure$
DECLARE signature TEXT; expected_owner OID; trusted_schema TEXT; function_owner OID; grantee_name TEXT;
BEGIN
 SELECT c.relowner,n.nspname INTO STRICT expected_owner,trusted_schema
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.oid='participation_owners'::regclass;
 IF trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
  RAISE EXCEPTION 'trusted guest closure schema required'; END IF;
 -- Actual source inventory: 0248 alias/owner deferred closure (already SD in
 --0250), and0249 command/audio closure. Other selected Study references are
 -- native deferred FKs, whose RI machinery already bypasses RLS safely.
 FOREACH signature IN ARRAY ARRAY['validate_guest_alias_state_v1()', 'validate_study_command_audio_source_v1()'] LOOP
  SELECT proowner INTO STRICT function_owner FROM pg_proc WHERE oid=signature::regprocedure;
  IF function_owner<>expected_owner THEN RAISE EXCEPTION 'deferred closure owner differs'; END IF;
  EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER',signature);
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $pin_guest_deferred_closure$;
-- Invoker immediate guards retain their real controlled owner frame; do not
-- promote every invoker function. Original account authority body is untouched.
