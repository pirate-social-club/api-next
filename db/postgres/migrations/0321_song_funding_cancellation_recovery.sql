-- Exceptional operator completion for an exact finalized Base Sepolia
-- self-cancellation. No signer or HTTP/Jobs completion capability is added.
CREATE TABLE reward_funding_cancellation_proofs_v2 (
  proof_id TEXT PRIMARY KEY CHECK(length(proof_id) BETWEEN 1 AND 128),
  contribution_id TEXT NOT NULL UNIQUE REFERENCES song_megapot_contributions_v2,
  nonce_lease_id TEXT NOT NULL UNIQUE REFERENCES reward_wallet_nonce_leases,
  chain_id BIGINT NOT NULL CHECK(chain_id=84532),
  sender_address TEXT NOT NULL CHECK(sender_address ~ '^0x[a-f0-9]{40}$'),
  nonce BIGINT NOT NULL CHECK(nonce>=0),
  transaction_hash TEXT NOT NULL CHECK(transaction_hash ~ '^0x[a-f0-9]{64}$'),
  evidence JSONB NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(chain_id,transaction_hash), UNIQUE(chain_id,sender_address,nonce)
);
CREATE TRIGGER reward_funding_cancellation_proofs_v2_append_only BEFORE UPDATE OR DELETE
  ON reward_funding_cancellation_proofs_v2 FOR EACH ROW EXECUTE FUNCTION reject_reward_contribution_history_v2();
CREATE TRIGGER reward_funding_cancellation_proofs_v2_no_truncate BEFORE TRUNCATE
  ON reward_funding_cancellation_proofs_v2 FOR EACH STATEMENT EXECUTE FUNCTION reject_reward_contribution_history_v2();

CREATE FUNCTION recover_song_funding_cancellation_v2(p JSONB, expected_revision BIGINT, expected_brake_revision BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE c song_megapot_contributions_v2; previous reward_funding_cancellation_proofs_v2;
  brake reward_operations_control; run reward_operations_run_lease; profile reward_funding_profiles_v2;
  r JSONB; i JSONB; plan JSONB; grant_receipt JSONB; policy JSONB; k TEXT; n INTEGER; observed TIMESTAMPTZ;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR expected_revision IS NULL OR expected_revision<0
    OR expected_brake_revision IS NULL OR expected_brake_revision<0
    OR jsonb_typeof(p->'chainId') IS DISTINCT FROM 'number' OR p->>'chainId'<>'84532'
    OR jsonb_typeof(p->'requiredConfirmations') IS DISTINCT FROM 'number'
    OR (p->>'requiredConfirmations' ~ '^[1-9][0-9]{0,8}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid cancellation proof' USING ERRCODE='PCV11'; END IF;
  FOREACH k IN ARRAY ARRAY['proofId','contributionId','nonceLeaseId','preparationId','grantId'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(p->>k) NOT BETWEEN 1 AND 128
      THEN RAISE EXCEPTION 'invalid cancellation identity' USING ERRCODE='PCV11'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['instructionHash','cancellationInstructionHash','policyHash'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR (p->>k ~ '^[a-f0-9]{64}$') IS NOT TRUE
      THEN RAISE EXCEPTION 'invalid cancellation digest' USING ERRCODE='PCV11'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['transactionHash','blockHash','checkpointHash'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR (p->>k ~ '^0x[a-f0-9]{64}$') IS NOT TRUE
      THEN RAISE EXCEPTION 'invalid cancellation block identity' USING ERRCODE='PCV11'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['nonce','blockNumber','checkpointBlock','confirmedNonce'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR (p->>k ~ '^(0|[1-9][0-9]{0,77})$') IS NOT TRUE
      THEN RAISE EXCEPTION 'invalid cancellation number' USING ERRCODE='PCV11'; END IF;
    PERFORM (p->>k)::reward_funding_atomic_v2;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['blockTimestamp','observedAt'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR
      (p->>k ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$') IS NOT TRUE
      THEN RAISE EXCEPTION 'invalid cancellation instant' USING ERRCODE='PCV11'; END IF;
    PERFORM (p->>k)::TIMESTAMPTZ;
  END LOOP;
  IF jsonb_typeof(p->'sender') IS DISTINCT FROM 'string' OR
    (p->>'sender' ~ '^0x[a-f0-9]{40}$') IS NOT TRUE OR
    p->>'proofId' IS DISTINCT FROM 'funding-cancel-v2:84532:'||(p->>'transactionHash')
    THEN RAISE EXCEPTION 'invalid cancellation sender' USING ERRCODE='PCV11'; END IF;
  SELECT * INTO brake FROM reward_operations_control WHERE singleton FOR SHARE;
  SELECT * INTO run FROM reward_operations_run_lease WHERE singleton FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run control missing' USING ERRCODE='PCV06'; END IF;
  observed:=clock_timestamp();
  IF brake.paused IS DISTINCT FROM TRUE OR brake.revision IS DISTINCT FROM expected_brake_revision
    OR (run.run_id IS NOT NULL AND run.expires_at>observed AND run.absolute_deadline>observed)
    THEN RAISE EXCEPTION 'cancellation recovery requires paused operations and no live run' USING ERRCODE='PCV06'; END IF;
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=p->>'contributionId';
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',c.account_id)::TEXT,0));
  PERFORM 1 FROM reward_song_slots_v2 WHERE community_id=c.community_id AND post_id=c.post_id FOR UPDATE;
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=c.contribution_id FOR UPDATE;
  r:=c.state->'receipt'; i:=r->'instruction'; plan:=c.state->'cancellationHead'; grant_receipt:=c.state->'cancellationGrant';
  PERFORM lock_reward_wallet_nonce_sender_v2((i->>'chain_id')::BIGINT,i->>'from');
  SELECT * INTO STRICT profile FROM reward_funding_profiles_v2 WHERE profile_id=c.profile_id;
  policy:=profile.policy->'reconciliation'->'receipt';
  IF (jsonb_typeof(policy)='object'
    AND policy->>'maximumObservationAgeMs' ~ '^[1-9][0-9]{0,8}$'
    AND policy->>'maximumClockSkewMs' ~ '^(0|[1-9][0-9]{0,8})$'
    AND policy->>'requiredConfirmations' ~ '^[1-9][0-9]{0,8}$') IS NOT TRUE
    THEN RAISE EXCEPTION 'cancellation receipt policy missing' USING ERRCODE='PCV11'; END IF;
  IF NOT EXISTS(SELECT 1 FROM megapot_deployment_attestations a WHERE a.attestation_id=i->>'attestation_id'
      AND a.environment='staging' AND a.chain_id=84532)
    OR (p->>'chainId'=(i->>'chain_id') AND p->>'nonceLeaseId'=c.nonce_lease_id
      AND p->>'sender'=i->>'from' AND p->>'nonce'=i->>'nonce' AND p->>'instructionHash'=i->>'instruction_hash'
      AND p->>'cancellationInstructionHash'=plan->>'instruction_hash' AND p->>'preparationId'=plan->>'preparation_id'
      AND plan->>'original_funding_instruction_hash'=i->>'instruction_hash' AND plan->>'sender'=i->>'from'
      AND plan->>'recipient'=i->>'from' AND plan->>'value_atomic'='0' AND plan->>'data'='0x'
      AND plan->>'contribution_id'=c.contribution_id AND plan->'chain_id'=i->'chain_id'
      AND plan->>'nonce'=i->>'nonce' AND plan->>'wallet_assignment_id'=i->>'wallet_assignment_id'
      AND plan->'wallet_index'=i->'wallet_index'
      AND grant_receipt->>'contribution_id'=c.contribution_id
      AND grant_receipt->>'valid_until'=plan->>'dispatch_expires_at'
      AND (grant_receipt->>'claimed_at')::TIMESTAMPTZ>=(plan->>'prepared_at')::TIMESTAMPTZ
      AND (grant_receipt->>'claimed_at')::TIMESTAMPTZ<(plan->>'dispatch_expires_at')::TIMESTAMPTZ
      AND p->>'grantId'=grant_receipt->>'grant_id' AND grant_receipt->>'purpose'='nonce_cancellation'
      AND grant_receipt->>'instruction_hash'=plan->>'instruction_hash'
      AND grant_receipt->>'cancellation_preparation_id'=plan->>'preparation_id'
      AND grant_receipt->'cancellation_preparation_revision'=plan->'preparation_revision'
      AND p->>'policyHash'=policy->>'policyHash'
      AND (p->>'requiredConfirmations')::NUMERIC=(policy->>'requiredConfirmations')::NUMERIC
      AND (p->>'confirmedNonce')::NUMERIC>(i->>'nonce')::NUMERIC
      AND (p->>'blockNumber')::NUMERIC>(r->'reservation'->>'valid_from_block_exclusive')::NUMERIC
      AND (p->>'checkpointBlock')::NUMERIC>=(p->>'blockNumber')::NUMERIC
      AND (p->>'blockTimestamp')::TIMESTAMPTZ>=(plan->>'prepared_at')::TIMESTAMPTZ
      AND (p->>'blockTimestamp')::TIMESTAMPTZ<=(p->>'observedAt')::TIMESTAMPTZ+((policy->>'maximumClockSkewMs')::NUMERIC*interval '1 millisecond')) IS NOT TRUE
    THEN RAISE EXCEPTION 'cancellation proof mismatch' USING ERRCODE='PCV11'; END IF;
  IF NOT EXISTS(SELECT 1 FROM reward_wallet_nonce_leases l WHERE l.lease_id=c.nonce_lease_id
    AND l.source='song_funding_v2' AND l.owner_id=c.contribution_id AND l.command_id=r->>'command_id'
    AND l.account_id=c.account_id AND l.persona_id=c.state->'owner'->>'persona_id'
    AND l.wallet_assignment_id=i->>'wallet_assignment_id' AND l.sender_address=i->>'from'
    AND l.chain_id=84532 AND l.nonce=(i->>'nonce')::BIGINT AND l.request_hash=r->>'request_hash')
    OR NOT EXISTS(SELECT 1 FROM reward_funding_submission_claims_v2 g WHERE g.contribution_id=c.contribution_id
      AND g.purpose='nonce_cancellation' AND g.grant_id=p->>'grantId')
    THEN RAISE EXCEPTION 'original cancellation authority missing' USING ERRCODE='PCV11'; END IF;
  SELECT * INTO previous FROM reward_funding_cancellation_proofs_v2 WHERE contribution_id=c.contribution_id;
  IF FOUND THEN
    -- Fresh verification may have a newer finality checkpoint. Frozen inclusion,
    -- original authority and the already-closed accounting must still match.
    IF previous.transaction_hash<>p->>'transactionHash' OR previous.evidence->>'blockHash'<>p->>'blockHash'
      OR previous.evidence->>'blockNumber'<>p->>'blockNumber' OR previous.evidence->>'grantId'<>p->>'grantId'
      OR (c.state->>'nonceFinalized')::BOOLEAN IS DISTINCT FROM TRUE OR c.state->>'fundingState'<>'nonce_closed_no_principal'
      OR NOT EXISTS(SELECT 1 FROM reward_contribution_reservations_v2 x WHERE x.contribution_id=c.contribution_id
        AND x.disposition='closed' AND x.closure_proof_id=previous.proof_id)
      THEN RAISE EXCEPTION 'conflicting cancellation proof' USING ERRCODE='PCV11'; END IF;
    RETURN to_jsonb(previous)||jsonb_build_object('nonce',previous.nonce::TEXT);
  END IF;
  IF (c.state->>'revision')::BIGINT<>expected_revision OR (c.state->>'nonceFinalized')::BOOLEAN
    OR EXISTS(SELECT 1 FROM reward_incoming_receipts_v2 WHERE contribution_id=c.contribution_id)
    OR (p->>'observedAt')::TIMESTAMPTZ>clock_timestamp()
    OR (p->>'observedAt')::TIMESTAMPTZ+((policy->>'maximumObservationAgeMs')::NUMERIC*interval '1 millisecond')<=clock_timestamp()
    THEN RAISE EXCEPTION 'stale or conflicting cancellation completion' USING ERRCODE='PCV06'; END IF;
  INSERT INTO reward_funding_cancellation_proofs_v2(proof_id,contribution_id,nonce_lease_id,chain_id,sender_address,nonce,transaction_hash,evidence)
    VALUES(p->>'proofId',c.contribution_id,c.nonce_lease_id,84532,i->>'from',(i->>'nonce')::BIGINT,p->>'transactionHash',p)
    RETURNING * INTO previous;
  UPDATE reward_contribution_reservations_v2 SET disposition='closed',closure_proof_id=previous.proof_id
    WHERE contribution_id=c.contribution_id AND reservation_id=r->'reservation'->>'reservation_id' AND disposition='held';
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'held cancellation reservation missing' USING ERRCODE='PCV11'; END IF;
  UPDATE reward_funding_account_counters_v2 SET active=active-1
    WHERE account_id=c.account_id AND scope_leg IN ('',c.pool_leg_id) AND active>0;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>2 THEN RAISE EXCEPTION 'cancellation active counters missing' USING ERRCODE='PCV11'; END IF;
  UPDATE song_megapot_contributions_v2 SET state=jsonb_set(jsonb_set(jsonb_set(state,
    '{nonceFinalized}','true'),'{fundingState}','"nonce_closed_no_principal"'),'{revision}',to_jsonb(expected_revision+1))
    WHERE contribution_id=c.contribution_id AND (state->>'revision')::BIGINT=expected_revision;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'cancellation state changed' USING ERRCODE='PCV06'; END IF;
  RETURN to_jsonb(previous)||jsonb_build_object('nonce',previous.nonce::TEXT);
END $$;

CREATE OR REPLACE FUNCTION reward_wallet_nonce_ownership_open_v2(p_chain BIGINT,p_sender TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM reward_wallet_nonce_leases l WHERE l.chain_id=p_chain AND l.sender_address=p_sender AND
        CASE WHEN l.source='song_funding_v2' THEN NOT EXISTS(
          SELECT 1 FROM song_megapot_contributions_v2 c JOIN reward_incoming_receipts_v2 r USING(contribution_id)
          WHERE c.nonce_lease_id=l.lease_id AND c.contribution_id=l.owner_id AND c.account_id=l.account_id
            -- Incoming evidence is uint256; the owned lease nonce remains BIGINT.
            AND (c.state->>'nonceFinalized')::BOOLEAN AND (r.evidence->>'observedConfirmedNonce')::NUMERIC>l.nonce::NUMERIC) AND NOT EXISTS(
          SELECT 1 FROM reward_funding_cancellation_proofs_v2 p JOIN song_megapot_contributions_v2 c USING(contribution_id)
          WHERE p.nonce_lease_id=l.lease_id AND p.contribution_id=l.owner_id AND c.account_id=l.account_id
            AND p.chain_id=l.chain_id AND p.sender_address=l.sender_address AND p.nonce=l.nonce
            AND (c.state->>'nonceFinalized')::BOOLEAN AND c.state->>'fundingState'='nonce_closed_no_principal'
            AND (p.evidence->>'confirmedNonce')::NUMERIC>l.nonce::NUMERIC)
        ELSE NOT EXISTS(SELECT 1 FROM reward_winner_send_outcomes o WHERE o.send_id=l.winner_send_id AND o.attempt=l.winner_attempt AND o.observed_confirmed_nonce>l.nonce) END)
$$;

CREATE OR REPLACE FUNCTION read_owned_song_contribution_current_v2(i JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE c song_megapot_contributions_v2; s JSONB; r JSONB; instr JSONB;
  incoming reward_incoming_receipts_v2; reservation reward_contribution_reservations_v2;
  completed reward_funding_cancellation_proofs_v2; late reward_late_principal_liabilities_v2; seal TEXT; claims JSONB:='[]'; g JSONB;
  cancel JSONB; nonce_status TEXT; category TEXT; current_state TEXT; actions JSONB;
  updated TIMESTAMPTZ; plan_state TEXT; refusal TEXT;
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
  updated:=greatest(c.created_at,incoming.created_at,completed.created_at,
    (SELECT max(created_at) FROM song_megapot_contribution_commands_v2 WHERE contribution_id=c.contribution_id),
    CASE WHEN current_state='expired_reconciling' THEN (s->>'effectiveDeadline')::TIMESTAMPTZ END);
  RETURN jsonb_build_object('accountId',c.account_id,'current',jsonb_build_object(
    'object','song_megapot_contribution_state','version',2,'contribution_id',c.contribution_id,
    'funding_effect_id',c.funding_effect_id,'revision',s->'revision','state',current_state,'nonce_state',nonce_status,
    'disposition',category,'target',r->'target','original_persona_id',s->'owner'->>'persona_id',
    'original_sender',instr->>'from','terms_hash',r->>'terms_hash','instruction_hash',instr->>'instruction_hash',
    'receipt_evidence',incoming.evidence->'evidence',
    'pool_credit_atomic',CASE WHEN incoming.category='pool_principal' THEN incoming.amount_atomic::TEXT ELSE '0' END,
    'late_principal_owed_atomic',coalesce(late.amount_atomic-late.paid_atomic,0)::TEXT,
    'refund_paid_atomic',coalesce(late.paid_atomic,0)::TEXT,
    'reservation_capacity_state',CASE reservation.disposition WHEN 'held' THEN 'reserved'
      WHEN 'converted' THEN 'consumed_by_pool_credit' ELSE 'released_after_nonce_consumed' END,
    'cohort_seal_id',seal,'allowed_actions',actions,'pause_reason',refusal,
    'updated_at',to_char(updated AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'submissions',claims,'command_receipt',r,'cancellation',jsonb_build_object(
      'object','contribution_cancellation_preparation_state','state',plan_state,
      'preparations_used',s->'preparationsUsed','current_preparation_id',cancel->'preparation_id',
      'current_preparation_revision',coalesce(cancel->'preparation_revision','0'::JSONB),'current_receipt',cancel)));
END $$;


-- Strip hostile inherited defaults; preserve all existing runtime entrypoint ACLs.
DO $cancellation_acl$
DECLARE trusted TEXT:=current_schema(); r RECORD; target OID; signature TEXT;
BEGIN
  FOREACH signature IN ARRAY ARRAY['recover_song_funding_cancellation_v2(jsonb,bigint,bigint)',
    'reward_wallet_nonce_ownership_open_v2(bigint,text)','read_owned_song_contribution_current_v2(jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog,%I,pg_temp',trusted,signature,trusted);
  END LOOP;
  target:='recover_song_funding_cancellation_v2(jsonb,bigint,bigint)'::regprocedure;
  EXECUTE format('REVOKE ALL ON FUNCTION %I.recover_song_funding_cancellation_v2(jsonb,bigint,bigint) FROM PUBLIC',trusted);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=target AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.recover_song_funding_cancellation_v2(jsonb,bigint,bigint) FROM %I CASCADE',trusted,r.name);
  END LOOP;
END $cancellation_acl$;

DO $cancellation_table_acl$
DECLARE owned_table REGCLASS; grant_row RECORD;
BEGIN
  owned_table:='reward_funding_cancellation_proofs_v2'::REGCLASS;
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',owned_table);
  FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    WHERE c.oid=owned_table AND acl.grantee<>0 AND acl.grantee<>c.relowner LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',owned_table,pg_get_userbyid(grant_row.grantee));
  END LOOP;
END $cancellation_table_acl$;
