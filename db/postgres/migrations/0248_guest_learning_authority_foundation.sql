-- Guest learning authority foundation. No reward/association or guest runtime activation.
-- Frozen operation identity is owner/kind/key; resource scope remains immutable metadata.
CREATE TABLE participation_owners (
  owner_id TEXT PRIMARY KEY CHECK (owner_id ~ '^owner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  kind TEXT NOT NULL CHECK (kind IN ('account','guest')),
  account_id TEXT UNIQUE REFERENCES users(user_id),
  guest_origin TEXT,
  state TEXT NOT NULL CHECK (state IN ('empty','established','aliased_empty')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id,kind),
  UNIQUE (owner_id,account_id),
  UNIQUE (owner_id,kind,guest_origin),
  CHECK ((kind='account' AND account_id IS NOT NULL AND guest_origin IS NULL AND state<>'aliased_empty')
      OR (kind='guest' AND account_id IS NULL AND guest_origin IS NOT NULL)),
  CHECK (guest_origin IS NULL OR (guest_origin LIKE 'https://%' AND octet_length(guest_origin)<=2048))
);
-- Owner identity/kind/origin are immutable; established never returns to empty.
-- New account admission requires active canonical users. Historical deleted-user
-- backfill retains audit source identity and grants no new authority.

CREATE TABLE guest_credentials (
  credential_id TEXT PRIMARY KEY CHECK (credential_id ~ '^[A-Za-z0-9_-]{21}[AQgw]$'),
  owner_id TEXT NOT NULL,
  owner_kind TEXT GENERATED ALWAYS AS ('guest'::TEXT) STORED,
  origin TEXT NOT NULL,
  secret_digest TEXT NOT NULL CHECK (secret_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('pending_bootstrap','pending_successor','confirmed','revoked')),
  created_at TIMESTAMPTZ NOT NULL,
  pending_expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  session_until TIMESTAMPTZ,
  predecessor_id TEXT,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  UNIQUE (owner_id,origin,credential_id),
  UNIQUE (origin,credential_id),
  FOREIGN KEY (owner_id,owner_kind,origin) REFERENCES participation_owners(owner_id,kind,guest_origin),
  FOREIGN KEY (owner_id,origin,predecessor_id) REFERENCES guest_credentials(owner_id,origin,credential_id),
  CHECK (pending_expires_at=created_at+INTERVAL '15 minutes'),
  CHECK ((state IN ('pending_bootstrap','pending_successor') AND confirmed_at IS NULL AND session_until IS NULL)
      OR (state='confirmed' AND confirmed_at IS NOT NULL AND session_until IS NOT NULL)
      OR state='revoked'),
  CHECK ((state='revoked')=(revoked_at IS NOT NULL)),
  CHECK ((state='revoked')=(revocation_reason IS NOT NULL)),
  CHECK (state<>'pending_bootstrap' OR predecessor_id IS NULL),
  CHECK (state<>'pending_successor' OR predecessor_id IS NOT NULL)
);
CREATE UNIQUE INDEX guest_one_pending_successor_per_original_owner
  ON guest_credentials(owner_id,origin) WHERE state='pending_successor';
CREATE UNIQUE INDEX guest_one_confirmed_credential_per_original_owner
  ON guest_credentials(owner_id,origin) WHERE state='confirmed';
CREATE INDEX guest_credential_owner_proof_lookup ON guest_credentials(owner_id,origin,state);
-- Confirmed recovery proof has no server age expiry. session_until is learning
-- lease only. State/digest/predecessor mutation is through controlled transitions.
-- Empty aliases can yield several proved credentials for one effective owner;
-- the partial confirmed index is on ORIGINAL credential owner, not alias root.

CREATE TABLE guest_empty_owner_aliases (
  source_owner_id TEXT PRIMARY KEY REFERENCES participation_owners(owner_id),
  canonical_owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
  owner_kind TEXT GENERATED ALWAYS AS ('guest'::TEXT) STORED,
  origin TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY(source_owner_id,owner_kind,origin) REFERENCES participation_owners(owner_id,kind,guest_origin),
  FOREIGN KEY(canonical_owner_id,owner_kind,origin) REFERENCES participation_owners(owner_id,kind,guest_origin),
  CHECK (source_owner_id<>canonical_owner_id)
);
CREATE INDEX guest_empty_alias_target_idx ON guest_empty_owner_aliases(canonical_owner_id);
-- Append-only, no cycles. Exclusive topology barrier + locked zero-history
-- component; target precedes source in (created_at, raw UTF8 owner_id) order.
-- Never rewrite an existing alias, credential provenance or admitted session.

CREATE TABLE participation_owner_clocks (
  owner_id TEXT PRIMARY KEY,
  owner_kind TEXT GENERATED ALWAYS AS ('guest'::TEXT) STORED,
  timezone TEXT NOT NULL CHECK (btrim(timezone)=timezone AND octet_length(timezone) BETWEEN 1 AND 128),
  timezone_updated_at TIMESTAMPTZ NOT NULL,
  next_change_allowed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (owner_id,owner_kind) REFERENCES participation_owners(owner_id,kind),
  CHECK (next_change_allowed_at=timezone_updated_at+INTERVAL '168 hours')
);
CREATE TABLE guest_learning_preferences (
  owner_id TEXT PRIMARY KEY,
  owner_kind TEXT GENERATED ALWAYS AS ('guest'::TEXT) STORED,
  mode TEXT NOT NULL CHECK (mode IN ('private_learning','ephemeral')),
  changed_at TIMESTAMPTZ NOT NULL,
  operation_id TEXT NOT NULL,
  FOREIGN KEY (owner_id,owner_kind) REFERENCES participation_owners(owner_id,kind)
);

CREATE TABLE guest_participation_operations (
  operation_id TEXT PRIMARY KEY CHECK (char_length(operation_id) BETWEEN 1 AND 128),
  source_owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN
    ('bootstrap_issue','bootstrap_confirm','authority_renew','credential_rotate',
     'credential_acknowledge','credential_cleanup','attachment_intent','attachment_prepare',
     'study_start','study_answer','learning_retention','learner_audio_deletion')),
  resource_scope TEXT NOT NULL CHECK (octet_length(resource_scope) BETWEEN 1 AND 2048),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('reserved','completed','known_aborted')),
  result_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  UNIQUE(source_owner_id,operation_kind,idempotency_key),
  UNIQUE(operation_id,source_owner_id),
  CHECK ((state='reserved' AND result_snapshot IS NULL AND resolved_at IS NULL)
      OR (state='completed' AND result_snapshot IS NOT NULL AND resolved_at IS NOT NULL)
      OR (state='known_aborted' AND result_snapshot IS NULL AND resolved_at IS NOT NULL)),
  CHECK (result_snapshot IS NULL OR
    (jsonb_typeof(result_snapshot)='object' AND octet_length(result_snapshot::TEXT)<=131072))
);
-- resource_scope is a canonical full resource identity, never a truncated hash.
-- Completed/known-aborted facts are immutable. Pending transaction uncertainty
-- is not inferred as abort from an absent row. GET lookup does not write a fence.

CREATE TABLE guest_secret_issuance_operations (
  origin TEXT NOT NULL,
  issuance_kind TEXT NOT NULL CHECK (issuance_kind IN ('bootstrap','rotation','attachment_intent')),
  resource_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  source_owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
  credential_id TEXT,
  credential_source_owner_id TEXT,
  source_owner_kind TEXT GENERATED ALWAYS AS ('guest'::TEXT) STORED,
  FOREIGN KEY(source_owner_id,source_owner_kind,origin) REFERENCES participation_owners(owner_id,kind,guest_origin),
  FOREIGN KEY(credential_source_owner_id,origin,credential_id) REFERENCES guest_credentials(owner_id,origin,credential_id),
  intent_id TEXT,
  operation_id TEXT NOT NULL,
  FOREIGN KEY(operation_id,source_owner_id) REFERENCES guest_participation_operations(operation_id,source_owner_id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(origin,issuance_kind,resource_scope,idempotency_key),
  FOREIGN KEY(origin,credential_id) REFERENCES guest_credentials(origin,credential_id),
  CHECK ((issuance_kind IN ('bootstrap','rotation') AND credential_id IS NOT NULL AND credential_source_owner_id IS NOT NULL AND intent_id IS NULL)
      OR (issuance_kind='attachment_intent' AND credential_id IS NULL AND credential_source_owner_id IS NULL AND intent_id IS NOT NULL))
);
-- Bootstrap natural scope is trusted product origin, without a browser-provided
-- owner. Rotation/intent scope contains the PROVED original owner. This index
-- precedes caller-generated replacement owner IDs during replay lookup.

CREATE TABLE guest_attachment_intents (
  intent_id TEXT PRIMARY KEY CHECK (intent_id ~ '^gai_[A-Za-z0-9_-]{21}[AQgw]$'),
  owner_id TEXT NOT NULL,
  credential_source_owner_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  nonce_digest TEXT NOT NULL CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('awaiting_account','awaiting_confirmation','expired','superseded')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  target_revision BIGINT NOT NULL DEFAULT 0 CHECK (target_revision BETWEEN 0 AND 9007199254740991),
  target_account_id TEXT REFERENCES users(user_id),
  target_session_digest TEXT CHECK (target_session_digest ~ '^[0-9a-f]{64}$'),
  prepared_operation_id TEXT,
  FOREIGN KEY(prepared_operation_id,owner_id) REFERENCES guest_participation_operations(operation_id,source_owner_id),
  owner_kind TEXT GENERATED ALWAYS AS ('guest'::TEXT) STORED,
  FOREIGN KEY (owner_id,owner_kind,origin) REFERENCES participation_owners(owner_id,kind,guest_origin),
  UNIQUE(intent_id,owner_id,origin),
  FOREIGN KEY (credential_source_owner_id,origin,credential_id) REFERENCES guest_credentials(owner_id,origin,credential_id),
  CHECK (expires_at=created_at+INTERVAL '15 minutes'),
  CHECK ((target_revision=0 AND target_account_id IS NULL AND target_session_digest IS NULL)
      OR (target_revision>0 AND target_account_id IS NOT NULL AND target_session_digest IS NOT NULL)),
  CHECK (state<>'awaiting_account' OR target_revision=0),
  CHECK (state<>'awaiting_confirmation' OR target_revision>0)
);
CREATE UNIQUE INDEX guest_one_live_intent_per_original_owner
  ON guest_attachment_intents(owner_id) WHERE state IN ('awaiting_account','awaiting_confirmation');
ALTER TABLE guest_secret_issuance_operations
  ADD CONSTRAINT guest_issuance_intent_fk FOREIGN KEY(intent_id,source_owner_id,origin) REFERENCES guest_attachment_intents(intent_id,owner_id,origin);
-- No consumed/bound/conflict state or association writer in this learning phase.
-- Expired live rows are terminalized under owner/intent locks before replacement.
-- owner_id is the effective immutable participation source; credential source
-- can differ after proved EMPTY aliasing. Controlled routines resolve and lock
-- that alias component and prove equality, rather than silently reparenting proof.

ALTER TABLE guest_learning_preferences ADD CONSTRAINT guest_preferences_operation_owner_fk
  FOREIGN KEY(operation_id,owner_id) REFERENCES guest_participation_operations(operation_id,source_owner_id);


-- Later resource/checkpoint/deletion tables are separate proposals, not part of this core packet.
-- Routine state transitions and composite/backfill closure are independently reviewed below.

DO $private_guest_core_tables$
DECLARE table_name TEXT; grantee_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'participation_owners','guest_credentials','guest_empty_owner_aliases',
    'participation_owner_clocks','guest_learning_preferences',
    'guest_participation_operations','guest_secret_issuance_operations','guest_attachment_intents'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',table_name);
    FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_class c CROSS JOIN LATERAL
        aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass(table_name) AND a.grantee<>0 AND a.grantee<>c.relowner
    LOOP EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,grantee_name); END LOOP;
  END LOOP;
END;
$private_guest_core_tables$;
-- Removes inherited broad runtime default grants as well as PUBLIC. Exact
-- controlled-reader/transition routine EXECUTE grants are a separate reviewed
-- role binding; ordinary runtime gets no raw owner/credential/alias/intent DML.

-- Original proof identity is immutable; rotation creates a separate credential.
ALTER TABLE guest_credentials ADD CONSTRAINT guest_predecessor_distinct
  CHECK(predecessor_id IS NULL OR predecessor_id<>credential_id);
ALTER TABLE guest_credentials ADD CONSTRAINT guest_revocation_reason_closed
  CHECK(revocation_reason IS NULL OR revocation_reason IN
    ('rotation_acknowledged','successor_superseded','pending_expired','empty_cleanup','attachment_bound'));
ALTER TABLE guest_participation_operations ADD CONSTRAINT guest_operation_resolution_clock
  CHECK(resolved_at IS NULL OR resolved_at>=created_at);

CREATE FUNCTION guard_participation_owner_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'participation source is retained'; END IF;
  IF ROW(NEW.owner_id,NEW.kind,NEW.account_id,NEW.guest_origin,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.owner_id,OLD.kind,OLD.account_id,OLD.guest_origin,OLD.created_at)
     OR (OLD.state='established' AND NEW.state<>'established')
     OR (OLD.state='aliased_empty' AND NEW.state<>'aliased_empty') THEN
    RAISE EXCEPTION 'participation source identity is immutable';
  END IF;
  IF NEW.state='aliased_empty' AND NOT EXISTS(
    SELECT 1 FROM guest_empty_owner_aliases WHERE source_owner_id=NEW.owner_id
  ) THEN RAISE EXCEPTION 'empty alias evidence required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER participation_owner_guard BEFORE UPDATE OR DELETE ON participation_owners
  FOR EACH ROW EXECUTE FUNCTION guard_participation_owner_v1();

CREATE FUNCTION guard_guest_credential_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
    IF (NEW.revocation_reason IN ('successor_superseded','pending_expired','empty_cleanup')
        AND OLD.state NOT IN ('pending_bootstrap','pending_successor'))
       OR (NEW.revocation_reason='successor_superseded' AND OLD.state<>'pending_successor')
       OR (NEW.revocation_reason='rotation_acknowledged' AND OLD.state<>'confirmed') THEN
      RAISE EXCEPTION 'revocation reason must match the credential protocol';
    END IF;
    IF ROW(NEW.confirmed_at,NEW.session_until) IS DISTINCT FROM ROW(OLD.confirmed_at,OLD.session_until)
       OR NEW.revoked_at<OLD.created_at OR NEW.revoked_at>clock_timestamp() THEN
      RAISE EXCEPTION 'invalid credential revocation';
    END IF;
  ELSE RAISE EXCEPTION 'invalid credential transition'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION guard_guest_credential_insert_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state NOT IN ('pending_bootstrap','pending_successor')
     OR NEW.created_at>clock_timestamp() OR NEW.pending_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'new credentials must enter the live pending protocol';
  END IF;
  IF NEW.state='pending_successor' AND NOT EXISTS(
    SELECT 1 FROM guest_credentials predecessor WHERE predecessor.credential_id=NEW.predecessor_id
      AND predecessor.owner_id=NEW.owner_id AND predecessor.origin=NEW.origin AND predecessor.state='confirmed'
  ) THEN RAISE EXCEPTION 'confirmed original predecessor required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_credential_insert_guard BEFORE INSERT ON guest_credentials
  FOR EACH ROW EXECUTE FUNCTION guard_guest_credential_insert_v1();
CREATE TRIGGER guest_credential_guard BEFORE UPDATE OR DELETE ON guest_credentials
  FOR EACH ROW EXECUTE FUNCTION guard_guest_credential_v1();

CREATE FUNCTION guard_guest_operation_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'guest outcome evidence is retained'; END IF;
  IF ROW(NEW.operation_id,NEW.source_owner_id,NEW.operation_kind,NEW.resource_scope,
         NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.operation_id,OLD.source_owner_id,OLD.operation_kind,OLD.resource_scope,
         OLD.idempotency_key,OLD.request_hash,OLD.created_at)
     OR (OLD.state<>'reserved' AND NEW IS DISTINCT FROM OLD)
     OR (OLD.state='reserved' AND NEW.state NOT IN ('reserved','completed','known_aborted')) THEN
    RAISE EXCEPTION 'guest operation identity and resolved outcome are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_operation_guard BEFORE UPDATE OR DELETE ON guest_participation_operations
  FOR EACH ROW EXECUTE FUNCTION guard_guest_operation_v1();
CREATE FUNCTION reject_guest_immutable_mutation_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'guest evidence is immutable'; END $$;
CREATE TRIGGER guest_issuance_immutable BEFORE UPDATE OR DELETE ON guest_secret_issuance_operations
  FOR EACH ROW EXECUTE FUNCTION reject_guest_immutable_mutation_v1();
CREATE TRIGGER guest_empty_alias_immutable BEFORE UPDATE OR DELETE ON guest_empty_owner_aliases
  FOR EACH ROW EXECUTE FUNCTION reject_guest_immutable_mutation_v1();

-- Strictly decreasing immutable creation order prevents alias cycles.
CREATE FUNCTION guard_guest_empty_alias_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source participation_owners%ROWTYPE; target participation_owners%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(83000003,1);
  PERFORM 1 FROM participation_owners WHERE owner_id IN(NEW.source_owner_id,NEW.canonical_owner_id)
    ORDER BY owner_id COLLATE "C" FOR UPDATE;
  SELECT * INTO STRICT source FROM participation_owners WHERE owner_id=NEW.source_owner_id;
  SELECT * INTO STRICT target FROM participation_owners WHERE owner_id=NEW.canonical_owner_id;
  IF source.kind<>'guest' OR target.kind<>'guest' OR source.state<>'empty' OR target.state<>'empty'
     OR source.guest_origin IS DISTINCT FROM target.guest_origin
     OR ROW(target.created_at,target.owner_id COLLATE "C")>=ROW(source.created_at,source.owner_id COLLATE "C")
     OR EXISTS(SELECT 1 FROM guest_attachment_intents
       WHERE owner_id IN(source.owner_id,target.owner_id)
         AND state IN ('awaiting_account','awaiting_confirmation') AND expires_at>clock_timestamp())
     OR EXISTS(SELECT 1 FROM guest_participation_operations
       WHERE source_owner_id IN(source.owner_id,target.owner_id)
         AND operation_kind='study_start' AND state<>'known_aborted') THEN
    RAISE EXCEPTION 'only same-origin empty sources may converge';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_empty_alias_guard BEFORE INSERT ON guest_empty_owner_aliases
  FOR EACH ROW EXECUTE FUNCTION guard_guest_empty_alias_v1();

CREATE FUNCTION validate_guest_alias_state_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source_id TEXT; source_state TEXT;
BEGIN
  IF TG_TABLE_NAME='guest_empty_owner_aliases' THEN source_id := NEW.source_owner_id;
  ELSE source_id := NEW.owner_id; END IF;
  SELECT state INTO STRICT source_state FROM participation_owners WHERE owner_id=source_id;
  IF (source_state='aliased_empty') IS DISTINCT FROM
     EXISTS(SELECT 1 FROM guest_empty_owner_aliases WHERE source_owner_id=source_id) THEN
    RAISE EXCEPTION 'empty alias state and evidence disagree';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_alias_state_closure AFTER INSERT ON guest_empty_owner_aliases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_guest_alias_state_v1();
CREATE CONSTRAINT TRIGGER guest_owner_alias_closure AFTER INSERT OR UPDATE ON participation_owners
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_guest_alias_state_v1();

DO $bind_guest_guards$
DECLARE signature TEXT; grantee_name TEXT; trusted_schema TEXT := current_schema();
BEGIN
  IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
    RAISE EXCEPTION 'trusted migration schema required';
  END IF;
  FOREACH signature IN ARRAY ARRAY[
    'guard_participation_owner_v1()','guard_guest_credential_v1()','guard_guest_credential_insert_v1()',
    'guard_guest_operation_v1()',
    'guard_guest_empty_alias_v1()','validate_guest_alias_state_v1()',
    'reject_guest_immutable_mutation_v1()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
    FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
      WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
  END LOOP;
END;
$bind_guest_guards$;

CREATE FUNCTION read_guest_credential_proof_matches_v1(
  expected_origin TEXT, presented_proofs JSONB, cleanup_operation BOOLEAN
) RETURNS TABLE(
  credential_id TEXT, credential_source_owner_id TEXT, origin TEXT,
  credential_state TEXT, session_until TIMESTAMPTZ, pending_expires_at TIMESTAMPTZ,
  predecessor_id TEXT, confirmed_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE maximum_proofs INTEGER;
BEGIN
  IF expected_origin IS NULL OR expected_origin NOT LIKE 'https://%'
     OR octet_length(expected_origin)>2048 OR cleanup_operation IS NULL
     OR presented_proofs IS NULL OR jsonb_typeof(presented_proofs)<>'array' THEN
    RAISE EXCEPTION 'invalid guest proof input' USING ERRCODE='22023';
  END IF;
  maximum_proofs := CASE WHEN cleanup_operation THEN 16 ELSE 4 END;
  IF jsonb_array_length(presented_proofs)>maximum_proofs THEN
    RAISE EXCEPTION 'invalid guest proof count' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(presented_proofs) p
    WHERE jsonb_typeof(p)<>'object'
       OR jsonb_typeof(p->'credentialId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p->'digest') IS DISTINCT FROM 'string'
       OR p->>'credentialId' IS NULL OR p->>'credentialId' !~ '^[A-Za-z0-9_-]{21}[AQgw]$'
       OR p->>'digest' IS NULL OR p->>'digest' !~ '^[0-9a-f]{64}$')
    OR (SELECT count(*) FROM jsonb_array_elements(presented_proofs)) <>
       (SELECT count(DISTINCT p->>'credentialId') FROM jsonb_array_elements(presented_proofs) p)
  THEN RAISE EXCEPTION 'invalid guest proof shape' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT c.credential_id,c.owner_id,c.origin,c.state,c.session_until,
    c.pending_expires_at,c.predecessor_id,c.confirmed_at,c.revoked_at
    FROM guest_credentials c
    JOIN jsonb_array_elements(presented_proofs) p
      ON c.credential_id=p->>'credentialId' AND c.secret_digest=p->>'digest'
    WHERE c.origin=expected_origin ORDER BY c.credential_id COLLATE "C";
END $$;
REVOKE ALL ON FUNCTION read_guest_credential_proof_matches_v1(TEXT,JSONB,BOOLEAN) FROM PUBLIC;
-- No digest/plaintext is returned. Revoked/pending metadata is NOT live authority;
-- the operation-specific adapter and locked mutation must recheck exact state,
-- root alias, Origin/CSRF, selector/predecessor and lease. Cleanup proof only
-- disposes a proved terminal/empty candidate; it never grants recovery access.

CREATE FUNCTION can_guest_access_activity_song_v1(
  expected_community_id TEXT, expected_post_id TEXT
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM posts p JOIN communities c USING(community_id)
    WHERE p.community_id=expected_community_id AND p.post_id=expected_post_id
      AND p.post_type='song' AND p.status='published' AND p.visibility='public'
      AND p.content_rating='general' AND c.status='active');
$$;
REVOKE ALL ON FUNCTION can_guest_access_activity_song_v1(TEXT,TEXT) FROM PUBLIC;
-- Public readiness can use this read-only predicate. Admission/capture routines
-- separately lock/recheck the exact resource before mutation; accepted provider
-- result persistence uses its durable command/fence and cannot be erased by a
-- later visibility/lease change. No account age/membership/persona shortcut.

DO $bind_private_readers$
DECLARE
  trusted_schema TEXT := current_schema();
  signature TEXT;
  grantee_name TEXT;
BEGIN
  IF trusted_schema IS NULL OR trusted_schema ~ '^pg_temp' OR trusted_schema='pg_catalog' THEN
    RAISE EXCEPTION 'trusted migration schema required';
  END IF;
  FOREACH signature IN ARRAY ARRAY[
    'read_guest_credential_proof_matches_v1(text,jsonb,boolean)',
    'can_guest_access_activity_song_v1(text,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
    FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc f CROSS JOIN LATERAL
        aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
      WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
    END LOOP;
  END LOOP;
END;
$bind_private_readers$;
-- No application grant is inferred. Root binds actual approved owner/reader
-- roles after proving runtime cannot CREATE in trusted schema or SET ROLE owner.

CREATE FUNCTION resolve_guest_empty_owner_root_v1(source_id TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER STABLE AS $$
DECLARE current_id TEXT := source_id; target_id TEXT; depth INTEGER := 0;
BEGIN
  LOOP
    IF NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=current_id AND kind='guest') THEN
      RAISE EXCEPTION 'guest source required';
    END IF;
    SELECT canonical_owner_id INTO target_id FROM guest_empty_owner_aliases WHERE source_owner_id=current_id;
    IF NOT FOUND THEN RETURN current_id; END IF;
    depth := depth+1;
    IF depth>1000 THEN RAISE EXCEPTION 'guest source component exceeds traversal bound'; END IF;
    current_id := target_id;
  END LOOP;
END $$;

CREATE FUNCTION guard_guest_issuance_lineage_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation guest_participation_operations%ROWTYPE; expected_kind TEXT;
BEGIN
  expected_kind := CASE NEW.issuance_kind WHEN 'bootstrap' THEN 'bootstrap_issue'
    WHEN 'rotation' THEN 'credential_rotate' ELSE 'attachment_intent' END;
  SELECT * INTO STRICT operation FROM guest_participation_operations WHERE operation_id=NEW.operation_id;
  IF operation.source_owner_id<>NEW.source_owner_id OR operation.operation_kind<>expected_kind
     OR ROW(operation.resource_scope,operation.idempotency_key,operation.request_hash)
       IS DISTINCT FROM ROW(NEW.resource_scope,NEW.idempotency_key,NEW.request_hash) THEN
    RAISE EXCEPTION 'issuance must retain its original operation identity';
  END IF;
  IF NEW.credential_id IS NOT NULL AND
     resolve_guest_empty_owner_root_v1(NEW.credential_source_owner_id)<>NEW.source_owner_id THEN
    RAISE EXCEPTION 'issuance credential source mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_issuance_lineage_guard BEFORE INSERT ON guest_secret_issuance_operations
  FOR EACH ROW EXECUTE FUNCTION guard_guest_issuance_lineage_v1();

CREATE FUNCTION guard_guest_intent_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ceremony evidence is retained'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'awaiting_account' OR NEW.target_revision<>0 OR NEW.prepared_operation_id IS NOT NULL
       OR NEW.created_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp()
       OR resolve_guest_empty_owner_root_v1(NEW.credential_source_owner_id)<>NEW.owner_id
       OR resolve_guest_empty_owner_root_v1(NEW.owner_id)<>NEW.owner_id
       OR NOT EXISTS(SELECT 1 FROM guest_credentials WHERE credential_id=NEW.credential_id
         AND owner_id=NEW.credential_source_owner_id AND origin=NEW.origin AND state='confirmed') THEN
      RAISE EXCEPTION 'new ceremony requires its original live empty-target protocol';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.intent_id,NEW.owner_id,NEW.credential_source_owner_id,NEW.credential_id,
         NEW.origin,NEW.nonce_digest,NEW.created_at,NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.intent_id,OLD.owner_id,OLD.credential_source_owner_id,OLD.credential_id,
         OLD.origin,OLD.nonce_digest,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'ceremony proof identity is immutable';
  END IF;
  IF OLD.state IN ('expired','superseded') THEN
    IF (to_jsonb(NEW)-'owner_kind') IS DISTINCT FROM (to_jsonb(OLD)-'owner_kind') THEN
      RAISE EXCEPTION 'ceremony terminal state is final';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IN ('expired','superseded') THEN
    IF ROW(NEW.target_revision,NEW.target_account_id,NEW.target_session_digest,NEW.prepared_operation_id)
       IS DISTINCT FROM ROW(OLD.target_revision,OLD.target_account_id,OLD.target_session_digest,OLD.prepared_operation_id) THEN
      RAISE EXCEPTION 'terminal ceremony retains its displayed target';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state<>'awaiting_confirmation' OR clock_timestamp()>=OLD.expires_at
     OR NEW.target_revision<OLD.target_revision OR NEW.prepared_operation_id IS NULL THEN
    RAISE EXCEPTION 'invalid ceremony preparation';
  END IF;
  IF ROW(NEW.target_account_id,NEW.target_session_digest) IS DISTINCT FROM ROW(OLD.target_account_id,OLD.target_session_digest) THEN
    IF NEW.target_revision<>OLD.target_revision+1 OR NEW.prepared_operation_id IS NOT DISTINCT FROM OLD.prepared_operation_id THEN
      RAISE EXCEPTION 'changed target requires next revision and operation'; END IF;
  ELSIF ROW(NEW.target_revision,NEW.prepared_operation_id) IS DISTINCT FROM ROW(OLD.target_revision,OLD.prepared_operation_id) THEN
    RAISE EXCEPTION 'same target preparation must replay';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM guest_participation_operations WHERE operation_id=NEW.prepared_operation_id
      AND source_owner_id=NEW.owner_id AND operation_kind='attachment_prepare'
      AND resource_scope=NEW.intent_id) THEN
    RAISE EXCEPTION 'preparation must retain its owner operation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON guest_attachment_intents
  FOR EACH ROW EXECUTE FUNCTION guard_guest_intent_v1();

DO $bind_guest_lineage$
DECLARE signature TEXT; grantee_name TEXT; trusted_schema TEXT := current_schema();
BEGIN
  IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN
    RAISE EXCEPTION 'trusted migration schema required';
  END IF;
  FOREACH signature IN ARRAY ARRAY[
    'resolve_guest_empty_owner_root_v1(text)','guard_guest_issuance_lineage_v1()','guard_guest_intent_v1()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
    FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
      WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
  END LOOP;
END;
$bind_guest_lineage$;

-- Private digest-matched browser evidence and fresh database-clock lease readers.
CREATE FUNCTION read_guest_browser_proof_snapshot_v1(
  expected_origin TEXT,
  credential_proofs JSONB,
  intent_proofs JSONB,
  cleanup_operation BOOLEAN
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE AS $$
DECLARE
  maximum_proofs INTEGER;
  observed_at TIMESTAMPTZ;
  result JSONB;
BEGIN
  IF expected_origin IS NULL OR expected_origin NOT LIKE 'https://%'
     OR octet_length(expected_origin)>2048 OR cleanup_operation IS NULL
     OR credential_proofs IS NULL OR jsonb_typeof(credential_proofs)<>'array'
     OR intent_proofs IS NULL OR jsonb_typeof(intent_proofs)<>'array' THEN
    RAISE EXCEPTION 'invalid guest proof input' USING ERRCODE='22023';
  END IF;
  maximum_proofs := CASE WHEN cleanup_operation THEN 16 ELSE 4 END;
  IF jsonb_array_length(credential_proofs)>maximum_proofs
     OR jsonb_array_length(intent_proofs)>maximum_proofs THEN
    RAISE EXCEPTION 'invalid guest proof count' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(credential_proofs) p
    WHERE jsonb_typeof(p)<>'object'
      OR jsonb_typeof(p->'credentialId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p->'digest') IS DISTINCT FROM 'string'
      OR p->>'credentialId' !~ '^[A-Za-z0-9_-]{21}[AQgw]$'
      OR p->>'digest' !~ '^[0-9a-f]{64}$'
      OR p - 'credentialId' - 'digest' <> '{}'::JSONB)
    OR jsonb_array_length(credential_proofs)<>
       (SELECT count(DISTINCT p->>'credentialId') FROM jsonb_array_elements(credential_proofs) p)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(intent_proofs) p
      WHERE jsonb_typeof(p)<>'object'
        OR jsonb_typeof(p->'intentId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(p->'digest') IS DISTINCT FROM 'string'
        OR p->>'intentId' !~ '^gai_[A-Za-z0-9_-]{21}[AQgw]$'
        OR p->>'digest' !~ '^[0-9a-f]{64}$'
        OR p - 'intentId' - 'digest' <> '{}'::JSONB)
    OR jsonb_array_length(intent_proofs)<>
       (SELECT count(DISTINCT p->>'intentId') FROM jsonb_array_elements(intent_proofs) p) THEN
    RAISE EXCEPTION 'invalid guest proof shape' USING ERRCODE='22023';
  END IF;

  -- Same namespace as current0248 exclusive alias writer, before owner/media locks.
  -- This reader changes no product row. VOLATILE + explicit clock avoids cached authority.
  PERFORM pg_advisory_xact_lock_shared(83000003,1);
  observed_at := clock_timestamp();
  WITH credentials AS MATERIALIZED (
    SELECT c.*,resolve_guest_empty_owner_root_v1(c.owner_id) AS effective_owner
    FROM guest_credentials c JOIN jsonb_array_elements(credential_proofs) p
      ON c.credential_id=p->>'credentialId' AND c.secret_digest=p->>'digest'
    WHERE c.origin=expected_origin
  ), intents AS MATERIALIZED (
    SELECT i.*,resolve_guest_empty_owner_root_v1(i.credential_source_owner_id) AS effective_owner
    FROM guest_attachment_intents i JOIN jsonb_array_elements(intent_proofs) p
      ON i.intent_id=p->>'intentId' AND i.nonce_digest=p->>'digest'
    WHERE i.origin=expected_origin
  ) SELECT jsonb_build_object(
    'origin',expected_origin,
    'databaseObservedAt',to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'provedCredentials',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'credentialId',c.credential_id,
      'credentialSourceOwnerId',c.owner_id,
      'effectiveOwnerId',c.effective_owner,
      'ownerId',c.effective_owner,
      'origin',c.origin,'state',c.state,
      'leaseUntil',to_char(c.session_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'pendingExpiresAt',to_char(c.pending_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'predecessorCredentialId',c.predecessor_id,
      'pendingActive',c.state IN ('pending_bootstrap','pending_successor') AND c.pending_expires_at>observed_at,
      'learningLeaseActive',c.state='confirmed' AND COALESCE(c.session_until>observed_at,FALSE)
    ) ORDER BY c.credential_id COLLATE "C") FROM credentials c),'[]'::JSONB),
    'provedIntents',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'intentId',i.intent_id,'credentialId',i.credential_id,
      'credentialSourceOwnerId',i.credential_source_owner_id,
      'effectiveOwnerId',i.effective_owner,'ownerId',i.owner_id,
      'origin',i.origin,'state',i.state,
      'expiresAt',to_char(i.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'active',i.state IN ('awaiting_account','awaiting_confirmation') AND i.expires_at>observed_at
    ) ORDER BY i.intent_id COLLATE "C") FROM intents i),'[]'::JSONB)
  ) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION read_guest_browser_proof_snapshot_v1(TEXT,JSONB,JSONB,BOOLEAN) FROM PUBLIC;

-- Locator-only follow-up is NOT independent proof. It accepts only metadata from
-- the previously digest-verified snapshot and repeats state/root/clock checks.
-- No granting or renewing lease, no raw digest lookup, and no browser body authority.
CREATE FUNCTION read_guest_learning_lease_observation_v1(
  expected_origin TEXT, expected_credential_id TEXT,
  expected_effective_owner TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE AS $$
DECLARE observed_at TIMESTAMPTZ; result JSONB;
BEGIN
  IF expected_origin IS NULL OR expected_origin NOT LIKE 'https://%'
     OR octet_length(expected_origin)>2048 OR expected_credential_id IS NULL
     OR expected_credential_id !~ '^[A-Za-z0-9_-]{21}[AQgw]$'
     OR expected_effective_owner IS NULL
     OR expected_effective_owner !~ '^owner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid guest lease input' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(83000003,1);
  observed_at := clock_timestamp();
  SELECT jsonb_build_object(
    'credential',jsonb_build_object(
      'credentialId',c.credential_id,'credentialSourceOwnerId',c.owner_id,
      'effectiveOwnerId',expected_effective_owner,'origin',c.origin),
    'state','confirmed',
    'leaseUntil',to_char(c.session_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'databaseObservedAt',to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'active',c.session_until>observed_at
  ) INTO result FROM guest_credentials c
  WHERE c.credential_id=expected_credential_id AND c.origin=expected_origin
    AND c.state='confirmed'
    AND resolve_guest_empty_owner_root_v1(c.owner_id)=expected_effective_owner;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION read_guest_learning_lease_observation_v1(TEXT,TEXT,TEXT) FROM PUBLIC;

DO $private_guest_proof_projection$
DECLARE trusted_schema TEXT:=current_schema(); signature TEXT; grantee_name TEXT;
BEGIN
  IF trusted_schema IS NULL OR trusted_schema ~ '^pg_temp' OR trusted_schema='pg_catalog' THEN
    RAISE EXCEPTION 'trusted migration schema required';
  END IF;
  FOREACH signature IN ARRAY ARRAY[
    'read_guest_browser_proof_snapshot_v1(text,jsonb,jsonb,boolean)',
    'read_guest_learning_lease_observation_v1(text,text,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
    FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc f CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
      WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name); END LOOP;
  END LOOP;
END;
$private_guest_proof_projection$;
-- Root binds EXECUTE only to the independently verified actual approved reader role.
-- Keep all eight tables and private alias helper denied to ordinary runtime directly.
