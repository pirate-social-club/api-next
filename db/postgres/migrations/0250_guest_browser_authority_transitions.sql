-- Private guest authority transitions. Runtime endpoints remain disabled.
-- Requires the owner foundation and populated learning-history preservation.
-- Private SQL result envelopes below are decoded/mapped by platform-cf to frozen
-- GuestAuthorityStore, never sent straight to browsers. No contract/port edit.
-- Trusted adapter metadata: ids below MUST come exclusively from the authenticated
-- BrowserParticipationContext. They are NOT HTTP/body-provided ownership proof.
-- Runtime is trusted application code; end users have no SQL role. Grant only these
-- functions to the reviewed server role, never raw table DML or helper EXECUTE.
-- SQL rechecks origin, original provenance, state, root and expiry after locks.
-- Controller separately enforces ALL parsed carried cookies (proved or not)
-- and header byte caps BEFORE issuance. Proved-ID count is not that parser cap.
-- No client GUC, supplied boolean, erased TS brand, or current_user trick grants
-- privileges. The actual migration-owner SECURITY DEFINER frame performs DML.
-- Closed INTERNAL SQLSTATE -> existing GuestParticipationStoreRejected.reason:
-- GP001 proof-revoked; GP002 owner-mismatch; GP003 authority-conflict;
-- GP004 credential-cleanup-required; GP005 idempotency-conflict.
-- ControlPlaneStatementFailed exposes safe sqlState/constraint only. The adapter
-- matches these exact codes, NEVER message text/raw PG cause. All other SQLSTATEs
-- (including existing guard P0001, validation 22023, FK/unique and unexpected
-- strict-select failures) remain internal statement failures, fail closed, and
-- are not guessed to be semantic rejections. Commit/rollback unknown bypasses
-- statement mapping and preserves frozen transaction uncertainty classification.

-- Deferred closure runs after the transition's definer frame returns. It needs
-- its own pinned definer authority, without exposing private table privileges.
ALTER FUNCTION validate_guest_alias_state_v1() SECURITY DEFINER;

-- Positive, private learning-only attestation; relation absence alone is not
-- evidence of financial emptiness. Accounting must replace this predicate and
-- attestation atomically with its accepted full liability/participation closure.
CREATE TABLE guest_learning_schema_phase (
  singleton BOOLEAN PRIMARY KEY CHECK(singleton),
  phase TEXT NOT NULL CHECK(phase='practice_only_owner_history_v1')
);
INSERT INTO guest_learning_schema_phase VALUES(TRUE,'practice_only_owner_history_v1');
DO $protect_guest_schema_phase$
DECLARE grantee_name TEXT;
BEGIN
  REVOKE ALL ON guest_learning_schema_phase FROM PUBLIC;
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
    FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='guest_learning_schema_phase'::regclass AND a.grantee<>0 AND a.grantee<>c.relowner
  LOOP EXECUTE format('REVOKE ALL ON guest_learning_schema_phase FROM %I',grantee_name); END LOOP;
END $protect_guest_schema_phase$;

CREATE FUNCTION require_guest_practice_only_schema_phase_v1()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE trusted_namespace OID; trusted_owner OID;
BEGIN
  SELECT relnamespace,relowner INTO STRICT trusted_namespace,trusted_owner
    FROM pg_class WHERE oid='participation_owners'::regclass;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='guest_learning_schema_phase'::regclass
      AND relnamespace=trusted_namespace AND relowner=trusted_owner)
    OR (SELECT count(*) FROM guest_learning_schema_phase
      WHERE singleton AND phase='practice_only_owner_history_v1')<>1
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
          'study_spoken_answer_commands','learner_audio_artifacts'))
    OR EXISTS(SELECT 1 FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE fk.contype='f' AND fk.confrelid=ANY(ARRAY[
          'participation_owners'::regclass,'guest_credentials'::regclass,
          'guest_empty_owner_aliases'::regclass,'participation_owner_clocks'::regclass,
          'guest_learning_preferences'::regclass,'guest_participation_operations'::regclass,
          'guest_secret_issuance_operations'::regclass,'guest_attachment_intents'::regclass])
        AND c.relnamespace=trusted_namespace AND c.relname NOT IN (
          'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks',
          'guest_learning_preferences','guest_participation_operations',
          'guest_secret_issuance_operations','guest_attachment_intents',
          'study_sessions_v2','study_review_items','study_session_items_v2',
          'study_spoken_answer_commands','learner_audio_artifacts'))
    OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=trusted_namespace
      AND relname IN ('guest_owner_associations','participation_eligibility_decisions',
        'megapot_owner_shares','megapot_owner_snapshot_leaves','megapot_owner_allocations',
        'reward_credit_persona_bindings','reward_credit_recipient_selections'))
  THEN RAISE EXCEPTION 'owner history closure unavailable' USING ERRCODE='GP003'; END IF;
END $$;

CREATE FUNCTION lock_guest_authority_sources_v1(expected_origin TEXT, proved_ids TEXT[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF expected_origin IS NULL OR expected_origin NOT LIKE 'https://%'
     OR octet_length(expected_origin)>2048 OR proved_ids IS NULL
     OR cardinality(proved_ids)>4
     OR EXISTS(SELECT 1 FROM unnest(proved_ids) id WHERE id IS NULL OR id !~ '^[A-Za-z0-9_-]{21}[AQgw]$')
     OR cardinality(proved_ids)<>(SELECT count(DISTINCT id) FROM unnest(proved_ids) id)
  THEN RAISE EXCEPTION 'invalid trusted proof context' USING ERRCODE='22023'; END IF;
  -- The caller taking EXCLUSIVE first (bootstrap) never upgrades a shared lock.
  -- Other operations keep aliases stable for their complete transaction.
  PERFORM pg_advisory_xact_lock_shared(83000003,1);
  PERFORM 1 FROM participation_owners o WHERE o.owner_id IN (
    WITH RECURSIVE component(owner_id) AS (
      SELECT DISTINCT resolve_guest_empty_owner_root_v1(c.owner_id)
        FROM guest_credentials c WHERE c.credential_id=ANY(proved_ids) AND c.origin=expected_origin
      UNION
      SELECT a.source_owner_id FROM guest_empty_owner_aliases a
        JOIN component x ON a.canonical_owner_id=x.owner_id
    ) SELECT owner_id FROM component
  ) ORDER BY o.owner_id COLLATE "C" FOR UPDATE;
  -- Owner component before all credentials; deterministic order prevents
  -- cross-proof rotation/confirmation locks from reversing the owner order.
  PERFORM 1 FROM guest_credentials c WHERE c.owner_id IN (
    WITH RECURSIVE component(owner_id) AS (
      SELECT DISTINCT resolve_guest_empty_owner_root_v1(c0.owner_id)
        FROM guest_credentials c0 WHERE c0.credential_id=ANY(proved_ids) AND c0.origin=expected_origin
      UNION SELECT a.source_owner_id FROM guest_empty_owner_aliases a
        JOIN component x ON a.canonical_owner_id=x.owner_id
    ) SELECT owner_id FROM component
  ) ORDER BY c.credential_id COLLATE "C" FOR UPDATE;
END $$;

CREATE FUNCTION guest_authority_metadata_v1(expected_origin TEXT, proved_ids TEXT[], selected_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE selected JSONB; metadata JSONB; selected_state TEXT; selected_until TIMESTAMPTZ;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
      'owner_id',resolve_guest_empty_owner_root_v1(c.owner_id),'credential_id',c.credential_id,
      'credential_state',c.state,'session_until',CASE WHEN c.session_until IS NULL THEN NULL
        ELSE to_char(c.session_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ) ORDER BY c.credential_id COLLATE "C") INTO metadata
    FROM guest_credentials c WHERE c.origin=expected_origin AND c.credential_id=ANY(proved_ids);
  IF selected_id IS NOT NULL THEN
    IF NOT selected_id=ANY(proved_ids) THEN RAISE EXCEPTION 'selected proof missing' USING ERRCODE='22023'; END IF;
    SELECT state,session_until INTO selected_state,selected_until FROM guest_credentials
      WHERE credential_id=selected_id AND origin=expected_origin;
    SELECT value INTO selected FROM jsonb_array_elements(COALESCE(metadata,'[]'::JSONB))
      WHERE value->>'credential_id'=selected_id;
  END IF;
  RETURN jsonb_build_object('object','guest_authority','state',CASE
    WHEN selected IS NULL THEN 'absent'
    WHEN selected_state IN ('pending_bootstrap','pending_successor') THEN 'pending'
    WHEN selected_state='confirmed' AND selected_until>clock_timestamp() THEN 'confirmed'
    ELSE 'recovery_required' END,
    'selected',selected,'proved_credentials',COALESCE(metadata,'[]'::JSONB),'pointer_repair',NULL);
END $$;

CREATE FUNCTION reject_guest_copresent_established_conflict_v1(
  expected_origin TEXT,proved_ids TEXT[],selected_owner TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM guest_credentials c JOIN participation_owners root
      ON root.owner_id=resolve_guest_empty_owner_root_v1(c.owner_id)
      WHERE c.origin=expected_origin AND c.credential_id=ANY(proved_ids)
        AND c.state='confirmed' AND root.state='established' AND root.owner_id<>selected_owner)
  THEN RAISE EXCEPTION 'authority-conflict' USING ERRCODE='GP003'; END IF;
END $$;

-- issuePending: its request hash is canonical request identity, NEVER the new
-- random digest/owner/credential/operation ID. Fresh random draws may differ on
-- retries, but cannot change the immutable natural issuance key.
CREATE FUNCTION guest_authority_issue_operation_v1(expected_operation_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE operation guest_participation_operations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT operation FROM guest_participation_operations
    WHERE operation_id=expected_operation_id FOR SHARE;
  IF operation.state<>'completed'
     OR operation.operation_kind NOT IN ('bootstrap_issue','credential_rotate') THEN
    RAISE EXCEPTION 'invalid guest issuance operation envelope' USING ERRCODE='22023';
  END IF;
  -- Original immutable receipt identity, even if its source later became aliased_empty.
  -- No current root lookup, synthetic pending/abort, raw digest or secret.
  RETURN jsonb_build_object(
    'sourceOwnerId',operation.source_owner_id,
    'kind',operation.operation_kind,
    'idempotencyKey',operation.idempotency_key,
    'requestHash',operation.request_hash);
END $$;

CREATE FUNCTION issue_guest_pending_v1(
  expected_origin TEXT,proved_ids TEXT[],selected_id TEXT,
  issuance_key TEXT,issuance_request_hash TEXT,new_operation_id TEXT,
  new_owner_id TEXT,new_credential_id TEXT,new_digest TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE prior guest_secret_issuance_operations%ROWTYPE;
  prior_credential guest_credentials%ROWTYPE; selected_credential guest_credentials%ROWTYPE;
  selected_root TEXT; at_time TIMESTAMPTZ; authority JSONB; snapshot JSONB;
BEGIN
  -- Serialize bootstrap natural issuance lookup before any owner/component row
  -- locks or replacement owner creation. No unbounded hash-identity locks.
  PERFORM pg_advisory_xact_lock(83000003,1);
  PERFORM lock_guest_authority_sources_v1(expected_origin,proved_ids);
  IF selected_id IS NOT NULL AND NOT selected_id=ANY(proved_ids) THEN
    RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
  SELECT * INTO prior FROM guest_secret_issuance_operations WHERE origin=expected_origin
    AND issuance_kind='bootstrap' AND resource_scope=expected_origin AND idempotency_key=issuance_key;
  IF FOUND THEN
    IF prior.request_hash<>issuance_request_hash THEN RAISE EXCEPTION 'idempotency-conflict' USING ERRCODE='GP005'; END IF;
    IF NOT prior.credential_id=ANY(proved_ids) THEN
      -- No unproved owner/credential metadata and no cookie: hash-only receipt
      -- recovery cannot manufacture the originally issued secret.
      RETURN jsonb_build_object('state','issuance_requires_restart');
    END IF;
    SELECT * INTO STRICT prior_credential FROM guest_credentials
      WHERE credential_id=prior.credential_id AND origin=expected_origin;
    IF selected_id IS NOT NULL THEN
      SELECT * INTO STRICT selected_credential FROM guest_credentials
        WHERE credential_id=selected_id AND origin=expected_origin;
      IF resolve_guest_empty_owner_root_v1(selected_credential.owner_id)<>
         resolve_guest_empty_owner_root_v1(prior_credential.owner_id) THEN
        -- Even a proved historical issuance cannot silently switch an explicitly
        -- selected different empty owner to its own authority. Same effective
        -- source after genuine empty aliasing is permitted, without reparenting.
        RAISE EXCEPTION 'owner-mismatch' USING ERRCODE='GP002';
      END IF;
    END IF;
    IF prior_credential.state='revoked' THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
    IF prior_credential.state='pending_bootstrap' AND prior_credential.pending_expires_at<=clock_timestamp()
      THEN RETURN jsonb_build_object('state','issuance_requires_restart'); END IF;
    PERFORM reject_guest_copresent_established_conflict_v1(expected_origin,proved_ids,
      resolve_guest_empty_owner_root_v1(prior_credential.owner_id));
    RETURN jsonb_build_object('state','completed','operation_id',prior.operation_id,
      'operation',guest_authority_issue_operation_v1(prior.operation_id),
      'authority',guest_authority_metadata_v1(expected_origin,proved_ids,prior.credential_id),'cookie_effects','[]'::JSONB);
  END IF;
  IF selected_id IS NOT NULL THEN
    SELECT * INTO STRICT selected_credential FROM guest_credentials WHERE credential_id=selected_id AND origin=expected_origin;
    selected_root := resolve_guest_empty_owner_root_v1(selected_credential.owner_id);
    PERFORM reject_guest_copresent_established_conflict_v1(expected_origin,proved_ids,selected_root);
    IF selected_credential.state='confirmed' OR
      (selected_credential.state='pending_bootstrap' AND selected_credential.pending_expires_at>clock_timestamp()) THEN
      -- Record the accepted same-key existing-authority command so the frozen
      -- DurableParticipationOutcome has a real immutable operation/outcome,
      -- rather than inventing an unrepresentable existing_authority variant.
      at_time := clock_timestamp();
      authority := guest_authority_metadata_v1(expected_origin,proved_ids,selected_id);
      INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,
          idempotency_key,request_hash,state,result_snapshot,created_at,resolved_at)
        VALUES(new_operation_id,selected_root,'bootstrap_issue',expected_origin,issuance_key,issuance_request_hash,
          'completed',jsonb_build_object('authority',authority),at_time,at_time);
      INSERT INTO guest_secret_issuance_operations(origin,issuance_kind,resource_scope,idempotency_key,request_hash,
          source_owner_id,credential_id,credential_source_owner_id,operation_id,created_at)
        VALUES(expected_origin,'bootstrap',expected_origin,issuance_key,issuance_request_hash,
          selected_root,selected_id,selected_credential.owner_id,new_operation_id,at_time);
      RETURN jsonb_build_object('state','completed','operation_id',new_operation_id,
      'operation',guest_authority_issue_operation_v1(new_operation_id),
        'authority',authority,'cookie_effects','[]'::JSONB);
    END IF;
    IF selected_credential.state='revoked' THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
    IF selected_credential.state='pending_successor' THEN RAISE EXCEPTION 'authority-conflict' USING ERRCODE='GP003'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM guest_credentials c JOIN participation_owners root
      ON root.owner_id=resolve_guest_empty_owner_root_v1(c.owner_id)
      WHERE c.origin=expected_origin AND c.credential_id=ANY(proved_ids)
        AND c.state='confirmed' AND root.state='established')
  THEN RAISE EXCEPTION 'authority-conflict' USING ERRCODE='GP003'; END IF;
  IF cardinality(proved_ids)>=4 THEN RAISE EXCEPTION 'credential-cleanup-required' USING ERRCODE='GP004'; END IF;
-- Fresh restart creates only
  -- a new empty pending candidate. Existing sources/history remain immutable.
  at_time := clock_timestamp();
  INSERT INTO participation_owners(owner_id,kind,guest_origin,state,created_at)
    VALUES(new_owner_id,'guest',expected_origin,'empty',at_time);
  INSERT INTO guest_credentials(credential_id,owner_id,origin,secret_digest,state,created_at,pending_expires_at)
    VALUES(new_credential_id,new_owner_id,expected_origin,new_digest,'pending_bootstrap',at_time,at_time+INTERVAL '15 minutes');
  authority := guest_authority_metadata_v1(expected_origin,proved_ids||ARRAY[new_credential_id],new_credential_id);
  snapshot := jsonb_build_object('authority',authority);
  INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,
      idempotency_key,request_hash,state,result_snapshot,created_at,resolved_at)
    VALUES(new_operation_id,new_owner_id,'bootstrap_issue',expected_origin,issuance_key,issuance_request_hash,
      'completed',snapshot,at_time,at_time);
  INSERT INTO guest_secret_issuance_operations(origin,issuance_kind,resource_scope,idempotency_key,request_hash,
      source_owner_id,credential_id,credential_source_owner_id,operation_id,created_at)
    VALUES(expected_origin,'bootstrap',expected_origin,issuance_key,issuance_request_hash,
      new_owner_id,new_credential_id,new_owner_id,new_operation_id,at_time);
  RETURN jsonb_build_object('state','completed','operation_id',new_operation_id,
      'operation',guest_authority_issue_operation_v1(new_operation_id),'authority',authority,
    'cookie_effects',jsonb_build_array(jsonb_build_object('kind','credential','action','issue','credentialId',new_credential_id)));
END $$;

-- Caller holds EXCLUSIVE topology FIRST and every reverse-alias component.
-- All five history families use immutable original source owners. Inspect the
-- complete component, not only its root. Financial composition is unavailable
-- until accounting supplies an independently accepted full history closure.
CREATE FUNCTION converge_proved_empty_guest_sources_v1(expected_origin TEXT,proved_ids TEXT[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE roots TEXT[]; component_ids TEXT[]; canonical TEXT; source_id TEXT;
BEGIN
  SELECT array_agg(DISTINCT resolve_guest_empty_owner_root_v1(c.owner_id)) INTO roots
    FROM guest_credentials c WHERE c.credential_id=ANY(proved_ids) AND c.origin=expected_origin
      AND (c.state='confirmed' OR
        (c.state IN ('pending_bootstrap','pending_successor') AND c.pending_expires_at>clock_timestamp()));
  IF COALESCE(cardinality(roots),0)<=1 THEN RETURN; END IF;
  PERFORM require_guest_practice_only_schema_phase_v1();
  WITH RECURSIVE component(owner_id) AS (
    SELECT unnest(roots)
    UNION SELECT a.source_owner_id FROM guest_empty_owner_aliases a
      JOIN component c ON a.canonical_owner_id=c.owner_id
  ) SELECT array_agg(owner_id ORDER BY owner_id COLLATE "C") INTO component_ids FROM component;
  IF EXISTS(SELECT 1 FROM study_sessions_v2 WHERE participation_owner_id=ANY(component_ids))
    OR EXISTS(SELECT 1 FROM study_review_items WHERE participation_owner_id=ANY(component_ids))
    OR EXISTS(SELECT 1 FROM study_session_items_v2 WHERE participation_owner_id=ANY(component_ids))
    OR EXISTS(SELECT 1 FROM study_spoken_answer_commands WHERE participation_owner_id=ANY(component_ids))
    OR EXISTS(SELECT 1 FROM learner_audio_artifacts WHERE participation_owner_id=ANY(component_ids))
  THEN RAISE EXCEPTION 'authority-conflict' USING ERRCODE='GP003'; END IF;
  IF EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=ANY(roots) AND state<>'empty') THEN
    RAISE EXCEPTION 'authority-conflict' USING ERRCODE='GP003'; END IF;
  IF EXISTS(SELECT 1 FROM guest_participation_operations operation
      JOIN participation_owners source_owner ON source_owner.owner_id=operation.source_owner_id
      WHERE operation.operation_kind='study_start' AND operation.state<>'known_aborted'
        AND CASE WHEN source_owner.kind='guest' THEN
          resolve_guest_empty_owner_root_v1(operation.source_owner_id) END=ANY(roots))
     OR EXISTS(SELECT 1 FROM guest_attachment_intents intent
      WHERE intent.state IN ('awaiting_account','awaiting_confirmation') AND intent.expires_at>clock_timestamp()
        AND resolve_guest_empty_owner_root_v1(intent.owner_id)=ANY(roots))
  THEN RAISE EXCEPTION 'authority-conflict' USING ERRCODE='GP003'; END IF;
  SELECT owner_id INTO STRICT canonical FROM participation_owners WHERE owner_id=ANY(roots)
    ORDER BY created_at,owner_id COLLATE "C" LIMIT 1;
  FOR source_id IN SELECT owner_id FROM participation_owners WHERE owner_id=ANY(roots) AND owner_id<>canonical
      ORDER BY owner_id COLLATE "C" LOOP
    INSERT INTO guest_empty_owner_aliases(source_owner_id,canonical_owner_id,origin,created_at)
      VALUES(source_id,canonical,expected_origin,clock_timestamp());
    UPDATE participation_owners SET state='aliased_empty' WHERE owner_id=source_id;
  END LOOP;
END $$;

CREATE FUNCTION confirm_guest_pending_v1(
  expected_origin TEXT,proved_ids TEXT[],selected_id TEXT,expected_owner_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE credential guest_credentials%ROWTYPE; root_id TEXT; at_time TIMESTAMPTZ;
BEGIN
  -- Confirmation can canonically converge empty proof components. Exclusive
  -- topology is acquired BEFORE any shared helper or component/credential row.
  PERFORM pg_advisory_xact_lock(83000003,1);
  PERFORM lock_guest_authority_sources_v1(expected_origin,proved_ids);
  IF selected_id IS NULL OR NOT selected_id=ANY(proved_ids) THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
  SELECT * INTO STRICT credential FROM guest_credentials WHERE credential_id=selected_id AND origin=expected_origin;
  root_id := resolve_guest_empty_owner_root_v1(credential.owner_id);
  IF root_id<>expected_owner_id THEN RAISE EXCEPTION 'owner-mismatch' USING ERRCODE='GP002'; END IF;
  PERFORM reject_guest_copresent_established_conflict_v1(expected_origin,proved_ids,root_id);
  IF credential.predecessor_id IS NOT NULL OR credential.state NOT IN ('pending_bootstrap','confirmed')
    THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
  IF credential.state='confirmed' THEN
    -- Natural key (origin, credentialId) replay: no UPDATE, secret, cookie or lease renewal.
    RETURN jsonb_build_object('authority',guest_authority_metadata_v1(expected_origin,proved_ids,selected_id),
      'cookie_effects','[]'::JSONB);
  END IF;
  at_time := clock_timestamp();
  IF credential.pending_expires_at<=at_time THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
  -- Initial confirmation only. Confirmed replay never aliases an owner.
  -- Expected source equality was checked before convergence. Only genuinely
  -- empty components converge; original proof provenance never changes.
  PERFORM converge_proved_empty_guest_sources_v1(expected_origin,proved_ids);
  UPDATE guest_credentials SET state='confirmed',confirmed_at=at_time,session_until=at_time+INTERVAL '1 hour'
    WHERE credential_id=selected_id;
  RETURN jsonb_build_object('authority',guest_authority_metadata_v1(expected_origin,proved_ids,selected_id),
    'cookie_effects','[]'::JSONB);
END $$;

CREATE FUNCTION renew_guest_authority_v1(
  expected_origin TEXT,proved_ids TEXT[],selected_id TEXT,expected_owner_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE credential guest_credentials%ROWTYPE; at_time TIMESTAMPTZ;
BEGIN
  PERFORM lock_guest_authority_sources_v1(expected_origin,proved_ids);
  IF selected_id IS NULL OR NOT selected_id=ANY(proved_ids) THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
  SELECT * INTO STRICT credential FROM guest_credentials WHERE credential_id=selected_id AND origin=expected_origin;
  IF resolve_guest_empty_owner_root_v1(credential.owner_id)<>expected_owner_id THEN RAISE EXCEPTION 'owner-mismatch' USING ERRCODE='GP002'; END IF;
  IF credential.state<>'confirmed' THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
  -- Recovery has NO age test. A deliberate renewal after expired learning lease
  -- extends only the current credential's lease and refreshes its carried value.
  at_time := clock_timestamp();
  IF credential.session_until<at_time+INTERVAL '1 hour' THEN
    UPDATE guest_credentials SET session_until=at_time+INTERVAL '1 hour' WHERE credential_id=selected_id;
  END IF;
  RETURN jsonb_build_object('authority',guest_authority_metadata_v1(expected_origin,proved_ids,selected_id),
    'cookie_effects',jsonb_build_array(jsonb_build_object('kind','credential','action','refresh','credentialId',selected_id)));
END $$;

CREATE FUNCTION issue_guest_rotation_v1(
  expected_origin TEXT,proved_ids TEXT[],expected_predecessor_credential_id TEXT,expected_owner_id TEXT,
  issuance_key TEXT,issuance_request_hash TEXT,new_operation_id TEXT,new_credential_id TEXT,new_digest TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE predecessor guest_credentials%ROWTYPE; prior guest_secret_issuance_operations%ROWTYPE;
  successor guest_credentials%ROWTYPE; existing_operation guest_participation_operations%ROWTYPE;
  at_time TIMESTAMPTZ; authority JSONB;
BEGIN
  PERFORM lock_guest_authority_sources_v1(expected_origin,proved_ids);
  IF expected_predecessor_credential_id IS NULL OR NOT expected_predecessor_credential_id=ANY(proved_ids) THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
  SELECT * INTO STRICT predecessor FROM guest_credentials WHERE credential_id=expected_predecessor_credential_id AND origin=expected_origin;
  IF resolve_guest_empty_owner_root_v1(predecessor.owner_id)<>expected_owner_id THEN RAISE EXCEPTION 'owner-mismatch' USING ERRCODE='GP002'; END IF;
  -- No learning-lease requirement. Old acknowledged proof can NEVER rotate.
  IF predecessor.state<>'confirmed' THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
  SELECT * INTO existing_operation FROM guest_participation_operations
    WHERE source_owner_id=expected_owner_id AND operation_kind='credential_rotate' AND idempotency_key=issuance_key;
  IF FOUND AND ROW(existing_operation.resource_scope,existing_operation.request_hash)
      IS DISTINCT FROM ROW(predecessor.owner_id,issuance_request_hash) THEN
    RAISE EXCEPTION 'idempotency-conflict' USING ERRCODE='GP005'; END IF;
  SELECT * INTO prior FROM guest_secret_issuance_operations WHERE origin=expected_origin
    AND issuance_kind='rotation' AND resource_scope=predecessor.owner_id AND idempotency_key=issuance_key;
  IF FOUND THEN
    IF prior.request_hash<>issuance_request_hash THEN RAISE EXCEPTION 'idempotency-conflict' USING ERRCODE='GP005'; END IF;
    IF NOT prior.credential_id=ANY(proved_ids) THEN RETURN jsonb_build_object('state','issuance_requires_restart'); END IF;
    SELECT * INTO STRICT successor FROM guest_credentials WHERE credential_id=prior.credential_id;
    IF successor.state<>'pending_successor' OR successor.predecessor_id<>expected_predecessor_credential_id
       OR successor.pending_expires_at<=clock_timestamp() THEN
      RETURN jsonb_build_object('state','issuance_requires_restart'); END IF;
    RETURN jsonb_build_object('state','completed','operation_id',prior.operation_id,
      'operation',guest_authority_issue_operation_v1(prior.operation_id),
      'authority',guest_authority_metadata_v1(expected_origin,proved_ids,successor.credential_id),'cookie_effects','[]'::JSONB);
  END IF;
  IF cardinality(proved_ids)>=4 THEN RAISE EXCEPTION 'credential-cleanup-required' USING ERRCODE='GP004'; END IF;
  at_time := clock_timestamp();
  -- Fresh deliberate key may replace ONLY an unconfirmed successor. Its original
  -- immutable issuance/operation remains as historical evidence.
  UPDATE guest_credentials SET state='revoked',revoked_at=at_time,revocation_reason='successor_superseded'
    WHERE owner_id=predecessor.owner_id AND origin=expected_origin AND state='pending_successor';
  INSERT INTO guest_credentials(credential_id,owner_id,origin,secret_digest,state,created_at,pending_expires_at,predecessor_id)
    VALUES(new_credential_id,predecessor.owner_id,expected_origin,new_digest,'pending_successor',at_time,
      at_time+INTERVAL '15 minutes',expected_predecessor_credential_id);
  authority := guest_authority_metadata_v1(expected_origin,proved_ids||ARRAY[new_credential_id],new_credential_id);
  INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,
      idempotency_key,request_hash,state,result_snapshot,created_at,resolved_at)
    VALUES(new_operation_id,expected_owner_id,'credential_rotate',predecessor.owner_id,issuance_key,issuance_request_hash,
      'completed',jsonb_build_object('authority',authority),at_time,at_time);
  INSERT INTO guest_secret_issuance_operations(origin,issuance_kind,resource_scope,idempotency_key,request_hash,
      source_owner_id,credential_id,credential_source_owner_id,operation_id,created_at)
    VALUES(expected_origin,'rotation',predecessor.owner_id,issuance_key,issuance_request_hash,
      expected_owner_id,new_credential_id,predecessor.owner_id,new_operation_id,at_time);
  RETURN jsonb_build_object('state','completed','operation_id',new_operation_id,
      'operation',guest_authority_issue_operation_v1(new_operation_id),'authority',authority,
    'cookie_effects',jsonb_build_array(jsonb_build_object('kind','credential','action','issue','credentialId',new_credential_id)));
END $$;

CREATE FUNCTION acknowledge_guest_rotation_v1(
  expected_origin TEXT,proved_ids TEXT[],expected_predecessor_credential_id TEXT,successor_id TEXT,expected_owner_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE predecessor guest_credentials%ROWTYPE; successor guest_credentials%ROWTYPE; at_time TIMESTAMPTZ;
BEGIN
  PERFORM lock_guest_authority_sources_v1(expected_origin,proved_ids);
  -- Frozen 028 requires correctly proved successor, not a carried predecessor
  -- cookie. Verify the stored confirmed predecessor/link under component locks.
  IF successor_id IS NULL OR NOT successor_id=ANY(proved_ids) THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
  SELECT * INTO STRICT successor FROM guest_credentials WHERE credential_id=successor_id AND origin=expected_origin;
  SELECT * INTO STRICT predecessor FROM guest_credentials WHERE credential_id=expected_predecessor_credential_id AND origin=expected_origin;
  IF successor.predecessor_id IS DISTINCT FROM expected_predecessor_credential_id OR successor.owner_id<>predecessor.owner_id
     OR resolve_guest_empty_owner_root_v1(successor.owner_id)<>expected_owner_id THEN RAISE EXCEPTION 'owner-mismatch' USING ERRCODE='GP002'; END IF;
  IF successor.state='confirmed' AND predecessor.state='revoked'
     AND predecessor.revocation_reason='rotation_acknowledged' THEN
    -- Exact natural triple replay. Do not UPDATE lease, recreate secret or rotate.
    RETURN jsonb_build_object('authority',guest_authority_metadata_v1(expected_origin,proved_ids,successor_id),
      'cookie_effects','[]'::JSONB);
  END IF;
  IF predecessor.state<>'confirmed'
     OR successor.state<>'pending_successor' OR successor.pending_expires_at<=clock_timestamp()
    THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
  at_time := clock_timestamp();
  -- BEFORE successor confirmation clears the original-owner partial uniqueness.
  UPDATE guest_credentials SET state='revoked',revoked_at=at_time,revocation_reason='rotation_acknowledged'
    WHERE credential_id=expected_predecessor_credential_id;
  UPDATE guest_credentials SET state='confirmed',confirmed_at=at_time,session_until=at_time+INTERVAL '1 hour'
    WHERE credential_id=successor_id;
  RETURN jsonb_build_object('authority',guest_authority_metadata_v1(expected_origin,proved_ids,successor_id),
    'cookie_effects',jsonb_build_array(jsonb_build_object('kind','credential','action','expire','credentialId',expected_predecessor_credential_id)));
END $$;

DO $bind_guest_authority_transitions$
DECLARE signature TEXT; grantee_name TEXT; trusted_schema TEXT := current_schema();
BEGIN
  IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
    RAISE EXCEPTION 'trusted migration schema required'; END IF;
  FOREACH signature IN ARRAY ARRAY[
    'guest_authority_issue_operation_v1(text)',
    'require_guest_practice_only_schema_phase_v1()',
    'lock_guest_authority_sources_v1(text,text[])',
    'guest_authority_metadata_v1(text,text[],text)',
    'reject_guest_copresent_established_conflict_v1(text,text[],text)',
    'converge_proved_empty_guest_sources_v1(text,text[])',
    'issue_guest_pending_v1(text,text[],text,text,text,text,text,text,text)',
    'confirm_guest_pending_v1(text,text[],text,text)',
    'renew_guest_authority_v1(text,text[],text,text)',
    'issue_guest_rotation_v1(text,text[],text,text,text,text,text,text,text)',
    'acknowledge_guest_rotation_v1(text,text[],text,text,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
    FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
      WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
  END LOOP;
END;
$bind_guest_authority_transitions$;
-- No serving-role grants or activation. Trusted runtime grants only the five
-- transitions after role and complete module acceptance. The caller owns COMMIT;
-- statement return alone cannot authorize an issue cookie or prove known abort.

-- CALLER takes shared/exclusive topology and C-sorted complete components first.
-- Usable for ONE source, unlike convergence's <=1-root early return.
CREATE FUNCTION guest_authority_component_is_empty_v1(original_source_id TEXT)
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
    AND NOT EXISTS(SELECT 1 FROM guest_participation_operations WHERE source_owner_id=ANY(member_ids)
      AND operation_kind IN ('study_start','study_answer','learning_retention','learner_audio_deletion')
      AND state<>'known_aborted')
    AND NOT EXISTS(SELECT 1 FROM guest_attachment_intents WHERE owner_id=ANY(member_ids)
      AND state IN ('awaiting_account','awaiting_confirmation') AND expires_at>clock_timestamp());
END $$;
-- Positive phase witness, exact canonical-owner inventory, all8 core FKs and
-- seven financial families remain those of actual0250; do not copy weaker scans.
-- Accounting replaces this helper/phase closure atomically before its writers.
-- Positive held allocations are never made empty by proof loss/signup/cleanup.

CREATE FUNCTION lock_guest_cleanup_components_v1(
  expected_origin TEXT,proved_credential_ids TEXT[],proved_intent_ids TEXT[]
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE roots TEXT[]; member_ids TEXT[];
BEGIN
  IF expected_origin IS NULL OR expected_origin NOT LIKE 'https://%' OR octet_length(expected_origin)>2048
    OR proved_credential_ids IS NULL OR proved_intent_ids IS NULL
    OR cardinality(proved_credential_ids)>16 OR cardinality(proved_intent_ids)>16
    OR EXISTS(SELECT 1 FROM unnest(proved_credential_ids) id WHERE id IS NULL OR id !~ '^[A-Za-z0-9_-]{21}[AQgw]$')
    OR EXISTS(SELECT 1 FROM unnest(proved_intent_ids) id WHERE id IS NULL OR id !~ '^gai_[A-Za-z0-9_-]{21}[AQgw]$')
    OR cardinality(proved_credential_ids)<>(SELECT count(DISTINCT id) FROM unnest(proved_credential_ids) id)
    OR cardinality(proved_intent_ids)<>(SELECT count(DISTINCT id) FROM unnest(proved_intent_ids) id)
  THEN RAISE EXCEPTION 'invalid trusted cleanup context' USING ERRCODE='22023'; END IF;
  -- No shared->exclusive upgrade. Own EXCLUSIVE topology before any rows;
  -- cleanup changes revocation/ceremony state but creates no owner or alias.
  PERFORM pg_advisory_xact_lock(83000003,1);
  IF cardinality(proved_credential_ids)<>(SELECT count(*) FROM guest_credentials
      WHERE origin=expected_origin AND credential_id=ANY(proved_credential_ids))
    OR cardinality(proved_intent_ids)<>(SELECT count(*) FROM guest_attachment_intents
      WHERE origin=expected_origin AND intent_id=ANY(proved_intent_ids)) THEN
    RAISE EXCEPTION 'trusted proof context changed' USING ERRCODE='GP001'; END IF;
  SELECT array_agg(DISTINCT root_id) INTO roots FROM (
    SELECT resolve_guest_empty_owner_root_v1(c.owner_id) root_id FROM guest_credentials c
      WHERE c.origin=expected_origin AND c.credential_id=ANY(proved_credential_ids)
    UNION SELECT resolve_guest_empty_owner_root_v1(i.owner_id) FROM guest_attachment_intents i
      WHERE i.origin=expected_origin AND i.intent_id=ANY(proved_intent_ids)
  ) r;
  WITH RECURSIVE component(owner_id) AS (
    SELECT unnest(COALESCE(roots,'{}'::TEXT[])) UNION SELECT a.source_owner_id FROM guest_empty_owner_aliases a
      JOIN component c ON a.canonical_owner_id=c.owner_id
  ) SELECT array_agg(owner_id ORDER BY owner_id COLLATE "C") INTO member_ids FROM component;
  PERFORM 1 FROM participation_owners WHERE owner_id=ANY(COALESCE(member_ids,'{}'::TEXT[]))
    ORDER BY owner_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM guest_credentials WHERE owner_id=ANY(COALESCE(member_ids,'{}'::TEXT[]))
    ORDER BY credential_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM guest_attachment_intents WHERE owner_id=ANY(COALESCE(member_ids,'{}'::TEXT[]))
    ORDER BY intent_id COLLATE "C" FOR UPDATE;
END $$;

CREATE FUNCTION discover_guest_authority_v1(
  expected_origin TEXT,proved_ids TEXT[],context_selected_id TEXT,
  expected_owner_id TEXT,previous_credential_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE selected guest_credentials%ROWTYPE; previous guest_credentials%ROWTYPE;
  candidate guest_credentials%ROWTYPE; candidates INTEGER; selected_root TEXT;
  metadata JSONB; result JSONB; repair JSONB := NULL; roots_count INTEGER;
BEGIN
  PERFORM lock_guest_authority_sources_v1(expected_origin,proved_ids);
  IF context_selected_id IS NOT NULL THEN
    IF NOT context_selected_id=ANY(proved_ids) THEN RAISE EXCEPTION 'proof-revoked' USING ERRCODE='GP001'; END IF;
    SELECT * INTO STRICT selected FROM guest_credentials WHERE origin=expected_origin AND credential_id=context_selected_id;
    selected_root := resolve_guest_empty_owner_root_v1(selected.owner_id);
    -- Explicit mismatch does not silently select another proved owner.
    IF expected_owner_id IS NOT NULL AND expected_owner_id<>selected_root THEN
      IF NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=expected_owner_id AND kind='guest') THEN
        RAISE EXCEPTION 'owner-mismatch' USING ERRCODE='GP002'; END IF;
      -- A genuine EMPTY alias can repair a pointer that still names its source.
      IF resolve_guest_empty_owner_root_v1(expected_owner_id)<>selected_root
        OR NOT guest_authority_component_is_empty_v1(selected.owner_id) THEN
        RAISE EXCEPTION 'owner-mismatch' USING ERRCODE='GP002'; END IF;
    END IF;
  END IF;
  result := guest_authority_metadata_v1(expected_origin,proved_ids,context_selected_id);
  -- The store honors context.selected, including an adapter-approved singleton.
  -- It NEVER constructs selection from an ambiguous same-/multi-owner list.
  IF context_selected_id IS NULL THEN
    SELECT count(DISTINCT resolve_guest_empty_owner_root_v1(c.owner_id)) INTO roots_count
      FROM guest_credentials c WHERE origin=expected_origin AND credential_id=ANY(proved_ids)
        AND (state='confirmed' OR (state IN ('pending_bootstrap','pending_successor') AND pending_expires_at>clock_timestamp()));
    result := jsonb_set(result,'{state}',to_jsonb(CASE
      WHEN expected_owner_id IS NOT NULL OR previous_credential_id IS NOT NULL THEN 'recovery_required'
      WHEN roots_count>0 THEN 'authority_conflict' ELSE 'absent' END::TEXT));
  ELSIF selected.state='revoked' OR
    (selected.state IN ('pending_bootstrap','pending_successor') AND selected.pending_expires_at<=clock_timestamp()) THEN
    result := jsonb_set(result,'{state}','"recovery_required"');
  END IF;
  IF previous_credential_id IS NOT NULL AND expected_owner_id IS NOT NULL THEN
    SELECT * INTO previous FROM guest_credentials WHERE origin=expected_origin AND credential_id=previous_credential_id;
    IF FOUND AND (previous.owner_id=expected_owner_id OR
      resolve_guest_empty_owner_root_v1(previous.owner_id)=expected_owner_id) THEN
      SELECT count(*) INTO candidates FROM guest_credentials c
        WHERE c.origin=expected_origin AND c.credential_id=ANY(proved_ids) AND c.state='confirmed'
          AND c.credential_id<>previous_credential_id
          AND (c.predecessor_id=previous_credential_id OR
            (c.owner_id<>previous.owner_id AND resolve_guest_empty_owner_root_v1(c.owner_id)=resolve_guest_empty_owner_root_v1(previous.owner_id)))
          AND (context_selected_id IS NULL OR context_selected_id=c.credential_id
            OR context_selected_id=previous_credential_id);
      IF candidates=1 THEN
        SELECT * INTO STRICT candidate FROM guest_credentials c
          WHERE c.origin=expected_origin AND c.credential_id=ANY(proved_ids) AND c.state='confirmed'
            AND c.credential_id<>previous_credential_id
            AND (c.predecessor_id=previous_credential_id OR
              (c.owner_id<>previous.owner_id AND resolve_guest_empty_owner_root_v1(c.owner_id)=resolve_guest_empty_owner_root_v1(previous.owner_id)))
            AND (context_selected_id IS NULL OR context_selected_id=c.credential_id
            OR context_selected_id=previous_credential_id);
        IF (candidate.predecessor_id=previous_credential_id AND previous.state='revoked'
              AND previous.revocation_reason='rotation_acknowledged' AND candidate.owner_id=previous.owner_id)
          OR (candidate.owner_id<>previous.owner_id
              AND guest_authority_component_is_empty_v1(candidate.owner_id)) THEN
          repair := jsonb_build_object('previous_credential_id',previous_credential_id,
            'credential_id',candidate.credential_id,'owner_id',resolve_guest_empty_owner_root_v1(candidate.owner_id));
        END IF;
      END IF;
    END IF;
  END IF;
  -- Repair is authenticated metadata, not selection mutation or a cookie effect.
  RETURN jsonb_set(result,'{pointer_repair}',COALESCE(repair,'null'::JSONB));
END $$;

CREATE FUNCTION cleanup_guest_authority_v1(
  expected_origin TEXT,proved_credential_ids TEXT[],proved_intent_ids TEXT[],
  context_selected_id TEXT,candidate_credential_ids TEXT[],candidate_intent_ids TEXT[]
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE credential guest_credentials%ROWTYPE; intent guest_attachment_intents%ROWTYPE;
  effects JSONB := '[]'; authority JSONB; at_time TIMESTAMPTZ;
BEGIN
  PERFORM lock_guest_cleanup_components_v1(expected_origin,proved_credential_ids,proved_intent_ids);
  IF candidate_credential_ids IS NULL OR candidate_intent_ids IS NULL
    OR cardinality(candidate_credential_ids)>16 OR cardinality(candidate_intent_ids)>16
    OR cardinality(candidate_credential_ids)<>(SELECT count(DISTINCT id) FROM unnest(candidate_credential_ids) id)
    OR cardinality(candidate_intent_ids)<>(SELECT count(DISTINCT id) FROM unnest(candidate_intent_ids) id)
    OR EXISTS(SELECT 1 FROM unnest(candidate_credential_ids) id WHERE id IS NULL OR NOT id=ANY(proved_credential_ids))
    OR EXISTS(SELECT 1 FROM unnest(candidate_intent_ids) id WHERE id IS NULL OR NOT id=ANY(proved_intent_ids))
    OR (context_selected_id IS NOT NULL AND NOT context_selected_id=ANY(proved_credential_ids))
  THEN RAISE EXCEPTION 'cleanup requires each exact proof' USING ERRCODE='GP001'; END IF;
  IF context_selected_id=ANY(candidate_credential_ids) THEN
    RAISE EXCEPTION 'selected authority is retained' USING ERRCODE='GP003'; END IF;
  IF EXISTS(SELECT 1 FROM guest_credentials WHERE credential_id=context_selected_id
      AND state='pending_successor' AND predecessor_id=ANY(candidate_credential_ids)) THEN
    RAISE EXCEPTION 'selected pending authority retains its predecessor' USING ERRCODE='GP003'; END IF;
  -- Preflight ALL candidates before any mutation; one live/retained candidate
  -- refuses the entire request. Unknown COMMIT still needs exact-state replay.
  FOR credential IN SELECT * FROM guest_credentials WHERE origin=expected_origin
      AND credential_id=ANY(candidate_credential_ids) ORDER BY credential_id COLLATE "C" LOOP
    IF credential.state<>'revoked' AND NOT guest_authority_component_is_empty_v1(credential.owner_id) THEN
      RAISE EXCEPTION 'credential history is retained' USING ERRCODE='GP003'; END IF;
  END LOOP;
  FOR intent IN SELECT * FROM guest_attachment_intents WHERE origin=expected_origin
      AND intent_id=ANY(candidate_intent_ids) ORDER BY intent_id COLLATE "C" LOOP
    IF intent.state IN ('awaiting_account','awaiting_confirmation') AND intent.expires_at>clock_timestamp() THEN
      RAISE EXCEPTION 'live ceremony is retained' USING ERRCODE='GP003'; END IF;
  END LOOP;
  at_time := clock_timestamp();
  FOR credential IN SELECT * FROM guest_credentials WHERE origin=expected_origin
      AND credential_id=ANY(candidate_credential_ids) ORDER BY credential_id COLLATE "C" LOOP
    IF credential.state<>'revoked' THEN
      UPDATE guest_credentials SET state='revoked',revoked_at=at_time,revocation_reason='empty_cleanup'
        WHERE credential_id=credential.credential_id;
    END IF;
    -- Already revoked proof cookie expiry does not erase its retained owner.
    effects := effects||jsonb_build_array(jsonb_build_object('kind','credential','action','expire','credentialId',credential.credential_id));
  END LOOP;
  FOR intent IN SELECT * FROM guest_attachment_intents WHERE origin=expected_origin
      AND intent_id=ANY(candidate_intent_ids) ORDER BY intent_id COLLATE "C" LOOP
    IF intent.state IN ('awaiting_account','awaiting_confirmation') THEN
      UPDATE guest_attachment_intents SET state='expired' WHERE intent_id=intent.intent_id;
    END IF;
    effects := effects||jsonb_build_array(jsonb_build_object('kind','intent','action','expire','intentId',intent.intent_id));
  END LOOP;
  -- Cleanup can project <=16; it NEVER auto-selects even a singleton without
  -- approved context.selected. Existing normal metadata helper already honors
  -- that argument but its declared frozen mapper must use GuestCleanupAuthorityV1.
  authority := guest_authority_metadata_v1(expected_origin,proved_credential_ids,context_selected_id);
  IF context_selected_id IS NULL AND cardinality(proved_credential_ids)>0 THEN
    authority := jsonb_set(authority,'{state}','"authority_conflict"');
  ELSIF EXISTS(SELECT 1 FROM guest_credentials WHERE credential_id=context_selected_id
      AND state IN ('pending_bootstrap','pending_successor') AND pending_expires_at<=clock_timestamp()) THEN
    authority := jsonb_set(authority,'{state}','"recovery_required"');
  END IF;
  RETURN jsonb_build_object('authority',authority,'cookieEffects',effects);
END $$;

-- Actual reusable extraction: convergence and empty cleanup share one closure.
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

-- Full actual0248 credential guard, only pending-only empty_cleanup condition
-- narrowed and complete-component empty guard added. All other checks retained.
CREATE OR REPLACE FUNCTION guard_guest_credential_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'credential evidence is retained'; END IF;
  IF ROW(NEW.credential_id,NEW.owner_id,NEW.origin,NEW.secret_digest,NEW.created_at,
         NEW.pending_expires_at,NEW.predecessor_id)
     IS DISTINCT FROM ROW(OLD.credential_id,OLD.owner_id,OLD.origin,OLD.secret_digest,OLD.created_at,
         OLD.pending_expires_at,OLD.predecessor_id) THEN
    RAISE EXCEPTION 'credential identity is immutable';
  END IF;
  IF OLD.state='revoked' THEN
    IF (to_jsonb(NEW)-'owner_kind') IS DISTINCT FROM (to_jsonb(OLD)-'owner_kind') THEN
      RAISE EXCEPTION 'credential revocation is final'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.state=OLD.state THEN
    IF ROW(NEW.confirmed_at,NEW.revoked_at,NEW.revocation_reason)
       IS DISTINCT FROM ROW(OLD.confirmed_at,OLD.revoked_at,OLD.revocation_reason)
       OR (OLD.state<>'confirmed' AND NEW.session_until IS DISTINCT FROM OLD.session_until) THEN
      RAISE EXCEPTION 'invalid credential transition';
    END IF;
    IF NEW.session_until IS DISTINCT FROM OLD.session_until AND
       (NEW.session_until<=OLD.session_until OR NEW.session_until>clock_timestamp()+INTERVAL '1 hour') THEN
      RAISE EXCEPTION 'invalid deliberate learning renewal';
    END IF;
  ELSIF NEW.state='confirmed' AND OLD.state IN ('pending_bootstrap','pending_successor') THEN
    IF clock_timestamp()>=OLD.pending_expires_at OR NEW.confirmed_at IS NULL
       OR NEW.confirmed_at<OLD.created_at OR NEW.confirmed_at>clock_timestamp()
       OR NEW.session_until IS DISTINCT FROM NEW.confirmed_at+INTERVAL '1 hour' THEN
      RAISE EXCEPTION 'invalid pending confirmation';
    END IF;
  ELSIF NEW.state='revoked' THEN
    IF (NEW.revocation_reason IN ('successor_superseded','pending_expired')
        AND OLD.state NOT IN ('pending_bootstrap','pending_successor'))
       OR (NEW.revocation_reason='successor_superseded' AND OLD.state<>'pending_successor')
       OR (NEW.revocation_reason='rotation_acknowledged' AND OLD.state<>'confirmed') THEN
      RAISE EXCEPTION 'revocation reason must match the credential protocol';
    END IF;
    IF NEW.revocation_reason='empty_cleanup' AND NOT guest_authority_component_is_empty_v1(OLD.owner_id) THEN
      RAISE EXCEPTION 'credential history is retained' USING ERRCODE='GP003'; END IF;
    IF ROW(NEW.confirmed_at,NEW.session_until) IS DISTINCT FROM ROW(OLD.confirmed_at,OLD.session_until)
       OR NEW.revoked_at<OLD.created_at OR NEW.revoked_at>clock_timestamp() THEN
      RAISE EXCEPTION 'invalid credential revocation';
    END IF;
  ELSE RAISE EXCEPTION 'invalid credential transition'; END IF;
  RETURN NEW;
END $$;

DO $bind_guest_discovery_cleanup$
DECLARE signature TEXT; grantee_name TEXT; trusted_schema TEXT:=current_schema();
BEGIN
  IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
    RAISE EXCEPTION 'trusted migration schema required'; END IF;
  FOREACH signature IN ARRAY ARRAY[
    'guest_authority_component_is_empty_v1(text)',
    'converge_proved_empty_guest_sources_v1(text,text[])',
    'guard_guest_credential_v1()',
    'lock_guest_cleanup_components_v1(text,text[],text[])',
    'discover_guest_authority_v1(text,text[],text,text,text)',
    'cleanup_guest_authority_v1(text,text[],text[],text,text[],text[])'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
    FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
      WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
  END LOOP;
END $bind_guest_discovery_cleanup$;
-- No serving-role grant, HTTP wire/port variant or activation in this proposal.
