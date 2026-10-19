-- SOURCE ONLY. Independent principal/cohort evidence storage. No outbound
-- interpreter, signer, solvency grant or selected late-refund economics here.
CREATE TABLE reward_pool_cohort_seals_v2 (
  seal_id TEXT PRIMARY KEY, pool_leg_id TEXT NOT NULL UNIQUE,
  source_hash TEXT NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  pool_principal_atomic reward_funding_atomic_v2 NOT NULL,
  scan_proofs JSONB NOT NULL CHECK(jsonb_typeof(scan_proofs)='array'),
  -- The missing accepted outgoing-cost/solvency interpreter cannot be asserted
  -- into existence by a caller. This record alone never authorizes a refund.
  financial_ready BOOLEAN NOT NULL DEFAULT FALSE CHECK(NOT financial_ready),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);
CREATE TABLE reward_pool_cohort_members_v2 (
  seal_id TEXT NOT NULL REFERENCES reward_pool_cohort_seals_v2,
  contribution_id TEXT NOT NULL UNIQUE REFERENCES song_megapot_contributions_v2,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES reward_incoming_receipts_v2,
  amount_atomic reward_funding_atomic_v2 NOT NULL CHECK(amount_atomic>0),
  PRIMARY KEY(seal_id,contribution_id)
);
CREATE TABLE reward_late_principal_liabilities_v2 (
  receipt_id TEXT PRIMARY KEY REFERENCES reward_incoming_receipts_v2,
  contribution_id TEXT NOT NULL UNIQUE REFERENCES song_megapot_contributions_v2,
  amount_atomic reward_funding_atomic_v2 NOT NULL CHECK(amount_atomic>0),
  original_sender TEXT NOT NULL CHECK(original_sender ~ '^0x[a-f0-9]{40}$'),
  -- No completion until the original parent-held outbound authority is accepted
  -- and supplies its exact source/completion contract. Unknown outflow is owed.
  paid_atomic reward_funding_atomic_v2 NOT NULL DEFAULT 0 CHECK(paid_atomic=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);
DO $immutable$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['reward_pool_cohort_seals_v2','reward_pool_cohort_members_v2','reward_late_principal_liabilities_v2'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_reward_contribution_history_v2()',t||'_append_only',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_reward_contribution_history_v2()',t||'_no_truncate',t);
  END LOOP;
END $immutable$;

CREATE FUNCTION accept_reward_funding_principal_v2(p JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c song_megapot_contributions_v2; old reward_incoming_receipts_v2; r JSONB; i JSONB; e JSONB:=p->'evidence';
  amount reward_funding_atomic_v2; category TEXT; next_state JSONB; leg TEXT; k TEXT;
BEGIN
  -- Decode the required proof BEFORE casts, receipt replay or any mutation.
  -- SQL NULL is not a successful proof; ->> alone also hides JSON type errors.
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(e) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p->'exactInstruction') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(e->'chain_id') IS DISTINCT FROM 'number'
    OR jsonb_typeof(e->'transfer_log_index') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'invalid principal proof shape' USING ERRCODE='PCV11';
  END IF;
  FOREACH k IN ARRAY ARRAY['receiptId','contributionId','category','senderAddress','recipientAddress','tokenAddress','instructionHash','attestationHash','policyHash','checkpointBlock','checkpointHash','observedConfirmedNonce'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'missing or mistyped principal proof field' USING ERRCODE='PCV11'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['transaction_hash','sender_nonce','block_number','block_hash','block_timestamp','first_observed_at','finalized_at','actual_amount_atomic','attestation_id'] LOOP
    IF jsonb_typeof(e->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'missing or mistyped receipt evidence field' USING ERRCODE='PCV11'; END IF;
  END LOOP;
  IF (p->>'category' IN ('pool_principal','late_principal')
    AND length(p->>'receiptId') BETWEEN 1 AND 128 AND length(p->>'contributionId') BETWEEN 1 AND 128
    AND length(e->>'attestation_id') BETWEEN 1 AND 128
    AND p->>'senderAddress' ~ '^0x[a-f0-9]{40}$' AND p->>'recipientAddress' ~ '^0x[a-f0-9]{40}$' AND p->>'tokenAddress' ~ '^0x[a-f0-9]{40}$'
    AND p->>'instructionHash' ~ '^[a-f0-9]{64}$' AND p->>'attestationHash' ~ '^[a-f0-9]{64}$' AND p->>'policyHash' ~ '^[a-f0-9]{64}$'
    AND p->>'checkpointHash' ~ '^0x[a-f0-9]{64}$' AND e->>'transaction_hash' ~ '^0x[a-f0-9]{64}$' AND e->>'block_hash' ~ '^0x[a-f0-9]{64}$'
    AND e->>'chain_id' IN ('84532','8453') AND e->>'transfer_log_index' ~ '^(0|[1-9][0-9]{0,15})$'
    AND p->>'checkpointBlock' ~ '^(0|[1-9][0-9]{0,77})$' AND p->>'observedConfirmedNonce' ~ '^(0|[1-9][0-9]{0,77})$'
    AND e->>'sender_nonce' ~ '^(0|[1-9][0-9]{0,77})$' AND e->>'block_number' ~ '^(0|[1-9][0-9]{0,77})$'
    AND e->>'actual_amount_atomic' ~ '^[1-9][0-9]{0,77}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid principal proof value' USING ERRCODE='PCV11';
  END IF;
  IF (e->>'transfer_log_index')::NUMERIC>9007199254740991
    OR greatest((p->>'checkpointBlock')::NUMERIC,(p->>'observedConfirmedNonce')::NUMERIC,(e->>'sender_nonce')::NUMERIC,(e->>'block_number')::NUMERIC,(e->>'actual_amount_atomic')::NUMERIC)>115792089237316195423570985008687907853269984665640564039457584007913129639935 THEN
    RAISE EXCEPTION 'principal proof representation overflow' USING ERRCODE='PCV11';
  END IF;
  FOREACH k IN ARRAY ARRAY['block_timestamp','first_observed_at','finalized_at'] LOOP
    IF (e->>k ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$') IS NOT TRUE THEN
      RAISE EXCEPTION 'invalid principal proof instant' USING ERRCODE='PCV11';
    END IF;
    PERFORM (e->>k)::TIMESTAMPTZ;
  END LOOP;
  -- Exact incoming key replay precedes current policy/lifecycle business guards.
  SELECT * INTO old FROM reward_incoming_receipts_v2 WHERE chain_id=(e->>'chain_id')::BIGINT AND transaction_hash=e->>'transaction_hash' AND transfer_log_index=(e->>'transfer_log_index')::BIGINT;
  IF FOUND THEN
    IF old.contribution_id<>p->>'contributionId' THEN RAISE EXCEPTION 'receipt already attributed' USING ERRCODE='PCV11'; END IF;
    RETURN to_jsonb(old);
  END IF;
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=p->>'contributionId';
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',c.account_id)::text,0));
  PERFORM 1 FROM reward_song_slots_v2 WHERE community_id=c.community_id AND post_id=c.post_id FOR UPDATE;
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=c.contribution_id FOR UPDATE;
  r:=c.state->'receipt'; i:=r->'instruction'; leg:=c.pool_leg_id;
  c.state:=project_song_contribution_state_v2(c.state);
  PERFORM lock_reward_wallet_nonce_sender_v2((i->>'chain_id')::BIGINT,i->>'from');
  SELECT * INTO old FROM reward_incoming_receipts_v2 WHERE chain_id=(e->>'chain_id')::BIGINT AND transaction_hash=e->>'transaction_hash' AND transfer_log_index=(e->>'transfer_log_index')::BIGINT;
  IF FOUND THEN
    IF old.contribution_id<>c.contribution_id THEN RAISE EXCEPTION 'receipt already attributed' USING ERRCODE='PCV11'; END IF;
    RETURN to_jsonb(old);
  END IF;
  amount:=(e->>'actual_amount_atomic')::reward_funding_atomic_v2;
  IF (amount>0 AND p->>'senderAddress'=i->>'from'
    AND p->>'recipientAddress'=i->>'recipient_custody' AND p->>'tokenAddress'=i->>'to_token'
    AND (e->>'chain_id')::BIGINT=(i->>'chain_id')::BIGINT AND e->>'sender_nonce'=i->>'nonce'
    AND p->>'instructionHash'=i->>'instruction_hash' AND p->>'attestationHash'=i->>'attestation_hash'
    AND e->>'attestation_id'=i->>'attestation_id'
    AND (e->>'block_number')::NUMERIC>(r->'reservation'->>'valid_from_block_exclusive')::NUMERIC
    AND (p->>'observedConfirmedNonce')::NUMERIC>(i->>'nonce')::NUMERIC
    AND (p->>'checkpointBlock')::NUMERIC>=(e->>'block_number')::NUMERIC) IS NOT TRUE THEN
    RAISE EXCEPTION 'principal proof mismatch' USING ERRCODE='PCV11';
  END IF;
  category:=CASE WHEN (p->>'exactInstruction')::BOOLEAN AND amount=(i->>'amount_atomic')::NUMERIC
    AND (e->>'block_timestamp')::TIMESTAMPTZ<(c.state->>'effectiveDeadline')::TIMESTAMPTZ
    AND (e->>'block_timestamp')::TIMESTAMPTZ<(r->'committed_terms'->>'ends_at')::TIMESTAMPTZ
    AND (e->>'block_timestamp')::TIMESTAMPTZ>=(r->'committed_terms'->>'starts_at')::TIMESTAMPTZ
    THEN 'pool_principal' ELSE 'late_principal' END;
  IF category IS DISTINCT FROM p->>'category' THEN RAISE EXCEPTION 'principal category mismatch' USING ERRCODE='PCV11'; END IF;
  IF EXISTS(SELECT 1 FROM reward_pool_cohort_seals_v2 WHERE pool_leg_id=leg) AND category='pool_principal' THEN
    RAISE EXCEPTION 'predeadline receipt contradicts sealed proof; incident reconciliation required' USING ERRCODE='PCV10'; END IF;
  IF (c.state->>'nonceFinalized')::BOOLEAN THEN RAISE EXCEPTION 'conflicting finalized principal' USING ERRCODE='PCV11'; END IF;
  INSERT INTO reward_incoming_receipts_v2 VALUES(p->>'receiptId',c.contribution_id,(e->>'chain_id')::BIGINT,e->>'transaction_hash',(e->>'transfer_log_index')::BIGINT,i->>'from',(i->>'nonce')::BIGINT,amount,category,p,transaction_timestamp()) RETURNING * INTO old;
  IF category='late_principal' THEN
    INSERT INTO reward_late_principal_liabilities_v2(receipt_id,contribution_id,amount_atomic,original_sender) VALUES(old.receipt_id,c.contribution_id,amount,i->>'from');
  END IF;
  next_state:=jsonb_set(jsonb_set(jsonb_set(c.state,'{fundingState}',to_jsonb(CASE WHEN category='pool_principal' THEN 'pool_credited'::TEXT ELSE 'late_principal_owed'::TEXT END)),'{nonceFinalized}','true'),'{revision}',to_jsonb((c.state->>'revision')::BIGINT+1));
  UPDATE song_megapot_contributions_v2 SET state=next_state WHERE contribution_id=c.contribution_id;
  -- A finalized actual receipt consumes the original nonce and resolves the
  -- reservation. Observation time/expiry alone cannot reach this function.
  UPDATE reward_contribution_reservations_v2 SET disposition=CASE WHEN category='pool_principal' THEN 'converted' ELSE 'closed' END,closure_proof_id=old.receipt_id WHERE contribution_id=c.contribution_id AND disposition='held';
  UPDATE reward_funding_account_counters_v2 SET active=active-1,admitted=admitted+CASE WHEN category='pool_principal' THEN 1 ELSE 0 END,custody_liabilities=custody_liabilities+1 WHERE account_id=c.account_id AND scope_leg IN ('',c.pool_leg_id);
  RETURN to_jsonb(old);
END $$;



-- Extend the SAME shared context authority with actual V2 receipt consumption.
-- Both legacy fencing and conservative V2 admission consume this one predicate.
-- V1/sponsored rows remain unknown in the original new-nonce context, unchanged.
CREATE OR REPLACE FUNCTION reward_wallet_nonce_ownership_open_v2(p_chain BIGINT,p_sender TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM reward_wallet_nonce_leases l WHERE l.chain_id=p_chain AND l.sender_address=p_sender AND
        CASE WHEN l.source='song_funding_v2' THEN NOT EXISTS(
          SELECT 1 FROM song_megapot_contributions_v2 c JOIN reward_incoming_receipts_v2 r USING(contribution_id)
          WHERE c.nonce_lease_id=l.lease_id AND c.contribution_id=l.owner_id AND c.account_id=l.account_id
            -- Incoming evidence is uint256; the owned lease nonce remains BIGINT.
            AND (c.state->>'nonceFinalized')::BOOLEAN AND (r.evidence->>'observedConfirmedNonce')::NUMERIC>l.nonce::NUMERIC)
        ELSE NOT EXISTS(SELECT 1 FROM reward_winner_send_outcomes o WHERE o.send_id=l.winner_send_id AND o.attempt=l.winner_attempt AND o.observed_confirmed_nonce>l.nonce) END)
$$;

-- This hash preimage contains arrays/scalars only, matching H/J compact JSON.
CREATE FUNCTION canonical_reward_funding_array_v2(j JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result TEXT;
BEGIN
  IF jsonb_typeof(j)='array' THEN
    SELECT '['||coalesce(string_agg(canonical_reward_funding_array_v2(value),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(j) WITH ORDINALITY AS e(value,ordinal);
    RETURN result;
  END IF;
  IF jsonb_typeof(j)='object' THEN RAISE EXCEPTION 'cohort preimage must be ordered arrays' USING ERRCODE='PCV10'; END IF;
  RETURN j::TEXT;
END $$;

-- Evidence-only cohort persistence; no refund numerator/completion authority.
CREATE FUNCTION record_reward_pool_cohort_v2(id TEXT,leg TEXT,hash TEXT,proofs JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE total reward_funding_atomic_v2; members JSONB; ordered_proofs JSONB; actual_hash TEXT;
BEGIN
  PERFORM 1 FROM reward_song_slots_v2 WHERE target->>'pool_leg_id'=leg AND status='closing' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'leg not closing' USING ERRCODE='PCV06'; END IF;
  IF EXISTS(SELECT 1 FROM song_megapot_contributions_v2 c WHERE c.pool_leg_id=leg AND NOT EXISTS(
    SELECT 1 FROM reward_funding_scan_checkpoints_v2 s WHERE s.contribution_id=c.contribution_id
      AND s.block_time>(c.state->>'effectiveDeadline')::TIMESTAMPTZ AND proofs @> jsonb_build_array(s.checkpoint_id))) THEN
    RAISE EXCEPTION 'incomplete interval closure proof' USING ERRCODE='PCV10'; END IF;
  SELECT coalesce(sum(r.amount_atomic),0) INTO total FROM reward_incoming_receipts_v2 r JOIN song_megapot_contributions_v2 c USING(contribution_id) WHERE c.pool_leg_id=leg AND r.category='pool_principal';
  SELECT coalesce(jsonb_agg(jsonb_build_array(c.funding_effect_id,r.receipt_id,r.amount_atomic::TEXT) ORDER BY c.funding_effect_id COLLATE "C"),'[]') INTO members FROM reward_incoming_receipts_v2 r JOIN song_megapot_contributions_v2 c USING(contribution_id) WHERE c.pool_leg_id=leg AND r.category='pool_principal';
  SELECT coalesce(jsonb_agg(value ORDER BY value COLLATE "C"),'[]') INTO ordered_proofs FROM jsonb_array_elements_text(proofs);
  actual_hash:=encode(sha256(convert_to(canonical_reward_funding_array_v2(jsonb_build_array('pirate.reward-pool-cohort.evidence.v2',jsonb_build_array(leg,members,ordered_proofs))),'UTF8')),'hex');
  IF hash IS DISTINCT FROM actual_hash THEN RAISE EXCEPTION 'cohort hash mismatch' USING ERRCODE='PCV10'; END IF;
  INSERT INTO reward_pool_cohort_seals_v2(seal_id,pool_leg_id,source_hash,pool_principal_atomic,scan_proofs) VALUES(id,leg,hash,total,proofs);
  INSERT INTO reward_pool_cohort_members_v2 SELECT id,c.contribution_id,r.receipt_id,r.amount_atomic FROM reward_incoming_receipts_v2 r JOIN song_megapot_contributions_v2 c USING(contribution_id) WHERE c.pool_leg_id=leg AND r.category='pool_principal';
END $$;

DO $principal_acl$
DECLARE x RECORD; r RECORD; trusted TEXT:=current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION reward_wallet_nonce_ownership_open_v2(bigint,text) SET search_path TO pg_catalog,%I,pg_temp',trusted);
  FOR x IN SELECT oid,relname,relowner FROM pg_class WHERE relnamespace=to_regnamespace(trusted) AND relname IN ('reward_pool_cohort_seals_v2','reward_pool_cohort_members_v2','reward_late_principal_liabilities_v2') LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC CASCADE',trusted,x.relname);
    FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=x.oid AND a.grantee<>0 AND a.grantee<>x.relowner LOOP EXECUTE format('REVOKE ALL ON %I.%I FROM %I CASCADE',trusted,x.relname,r.name); END LOOP;
  END LOOP;
  FOR x IN SELECT oid,proowner,oid::regprocedure AS sig FROM pg_proc WHERE pronamespace=to_regnamespace(trusted) AND proname IN ('accept_reward_funding_principal_v2','record_reward_pool_cohort_v2','canonical_reward_funding_array_v2') LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',x.sig,trusted);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',x.sig);
    FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=x.oid AND a.grantee<>0 AND a.grantee<>x.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',x.sig,r.name); END LOOP;
  END LOOP;
END $principal_acl$;
