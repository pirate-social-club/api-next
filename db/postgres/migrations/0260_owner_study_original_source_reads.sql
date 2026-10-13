-- Controlled original-source and dispatch reads; no runtime role grants.
SELECT pg_advisory_xact_lock(83000003,1);
-- Private ordinary-Account LIVE read/JSON bridge proposal. No provisioning,
-- principal/persona mint, alias canonicalization, scope inference or serving grant.
-- Verified ordinary canonical account/sessionBinding comes from transport and
-- is matched again by the bound platform composition; JSON is not token proof.
CREATE FUNCTION read_original_account_study_source_v1(p_access JSONB,p_community TEXT,p_session TEXT,p_item TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE sess study_sessions_v2%ROWTYPE; original_owner TEXT;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 IF p_access IS NULL OR jsonb_typeof(p_access) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(p_access))<>3 OR NOT(p_access ?& ARRAY['kind','accountId','sessionBinding'])
  OR p_access->>'kind' IS DISTINCT FROM 'account' OR jsonb_typeof(p_access->'accountId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p_access->'sessionBinding') IS DISTINCT FROM 'string' OR p_access->>'sessionBinding' !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'verified ordinary Account context required' USING ERRCODE='GP002'; END IF;
 SELECT * INTO sess FROM study_sessions_v2 WHERE session_id=p_session AND community_id=p_community
  AND participation_owner_kind='account' AND account_id=p_access->>'accountId';
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- ORIGINAL map helper only: never provision_account_participation_owner_v1,
 -- resolve/reparent historical aliases or infer persona from a body/token.
 original_owner:=require_existing_account_participation_owner_v1(sess.account_id);
 IF original_owner IS DISTINCT FROM sess.participation_owner_id
  OR NOT active_activity_persona(sess.account_id,sess.persona_id,sess.community_id)
  OR NOT can_account_access_activity_song(sess.account_id,sess.community_id,sess.post_id) THEN RETURN NULL; END IF;
 IF p_item IS NOT NULL AND NOT EXISTS(SELECT 1 FROM study_session_items_v2 WHERE session_item_id=p_item
  AND session_id=sess.session_id AND participation_owner_id=original_owner AND account_id=sess.account_id
  AND participation_owner_kind='account') THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('kind','account','ownerId',original_owner,'accountId',sess.account_id,'personaId',sess.persona_id);
END $$;

CREATE FUNCTION read_original_account_study_answer_receipt_v1(p_access JSONB,p_community TEXT,p_session TEXT,p_item TEXT,p_key TEXT,p_hash TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source JSONB; attempt_id TEXT;
BEGIN
 source:=read_original_account_study_source_v1(p_access,p_community,p_session,p_item);
 IF source IS NULL THEN RETURN NULL; END IF;
 SELECT a.attempt_id INTO attempt_id FROM study_attempts_v2 a JOIN study_session_items_v2 i USING(session_item_id)
  WHERE i.session_id=p_session AND i.session_item_id=p_item AND i.participation_owner_id=source->>'ownerId'
   AND a.idempotency_key=p_key AND a.request_hash=p_hash AND a.submission_kind='single_select';
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('source',source,'attemptId',attempt_id);
END $$;

DO $bind_original_account_study_read_leaves$
DECLARE signature TEXT; schema_name TEXT; owner_id OID; grantee_name TEXT;
BEGIN
 SELECT n.nspname,c.relowner INTO STRICT schema_name,owner_id FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.oid='participation_owners'::regclass;
 IF schema_name='pg_catalog' OR schema_name ~ '^pg_temp' THEN RAISE EXCEPTION 'trusted Account source namespace required'; END IF;
 FOREACH signature IN ARRAY ARRAY['read_original_account_study_source_v1(jsonb,text,text,text)',
  'read_original_account_study_answer_receipt_v1(jsonb,text,text,text,text,text)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=signature::regprocedure AND proowner=owner_id) THEN
   RAISE EXCEPTION 'approved Account source owner required'; END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $bind_original_account_study_read_leaves$;

-- Private pre-I/O candidate context; no source/raw-table/paid-helper grant.
-- Reuses the actual controlled context validator and source/lease checks.
-- Current fence is observational. Actual NEW reserve rechecks source/component,
-- current deletion fence and resource reservation under its existing locks.
CREATE FUNCTION read_owner_guest_answer_source_v1(p_access JSONB,p_community TEXT,p_session TEXT,p_item TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE sess study_sessions_v2%ROWTYPE; rsv guest_resource_session_reservations%ROWTYPE;
BEGIN
 PERFORM require_guest_study_composition_v1();
 SELECT * INTO sess FROM study_sessions_v2 WHERE session_id=p_session AND community_id=p_community
  AND participation_owner_kind='guest';
 IF NOT FOUND THEN RAISE EXCEPTION 'original guest lesson unavailable' USING ERRCODE='GP010'; END IF;
 SELECT * INTO STRICT rsv FROM guest_resource_session_reservations WHERE reservation_id=sess.guest_resource_reservation_id;
 PERFORM lock_guest_resource_budget_v1(sess.participation_owner_id,rsv.edge_fingerprint);
 PERFORM require_guest_study_learning_access_v1(p_access,sess.participation_owner_id);
 IF NOT EXISTS(SELECT 1 FROM study_session_items_v2 WHERE session_id=p_session AND session_item_id=p_item
  AND participation_owner_kind='guest' AND participation_owner_id=sess.participation_owner_id) THEN
  RAISE EXCEPTION 'original guest item unavailable' USING ERRCODE='GP010'; END IF;
 -- Publication/current-card/session-expiry checks apply to NEW writes in the
 -- mutation; this source read cannot suppress an immutable completed replay.
 RETURN jsonb_build_object('kind','guest','ownerId',sess.participation_owner_id);
END $$;

CREATE FUNCTION read_owner_guest_spoken_dispatch_context_v1(p_access JSONB,p_community TEXT,p_session TEXT,p_item TEXT,p_key TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE context JSONB; sess study_sessions_v2%ROWTYPE; fence learner_audio_owner_fences%ROWTYPE;
BEGIN
 context:=read_guest_spoken_context_v1(p_access,p_community,p_session,p_item,p_key);
 SELECT * INTO STRICT sess FROM study_sessions_v2 WHERE session_id=p_session AND community_id=p_community
  AND participation_owner_kind='guest' AND participation_owner_id=context->'source'->>'ownerId';
 IF sess.guest_resource_reservation_id IS NULL OR NOT EXISTS(SELECT 1 FROM guest_resource_session_reservations r
  WHERE r.reservation_id=sess.guest_resource_reservation_id AND r.source_owner_id=sess.participation_owner_id AND r.session_id=sess.session_id) THEN
  RAISE EXCEPTION 'original guest session resource required' USING ERRCODE='GP006'; END IF;
 SELECT * INTO fence FROM learner_audio_owner_fences WHERE owner_id=sess.participation_owner_id;
 IF FOUND AND fence.active_delete_command_id IS NOT NULL THEN
  RAISE EXCEPTION 'learner audio deletion in progress' USING ERRCODE='GP009'; END IF;
 -- Absent fence has the actual native creation default revision=0. The reserve
 -- performs that guarded creation before comparing this value. No fence write
 -- or paid authority is created by this read, and no claim covers later drift.
 RETURN context||jsonb_build_object('resourceReservationId',sess.guest_resource_reservation_id,
  'deletionFenceRevision',COALESCE(fence.revision,0));
END $$;

CREATE FUNCTION read_owner_guest_answer_operation_v1(p_access JSONB,p_source TEXT,p_operation JSONB,
 p_community TEXT,p_session TEXT,p_item TEXT,p_attempt INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE sess study_sessions_v2%ROWTYPE; rsv guest_resource_session_reservations%ROWTYPE; original guest_participation_operations%ROWTYPE;
BEGIN
 PERFORM require_guest_study_composition_v1();
 PERFORM validate_guest_resource_operation_v1(p_source,p_operation,'study_answer');
 SELECT * INTO sess FROM study_sessions_v2 WHERE session_id=p_session AND community_id=p_community
  AND participation_owner_kind='guest' AND participation_owner_id=p_source;
 IF NOT FOUND THEN RAISE EXCEPTION 'original guest lesson unavailable' USING ERRCODE='GP010'; END IF;
 SELECT * INTO STRICT rsv FROM guest_resource_session_reservations WHERE reservation_id=sess.guest_resource_reservation_id;
 PERFORM lock_guest_resource_budget_v1(p_source,rsv.edge_fingerprint);
 PERFORM require_guest_study_learning_access_v1(p_access,p_source);
 SELECT * INTO original FROM guest_participation_operations WHERE source_owner_id=p_source
  AND operation_kind='study_answer' AND idempotency_key=p_operation->>'idempotencyKey';
 IF NOT FOUND THEN RETURN jsonb_build_object('state','absent'); END IF;
 IF ROW(original.request_hash,original.resource_scope) IS DISTINCT FROM ROW(p_operation->>'requestHash',
  guest_study_answer_resource_scope_v1(p_community,p_session,p_item,p_attempt,'spoken')) THEN
  RAISE EXCEPTION 'original spoken request changed' USING ERRCODE='GP005'; END IF;
 RETURN jsonb_build_object('state',original.state,'operationId',original.operation_id,'result',original.result_snapshot);
END $$;

DO $bind_guest_dispatch_context$
DECLARE schema_name TEXT; owner_id OID; signature TEXT; grantee_name TEXT;
BEGIN
 SELECT n.nspname,c.relowner INTO STRICT schema_name,owner_id FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.oid='participation_owners'::regclass;
 IF schema_name='pg_catalog' OR schema_name ~ '^pg_temp' THEN RAISE EXCEPTION 'approved private dispatch context namespace required'; END IF;
 FOREACH signature IN ARRAY ARRAY['read_owner_guest_spoken_dispatch_context_v1(jsonb,text,text,text,text)',
  'read_owner_guest_answer_operation_v1(jsonb,text,jsonb,text,text,text,integer)',
  'read_owner_guest_answer_source_v1(jsonb,text,text,text)'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=signature::regprocedure AND proowner=owner_id) THEN RAISE EXCEPTION 'approved private dispatch context owner required'; END IF;
 EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,schema_name);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
  CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
  WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
 END LOOP;
 END LOOP;
END $bind_guest_dispatch_context$;
