-- SOURCE ONLY. No roles/credentials are created or guessed. Every new object
-- starts migration-owner only, including inherited/default grants. The parent
-- must bind exact existing runtime roles after independent migration review.
-- Private read capabilities expose authoritative persisted evidence only. GET
-- creates no quote, slot, purpose claim, budget or observation work item.
CREATE FUNCTION read_song_contribution_context_v2(i JSONB,persona TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE snap reward_funding_leg_snapshots_v2; slot reward_song_slots_v2;
  p reward_funding_profiles_v2; w reward_funding_schedule_witnesses_v2;
  refusal TEXT; funded NUMERIC; reserved NUMERIC; paused BOOLEAN; owned BOOLEAN;
BEGIN
  SELECT s.* INTO snap FROM reward_funding_leg_snapshots_v2 s JOIN reward_song_slots_v2 l USING(slot_id)
    WHERE l.community_id=i->>'communityId' AND l.post_id=i->>'postId'
      AND s.context->'actor'->>'account_id'=i->>'accountId' AND s.context->'actor'->>'persona_id'=persona
    ORDER BY s.created_at DESC,s.snapshot_id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO STRICT slot FROM reward_song_slots_v2 WHERE slot_id=snap.slot_id;
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=snap.profile_id;
  SELECT * INTO STRICT w FROM reward_funding_schedule_witnesses_v2 WHERE witness_id=snap.witness_id;
  SELECT x.paused INTO paused FROM reward_operations_control x WHERE singleton;
  SELECT EXISTS(SELECT 1 FROM persona_wallet_assignments a JOIN personas v USING(persona_id,account_id)
    JOIN persona_community_bindings b USING(persona_id,account_id)
    WHERE a.assignment_id=snap.context->'actor'->>'wallet_assignment_id' AND a.account_id=i->>'accountId'
      AND a.persona_id=persona AND a.status='active' AND v.status='active' AND b.community_id=slot.community_id
      AND a.address=snap.context->'actor'->>'sender_address') INTO owned;
  SELECT coalesce(sum(r.amount_atomic),0) INTO funded FROM reward_incoming_receipts_v2 r
    JOIN song_megapot_contributions_v2 c USING(contribution_id)
    WHERE c.pool_leg_id=slot.target->>'pool_leg_id' AND r.category='pool_principal';
  SELECT coalesce(sum(amount_atomic),0) INTO reserved FROM reward_contribution_reservations_v2
    WHERE pool_leg_id=slot.target->>'pool_leg_id' AND disposition='held';
  refusal:=CASE
    WHEN NOT owned THEN 'wallet_not_ready'
    WHEN paused IS DISTINCT FROM FALSE THEN 'paused'
    WHEN NOT p.accepted OR p.valid_until<=statement_timestamp() THEN 'policy_unavailable'
    WHEN NOT EXISTS(SELECT 1 FROM megapot_deployment_attestations a WHERE a.attestation_id=snap.context->>'attestation_id'
      AND a.status='active' AND a.retired_at IS NULL AND a.verified_at<=statement_timestamp()
      AND a.chain_id=(snap.context->>'chain_id')::BIGINT AND a.usdc_address=snap.context->>'token_address'
      AND a.custody_address=snap.context->>'custody_address') THEN 'attestation_unavailable'
    WHEN NOT slot.reward_policy_ready THEN 'mixed_objective_unavailable'
    WHEN slot.status<>'open' THEN 'recovery_required'
    WHEN w.valid_until<=statement_timestamp() OR (snap.context->>'context_expires_at')::TIMESTAMPTZ<=statement_timestamp() THEN 'observation_stale'
    WHEN snap.context->'context_ref'->>'profile_hash' IS DISTINCT FROM p.profile_hash
      OR snap.context->'context_ref'->>'schedule_witness_id' IS DISTINCT FROM w.witness_id
      OR (snap.context->'context_ref'->>'slot_generation')::BIGINT<>slot.generation
      OR (slot.target IS NOT NULL AND (snap.context->'target' IS DISTINCT FROM slot.target OR snap.context->'quote'->'committed_terms' IS DISTINCT FROM slot.terms))
      THEN 'recovery_required'
    WHEN NOT snap.costs_reconciled OR (snap.budget->>'funded')::NUMERIC IS DISTINCT FROM funded
      OR (snap.budget->>'liveInboundReservations')::NUMERIC IS DISTINCT FROM reserved THEN 'recovery_required'
    WHEN snap.refusal IS NOT NULL THEN 'recovery_required'
    ELSE NULL END;
  IF refusal IS NULL THEN RETURN snap.context; END IF;
  RETURN jsonb_build_object('object','song_megapot_funding_context','version',2,'readiness','unavailable',
    'target',coalesce(slot.target,snap.context->'target'),'persona_id',persona,'reason',refusal,
    'retry_after_seconds',NULL,'own_recovery_href',NULL);
END $$;

CREATE FUNCTION read_song_contribution_command_v2(i JSONB,o TEXT,k TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object('accountId',account_id,'communityId',community_id,'postId',post_id,
    'operation',operation,'key',idempotency_key,'requestHash',request_hash,'receipt',receipt)
  FROM song_megapot_contribution_commands_v2 WHERE account_id=i->>'accountId'
    AND community_id=i->>'communityId' AND post_id=i->>'postId' AND operation=o AND idempotency_key=k
$$;

CREATE FUNCTION read_owned_song_contribution_current_v2(i JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE c song_megapot_contributions_v2; s JSONB; r JSONB; instr JSONB;
  incoming reward_incoming_receipts_v2; reservation reward_contribution_reservations_v2;
  late reward_late_principal_liabilities_v2; seal TEXT; claims JSONB:='[]'; g JSONB;
  cancel JSONB; nonce_status TEXT; category TEXT; current_state TEXT; actions JSONB;
  updated TIMESTAMPTZ; plan_state TEXT;
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
    'cohort_seal_id',seal,'allowed_actions',actions,'pause_reason',NULL,
    'updated_at',to_char(updated AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'submissions',claims,'command_receipt',r,'cancellation',jsonb_build_object(
      'object','contribution_cancellation_preparation_state','state',plan_state,
      'preparations_used',s->'preparationsUsed','current_preparation_id',cancel->'preparation_id',
      'current_preparation_revision',coalesce(cancel->'preparation_revision','0'::JSONB),'current_receipt',cancel)));
END $$;

DO $acl$
DECLARE t RECORD; r RECORD; f RECORD; trusted TEXT:=current_schema();
BEGIN
  FOR t IN SELECT c.oid,c.relname,c.relowner FROM pg_class c WHERE c.relnamespace=to_regnamespace(trusted) AND c.relname IN (
    'reward_funding_profiles_v2','reward_funding_schedule_witnesses_v2','reward_song_slots_v2','reward_funding_leg_snapshots_v2',
    'song_megapot_contributions_v2','song_megapot_contribution_commands_v2','reward_funding_submission_claims_v2',
    'reward_contribution_reservations_v2','reward_funding_account_counters_v2','reward_funding_work_envelopes_v2',
    'reward_funding_scan_checkpoints_v2','reward_incoming_receipts_v2','reward_pool_cohort_seals_v2',
    'reward_pool_cohort_members_v2','reward_late_principal_liabilities_v2') LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC CASCADE',trusted,t.relname);
    FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=t.oid AND a.grantee<>0 AND a.grantee<>t.relowner LOOP
      EXECUTE format('REVOKE ALL ON %I.%I FROM %I CASCADE',trusted,t.relname,r.name);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure AS signature FROM pg_proc p WHERE p.pronamespace=to_regnamespace(trusted) AND p.proname IN (
    'read_song_contribution_context_v2','read_song_contribution_command_v2','read_owned_song_contribution_current_v2',
    'invalidate_song_recovery_evidence_v2','require_song_funding_work_lease_v2','song_funding_work_packet_v2','list_song_funding_work_v2','claim_song_funding_work_v2','record_song_recovery_evidence_v2','finish_song_funding_work_v2','reject_reward_contribution_history_v2','guard_reward_funding_scan_checkpoint_v2','guard_reward_song_slot_v2','load_song_contribution_command_v2','load_owned_song_contribution_v2','project_song_contribution_state_v2',
    'lock_song_contribution_context_v2','insert_song_contribution_command_v2','charge_reward_funding_work_v2','assert_reward_contribution_capacity_v2',
    'create_song_contribution_v2','update_song_contribution_command_v2','enqueue_song_contribution_reconciliation_v2',
    'load_song_contribution_recovery_v2','accept_reward_funding_principal_v2','record_reward_pool_cohort_v2','canonical_reward_funding_array_v2') LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',f.signature,trusted);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
    FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f.oid AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name);
    END LOOP;
  END LOOP;
  -- CREATE OR REPLACE retained the shared-nonce grants. Restore the secure path
  -- without revoking the accepted winner roles' existing context capability.
  EXECUTE format('ALTER FUNCTION reward_wallet_nonce_context_v2(bigint,text,text) SET search_path TO pg_catalog,%I,pg_temp',trusted);
END $acl$;

CREATE FUNCTION bind_reward_contribution_purpose_v2(role_name TEXT,purpose TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE allowed TEXT[]; signature TEXT; trusted TEXT:=current_schema(); target OID; owner OID;
BEGIN
  -- SECURITY INVOKER and owner-only EXECUTE: no runtime can bind itself.
  SELECT oid INTO STRICT target FROM pg_roles WHERE rolname=role_name AND NOT rolsuper AND NOT rolcreaterole AND NOT rolbypassrls;
  SELECT relowner INTO STRICT owner FROM pg_class WHERE oid='song_megapot_contributions_v2'::regclass;
  IF pg_has_role(target,owner,'MEMBER') THEN RAISE EXCEPTION 'runtime owns money authority' USING ERRCODE='42501'; END IF;
  CASE purpose
    WHEN 'http_commands' THEN allowed:=ARRAY[
      'read_song_contribution_context_v2(jsonb,text)','read_song_contribution_command_v2(jsonb,text,text)','read_owned_song_contribution_current_v2(jsonb)',
      'load_song_contribution_command_v2(text,text,text)','load_owned_song_contribution_v2(jsonb)',
      'lock_song_contribution_context_v2(jsonb,text)','create_song_contribution_v2(jsonb,jsonb,text)',
      'update_song_contribution_command_v2(jsonb,jsonb,jsonb,jsonb)','enqueue_song_contribution_reconciliation_v2(jsonb,jsonb,jsonb)',
      'load_song_contribution_recovery_v2(jsonb)','lock_reward_wallet_nonce_sender_v2(bigint,text)',
      'reward_wallet_nonce_context_v2(bigint,text,text)','reserve_reward_funding_wallet_nonce_v2(jsonb)',
      'load_reward_funding_wallet_nonce_owner_v2(jsonb)'];
    WHEN 'incoming_observer' THEN allowed:=ARRAY['load_owned_song_contribution_v2(jsonb)','accept_reward_funding_principal_v2(jsonb)'];
    WHEN 'funding_recovery_jobs' THEN allowed:=ARRAY[
      'invalidate_song_recovery_evidence_v2(text,text,text)','require_song_funding_work_lease_v2(text,text)','list_song_funding_work_v2(integer)','claim_song_funding_work_v2(text,text)',
      'record_song_recovery_evidence_v2(text,text,jsonb)','finish_song_funding_work_v2(text,text,jsonb)',
      'load_owned_song_contribution_v2(jsonb)','accept_reward_funding_principal_v2(jsonb)'];
    -- Evidence-only seal storage does not grant outgoing/refund completion.
    WHEN 'cohort_evidence' THEN allowed:=ARRAY['record_reward_pool_cohort_v2(text,text,text,jsonb)'];
    ELSE RAISE EXCEPTION 'unrecognized funding purpose' USING ERRCODE='42501';
  END CASE;
  FOREACH signature IN ARRAY allowed LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',trusted,signature,role_name);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION bind_reward_contribution_purpose_v2(TEXT,TEXT) FROM PUBLIC;
DO $binding_acl$
DECLARE r RECORD; f OID:='bind_reward_contribution_purpose_v2(text,text)'::regprocedure;
BEGIN
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION bind_reward_contribution_purpose_v2(text,text) FROM %I CASCADE',r.name);
  END LOOP;
END $binding_acl$;
