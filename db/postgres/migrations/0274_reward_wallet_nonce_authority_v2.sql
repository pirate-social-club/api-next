-- PROVISIONAL ordinal on main270 only. Rebase/ordinal/checksum/baseline and
-- independent committed-migration review are required BEFORE apply or merge.
-- EOA persona-wallet instruction nonces only, never custody-signer/refund nonces.
-- Append-only ownership; consumption comes ONLY from exact accepted winner
-- outcomes. V2 consumption and purpose-grant persistence are later source work.
CREATE TABLE reward_wallet_nonce_leases (
  lease_id TEXT PRIMARY KEY CHECK (btrim(lease_id) <> '' AND octet_length(lease_id) <= 256),
  source TEXT NOT NULL CHECK (source IN ('winner_attempt_v1','song_funding_v2')),
  owner_id TEXT NOT NULL CHECK (btrim(owner_id) <> '' AND octet_length(owner_id) <= 128),
  owner_revision INTEGER NOT NULL CHECK (owner_revision > 0),
  command_id TEXT UNIQUE CHECK (btrim(command_id) <> '' AND octet_length(command_id) <= 128),
  account_id TEXT NOT NULL REFERENCES users(user_id),
  persona_id TEXT NOT NULL,
  wallet_assignment_id TEXT NOT NULL REFERENCES persona_wallet_assignments(assignment_id),
  chain_id BIGINT NOT NULL CHECK (chain_id > 0 AND chain_id <= 9007199254740991),
  sender_address TEXT NOT NULL CHECK (sender_address ~ '^0x[0-9a-f]{40}$'),
  nonce BIGINT NOT NULL CHECK (nonce >= 0),
  request_hash TEXT CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  winner_send_id TEXT,
  winner_attempt INTEGER,
  witness_id TEXT UNIQUE CHECK (witness_id ~ '^[0-9a-f]{64}$'),
  observed_at_ms BIGINT CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  confirmed_block BIGINT CHECK (confirmed_block >= 0),
  confirmed_block_hash TEXT CHECK (confirmed_block_hash ~ '^[0-9a-f]{64}$'),
  pending_base_block BIGINT CHECK (pending_base_block >= 0),
  pending_base_hash TEXT CHECK (pending_base_hash ~ '^[0-9a-f]{64}$'),
  confirmed_nonce BIGINT CHECK (confirmed_nonce >= 0),
  pending_nonce BIGINT CHECK (pending_nonce >= 0),
  freshness_policy_hash TEXT CHECK (freshness_policy_hash ~ '^[0-9a-f]{64}$'),
  max_age_ms BIGINT CHECK (max_age_ms BETWEEN 1 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (chain_id,sender_address,nonce),
  UNIQUE (source,owner_id,owner_revision),
  FOREIGN KEY (account_id,persona_id) REFERENCES personas(account_id,persona_id),
  FOREIGN KEY (winner_send_id,winner_attempt)
    REFERENCES reward_winner_send_attempts(send_id,attempt),
  CONSTRAINT reward_wallet_nonce_provenance CHECK (
    (source='winner_attempt_v1' AND owner_id=winner_send_id AND owner_revision=winner_attempt
      AND winner_send_id IS NOT NULL AND winner_attempt IS NOT NULL
      AND command_id IS NULL AND request_hash IS NULL AND witness_id IS NULL
      AND observed_at_ms IS NULL AND confirmed_block IS NULL AND confirmed_block_hash IS NULL
      AND pending_base_block IS NULL AND pending_base_hash IS NULL
      AND confirmed_nonce IS NULL AND pending_nonce IS NULL
      AND freshness_policy_hash IS NULL AND max_age_ms IS NULL)
    OR (source='song_funding_v2' AND owner_revision=1
      AND command_id IS NOT NULL AND request_hash IS NOT NULL
      AND winner_send_id IS NULL AND winner_attempt IS NULL
      AND witness_id IS NOT NULL AND observed_at_ms IS NOT NULL
      AND confirmed_block IS NOT NULL AND confirmed_block_hash IS NOT NULL
      AND pending_base_block IS NOT NULL AND pending_base_hash IS NOT NULL
      AND confirmed_nonce IS NOT NULL AND pending_nonce IS NOT NULL
      AND freshness_policy_hash IS NOT NULL AND max_age_ms IS NOT NULL
      AND nonce=confirmed_nonce AND nonce=pending_nonce
      AND confirmed_block=pending_base_block AND confirmed_block_hash=pending_base_hash)
  )
);

-- Exact stored evidence only. Duplicate historical ownership fails migration;
-- it is never silently deduplicated or inferred from transaction amounts.
-- Backfill precedes new-admission guards, so open history is retained as open.
INSERT INTO reward_wallet_nonce_leases (
  lease_id,source,owner_id,owner_revision,account_id,persona_id,wallet_assignment_id,
  chain_id,sender_address,nonce,winner_send_id,winner_attempt,created_at
)
SELECT 'winner:'||a.send_id||':'||a.attempt,'winner_attempt_v1',a.send_id,a.attempt,
       a.account_id,s.persona_id,s.wallet_assignment_id,s.chain_id,s.sender_address,
       a.nonce,a.send_id,a.attempt,a.created_at
  FROM reward_winner_send_attempts a JOIN reward_winner_sends s USING(send_id)
 WHERE a.account_id=s.account_id;
DO $$ BEGIN
  IF (SELECT count(*) FROM reward_wallet_nonce_leases) <>
     (SELECT count(*) FROM reward_winner_send_attempts) THEN
    RAISE EXCEPTION 'winner nonce backfill has missing or foreign account provenance';
  END IF;
  IF EXISTS (
    SELECT 1 FROM reward_wallet_nonce_leases l
      LEFT JOIN persona_wallet_assignments w ON w.assignment_id=l.wallet_assignment_id
     WHERE w.assignment_id IS NULL OR w.account_id<>l.account_id OR w.persona_id<>l.persona_id
       OR w.address IS DISTINCT FROM l.sender_address OR w.chain_account_kind<>'evm'
  ) THEN
    RAISE EXCEPTION 'winner nonce backfill has foreign wallet provenance';
  END IF;
END $$;

CREATE FUNCTION lock_reward_wallet_nonce_sender_v2(p_chain BIGINT,p_sender TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_chain IS NULL OR p_chain <= 0 OR p_chain > 9007199254740991
     OR p_sender IS NULL OR p_sender !~ '^0x[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'invalid sender identity' USING ERRCODE='PWN01';
  END IF;
  -- Preserve the accepted winner lock key; no funding-only competing mutex.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'reward-winner-send:'||p_chain::text||':'||p_sender,0));
END $$;

CREATE FUNCTION reward_wallet_nonce_context_v2(
  p_chain BIGINT,p_sender TEXT,p_own_winner TEXT
) RETURNS TABLE(highest_nonce BIGINT,blocked_reason TEXT)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT (SELECT max(nonce) FROM reward_wallet_nonce_leases
           WHERE chain_id=p_chain AND sender_address=p_sender),
    CASE
      -- V1 records contain no nonce. Even a hash or a terminal state is NOT
      -- exact nonce provenance. Reconciliation is later, not a guessed import.
      WHEN EXISTS (SELECT 1 FROM song_reward_leg_funding_effects
                    WHERE chain_id=p_chain AND sender_address=p_sender)
        THEN 'unknown_v1_funding'
      -- Sponsored history also has no exact EOA nonce in this accepted base.
      -- Neither abandonment by time nor a missing hash proves it unsigned.
      WHEN EXISTS (SELECT 1 FROM wallet_sponsored_sends
                    WHERE chain_id=p_chain AND sender_address=p_sender)
        OR EXISTS (SELECT 1 FROM reward_winner_sends
                    WHERE chain_id=p_chain AND sender_address=p_sender
                      AND send_id IS DISTINCT FROM p_own_winner
                      AND status IN ('retryable','pending'))
        THEN 'other_instruction'
      WHEN EXISTS (
        SELECT 1 FROM reward_wallet_nonce_leases l
         WHERE l.chain_id=p_chain AND l.sender_address=p_sender AND (
           l.source='song_funding_v2'
           OR NOT EXISTS (
             SELECT 1 FROM reward_winner_send_outcomes o
              WHERE o.send_id=l.winner_send_id AND o.attempt=l.winner_attempt
                AND o.observed_confirmed_nonce > l.nonce
           )
         )
      ) THEN 'outstanding_nonce'
      ELSE NULL
    END::TEXT
$$;

CREATE FUNCTION reject_reward_wallet_nonce_history_change_v2() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'wallet nonce ownership is append-only';
END $$;
CREATE TRIGGER reward_wallet_nonce_leases_append_only
  BEFORE UPDATE OR DELETE ON reward_wallet_nonce_leases FOR EACH ROW
  EXECUTE FUNCTION reject_reward_wallet_nonce_history_change_v2();
CREATE TRIGGER reward_wallet_nonce_leases_no_truncate
  BEFORE TRUNCATE ON reward_wallet_nonce_leases FOR EACH STATEMENT
  EXECUTE FUNCTION reject_reward_wallet_nonce_history_change_v2();

CREATE FUNCTION guard_reward_wallet_nonce_lease_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  history RECORD;
  paused BOOLEAN;
BEGIN
  PERFORM lock_reward_wallet_nonce_sender_v2(NEW.chain_id,NEW.sender_address);
  IF NEW.source='winner_attempt_v1' THEN
    IF NOT EXISTS (
      SELECT 1 FROM reward_winner_send_attempts a
        JOIN reward_winner_sends s USING(send_id)
       WHERE a.send_id=NEW.winner_send_id AND a.attempt=NEW.winner_attempt
         AND a.nonce=NEW.nonce AND a.account_id=NEW.account_id AND s.account_id=NEW.account_id
         AND s.persona_id=NEW.persona_id AND s.wallet_assignment_id=NEW.wallet_assignment_id
         AND s.chain_id=NEW.chain_id AND s.sender_address=NEW.sender_address
    ) THEN RAISE EXCEPTION 'missing exact winner provenance' USING ERRCODE='PWN01'; END IF;
  ELSIF NEW.source='song_funding_v2' THEN
    -- Original community-persona ownership is checked, never a foreign wallet.
    IF NOT EXISTS (
      SELECT 1 FROM persona_wallet_assignments w JOIN personas p
        ON p.account_id=w.account_id AND p.persona_id=w.persona_id
       WHERE w.assignment_id=NEW.wallet_assignment_id AND w.account_id=NEW.account_id
         AND w.persona_id=NEW.persona_id AND w.address=NEW.sender_address
         AND w.chain_account_kind='evm' AND w.status='active' AND p.status='active'
    ) THEN RAISE EXCEPTION 'foreign or inactive wallet owner' USING ERRCODE='PWN01'; END IF;
    SELECT c.paused INTO paused FROM reward_operations_control c WHERE singleton FOR SHARE;
    IF paused IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
    END IF;
    PERFORM require_reward_run_authority_v1();
    IF NEW.observed_at_ms > floor(extract(epoch FROM clock_timestamp())*1000)
       OR floor(extract(epoch FROM clock_timestamp())*1000)-NEW.observed_at_ms > NEW.max_age_ms THEN
      RAISE EXCEPTION 'stale nonce witness' USING ERRCODE='PWN04';
    END IF;
  ELSE RAISE EXCEPTION 'invalid nonce operation' USING ERRCODE='PWN01'; END IF;
  SELECT * INTO history FROM reward_wallet_nonce_context_v2(
    NEW.chain_id,NEW.sender_address,NEW.winner_send_id);
  IF history.blocked_reason IS NOT NULL THEN
    RAISE EXCEPTION 'outstanding wallet instruction or unknown history' USING ERRCODE='PWN02';
  END IF;
  IF history.highest_nonce IS NOT NULL AND NEW.nonce <= history.highest_nonce THEN
    RAISE EXCEPTION 'nonce already owned or consumed' USING ERRCODE='PWN03';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reward_wallet_nonce_lease_guard BEFORE INSERT ON reward_wallet_nonce_leases
  FOR EACH ROW EXECUTE FUNCTION guard_reward_wallet_nonce_lease_v2();

CREATE FUNCTION record_reward_winner_nonce_lease_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
  INSERT INTO reward_wallet_nonce_leases (
    lease_id,source,owner_id,owner_revision,account_id,persona_id,wallet_assignment_id,
    chain_id,sender_address,nonce,winner_send_id,winner_attempt
  ) SELECT 'winner:'||NEW.send_id||':'||NEW.attempt,'winner_attempt_v1',NEW.send_id,NEW.attempt,
           NEW.account_id,s.persona_id,s.wallet_assignment_id,s.chain_id,s.sender_address,
           NEW.nonce,NEW.send_id,NEW.attempt
      FROM reward_winner_sends s WHERE s.send_id=NEW.send_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing winner owner' USING ERRCODE='PWN01'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reward_winner_attempt_nonce_history_v2 AFTER INSERT ON reward_winner_send_attempts
  FOR EACH ROW EXECUTE FUNCTION record_reward_winner_nonce_lease_v2();

-- Fence original instruction producers too. They cannot race a V2 lease.
-- Taking this lock first also preserves one shared->old-mode-lock order.
CREATE FUNCTION guard_reward_wallet_instruction_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE h RECORD;
BEGIN
  PERFORM lock_reward_wallet_nonce_sender_v2(NEW.chain_id,NEW.sender_address);
  SELECT * INTO h FROM reward_wallet_nonce_context_v2(NEW.chain_id,NEW.sender_address,NULL);
  IF h.blocked_reason IS NOT NULL THEN
    RAISE EXCEPTION 'wallet has outstanding nonce ownership' USING ERRCODE='PWN02';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_reward_wallet_instruction_v2 BEFORE INSERT ON reward_winner_sends
  FOR EACH ROW EXECUTE FUNCTION guard_reward_wallet_instruction_v2();
CREATE TRIGGER a_reward_wallet_instruction_v2 BEFORE INSERT ON wallet_sponsored_sends
  FOR EACH ROW EXECUTE FUNCTION guard_reward_wallet_instruction_v2();
CREATE TRIGGER a_reward_wallet_instruction_v2 BEFORE INSERT ON song_reward_leg_funding_effects
  FOR EACH ROW EXECUTE FUNCTION guard_reward_wallet_instruction_v2();
CREATE FUNCTION lock_reward_winner_attempt_sender_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s RECORD;
BEGIN
  SELECT chain_id,sender_address INTO STRICT s FROM reward_winner_sends WHERE send_id=NEW.send_id;
  PERFORM lock_reward_wallet_nonce_sender_v2(s.chain_id,s.sender_address);
  RETURN NEW;
END $$;
CREATE TRIGGER a_reward_wallet_attempt_lock_v2 BEFORE INSERT ON reward_winner_send_attempts
  FOR EACH ROW EXECUTE FUNCTION lock_reward_winner_attempt_sender_v2();

CREATE FUNCTION reserve_reward_funding_wallet_nonce_v2(p JSONB)
RETURNS SETOF reward_wallet_nonce_leases LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid nonce reservation shape' USING ERRCODE='PWN01';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p) AS keys(key) WHERE key <> ALL(ARRAY[
      'lease_id','owner_id','command_id','account_id','persona_id','wallet_assignment_id',
      'chain_id','sender_address','request_hash','nonce','witness_id','observed_at_ms',
      'confirmed_block','confirmed_block_hash','pending_base_block','pending_base_hash',
      'confirmed_nonce','pending_nonce','freshness_policy_hash','max_age_ms'
    ])
  ) THEN RAISE EXCEPTION 'invalid nonce reservation shape' USING ERRCODE='PWN01'; END IF;
  RETURN QUERY INSERT INTO reward_wallet_nonce_leases (
    lease_id,source,owner_id,owner_revision,command_id,account_id,persona_id,wallet_assignment_id,
    chain_id,sender_address,request_hash,nonce,witness_id,observed_at_ms,
    confirmed_block,confirmed_block_hash,pending_base_block,pending_base_hash,
    confirmed_nonce,pending_nonce,freshness_policy_hash,max_age_ms
  ) VALUES (
    p->>'lease_id','song_funding_v2',p->>'owner_id',1,p->>'command_id',p->>'account_id',
    p->>'persona_id',p->>'wallet_assignment_id',(p->>'chain_id')::BIGINT,p->>'sender_address',
    p->>'request_hash',(p->>'nonce')::BIGINT,p->>'witness_id',(p->>'observed_at_ms')::BIGINT,
    (p->>'confirmed_block')::BIGINT,p->>'confirmed_block_hash',
    (p->>'pending_base_block')::BIGINT,p->>'pending_base_hash',
    (p->>'confirmed_nonce')::BIGINT,(p->>'pending_nonce')::BIGINT,
    p->>'freshness_policy_hash',(p->>'max_age_ms')::BIGINT
  ) RETURNING *;
END $$;

CREATE FUNCTION load_reward_funding_wallet_nonce_owner_v2(p JSONB)
RETURNS SETOF reward_wallet_nonce_leases LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT l.* FROM reward_wallet_nonce_leases l
   WHERE l.source='song_funding_v2' AND l.lease_id=p->>'lease_id'
     AND l.owner_id=p->>'owner_id' AND l.command_id=p->>'command_id'
     AND l.account_id=p->>'account_id' AND l.persona_id=p->>'persona_id'
     AND l.wallet_assignment_id=p->>'wallet_assignment_id'
     AND l.chain_id=(p->>'chain_id')::BIGINT AND l.sender_address=p->>'sender_address'
     AND l.request_hash=p->>'request_hash'
$$;

-- Remove ALL inherited/default direct grants on the new authority, including
-- DELETE/TRUNCATE/UPDATE. No runtime role receives raw DML or V2 execution.
-- Only existing actual winner-attempt INSERT roles receive lock/context reads.
-- V2 CP5 grants remain a separate exact-reviewed deliverable, not a PUBLIC API.
DO $permissions$
DECLARE r TEXT; f RECORD; trusted TEXT := current_schema();
BEGIN
  REVOKE ALL ON reward_wallet_nonce_leases FROM PUBLIC CASCADE;
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee)
    FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='reward_wallet_nonce_leases'::regclass AND a.grantee<>0 AND a.grantee<>c.relowner
  LOOP EXECUTE format('REVOKE ALL ON %I.reward_wallet_nonce_leases FROM %I CASCADE',trusted,r); END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    WHERE p.pronamespace=to_regnamespace(trusted) AND p.proname IN (
      'lock_reward_wallet_nonce_sender_v2','reward_wallet_nonce_context_v2',
      'reject_reward_wallet_nonce_history_change_v2','guard_reward_wallet_nonce_lease_v2',
      'record_reward_winner_nonce_lease_v2','guard_reward_wallet_instruction_v2',
      'lock_reward_winner_attempt_sender_v2','reserve_reward_funding_wallet_nonce_v2',
      'load_reward_funding_wallet_nonce_owner_v2'
    )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
    FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=f.signature::oid AND a.grantee<>0 AND a.grantee<>p.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r); END LOOP;
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I, pg_temp',f.signature,trusted);
  END LOOP;
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee)
    FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='reward_winner_send_attempts'::regclass AND a.grantee<>0 AND a.grantee<>c.relowner
      AND a.privilege_type='INSERT'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION lock_reward_wallet_nonce_sender_v2(bigint,text) TO %I',r);
    EXECUTE format('GRANT EXECUTE ON FUNCTION reward_wallet_nonce_context_v2(bigint,text,text) TO %I',r);
  END LOOP;
END;
$permissions$;
