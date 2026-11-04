-- Forward repair; preserve the predecessor migration and its historical checksum.
-- Ordinal is provisional until parent merge-order mediation.
ALTER TABLE reward_safe_settlements_v1 ADD COLUMN preparation_owner TEXT
  CHECK(preparation_owner IS NULL OR preparation_owner ~ '^[0-9a-f-]{36}$');
-- Legacy signing rows have no owner and are lookup-only; never fabricate ownership.
CREATE OR REPLACE FUNCTION guard_reward_safe_settlement_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
    IF credit.credit_id IS NULL OR policy.policy_id IS NULL OR NEW.state<>'authorized' OR NEW.preparation_owner IS NOT NULL
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
      OR (OLD.state='authorized' AND NEW.state='signing' AND (NEW.preparation_owner IS NULL OR NEW.preparation_owner !~ '^[0-9a-f-]{36}$'))
      OR (OLD.state<>'authorized' AND NEW.preparation_owner IS DISTINCT FROM OLD.preparation_owner)
      OR NEW.updated_at<=OLD.updated_at
      OR NOT ((OLD.state='authorized' AND NEW.state='signing') OR (OLD.state='signing' AND NEW.state='signed')
        OR (OLD.state='signed' AND NEW.state='broadcast_unknown') OR (OLD.state='broadcast_unknown' AND NEW.state IN ('submitted','confirmed','held'))
        OR (OLD.state='submitted' AND NEW.state IN ('confirmed','held'))) THEN
      RAISE EXCEPTION 'invalid Safe settlement transition or identity change';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER reward_safe_settlement_v1_guard ON reward_safe_settlements_v1;
CREATE TRIGGER reward_safe_settlement_v1_guard BEFORE INSERT OR UPDATE OR DELETE ON reward_safe_settlements_v1
  FOR EACH ROW EXECUTE FUNCTION guard_reward_safe_settlement_v1();
CREATE OR REPLACE FUNCTION guard_reward_direct_safe_overlap_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Both routes serialize on the same credit before inspecting the other journal.
  PERFORM 1 FROM reward_ledger_credits WHERE credit_id=NEW.credit_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM reward_safe_settlements_v1 WHERE credit_id=NEW.credit_id) THEN
    RAISE EXCEPTION 'credit is assigned to versioned Safe settlement';
  END IF;
  RETURN NEW;
END $$;
DO $safe_v1_exact_permissions$
DECLARE table_name TEXT; role_name TEXT; signature TEXT; sequence_name TEXT; object_oid OID; trusted_schema TEXT:=current_schema();
BEGIN
  FOREACH table_name IN ARRAY ARRAY['reward_safe_backing_v1','reward_safe_policies_v1','reward_safe_settlement_events_v1','reward_safe_settlements_v1','reward_safe_solvency_v1'] LOOP
    object_oid:=to_regclass(format('%I.%I',trusted_schema,table_name));
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC CASCADE',trusted_schema,table_name);
    FOR role_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=object_oid AND a.grantee<>0 AND a.grantee<>c.relowner LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %I CASCADE',trusted_schema,table_name,role_name);
    END LOOP;
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['guard_reward_safe_policy_v1()','guard_reward_safe_settlement_v1()','guard_reward_safe_backing_v1()','guard_reward_direct_safe_overlap_v1()'] LOOP
    object_oid:=signature::regprocedure;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',signature);
    FOR role_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=object_oid AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',signature,role_name);
    END LOOP;
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I, pg_temp',signature,trusted_schema);
  END LOOP;
  FOREACH sequence_name IN ARRAY ARRAY['reward_safe_solvency_v1_observation_id_seq','reward_safe_settlement_events_v1_event_id_seq'] LOOP
    object_oid:=to_regclass(format('%I.%I',trusted_schema,sequence_name));
    IF object_oid IS NULL THEN RAISE EXCEPTION 'Safe identity sequence missing'; END IF;
    EXECUTE format('REVOKE ALL ON SEQUENCE %I.%I FROM PUBLIC CASCADE',trusted_schema,sequence_name);
    FOR role_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('s',c.relowner))) a
      WHERE c.oid=object_oid AND a.grantee<>0 AND a.grantee<>c.relowner LOOP
      EXECUTE format('REVOKE ALL ON SEQUENCE %I.%I FROM %I CASCADE',trusted_schema,sequence_name,role_name);
    END LOOP;
  END LOOP;
END;
$safe_v1_exact_permissions$;
