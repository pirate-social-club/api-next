-- Safe refunds consume the V2 receipt ledger. Original receipts, late liabilities
-- and completed refund evidence remain append-only; no historical row is rewritten.
CREATE TABLE reward_safe_refunds_v1 (
  refund_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES reward_incoming_receipts_v2,
  contribution_id TEXT NOT NULL UNIQUE REFERENCES song_megapot_contributions_v2,
  pool_leg_id TEXT NOT NULL REFERENCES song_reward_offer_legs,
  attestation_id TEXT NOT NULL REFERENCES megapot_deployment_attestations,
  category TEXT NOT NULL CHECK(category IN ('late_principal','unspent_budget')),
  account_id TEXT NOT NULL REFERENCES users(user_id),
  original_sender TEXT NOT NULL CHECK(original_sender ~ '^0x[a-f0-9]{40}$'),
  amount_atomic reward_funding_atomic_v2 NOT NULL CHECK(amount_atomic>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE reward_safe_refund_attempts_v1 (
  effect_id TEXT PRIMARY KEY REFERENCES reward_chain_effects,
  refund_id TEXT NOT NULL REFERENCES reward_safe_refunds_v1,
  solvency_observation_id TEXT NOT NULL REFERENCES custody_solvency_observations,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reward_safe_refund_attempts_by_refund_v1 ON reward_safe_refund_attempts_v1(refund_id);
CREATE TABLE reward_safe_refund_completions_v1 (
  refund_id TEXT PRIMARY KEY REFERENCES reward_safe_refunds_v1,
  effect_id TEXT NOT NULL UNIQUE REFERENCES reward_erc20_transfer_receipt_evidence(effect_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DO $immutable$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['reward_safe_refunds_v1','reward_safe_refund_attempts_v1','reward_safe_refund_completions_v1'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_reward_contribution_history_v2()',t||'_append_only',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_reward_contribution_history_v2()',t||'_no_truncate',t);
  END LOOP;
END $immutable$;

-- Late money never enters leg.funded_atomic. A prepared, uncertain or failed
-- outbound call does not discharge it; only its unique confirmed completion does.
CREATE FUNCTION reward_unpaid_late_principal_atomic_v2(p_chain BIGINT,p_token TEXT)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce(sum(l.amount_atomic),0)
  FROM reward_late_principal_liabilities_v2 l
  JOIN song_megapot_contributions_v2 c USING(contribution_id)
  WHERE (c.state->'receipt'->'instruction'->>'chain_id')::BIGINT=p_chain
    AND c.state->'receipt'->'instruction'->>'to_token'=p_token
    AND NOT EXISTS (
      SELECT 1 FROM reward_safe_refunds_v1 r
      JOIN reward_safe_refund_completions_v1 done USING(refund_id)
      WHERE r.receipt_id=l.receipt_id AND r.category='late_principal'
    )
$$;

CREATE FUNCTION reward_offer_has_unfinalized_contribution_v2(p_offer TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM song_reward_offer_legs leg
    JOIN song_megapot_contributions_v2 c ON c.pool_leg_id=leg.leg_id
    WHERE leg.offer_id=p_offer AND (c.state->>'nonceFinalized')::BOOLEAN IS DISTINCT FROM TRUE)
$$;

CREATE FUNCTION seal_reward_safe_refunds_v1(p_attestation TEXT,p_limit INTEGER)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE item RECORD; amount NUMERIC; count_added INTEGER:=0;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'invalid refund limit'; END IF;
  FOR item IN
    SELECT r.receipt_id,r.category,r.amount_atomic,r.sender_address,c.contribution_id,
      c.account_id,c.pool_leg_id,l.status,l.funded_atomic,l.spent_atomic,l.fulfilled_atomic,
      l.refunded_atomic,l.reserved_atomic,l.refund_policy,o.status AS offer_status
    FROM reward_incoming_receipts_v2 r
    JOIN song_megapot_contributions_v2 c USING(contribution_id)
    JOIN song_reward_offer_legs l ON l.leg_id=c.pool_leg_id
    JOIN song_reward_offers o ON o.offer_id=l.offer_id
    WHERE l.attestation_id=p_attestation AND l.purchase_order='ticket_first_v1'
      AND l.qualification_family_v2='shared_song'
      AND NOT EXISTS(SELECT 1 FROM reward_safe_refunds_v1 f WHERE f.receipt_id=r.receipt_id)
      AND (r.category='late_principal' OR (l.status IN ('exhausted','ended')
        AND l.funded_atomic-l.spent_atomic-l.fulfilled_atomic-l.refunded_atomic>0))
    ORDER BY r.created_at,r.receipt_id LIMIT p_limit FOR UPDATE OF l,c SKIP LOCKED
  LOOP
    IF item.category='late_principal' THEN
      SELECT amount_atomic INTO amount FROM reward_late_principal_liabilities_v2
        WHERE receipt_id=item.receipt_id AND original_sender=item.sender_address;
      IF amount IS DISTINCT FROM item.amount_atomic THEN RAISE EXCEPTION 'late refund provenance mismatch'; END IF;
    ELSE
      IF item.offer_status NOT IN ('exhausted','expired','ended')
        OR item.reserved_atomic<>0 OR item.refund_policy<>'refund_to_funders_pro_rata'
        OR item.funded_atomic<>item.amount_atomic
        OR EXISTS(SELECT 1 FROM song_megapot_contributions_v2 c
          WHERE c.pool_leg_id=item.pool_leg_id AND NOT (c.state->>'nonceFinalized')::BOOLEAN)
        OR (SELECT count(*) FROM reward_incoming_receipts_v2 r
          JOIN song_megapot_contributions_v2 c USING(contribution_id)
          WHERE c.pool_leg_id=item.pool_leg_id AND r.category='pool_principal')<>1
        OR EXISTS(SELECT 1 FROM megapot_pool_drawings d WHERE d.pool_leg_id=item.pool_leg_id
          AND d.status NOT IN ('no_win','credited','closed_purchase_unavailable'))
      THEN CONTINUE; END IF;
      amount:=item.funded_atomic-item.spent_atomic-item.fulfilled_atomic-item.refunded_atomic;
      IF amount<=0 THEN CONTINUE; END IF;
    END IF;
    INSERT INTO reward_safe_refunds_v1(refund_id,receipt_id,contribution_id,pool_leg_id,
      attestation_id,category,account_id,original_sender,amount_atomic)
    VALUES('safe-refund:'||item.receipt_id,item.receipt_id,item.contribution_id,item.pool_leg_id,
      p_attestation,CASE item.category WHEN 'late_principal' THEN 'late_principal' ELSE 'unspent_budget' END,
      item.account_id,item.sender_address,amount);
    count_added:=count_added+1;
  END LOOP;
  RETURN count_added;
END $$;

-- Generate exact ERC20 calldata from durable obligation facts, including uint256
-- amounts that do not fit BIGINT. No caller chooses the destination or amount.
CREATE FUNCTION reward_safe_refund_calldata_v1(p_sender TEXT,p_amount NUMERIC)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE n NUMERIC:=p_amount; digits TEXT:='';
BEGIN
  IF p_sender IS NULL OR p_sender !~ '^0x[a-f0-9]{40}$' OR n IS NULL OR n<>trunc(n)
    OR n<=0 OR n>=power(2::NUMERIC,256) THEN RAISE EXCEPTION 'invalid refund transfer'; END IF;
  WHILE n>0 LOOP
    digits:=substr('0123456789abcdef',mod(n,16)::INTEGER+1,1)||digits;
    n:=div(n,16);
  END LOOP;
  RETURN '0xa9059cbb'||lpad(substr(p_sender,3),64,'0')||lpad(digits,64,'0');
END $$;

CREATE FUNCTION prepare_reward_safe_refund_v1(p_refund TEXT,p_effect TEXT,p_head BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r reward_safe_refunds_v1; a megapot_deployment_attestations;
  s custody_solvency_observations; data TEXT; hash TEXT; first_block BIGINT; owed NUMERIC;
BEGIN
  SELECT * INTO STRICT r FROM reward_safe_refunds_v1 WHERE refund_id=p_refund FOR UPDATE;
  SELECT * INTO STRICT a FROM megapot_deployment_attestations WHERE attestation_id=r.attestation_id;
  IF p_head IS NULL OR p_head<0 OR p_effect IS NULL OR btrim(p_effect)=''
    OR EXISTS(SELECT 1 FROM reward_safe_refund_completions_v1 WHERE refund_id=p_refund)
    OR EXISTS(SELECT 1 FROM reward_safe_refund_attempts_v1 attempt JOIN reward_chain_effects e USING(effect_id)
      WHERE attempt.refund_id=p_refund AND e.state<>'reverted') THEN
    RAISE EXCEPTION 'refund already reserved or completed';
  END IF;
  SELECT * INTO s FROM custody_solvency_observations
    WHERE attestation_id=r.attestation_id AND token_address=a.usdc_address
    ORDER BY block_number DESC,observation_id DESC LIMIT 1 FOR SHARE;
  SELECT
    coalesce((SELECT sum(funded_atomic-spent_atomic-fulfilled_atomic-refunded_atomic)
      FROM song_reward_offer_legs WHERE (funding_source='leg_budget' OR kind='asset_bonus')
      AND chain_id=a.chain_id AND token_address=a.usdc_address),0)
    +coalesce((SELECT sum(amount_atomic-paid_atomic) FROM reward_ledger_credits
      WHERE state<>'sent' AND chain_id=a.chain_id AND token_address=a.usdc_address),0)
    +coalesce((SELECT sum(funded_atomic+winnings_credited_atomic-spent_atomic-withdrawn_atomic)
      FROM platform_sponsorship_budgets WHERE chain_id=a.chain_id AND token_address=a.usdc_address),0)
    +reward_unpaid_late_principal_atomic_v2(a.chain_id,a.usdc_address) INTO owed;
  IF s.observation_id IS NULL OR s.custody_address<>a.custody_address OR s.chain_id<>a.chain_id
    OR s.expires_at<=clock_timestamp() OR NOT s.solvent OR s.balance_atomic<owed
    OR EXISTS(SELECT 1 FROM reward_chain_effects e WHERE e.chain_id=a.chain_id
      AND e.signer_address=a.custody_address AND e.state='confirmed'
      AND e.receipt_block_number>s.block_number) THEN
    RAISE EXCEPTION 'fresh solvent custody required';
  END IF;
  data:=reward_safe_refund_calldata_v1(r.original_sender,r.amount_atomic);
  hash:=encode(sha256(decode(substr(data,3),'hex')),'hex');
  INSERT INTO reward_safe_execution_cursors(chain_id,safe_address,next_block_number)
    VALUES(a.chain_id,a.custody_address,p_head) ON CONFLICT DO NOTHING;
  SELECT greatest(next_block_number,p_head+1) INTO first_block FROM reward_safe_execution_cursors
    WHERE chain_id=a.chain_id AND safe_address=a.custody_address FOR UPDATE;
  INSERT INTO reward_chain_effects(effect_id,effect_kind,state,chain_id,signer_address,
    target_address,reserved_amount_atomic,execution_mode)
  VALUES(p_effect,'reward_refund','planned',a.chain_id,a.custody_address,a.usdc_address,r.amount_atomic,'safe_owner_v1');
  INSERT INTO reward_chain_effect_transitions(effect_id,target_version,event_type,event)
  VALUES(p_effect,2,'safe_call_prepared',jsonb_build_object('calldata_hash',hash,'safe_prepared_block_number',first_block::TEXT));
  UPDATE reward_chain_effects SET state='prepared',version=2,calldata=data,calldata_hash=hash,
    prepared_at=clock_timestamp(),safe_prepared_block_number=first_block,updated_at=clock_timestamp()
    WHERE effect_id=p_effect;
  INSERT INTO reward_safe_refund_attempts_v1(effect_id,refund_id,solvency_observation_id)
    VALUES(p_effect,p_refund,s.observation_id);
  RETURN jsonb_build_object('effectId',p_effect,'data',data,'preparedBlockNumber',first_block::TEXT);
END $$;

CREATE FUNCTION settle_reward_safe_refund_v1(p JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE e reward_chain_effects; r reward_safe_refunds_v1; a megapot_deployment_attestations;
  receipt reward_erc20_transfer_receipt_evidence; next_version BIGINT;
BEGIN
  SELECT refund.* INTO STRICT r FROM reward_safe_refund_attempts_v1 attempt
    JOIN reward_safe_refunds_v1 refund USING(refund_id) WHERE attempt.effect_id=p->>'effectId' FOR UPDATE OF refund;
  SELECT * INTO STRICT e FROM reward_chain_effects WHERE effect_id=p->>'effectId' FOR UPDATE;
  SELECT * INTO STRICT a FROM megapot_deployment_attestations WHERE attestation_id=r.attestation_id;
  IF e.state IN ('confirmed','reverted') THEN
    IF e.transaction_hash IS DISTINCT FROM p->>'transactionHash'
      OR e.receipt_block_hash IS DISTINCT FROM p->>'blockHash'
      OR e.receipt_hash IS DISTINCT FROM p->>'receiptHash' THEN RAISE EXCEPTION 'refund settlement replay conflict'; END IF;
    RETURN;
  END IF;
  IF e.execution_mode<>'safe_owner_v1' OR e.effect_kind<>'reward_refund'
    OR e.state NOT IN ('confirming','reconciliation_required')
    OR e.transaction_hash IS DISTINCT FROM p->>'transactionHash'
    OR e.safe_execution_outcome IS DISTINCT FROM p->>'outcome'
    OR e.safe_execution_outcome NOT IN ('success','failure')
    OR EXISTS(SELECT 1 FROM reward_safe_refund_completions_v1 WHERE refund_id=r.refund_id)
    OR (p->>'confirmations')::INTEGER<1 THEN RAISE EXCEPTION 'refund execution mismatch'; END IF;
  next_version:=e.version+1;
  INSERT INTO reward_chain_effect_transitions(effect_id,target_version,event_type,event)
    VALUES(e.effect_id,next_version,CASE e.safe_execution_outcome WHEN 'success' THEN 'receipt_confirmed' ELSE 'safe_execution_failed' END,p);
  UPDATE reward_chain_effects SET state=CASE e.safe_execution_outcome WHEN 'success' THEN 'confirmed' ELSE 'reverted' END,
    version=next_version,receipt_status='success',receipt_block_number=(p->>'blockNumber')::BIGINT,
    receipt_block_hash=p->>'blockHash',receipt_hash=p->>'receiptHash',confirmations=(p->>'confirmations')::INTEGER,
    confirmed_at=(p->>'confirmedAt')::TIMESTAMPTZ,
    settled_amount_atomic=CASE e.safe_execution_outcome WHEN 'success' THEN r.amount_atomic ELSE NULL END,
    failure_class=NULL,failure_reason=NULL,
    updated_at=clock_timestamp() WHERE effect_id=e.effect_id;
  IF e.safe_execution_outcome='failure' THEN RETURN; END IF;
  INSERT INTO reward_erc20_transfer_receipt_evidence(effect_id,attestation_id,transfer_purpose,
    token_address,sender_address,recipient_address,amount_atomic,transaction_hash,transfer_log_index,
    custody_balance_after_atomic,block_number,block_hash,receipt_hash,confirmations,confirmed_at)
  VALUES(e.effect_id,a.attestation_id,'reward_refund',a.usdc_address,a.custody_address,r.original_sender,
    r.amount_atomic,e.transaction_hash,(p->>'transferLogIndex')::INTEGER,(p->>'custodyBalanceAfterAtomic')::NUMERIC,
    (p->>'blockNumber')::BIGINT,p->>'blockHash',p->>'receiptHash',(p->>'confirmations')::INTEGER,(p->>'confirmedAt')::TIMESTAMPTZ);
  INSERT INTO reward_safe_refund_completions_v1(refund_id,effect_id) VALUES(r.refund_id,e.effect_id);
  IF r.category='unspent_budget' THEN
    UPDATE song_reward_offer_legs SET refunded_atomic=refunded_atomic+r.amount_atomic,updated_at=clock_timestamp()
      WHERE leg_id=r.pool_leg_id AND status IN ('exhausted','ended') AND reserved_atomic=0
        AND funded_atomic-spent_atomic-fulfilled_atomic-refunded_atomic>=r.amount_atomic;
    IF NOT FOUND THEN RAISE EXCEPTION 'refund leg accounting conflict'; END IF;
  END IF;
END $$;

-- New runtime authority is function-only. Existing receipts and liabilities keep
-- their original immutability and no direct new-table write grant is admitted.
DO $acl$
DECLARE name TEXT; grant_row RECORD; item RECORD; recipient RECORD;
BEGIN
  FOR item IN SELECT oid,relowner FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname=ANY(ARRAY[
    'reward_safe_refunds_v1','reward_safe_refund_attempts_v1','reward_safe_refund_completions_v1'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC CASCADE',item.oid::regclass);
    FOR recipient IN SELECT DISTINCT a.grantee FROM pg_class c
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=item.oid AND a.grantee<>0 AND a.grantee<>item.relowner LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I CASCADE',item.oid::regclass,pg_get_userbyid(recipient.grantee));
    END LOOP;
  END LOOP;
  FOREACH name IN ARRAY ARRAY[
    'reward_unpaid_late_principal_atomic_v2(bigint,text)',
    'reward_offer_has_unfinalized_contribution_v2(text)',
    'seal_reward_safe_refunds_v1(text,integer)',
    'reward_safe_refund_calldata_v1(text,numeric)',
    'prepare_reward_safe_refund_v1(text,text,bigint)',
    'settle_reward_safe_refund_v1(jsonb)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I,pg_catalog,pg_temp',name,current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',name);
    FOR grant_row IN SELECT DISTINCT a.grantee FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=name::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',name,pg_get_userbyid(grant_row.grantee));
    END LOOP;
  END LOOP;
END $acl$;

-- Existing payout/refund guards keep their checks and include V2 obligations.
CREATE OR REPLACE FUNCTION guard_reward_payout_effect() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
  credit_record reward_ledger_credits%ROWTYPE;
  wallet_record persona_wallet_assignments%ROWTYPE;
  solvency_record custody_solvency_observations%ROWTYPE;
  attestation_record megapot_deployment_attestations%ROWTYPE;
  live_reserved_purchase NUMERIC(78, 0);
  live_outstanding_credit NUMERIC(78, 0);
  live_pending_refund NUMERIC(78, 0);
  live_shared_sponsorship NUMERIC(78, 0);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'reward payout effects are append-only';
  END IF;
  SELECT * INTO chain_record FROM reward_chain_effects
   WHERE effect_id = NEW.payout_effect_id FOR SHARE;
  SELECT * INTO credit_record FROM reward_ledger_credits
   WHERE credit_id = NEW.credit_id FOR SHARE;
  SELECT * INTO wallet_record FROM persona_wallet_assignments
   WHERE assignment_id = NEW.wallet_assignment_id FOR SHARE;
  SELECT * INTO solvency_record FROM custody_solvency_observations
   WHERE observation_id = NEW.solvency_observation_id FOR SHARE;
  SELECT * INTO attestation_record FROM megapot_deployment_attestations
   WHERE attestation_id = NEW.attestation_id FOR SHARE;
  SELECT COALESCE(sum(reserved_atomic), 0) INTO live_reserved_purchase
    FROM song_reward_offer_legs WHERE kind='megapot_pool' AND funding_source='leg_budget'
      AND chain_id=credit_record.chain_id AND token_address=credit_record.token_address;
  SELECT COALESCE(sum(amount_atomic - paid_atomic), 0) INTO live_outstanding_credit
    FROM reward_ledger_credits WHERE state <> 'sent'
      AND chain_id=credit_record.chain_id AND token_address=credit_record.token_address;
  SELECT COALESCE(sum(funded_atomic - reserved_atomic - spent_atomic
      - fulfilled_atomic - refunded_atomic), 0) INTO live_pending_refund
    FROM song_reward_offer_legs
   WHERE (funding_source='leg_budget' OR kind='asset_bonus')
     AND chain_id=credit_record.chain_id AND token_address=credit_record.token_address;
  live_pending_refund := live_pending_refund + reward_unpaid_late_principal_atomic_v2(credit_record.chain_id,credit_record.token_address);
  SELECT COALESCE(sum(funded_atomic + winnings_credited_atomic
      - spent_atomic - withdrawn_atomic), 0) INTO live_shared_sponsorship
    FROM platform_sponsorship_budgets
   WHERE chain_id=credit_record.chain_id AND token_address=credit_record.token_address;
  IF chain_record.effect_kind <> 'reward_payout'
     OR chain_record.reserved_amount_atomic <> NEW.amount_atomic
     OR chain_record.chain_id <> credit_record.chain_id
     OR chain_record.signer_address <> attestation_record.custody_address
     OR chain_record.target_address <> credit_record.token_address
     OR attestation_record.chain_id <> credit_record.chain_id
     OR credit_record.account_id <> NEW.account_id
     OR credit_record.payout_persona_id <> NEW.payout_persona_id
     OR credit_record.amount_atomic - credit_record.paid_atomic < NEW.amount_atomic
     OR credit_record.state <> 'payout_reserved'
     OR credit_record.reserved_atomic <> NEW.amount_atomic
     OR wallet_record.account_id <> NEW.account_id
     OR wallet_record.persona_id <> NEW.payout_persona_id
     OR wallet_record.status <> 'active'
     OR wallet_record.address <> NEW.destination_address
     OR solvency_record.attestation_id <> NEW.attestation_id
     OR solvency_record.chain_id <> credit_record.chain_id
     OR solvency_record.custody_address <> chain_record.signer_address
     OR solvency_record.token_address <> credit_record.token_address
     OR solvency_record.expires_at <= clock_timestamp()
     OR NOT solvency_record.solvent
     OR solvency_record.balance_atomic <> NEW.custody_balance_before_atomic
     OR solvency_record.balance_atomic < live_reserved_purchase
       + live_outstanding_credit + live_pending_refund + live_shared_sponsorship THEN
    RAISE EXCEPTION 'reward payout does not match credit and active persona wallet';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION guard_reward_refund_effect() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
  funding_record song_reward_leg_funding_effects%ROWTYPE;
  leg_record song_reward_offer_legs%ROWTYPE;
  offer_record song_reward_offers%ROWTYPE;
  attestation_record megapot_deployment_attestations%ROWTYPE;
  solvency_record custody_solvency_observations%ROWTYPE;
  confirmed_total NUMERIC(78, 0);
  refundable_total NUMERIC(78, 0);
  expected_amount NUMERIC(78, 0);
  live_reserved_purchase NUMERIC(78, 0);
  live_outstanding_credit NUMERIC(78, 0);
  live_pending_refund NUMERIC(78, 0);
  live_shared_sponsorship NUMERIC(78, 0);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'reward refund effects are append-only';
  END IF;
  SELECT * INTO chain_record FROM reward_chain_effects
   WHERE effect_id = NEW.refund_effect_id FOR SHARE;
  SELECT * INTO funding_record FROM song_reward_leg_funding_effects
   WHERE funding_effect_id = NEW.funding_effect_id FOR SHARE;
  SELECT * INTO leg_record FROM song_reward_offer_legs
   WHERE leg_id = NEW.leg_id FOR SHARE;
  SELECT * INTO offer_record FROM song_reward_offers
   WHERE offer_id = leg_record.offer_id FOR SHARE;
  SELECT * INTO attestation_record FROM megapot_deployment_attestations
   WHERE attestation_id = NEW.attestation_id FOR SHARE;
  SELECT * INTO solvency_record FROM custody_solvency_observations
   WHERE observation_id = NEW.solvency_observation_id FOR SHARE;
  SELECT COALESCE(sum(confirmed_amount_atomic), 0) INTO confirmed_total
    FROM song_reward_leg_funding_effects
   WHERE leg_id = NEW.leg_id AND state = 'confirmed';
  refundable_total := leg_record.funded_atomic - leg_record.spent_atomic
    - leg_record.fulfilled_atomic;
  SELECT COALESCE(sum(reserved_atomic), 0) INTO live_reserved_purchase
    FROM song_reward_offer_legs WHERE kind='megapot_pool' AND funding_source='leg_budget'
      AND chain_id=leg_record.chain_id AND token_address=leg_record.token_address;
  SELECT COALESCE(sum(amount_atomic-paid_atomic), 0) INTO live_outstanding_credit
    FROM reward_ledger_credits WHERE state <> 'sent'
      AND chain_id=leg_record.chain_id AND token_address=leg_record.token_address;
  SELECT COALESCE(sum(funded_atomic-reserved_atomic-spent_atomic
      -fulfilled_atomic-refunded_atomic), 0) INTO live_pending_refund
    FROM song_reward_offer_legs
   WHERE (funding_source='leg_budget' OR kind='asset_bonus')
     AND chain_id=leg_record.chain_id AND token_address=leg_record.token_address;
  live_pending_refund := live_pending_refund + reward_unpaid_late_principal_atomic_v2(leg_record.chain_id,leg_record.token_address);
  SELECT COALESCE(sum(funded_atomic+winnings_credited_atomic
      -spent_atomic-withdrawn_atomic), 0) INTO live_shared_sponsorship
    FROM platform_sponsorship_budgets
   WHERE chain_id=leg_record.chain_id AND token_address=leg_record.token_address;
  IF confirmed_total > 0 THEN
    WITH allocations AS (
      SELECT funding_effect_id,
             floor(refundable_total * confirmed_amount_atomic / confirmed_total) AS base,
             row_number() OVER (
               ORDER BY mod(refundable_total * confirmed_amount_atomic, confirmed_total) DESC,
                        funding_effect_id
             ) AS remainder_rank,
             refundable_total - sum(floor(
               refundable_total * confirmed_amount_atomic / confirmed_total
             )) OVER () AS remainder_units
        FROM song_reward_leg_funding_effects
       WHERE leg_id = NEW.leg_id AND state = 'confirmed'
    )
    SELECT base + CASE WHEN remainder_rank <= remainder_units THEN 1 ELSE 0 END
      INTO expected_amount FROM allocations
     WHERE funding_effect_id = NEW.funding_effect_id;
  END IF;
  IF chain_record.effect_kind <> 'reward_refund'
     OR chain_record.state <> 'nonce_reserved'
     OR chain_record.reserved_amount_atomic <> NEW.amount_atomic
     OR chain_record.chain_id <> leg_record.chain_id
     OR chain_record.signer_address <> attestation_record.custody_address
     OR chain_record.target_address <> leg_record.token_address
     OR funding_record.leg_id <> NEW.leg_id
     OR funding_record.funder_account_id <> NEW.funder_account_id
     OR funding_record.state <> 'confirmed'
     OR funding_record.sender_address <> NEW.destination_address
     OR leg_record.status NOT IN ('exhausted', 'ended')
     OR leg_record.refund_policy <> 'refund_to_funders_pro_rata'
     OR NOT (leg_record.funding_source = 'leg_budget' OR leg_record.kind = 'asset_bonus')
     OR leg_record.reserved_atomic <> 0
     OR offer_record.status NOT IN ('exhausted', 'expired', 'ended')
     OR confirmed_total = 0 OR confirmed_total <> leg_record.funded_atomic
     OR refundable_total <= 0 OR expected_amount IS NULL
     OR NEW.amount_atomic <> expected_amount
     OR NEW.pro_rata_numerator_atomic <> funding_record.confirmed_amount_atomic
     OR NEW.pro_rata_denominator_atomic <> confirmed_total
     OR attestation_record.chain_id <> leg_record.chain_id
     OR solvency_record.attestation_id <> NEW.attestation_id
     OR solvency_record.chain_id <> leg_record.chain_id
     OR solvency_record.custody_address <> chain_record.signer_address
     OR solvency_record.token_address <> leg_record.token_address
     OR solvency_record.expires_at <= clock_timestamp()
     OR NOT solvency_record.solvent
     OR solvency_record.balance_atomic <> NEW.custody_balance_before_atomic
     OR solvency_record.balance_atomic < live_reserved_purchase
       + live_outstanding_credit + live_pending_refund + live_shared_sponsorship THEN
    RAISE EXCEPTION 'reward refund does not match terminal pro-rata contribution';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION guard_reward_erc20_transfer_receipt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
  attestation_record megapot_deployment_attestations%ROWTYPE;
  payout_record reward_payout_effects%ROWTYPE;
  refund_record reward_refund_effects%ROWTYPE;
  safe_refund reward_safe_refunds_v1%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'reward ERC20 transfer receipt evidence is append-only';
  END IF;
  SELECT * INTO chain_record FROM reward_chain_effects
   WHERE effect_id = NEW.effect_id FOR SHARE;
  SELECT * INTO attestation_record FROM megapot_deployment_attestations
   WHERE attestation_id = NEW.attestation_id FOR SHARE;
  IF chain_record.state <> 'confirmed'
     OR chain_record.effect_kind <> NEW.transfer_purpose
     OR chain_record.signer_address <> NEW.sender_address
     OR chain_record.target_address <> NEW.token_address
     OR chain_record.settled_amount_atomic <> NEW.amount_atomic
     OR chain_record.transaction_hash <> NEW.transaction_hash
     OR chain_record.receipt_block_number <> NEW.block_number
     OR chain_record.receipt_block_hash <> NEW.block_hash
     OR chain_record.receipt_hash <> NEW.receipt_hash
     OR chain_record.confirmations <> NEW.confirmations
     OR attestation_record.chain_id <> chain_record.chain_id
     OR attestation_record.custody_address <> NEW.sender_address
     OR NOT EXISTS (
       SELECT 1 FROM reward_asset_whitelist asset
        WHERE asset.chain_id = chain_record.chain_id
          AND asset.token_address = NEW.token_address
     ) THEN
    RAISE EXCEPTION 'reward ERC20 transfer receipt does not match confirmed effect';
  END IF;
  IF NEW.transfer_purpose = 'reward_payout' THEN
    SELECT * INTO payout_record FROM reward_payout_effects
     WHERE payout_effect_id = NEW.effect_id;
    IF payout_record.attestation_id <> NEW.attestation_id
       OR payout_record.destination_address <> NEW.recipient_address
       OR payout_record.amount_atomic <> NEW.amount_atomic THEN
      RAISE EXCEPTION 'reward payout receipt does not match payout reservation';
    END IF;
  ELSIF NEW.transfer_purpose = 'reward_refund' THEN
    SELECT * INTO refund_record FROM reward_refund_effects
     WHERE refund_effect_id = NEW.effect_id;
    IF refund_record.refund_effect_id IS NULL THEN
      SELECT r.* INTO safe_refund FROM reward_safe_refund_attempts_v1 attempt
        JOIN reward_safe_refunds_v1 r USING(refund_id) WHERE attempt.effect_id=NEW.effect_id;
      IF safe_refund.refund_id IS NULL OR chain_record.execution_mode<>'safe_owner_v1'
        OR safe_refund.attestation_id IS DISTINCT FROM NEW.attestation_id
        OR safe_refund.original_sender IS DISTINCT FROM NEW.recipient_address
        OR safe_refund.amount_atomic IS DISTINCT FROM NEW.amount_atomic THEN
        RAISE EXCEPTION 'Safe refund receipt does not match original receipt obligation';
      END IF;
    ELSIF refund_record.attestation_id <> NEW.attestation_id
       OR refund_record.destination_address <> NEW.recipient_address
       OR refund_record.amount_atomic <> NEW.amount_atomic THEN
      RAISE EXCEPTION 'reward refund receipt does not match refund reservation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION guard_song_reward_offer_leg() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  offer_record song_reward_offers%ROWTYPE;
  attestation_record megapot_deployment_attestations%ROWTYPE;
  activity TEXT;
  confirmed_refund_total NUMERIC(78, 0);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'song reward offer legs cannot be deleted';
  END IF;
  SELECT * INTO offer_record FROM song_reward_offers
   WHERE offer_id = NEW.offer_id FOR SHARE;
  IF offer_record.offer_id IS NULL THEN
    RAISE EXCEPTION 'song reward offer leg requires offer';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'song reward offer leg must begin as draft';
  END IF;
  IF NEW.kind = 'megapot_pool' THEN
    SELECT * INTO attestation_record FROM megapot_deployment_attestations
     WHERE attestation_id = NEW.attestation_id FOR SHARE;
    IF attestation_record.attestation_id IS NULL
       OR attestation_record.chain_id <> NEW.chain_id
       OR attestation_record.usdc_address <> NEW.token_address
       OR attestation_record.status <> 'active' THEN
      RAISE EXCEPTION 'Megapot pool leg requires active exact deployment attestation';
    END IF;
    FOREACH activity IN ARRAY NEW.eligible_activities
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM activity_registry registry
         WHERE registry.activity_key = activity AND registry.status = 'active'
      ) THEN
        RAISE EXCEPTION 'Megapot pool leg activity is not active';
      END IF;
    END LOOP;
    IF NEW.status = 'active' THEN
      IF offer_record.status <> 'active' THEN
        RAISE EXCEPTION 'Megapot pool leg requires active offer';
      END IF;
      IF attestation_record.environment = 'production'
         AND NEW.legal_activation_gate <> 'production_approved' THEN
        RAISE EXCEPTION 'production Megapot pool activation is not legally approved';
      END IF;
      IF NEW.empty_pool_policy = 'funder_fallback'
         AND NEW.funding_source = 'leg_budget' THEN
        IF NOT EXISTS (
          SELECT 1 FROM posts post
           WHERE post.community_id = offer_record.community_id
             AND post.post_id = offer_record.post_id
             AND post.post_type = 'song' AND post.status = 'published'
             AND post.visibility = 'public'
        ) THEN
          RAISE EXCEPTION 'external fallback requires discoverable song';
        END IF;
        FOREACH activity IN ARRAY NEW.eligible_activities
        LOOP
          IF NOT EXISTS (
            SELECT 1 FROM reward_activity_availability_observations availability
             WHERE availability.community_id = offer_record.community_id
               AND availability.post_id = offer_record.post_id
               AND availability.audio_revision = offer_record.audio_revision
               AND availability.activity_key = activity
               AND availability.state = 'available'
               AND availability.expires_at > clock_timestamp()
          ) THEN
            RAISE EXCEPTION 'external fallback activity is unavailable';
          END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.leg_id, NEW.offer_id, NEW.kind, NEW.funder_account_id, NEW.refund_policy,
      NEW.leg_terms_hash, NEW.participation_starts_at, NEW.chain_id, NEW.token_address,
      NEW.token_decimals, NEW.amount_per_claim_atomic, NEW.max_claims,
      NEW.tickets_per_drawing, NEW.max_ticket_price_atomic, NEW.entry_cutoff_seconds,
      NEW.beneficiary_algorithm_version, NEW.ticket_selection_version, NEW.attestation_id,
      NEW.participation_starts_drawing_id, NEW.eligible_activities, NEW.min_score_bps,
      NEW.empty_pool_policy, NEW.funding_source, NEW.fallback_beneficiary_account_id,
      NEW.fallback_payout_persona_id, NEW.referral_allocation_version,
      NEW.referral_policy_hash, NEW.referral_disclosed_at, NEW.legal_activation_gate,
      NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.leg_id, OLD.offer_id, OLD.kind, OLD.funder_account_id, OLD.refund_policy,
      OLD.leg_terms_hash, OLD.participation_starts_at, OLD.chain_id, OLD.token_address,
      OLD.token_decimals, OLD.amount_per_claim_atomic, OLD.max_claims,
      OLD.tickets_per_drawing, OLD.max_ticket_price_atomic, OLD.entry_cutoff_seconds,
      OLD.beneficiary_algorithm_version, OLD.ticket_selection_version, OLD.attestation_id,
      OLD.participation_starts_drawing_id, OLD.eligible_activities, OLD.min_score_bps,
      OLD.empty_pool_policy, OLD.funding_source, OLD.fallback_beneficiary_account_id,
      OLD.fallback_payout_persona_id, OLD.referral_allocation_version,
      OLD.referral_policy_hash, OLD.referral_disclosed_at, OLD.legal_activation_gate,
      OLD.created_at
    ) THEN
      RAISE EXCEPTION 'song reward offer leg terms are immutable';
    END IF;
    IF NEW.funded_atomic < OLD.funded_atomic OR NEW.reserved_atomic < 0
       OR NEW.spent_atomic < OLD.spent_atomic OR NEW.fulfilled_atomic < OLD.fulfilled_atomic
       OR NEW.refunded_atomic < OLD.refunded_atomic THEN
      RAISE EXCEPTION 'song reward offer leg accounting cannot reverse';
    END IF;
    IF NEW.refunded_atomic > OLD.refunded_atomic THEN
      SELECT COALESCE(sum(refund.amount_atomic), 0) INTO confirmed_refund_total
        FROM reward_refund_effects refund
        JOIN reward_erc20_transfer_receipt_evidence receipt
          ON receipt.effect_id=refund.refund_effect_id
       WHERE refund.leg_id=NEW.leg_id AND receipt.transfer_purpose='reward_refund';
      confirmed_refund_total:=confirmed_refund_total+coalesce((
        SELECT sum(r.amount_atomic) FROM reward_safe_refunds_v1 r
        JOIN reward_safe_refund_completions_v1 done USING(refund_id)
        WHERE r.pool_leg_id=NEW.leg_id AND r.category='unspent_budget'),0);
      IF NEW.refunded_atomic <> confirmed_refund_total THEN
        RAISE EXCEPTION 'song reward offer leg refund accounting requires exact receipts';
      END IF;
    END IF;
    IF OLD.status IN ('exhausted', 'ended') AND (
      ROW(
        NEW.status, NEW.funded_atomic, NEW.reserved_atomic, NEW.spent_atomic,
        NEW.fulfilled_atomic, NEW.participation_ends_at, NEW.activated_at
      ) IS DISTINCT FROM ROW(
        OLD.status, OLD.funded_atomic, OLD.reserved_atomic, OLD.spent_atomic,
        OLD.fulfilled_atomic, OLD.participation_ends_at, OLD.activated_at
      )
      OR NEW.refunded_atomic < OLD.refunded_atomic
    ) THEN
      RAISE EXCEPTION 'terminal song reward offer leg only permits refund settlement';
    END IF;
    IF NOT (
      NEW.status = OLD.status
      OR (OLD.status = 'draft' AND NEW.status IN ('funding', 'active', 'ended'))
      OR (OLD.status = 'funding' AND NEW.status IN ('active', 'ended', 'operational_hold'))
      OR (OLD.status = 'active' AND NEW.status IN (
        'paused', 'exhausted', 'ended', 'operational_hold'
      ))
      OR (OLD.status = 'paused' AND NEW.status IN ('active', 'ended', 'operational_hold'))
      OR (OLD.status = 'operational_hold' AND NEW.status IN ('active', 'ended'))
    ) THEN
      RAISE EXCEPTION 'invalid song reward offer leg transition';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'song reward offer leg update time cannot reverse';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Public recovery reads report refunds from immutable settlement evidence.
CREATE OR REPLACE FUNCTION read_owned_song_contribution_current_v2(i JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE c song_megapot_contributions_v2; s JSONB; r JSONB; instr JSONB;
  incoming reward_incoming_receipts_v2; reservation reward_contribution_reservations_v2;
  completed reward_funding_cancellation_proofs_v2; late reward_late_principal_liabilities_v2; seal TEXT; claims JSONB:='[]'; g JSONB;
  cancel JSONB; nonce_status TEXT; category TEXT; current_state TEXT; actions JSONB;
  updated TIMESTAMPTZ; plan_state TEXT; refusal TEXT;
  refund_paid NUMERIC:=0; refund_pending BOOLEAN:=FALSE; refund_updated TIMESTAMPTZ;
BEGIN
  SELECT * INTO c FROM song_megapot_contributions_v2 WHERE account_id=i->>'accountId'
    AND community_id=i->>'communityId' AND post_id=i->>'postId' AND contribution_id=i->>'contributionId';
  IF NOT FOUND THEN RETURN NULL; END IF;
  s:=project_song_contribution_state_v2(c.state);r:=s->'receipt';instr:=r->'instruction';
  SELECT * INTO incoming FROM reward_incoming_receipts_v2 WHERE contribution_id=c.contribution_id;
  SELECT * INTO STRICT reservation FROM reward_contribution_reservations_v2 WHERE contribution_id=c.contribution_id;
  SELECT * INTO late FROM reward_late_principal_liabilities_v2 WHERE contribution_id=c.contribution_id;
  SELECT seal_id INTO seal FROM reward_pool_cohort_members_v2 WHERE contribution_id=c.contribution_id;
  SELECT * INTO completed FROM reward_funding_cancellation_proofs_v2 WHERE contribution_id=c.contribution_id;
  -- Expiry, absent hash and a client assertion never prove nonce consumption.
  -- Only the owner-only canonical cancellation interpreter can close without principal.
  nonce_status:=CASE WHEN incoming.receipt_id IS NOT NULL AND (s->>'nonceFinalized')::BOOLEAN
    THEN 'consumed_transfer' WHEN completed.proof_id IS NOT NULL AND (s->>'nonceFinalized')::BOOLEAN THEN 'consumed_cancellation' ELSE 'unresolved' END;
  category:=CASE incoming.category WHEN 'pool_principal' THEN 'pool_principal'
    WHEN 'late_principal' THEN 'late_principal' WHEN 'unattributed_principal' THEN 'unattributed_asset'
    ELSE CASE WHEN completed.proof_id IS NOT NULL THEN 'no_principal' ELSE 'unresolved' END END;
  current_state:=CASE WHEN s->>'fundingState'='nonce_closed_no_principal' AND incoming.receipt_id IS NULL AND completed.proof_id IS NULL
    THEN 'manual_reconciliation_required' ELSE s->>'fundingState' END;
  SELECT coalesce(sum(refund.amount_atomic),0),max(done.created_at) INTO refund_paid,refund_updated
    FROM reward_safe_refunds_v1 refund JOIN reward_safe_refund_completions_v1 done USING(refund_id)
    WHERE refund.contribution_id=c.contribution_id;
  SELECT EXISTS(SELECT 1 FROM reward_safe_refunds_v1 refund
    JOIN reward_safe_refund_attempts_v1 attempt USING(refund_id)
    JOIN reward_chain_effects effect USING(effect_id)
    WHERE refund.contribution_id=c.contribution_id AND effect.state IN ('prepared','confirming','reconciliation_required'))
    INTO refund_pending;
  IF refund_paid>0 THEN current_state:='refunded';
  ELSIF refund_pending THEN current_state:='refund_pending'; END IF;
  IF reservation.disposition='closed' AND incoming.receipt_id IS NULL AND (completed.proof_id IS NULL OR reservation.closure_proof_id IS DISTINCT FROM completed.proof_id) THEN
    RAISE EXCEPTION 'closed reservation lacks accepted nonce disposition' USING ERRCODE='PCV10';
  END IF;
  FOREACH g IN ARRAY ARRAY[s->'fundingGrant',s->'cancellationGrant'] LOOP
    IF g IS NOT NULL AND g<>'null'::JSONB THEN
      claims:=claims||jsonb_build_array(jsonb_build_object('state',CASE WHEN nonce_status IN ('consumed_transfer','consumed_cancellation') THEN 'finalized' ELSE 'claimed' END,
        'purpose',g->>'purpose','grant_id',g->>'grant_id','grant_revision',g->'grant_revision',
        'holder_client_instance_id',g->>'holder_client_instance_id','submission_attempt_id',g->>'submission_attempt_id',
        'valid_until',g->>'valid_until','cancellation_preparation_id',g->'cancellation_preparation_id',
        'cancellation_preparation_revision',g->'cancellation_preparation_revision'));
    END IF;
  END LOOP;
  cancel:=s->'cancellationHead';
  plan_state:=CASE WHEN cancel='null'::JSONB THEN 'not_prepared'
    WHEN s->'cancellationGrant'<>'null'::JSONB THEN CASE WHEN nonce_status IN ('consumed_transfer','consumed_cancellation') THEN 'finalized' ELSE 'claimed' END
    WHEN (cancel->>'dispatch_expires_at')::TIMESTAMPTZ<=statement_timestamp() THEN 'expired_unclaimed' ELSE 'prepared' END;
  -- These are reconciliation requests, not fresh wallet invocation authority.
  -- A consumed purpose remains claimed after its dispatch deadline expires.
  actions:=CASE WHEN nonce_status IN ('consumed_transfer','consumed_cancellation') THEN '["start_fresh_contribution"]'::JSONB
    ELSE '["observe_original","recover_original","wait"]'::JSONB END;
  refusal:=song_contribution_signing_refusal_v2(i,statement_timestamp());
  -- The wallet rechecks this projection after claiming. A pause followed by
  -- unpause cannot revive that held grant's permanently shortened interval.
  IF refusal IS NULL AND nonce_status='unresolved' AND
    ((s->>'effectiveDeadline')::TIMESTAMPTZ<=statement_timestamp()
      OR (instr->>'expires_at')::TIMESTAMPTZ<=statement_timestamp()) THEN
    refusal:='instruction_expired';
  END IF;
  IF refusal IS NULL AND nonce_status='unresolved' AND NOT (s->>'nonceFinalized')::BOOLEAN
    AND s->'fundingGrant'='null'::JSONB AND s->'cancellationGrant'='null'::JSONB
    AND (s->>'effectiveDeadline')::TIMESTAMPTZ>statement_timestamp()
    AND (instr->>'expires_at')::TIMESTAMPTZ>statement_timestamp() THEN
    actions:=actions||'["claim_funding_submission"]'::JSONB;
  END IF;
  updated:=greatest(c.created_at,incoming.created_at,completed.created_at,refund_updated,
    (SELECT max(created_at) FROM song_megapot_contribution_commands_v2 WHERE contribution_id=c.contribution_id),
    CASE WHEN current_state='expired_reconciling' THEN (s->>'effectiveDeadline')::TIMESTAMPTZ END);
  RETURN jsonb_build_object('accountId',c.account_id,'current',jsonb_build_object(
    'object','song_megapot_contribution_state','version',2,'contribution_id',c.contribution_id,
    'funding_effect_id',c.funding_effect_id,'revision',s->'revision','state',current_state,'nonce_state',nonce_status,
    'disposition',category,'target',r->'target','original_persona_id',s->'owner'->>'persona_id',
    'original_sender',instr->>'from','terms_hash',r->>'terms_hash','instruction_hash',instr->>'instruction_hash',
    'receipt_evidence',incoming.evidence->'evidence',
    'pool_credit_atomic',CASE WHEN incoming.category='pool_principal' THEN incoming.amount_atomic::TEXT ELSE '0' END,
    'late_principal_owed_atomic',CASE WHEN late.receipt_id IS NULL THEN '0' ELSE (late.amount_atomic-refund_paid)::TEXT END,
    'refund_paid_atomic',refund_paid::TEXT,
    'reservation_capacity_state',CASE reservation.disposition WHEN 'held' THEN 'reserved'
      WHEN 'converted' THEN 'consumed_by_pool_credit' ELSE 'released_after_nonce_consumed' END,
    'cohort_seal_id',seal,'allowed_actions',actions,'pause_reason',refusal,
    'updated_at',to_char(updated AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'submissions',claims,'command_receipt',r,'cancellation',jsonb_build_object(
      'object','contribution_cancellation_preparation_state','state',plan_state,
      'preparations_used',s->'preparationsUsed','current_preparation_id',cancel->'preparation_id',
      'current_preparation_revision',coalesce(cancel->'preparation_revision','0'::JSONB),'current_receipt',cancel)));
END $$;
DO $projection_search_path$ BEGIN
 EXECUTE format('ALTER FUNCTION read_owned_song_contribution_current_v2(jsonb) SET search_path TO pg_catalog,%I,pg_temp',current_schema());
END $projection_search_path$;
