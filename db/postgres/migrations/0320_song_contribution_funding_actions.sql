-- Expose the ordinary funding claim only while its original authority remains
-- live. The same read-only predicate is used after the command's existing locks;
-- GET never acquires a work lease, charges work or grants wallet authority.
CREATE FUNCTION song_contribution_signing_refusal_v2(i JSONB, observed_at TIMESTAMPTZ) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE c song_megapot_contributions_v2; instr JSONB; p reward_funding_profiles_v2;
  snap reward_funding_leg_snapshots_v2; brake BOOLEAN; run reward_operations_run_lease;
BEGIN
  SELECT * INTO c FROM song_megapot_contributions_v2 WHERE contribution_id=i->>'contributionId'
    AND account_id=i->>'accountId' AND community_id=i->>'communityId' AND post_id=i->>'postId';
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  instr:=c.state->'receipt'->'instruction';
  SELECT paused INTO brake FROM reward_operations_control WHERE singleton;
  SELECT * INTO run FROM reward_operations_run_lease WHERE singleton;
  IF brake IS DISTINCT FROM FALSE OR run.required IS NULL OR (run.required AND
    (run.run_id IS NOT NULL AND run.expires_at>observed_at
      AND run.absolute_deadline>observed_at) IS NOT TRUE) THEN RETURN 'paused'; END IF;
  IF NOT EXISTS(SELECT 1 FROM persona_wallet_assignments wa
    JOIN personas v USING(persona_id,account_id)
    JOIN persona_community_bindings b USING(persona_id,account_id)
    JOIN users u ON u.user_id=wa.account_id
    WHERE wa.assignment_id=instr->>'wallet_assignment_id' AND wa.account_id=c.account_id
      AND wa.persona_id=c.state->'owner'->>'persona_id' AND wa.address=instr->>'from'
      AND wa.status='active' AND v.status='active' AND u.status='active' AND b.community_id=c.community_id)
    THEN RETURN 'persona_not_owned'; END IF;
  IF NOT EXISTS(SELECT 1 FROM reward_wallet_nonce_leases l WHERE l.lease_id=c.nonce_lease_id
    AND l.source='song_funding_v2' AND l.owner_id=c.contribution_id
    AND l.command_id=c.state->'receipt'->>'command_id' AND l.request_hash=c.state->'receipt'->>'request_hash'
    AND l.account_id=c.account_id AND l.persona_id=c.state->'owner'->>'persona_id'
    AND l.wallet_assignment_id=instr->>'wallet_assignment_id' AND l.chain_id=(instr->>'chain_id')::BIGINT
    AND l.sender_address=instr->>'from' AND l.nonce=(instr->>'nonce')::BIGINT)
    THEN RETURN 'lifecycle_changed'; END IF;
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=c.profile_id;
  SELECT * INTO STRICT snap FROM reward_funding_leg_snapshots_v2 WHERE snapshot_id=c.snapshot_id;
  IF NOT p.accepted OR least(p.valid_until,(p.recovery_policy->>'valid_until')::TIMESTAMPTZ)<=observed_at THEN RETURN 'policy_unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM megapot_deployment_attestations a
    WHERE a.attestation_id=instr->>'attestation_id' AND a.status='active' AND a.retired_at IS NULL
      AND a.verified_at<=observed_at AND a.chain_id=(instr->>'chain_id')::BIGINT
      AND a.usdc_address=instr->>'to_token' AND a.custody_address=instr->>'recipient_custody')
    THEN RETURN 'attestation_unavailable'; END IF;
  RETURN snap.recovery_authority->>'currentSigningRefusal';
END $$;

CREATE OR REPLACE FUNCTION read_owned_song_contribution_current_v2(i JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE c song_megapot_contributions_v2; s JSONB; r JSONB; instr JSONB;
  incoming reward_incoming_receipts_v2; reservation reward_contribution_reservations_v2;
  late reward_late_principal_liabilities_v2; seal TEXT; claims JSONB:='[]'; g JSONB;
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
  -- Expiry, absent hash and a client assertion never prove nonce consumption.
  -- This source has no accepted no-principal/outbound completion interpreter.
  nonce_status:=CASE WHEN incoming.receipt_id IS NOT NULL AND (s->>'nonceFinalized')::BOOLEAN
    THEN 'consumed_transfer' ELSE 'unresolved' END;
  category:=CASE incoming.category WHEN 'pool_principal' THEN 'pool_principal'
    WHEN 'late_principal' THEN 'late_principal' WHEN 'unattributed_principal' THEN 'unattributed_asset'
    ELSE 'unresolved' END;
  current_state:=CASE WHEN s->>'fundingState'='nonce_closed_no_principal' AND incoming.receipt_id IS NULL
    THEN 'manual_reconciliation_required' ELSE s->>'fundingState' END;
  IF reservation.disposition='closed' AND incoming.receipt_id IS NULL THEN
    RAISE EXCEPTION 'closed reservation lacks accepted nonce disposition' USING ERRCODE='PCV10';
  END IF;
  FOREACH g IN ARRAY ARRAY[s->'fundingGrant',s->'cancellationGrant'] LOOP
    IF g IS NOT NULL AND g<>'null'::JSONB THEN
      claims:=claims||jsonb_build_array(jsonb_build_object('state',CASE WHEN nonce_status='consumed_transfer' THEN 'finalized' ELSE 'claimed' END,
        'purpose',g->>'purpose','grant_id',g->>'grant_id','grant_revision',g->'grant_revision',
        'holder_client_instance_id',g->>'holder_client_instance_id','submission_attempt_id',g->>'submission_attempt_id',
        'valid_until',g->>'valid_until','cancellation_preparation_id',g->'cancellation_preparation_id',
        'cancellation_preparation_revision',g->'cancellation_preparation_revision'));
    END IF;
  END LOOP;
  cancel:=s->'cancellationHead';
  plan_state:=CASE WHEN cancel='null'::JSONB THEN 'not_prepared'
    WHEN s->'cancellationGrant'<>'null'::JSONB THEN CASE WHEN nonce_status='consumed_transfer' THEN 'finalized' ELSE 'claimed' END
    WHEN (cancel->>'dispatch_expires_at')::TIMESTAMPTZ<=statement_timestamp() THEN 'expired_unclaimed' ELSE 'prepared' END;
  -- These are reconciliation requests, not fresh wallet invocation authority.
  -- A consumed purpose remains claimed after its dispatch deadline expires.
  actions:=CASE WHEN nonce_status='consumed_transfer' THEN '["start_fresh_contribution"]'::JSONB
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
  updated:=greatest(c.created_at,incoming.created_at,
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

CREATE OR REPLACE FUNCTION load_song_contribution_recovery_v2(i JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c song_megapot_contributions_v2; s reward_funding_leg_snapshots_v2; p reward_funding_profiles_v2;
  owned BOOLEAN; paused BOOLEAN; available BOOLEAN; w reward_funding_schedule_witnesses_v2;
  a megapot_deployment_attestations; current_ok BOOLEAN; instr JSONB; until_at TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',i->>'accountId')::text,0));
  PERFORM 1 FROM reward_song_slots_v2 WHERE community_id=i->>'communityId' AND post_id=i->>'postId' FOR UPDATE;
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=i->>'contributionId' AND account_id=i->>'accountId' AND community_id=i->>'communityId' AND post_id=i->>'postId' FOR UPDATE;
  PERFORM lock_reward_wallet_nonce_sender_v2((c.state->'receipt'->'instruction'->>'chain_id')::BIGINT,c.state->'owner'->>'sender_address');
  SELECT * INTO STRICT s FROM reward_funding_leg_snapshots_v2 WHERE snapshot_id=c.snapshot_id;
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=c.profile_id FOR SHARE;
  instr:=c.state->'receipt'->'instruction';
  PERFORM 1 FROM persona_wallet_assignments WHERE assignment_id=instr->>'wallet_assignment_id' FOR SHARE;
  PERFORM 1 FROM personas WHERE persona_id=c.state->'owner'->>'persona_id' AND account_id=c.account_id FOR SHARE;
  SELECT * INTO a FROM megapot_deployment_attestations WHERE attestation_id=instr->>'attestation_id' FOR SHARE;
  SELECT * INTO w FROM reward_funding_schedule_witnesses_v2 WHERE profile_id=c.profile_id
    AND schedule->>'kind' IN ('cancellation_recovery_v2','cancellation_recovery_unavailable_v2') AND schedule->>'contributionId'=c.contribution_id
    ORDER BY (schedule->>'observedAt')::TIMESTAMPTZ DESC,(schedule->>'kind'='cancellation_recovery_unavailable_v2') DESC,created_at DESC,witness_id DESC LIMIT 1;
  SELECT EXISTS(SELECT 1 FROM persona_wallet_assignments wa JOIN personas v USING(persona_id,account_id) JOIN persona_community_bindings b USING(persona_id,account_id)
    WHERE wa.assignment_id=c.state->'owner'->>'wallet_assignment_id' AND wa.account_id=c.account_id AND wa.persona_id=c.state->'owner'->>'persona_id' AND wa.address=c.state->'owner'->>'sender_address'
      AND wa.status='active' AND v.status='active' AND b.community_id=c.community_id) INTO owned;
  SELECT x.paused INTO paused FROM reward_operations_control x WHERE singleton FOR SHARE;
  PERFORM 1 FROM reward_operations_run_lease WHERE singleton FOR SHARE;
  SELECT count(*)=3 INTO available FROM reward_funding_work_envelopes_v2 WHERE profile_id=c.profile_id AND valid_until>clock_timestamp()
    AND (scope,scope_key) IN (('account',c.account_id),('leg',c.pool_leg_id),('global','funding')) AND reserved>=1;
  until_at:=least(p.valid_until,(p.recovery_policy->>'valid_until')::TIMESTAMPTZ);
  current_ok:=coalesce(owned AND paused IS FALSE AND p.accepted AND p.recovery_policy IS NOT NULL
    AND p.recovery_policy->>'attestation_contract_version'='megapot-v2-current-recovery-v1'
    AND (p.recovery_policy->>'valid_from')::TIMESTAMPTZ<=clock_timestamp() AND until_at>clock_timestamp()
    AND a.status='active' AND a.retired_at IS NULL AND a.chain_id=(instr->>'chain_id')::BIGINT
    AND a.usdc_address=instr->>'to_token' AND a.custody_address=instr->>'recipient_custody'
    AND NOT (c.state->>'nonceFinalized')::BOOLEAN AND w.schedule->>'kind'='cancellation_recovery_v2' AND w.valid_until>clock_timestamp()
    AND w.schedule->>'profileHash'=p.profile_hash AND w.schedule->>'policyHash'=p.recovery_policy->>'policy_hash'
    AND w.schedule->>'noncePolicyHash'=p.nonce_policy->>'hash'
    AND w.schedule->>'instructionHash'=instr->>'instruction_hash' AND w.schedule->>'attestationId'=a.attestation_id
    AND w.schedule->>'attestationHash'=instr->>'attestation_hash' AND w.schedule->>'walletAssignmentId'=instr->>'wallet_assignment_id'
    AND w.schedule->>'sender'=instr->>'from' AND w.schedule->>'confirmedNonce'=instr->>'nonce'
    AND (w.schedule->>'pendingNonce')::NUMERIC>=(instr->>'nonce')::NUMERIC
    AND (w.schedule->>'observedAt')::TIMESTAMPTZ<=clock_timestamp()
    AND (w.schedule->>'blockTimestamp')::TIMESTAMPTZ<=clock_timestamp()
    AND (w.schedule->>'blockTimestamp')::TIMESTAMPTZ+((p.nonce_policy->>'maxAgeMs')::NUMERIC*interval '1 millisecond')>clock_timestamp()
    AND (w.schedule->>'observedAt')::TIMESTAMPTZ+((p.nonce_policy->>'maxAgeMs')::NUMERIC*interval '1 millisecond')>clock_timestamp(),FALSE);
  RETURN s.recovery_authority || jsonb_build_object('policy',CASE WHEN current_ok THEN p.recovery_policy ELSE NULL END,
    'currentEvidence',CASE WHEN current_ok THEN w.schedule ELSE NULL END,
    'attestationId',instr->>'attestation_id','attestationHash',instr->>'attestation_hash',
    'attestationValidUntil',to_char(until_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'originalWalletStillOwned',owned,'boundedWorkAvailable',available,
    'currentSigningRefusal',song_contribution_signing_refusal_v2(i,clock_timestamp()));
END $$;

-- CREATE OR REPLACE preserves the existing narrow runtime grants. The new
-- helper is owner-only and reachable solely through the scoped definer entrypoints.
DO $signing_paths$
DECLARE trusted TEXT:=current_schema(); signature TEXT; r RECORD; helper OID;
BEGIN
  FOREACH signature IN ARRAY ARRAY['song_contribution_signing_refusal_v2(jsonb,timestamp with time zone)',
    'read_owned_song_contribution_current_v2(jsonb)','load_song_contribution_recovery_v2(jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog,%I,pg_temp',trusted,signature,trusted);
  END LOOP;
  helper:='song_contribution_signing_refusal_v2(jsonb,timestamp with time zone)'::regprocedure;
  EXECUTE format('REVOKE ALL ON FUNCTION %I.song_contribution_signing_refusal_v2(jsonb,timestamp with time zone) FROM PUBLIC',trusted);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=helper AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.song_contribution_signing_refusal_v2(jsonb,timestamp with time zone) FROM %I CASCADE',trusted,r.name);
  END LOOP;
END $signing_paths$;
