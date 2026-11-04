-- Versioned local-only Safe settlement. Historical direct ERC20 rows are untouched.
CREATE TABLE reward_safe_policies_v1 (
  policy_id TEXT PRIMARY KEY,
  attestation_id TEXT NOT NULL UNIQUE REFERENCES megapot_deployment_attestations(attestation_id),
  configuration JSONB NOT NULL,
  cap_atomic NUMERIC(78,0) NOT NULL CHECK (cap_atomic > 0),
  CHECK (configuration->>'version'='safe_credit_v1' AND configuration->>'posture'='local_only'),
  CHECK (configuration->>'policyId'=policy_id AND configuration->>'attestationId'=attestation_id),
  CHECK ((configuration->>'aggregateCapAtomic')::numeric=cap_atomic)
  ,CHECK (configuration ?& ARRAY['version','posture','policyId','attestationId','collectionRoot','safeRoot','token','module','moduleCodeHash','safeCodeHash','safeSingleton','safeSingletonCodeHash','relayer','creditAuthority','aggregateCapAtomic'])
  ,CHECK (configuration->>'collectionRoot'<>configuration->>'safeRoot')
  ,CHECK (configuration->>'creditAuthority'<>configuration->>'relayer' AND configuration->>'creditAuthority'<>configuration->>'collectionRoot' AND configuration->>'creditAuthority'<>configuration->>'safeRoot')
);
CREATE UNIQUE INDEX reward_safe_policy_v1_module ON reward_safe_policies_v1((configuration->>'module'));
CREATE TABLE reward_safe_solvency_v1 (
  observation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES reward_safe_policies_v1(policy_id),
  block_number BIGINT NOT NULL CHECK(block_number>=0), block_hash TEXT NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
  collection_balance_atomic NUMERIC(78,0) NOT NULL CHECK(collection_balance_atomic>=0),
  safe_balance_atomic NUMERIC(78,0) NOT NULL CHECK(safe_balance_atomic>=0),
  liabilities JSONB NOT NULL, solvent BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE reward_safe_settlements_v1 (
  credit_id TEXT PRIMARY KEY REFERENCES reward_ledger_credits(credit_id),
  policy_id TEXT NOT NULL REFERENCES reward_safe_policies_v1(policy_id),
  candidate JSONB NOT NULL, credit_authorization JSONB NOT NULL,
  amount_atomic NUMERIC(78,0) NOT NULL CHECK (amount_atomic>0),
  state TEXT NOT NULL CHECK (state IN ('authorized','signing','signed','broadcast_unknown','submitted','confirmed','held')),
  relayer_address TEXT NOT NULL CHECK (relayer_address ~ '^0x[0-9a-f]{40}$'),
  nonce NUMERIC(78,0), unsigned_transaction JSONB, raw_transaction TEXT, transaction_hash TEXT,
  module_log_index INTEGER, transfer_log_index INTEGER, block_number BIGINT, block_hash TEXT, receipt_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='authorized' AND nonce IS NULL AND unsigned_transaction IS NULL AND raw_transaction IS NULL AND transaction_hash IS NULL)
    OR (state='signing' AND nonce IS NOT NULL AND unsigned_transaction IS NOT NULL AND raw_transaction IS NULL AND transaction_hash IS NULL)
    OR (state IN ('signed','broadcast_unknown','submitted','confirmed','held') AND nonce IS NOT NULL AND unsigned_transaction IS NOT NULL AND raw_transaction IS NOT NULL AND transaction_hash IS NOT NULL)),
  CHECK (raw_transaction IS NULL OR raw_transaction ~ '^0x([0-9a-f]{2})+$'),
  CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
  CHECK ((state='confirmed' AND module_log_index IS NOT NULL AND transfer_log_index IS NOT NULL AND module_log_index<>transfer_log_index
      AND block_number IS NOT NULL AND block_hash ~ '^0x[0-9a-f]{64}$' AND receipt_hash ~ '^[0-9a-f]{64}$')
    OR (state<>'confirmed' AND module_log_index IS NULL AND transfer_log_index IS NULL AND block_number IS NULL AND block_hash IS NULL AND receipt_hash IS NULL)),
  UNIQUE (relayer_address,nonce), UNIQUE(transaction_hash,module_log_index), UNIQUE(transaction_hash,transfer_log_index)
);
CREATE TABLE reward_safe_settlement_events_v1 (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credit_id TEXT NOT NULL REFERENCES reward_safe_settlements_v1(credit_id),
  state TEXT NOT NULL, evidence JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE reward_safe_backing_v1 (
  policy_id TEXT PRIMARY KEY REFERENCES reward_safe_policies_v1(policy_id),
  amount_atomic NUMERIC(78,0) NOT NULL CHECK(amount_atomic>0),
  state TEXT NOT NULL CHECK(state IN ('signing','signed','broadcast_unknown','submitted','confirmed','held')),
  unsigned_transaction JSONB NOT NULL, raw_transaction TEXT, transaction_hash TEXT,
  evidence JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='signing' AND raw_transaction IS NULL AND transaction_hash IS NULL) OR
    (state<>'signing' AND raw_transaction ~ '^0x([0-9a-f]{2})+$' AND transaction_hash ~ '^0x[0-9a-f]{64}$')),
  CHECK ((state IN ('confirmed','held') AND evidence IS NOT NULL) OR (state NOT IN ('confirmed','held') AND evidence IS NULL))
);
CREATE FUNCTION guard_reward_safe_backing_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Safe backing journal is retained'; END IF;
  IF ROW(NEW.policy_id,NEW.amount_atomic,NEW.unsigned_transaction,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.policy_id,OLD.amount_atomic,OLD.unsigned_transaction,OLD.created_at)
    OR (OLD.raw_transaction IS NOT NULL AND ROW(NEW.raw_transaction,NEW.transaction_hash) IS DISTINCT FROM ROW(OLD.raw_transaction,OLD.transaction_hash))
    OR NEW.updated_at<=OLD.updated_at
    OR NOT ((OLD.state='signing' AND NEW.state='signed') OR (OLD.state='signed' AND NEW.state='broadcast_unknown')
      OR (OLD.state='broadcast_unknown' AND NEW.state IN ('submitted','confirmed','held')) OR (OLD.state='submitted' AND NEW.state IN ('confirmed','held'))) THEN
    RAISE EXCEPTION 'invalid Safe backing transition or identity change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reward_safe_backing_v1_guard BEFORE UPDATE OR DELETE ON reward_safe_backing_v1 FOR EACH ROW EXECUTE FUNCTION guard_reward_safe_backing_v1();
CREATE FUNCTION guard_reward_safe_policy_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Safe policy identity is immutable'; END $$;
CREATE TRIGGER reward_safe_policy_v1_immutable BEFORE UPDATE OR DELETE ON reward_safe_policies_v1
  FOR EACH ROW EXECUTE FUNCTION guard_reward_safe_policy_v1();
CREATE FUNCTION guard_reward_safe_settlement_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  credit reward_ledger_credits%ROWTYPE;
  policy reward_safe_policies_v1%ROWTYPE;
  reserved_total NUMERIC(78,0);
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Safe settlements are retained'; END IF;
  IF TG_OP='INSERT' THEN
    PERFORM require_reward_run_authority_v1();
    SELECT * INTO policy FROM reward_safe_policies_v1 WHERE policy_id=NEW.policy_id FOR UPDATE;
    SELECT * INTO credit FROM reward_ledger_credits WHERE credit_id=NEW.credit_id FOR UPDATE;
    SELECT coalesce(sum(amount_atomic),0) INTO reserved_total FROM reward_safe_settlements_v1 WHERE policy_id=NEW.policy_id;
    IF credit.credit_id IS NULL OR policy.policy_id IS NULL OR NEW.state<>'authorized'
      OR NEW.amount_atomic<>credit.amount_atomic OR credit.state<>'credited' OR credit.paid_atomic<>0 OR credit.reserved_atomic<>0
      OR credit.chain_id<>8453 OR credit.token_address<>policy.configuration->>'token'
      OR NEW.relayer_address<>policy.configuration->>'relayer'
      OR NOT (NEW.candidate ?& ARRAY['creditId','accountId','personaId','walletAssignmentId','recipient','amountAtomic'])
      OR NEW.candidate->>'creditId'<>credit.credit_id OR NEW.candidate->>'accountId'<>credit.account_id
      OR NEW.candidate->>'personaId'<>credit.payout_persona_id OR (NEW.candidate->>'amountAtomic')::numeric<>credit.amount_atomic
      OR NOT (NEW.credit_authorization ?& ARRAY['digest','signature','validUntil','issuerKeyId'])
      OR NEW.credit_authorization->>'digest' !~ '^0x[0-9a-f]{64}$'
      OR NEW.credit_authorization->>'signature' !~ '^0x[0-9a-f]{130}$'
      OR (NEW.credit_authorization->>'validUntil')::numeric<=0
      OR NOT EXISTS (SELECT 1 FROM persona_wallet_assignments w WHERE w.assignment_id=NEW.candidate->>'walletAssignmentId'
        AND w.account_id=credit.account_id AND w.persona_id=credit.payout_persona_id AND w.address=NEW.candidate->>'recipient'
        AND w.status='active' AND w.chain_account_kind='evm')
      OR NOT EXISTS (SELECT 1 FROM megapot_allocations a JOIN megapot_allocation_batches b USING(allocation_batch_id)
        JOIN song_reward_offer_legs l ON l.leg_id=b.pool_leg_id JOIN megapot_deployment_attestations pin ON pin.attestation_id=l.attestation_id
        WHERE a.credit_id=credit.credit_id AND l.attestation_id=policy.attestation_id
          AND pin.custody_address=policy.configuration->>'collectionRoot' AND pin.usdc_address=policy.configuration->>'token' AND pin.chain_id=8453)
      OR NOT ((credit.source_kind='megapot_allocation' AND EXISTS(SELECT 1 FROM megapot_participant_claims c WHERE c.credit_id=credit.credit_id AND c.status='accepted')) OR credit.source_kind='external_fallback')
      OR EXISTS(SELECT 1 FROM reward_payout_effects WHERE credit_id=credit.credit_id)
      OR reserved_total+NEW.amount_atomic>policy.cap_atomic THEN
      RAISE EXCEPTION 'Safe credit reservation authority or aggregate cap mismatch';
    END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.credit_id,NEW.policy_id,NEW.candidate,NEW.credit_authorization,NEW.amount_atomic,NEW.relayer_address,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.credit_id,OLD.policy_id,OLD.candidate,OLD.credit_authorization,OLD.amount_atomic,OLD.relayer_address,OLD.created_at)
      OR (OLD.nonce IS NOT NULL AND NEW.nonce IS DISTINCT FROM OLD.nonce)
      OR (OLD.unsigned_transaction IS NOT NULL AND NEW.unsigned_transaction IS DISTINCT FROM OLD.unsigned_transaction)
      OR (OLD.raw_transaction IS NOT NULL AND ROW(NEW.raw_transaction,NEW.transaction_hash) IS DISTINCT FROM ROW(OLD.raw_transaction,OLD.transaction_hash))
      OR NEW.updated_at<=OLD.updated_at
      OR NOT ((OLD.state='authorized' AND NEW.state='signing') OR (OLD.state='signing' AND NEW.state='signed')
        OR (OLD.state='signed' AND NEW.state='broadcast_unknown') OR (OLD.state='broadcast_unknown' AND NEW.state IN ('submitted','confirmed','held'))
        OR (OLD.state='submitted' AND NEW.state IN ('confirmed','held'))) THEN
      RAISE EXCEPTION 'invalid Safe settlement transition or identity change';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reward_safe_settlement_v1_guard BEFORE UPDATE OR DELETE ON reward_safe_settlements_v1
  FOR EACH ROW EXECUTE FUNCTION guard_reward_safe_settlement_v1();
CREATE TRIGGER reward_safe_events_v1_immutable BEFORE UPDATE OR DELETE ON reward_safe_settlement_events_v1
  FOR EACH ROW EXECUTE FUNCTION guard_reward_safe_policy_v1();
CREATE TRIGGER reward_safe_solvency_v1_immutable BEFORE UPDATE OR DELETE ON reward_safe_solvency_v1
  FOR EACH ROW EXECUTE FUNCTION guard_reward_safe_policy_v1();
CREATE FUNCTION guard_reward_direct_safe_overlap_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM reward_safe_settlements_v1 WHERE credit_id=NEW.credit_id) THEN
    RAISE EXCEPTION 'credit is assigned to versioned Safe settlement';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reward_direct_safe_overlap_v1 BEFORE INSERT ON reward_payout_effects
  FOR EACH ROW EXECUTE FUNCTION guard_reward_direct_safe_overlap_v1();

-- Source-only local route: inherit no runtime grant. Operator/key
-- policy and any application grants require separate parent mediation.
DO $safe_v1_permissions$
DECLARE table_name TEXT; role_name TEXT; signature TEXT; table_oid OID; trusted_schema TEXT:=current_schema();
BEGIN
  FOREACH table_name IN ARRAY ARRAY['reward_safe_backing_v1','reward_safe_policies_v1','reward_safe_settlement_events_v1','reward_safe_settlements_v1','reward_safe_solvency_v1'] LOOP
    table_oid:=to_regclass(format('%I.%I',trusted_schema,table_name));
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
    FOR role_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=table_oid AND a.grantee<>0 AND a.grantee<>c.relowner LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,role_name);
    END LOOP;
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['guard_reward_safe_policy_v1()','guard_reward_safe_settlement_v1()','guard_reward_safe_backing_v1()','guard_reward_direct_safe_overlap_v1()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I, pg_temp',signature,trusted_schema);
  END LOOP;
END;
$safe_v1_permissions$;
