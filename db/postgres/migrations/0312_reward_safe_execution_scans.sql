-- Reconciliation state for owner-executed Safe custody. The cursor records how far
-- the Safe's execution events have been read at the required confirmation depth
-- and only moves forward. An execution that might have run a prepared call but
-- cannot be bound to one by content is kept for operator review, never dropped.

CREATE TABLE reward_safe_execution_cursors (
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  safe_address TEXT NOT NULL CHECK (safe_address ~ '^0x[0-9a-f]{40}$'),
  next_block_number BIGINT NOT NULL CHECK (next_block_number >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, safe_address),
  FOREIGN KEY (chain_id, safe_address)
    REFERENCES reward_signer_nonces (chain_id, signer_address)
);

CREATE FUNCTION guard_reward_safe_execution_cursor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Safe execution cursors cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM reward_signer_nonces authority
       WHERE authority.chain_id = NEW.chain_id
         AND authority.signer_address = NEW.safe_address
         AND authority.nonce_authority = 'safe_owner_v1'
    ) THEN
      RAISE EXCEPTION 'Safe execution cursor requires a Safe nonce authority';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.chain_id, NEW.safe_address, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.chain_id, OLD.safe_address, OLD.created_at)
     OR NEW.next_block_number < OLD.next_block_number
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'Safe execution cursor only moves forward';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_safe_execution_cursors_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON reward_safe_execution_cursors
FOR EACH ROW EXECUTE FUNCTION guard_reward_safe_execution_cursor();

CREATE TABLE reward_safe_unbound_executions (
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  safe_address TEXT NOT NULL CHECK (safe_address ~ '^0x[0-9a-f]{40}$'),
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  safe_transaction_hash TEXT NOT NULL CHECK (safe_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  reason TEXT NOT NULL CHECK (reason IN ('undecodable')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, transaction_hash, log_index),
  FOREIGN KEY (chain_id, safe_address)
    REFERENCES reward_safe_execution_cursors (chain_id, safe_address)
);
CREATE TRIGGER reward_safe_unbound_executions_append_only
BEFORE UPDATE OR DELETE ON reward_safe_unbound_executions
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();

-- A Safe ExecutionFailure spends a nonce without paying, and its credit returns to
-- credited for a new call. One payout detail per credit therefore becomes one live
-- payout per credit: only a reverted owner-executed Safe payout stops counting. The
-- credit row lock taken by payout preparation serializes competing inserts, and the
-- credit state machine already refuses a second reservation.
ALTER TABLE reward_payout_effects DROP CONSTRAINT reward_payout_effects_credit_id_key;
CREATE INDEX reward_payout_effects_credit_idx ON reward_payout_effects (credit_id);

CREATE FUNCTION guard_reward_payout_effect_single_live() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reward_payout_effects payout
      JOIN reward_chain_effects effect ON effect.effect_id = payout.payout_effect_id
     WHERE payout.credit_id = NEW.credit_id
       AND payout.payout_effect_id <> NEW.payout_effect_id
       AND NOT (effect.execution_mode = 'safe_owner_v1' AND effect.state = 'reverted')
  ) THEN
    RAISE EXCEPTION 'reward credit already has a live payout' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_payout_effects_single_live
BEFORE INSERT ON reward_payout_effects
FOR EACH ROW EXECUTE FUNCTION guard_reward_payout_effect_single_live();

-- New money tables start with no inherited privileges; runtime access is granted only
-- by the reviewed release grant plan.
DO $acl$
DECLARE item RECORD; recipient RECORD;
BEGIN
 FOR item IN SELECT oid,relowner FROM pg_class WHERE relnamespace=current_schema()::regnamespace
   AND relname=ANY(ARRAY['reward_safe_execution_cursors','reward_safe_unbound_executions']) LOOP
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC CASCADE',item.oid::regclass);
  FOR recipient IN SELECT DISTINCT a.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid=item.oid AND a.grantee<>0 AND a.grantee<>item.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE %s FROM %I CASCADE',item.oid::regclass,pg_get_userbyid(recipient.grantee));
  END LOOP;
 END LOOP;
END $acl$;
