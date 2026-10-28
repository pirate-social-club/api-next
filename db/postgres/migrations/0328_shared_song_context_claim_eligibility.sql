-- Shared-song context claims skip pots that can no longer accept a contribution
-- and accounts or profiles whose context-work counter has no room for another
-- attempt. Previously an exhausted account raised on its oldest candidate, the
-- rollback kept that candidate oldest, and every later batch failed before any
-- eligible account could be quoted. The counter update and its raise remain as
-- the guard against a concurrent charge. Ownership and grants are unchanged.
CREATE OR REPLACE FUNCTION claim_next_shared_song_context_v2(p_token TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate RECORD; work reward_song_context_work_v2; slot reward_song_slots_v2;
 t reward_shared_song_templates_v2; profile reward_funding_profiles_v2; deployment megapot_deployment_attestations;
 wallet persona_wallet_assignments; song_policy song_owner_policies; leg song_reward_offer_legs;
 actor JSONB; target JSONB; budget JSONB; total NUMERIC; reserved NUMERIC; now_ms BIGINT;
 max_attempts BIGINT; lease_ms BIGINT; capacity_revision BIGINT; work_key TEXT; units BIGINT; affected INTEGER;
BEGIN
 PERFORM require_reward_run_authority_v1();
 IF (SELECT paused FROM reward_operations_control WHERE singleton) IS DISTINCT FROM FALSE THEN RETURN NULL; END IF;
 -- One bounded candidate, ordered by prior attempt rather than a lossy watermark.
 -- Non-members' own community-bound personas use this exact same path.
 SELECT s.slot_id,a.assignment_id,template.template_id INTO candidate
 FROM reward_shared_song_template_admissions_v2 admission JOIN reward_shared_song_templates_v2 template USING(community_id,template_id)
 JOIN reward_funding_profiles_v2 p ON p.profile_id=template.profile_id
 JOIN reward_song_slots_v2 s ON s.community_id=template.community_id AND s.status='open'
 JOIN persona_community_bindings binding ON binding.community_id=s.community_id
 JOIN personas persona USING(persona_id,account_id)
 JOIN persona_wallet_assignments a ON a.persona_id=persona.persona_id AND a.account_id=persona.account_id
 JOIN users account ON account.user_id=persona.account_id
 LEFT JOIN reward_song_context_work_v2 prior ON prior.slot_id=s.slot_id AND prior.assignment_id=a.assignment_id AND prior.template_id=template.template_id
 WHERE admission.accepted AND admission.effective_at<=clock_timestamp() AND admission.valid_until>clock_timestamp()
   AND shared_song_qualification_templates_ready_v2(template.template_id)
   AND template.valid_from<=clock_timestamp() AND template.valid_until>clock_timestamp() AND p.accepted AND p.valid_until>clock_timestamp()
   AND account.status='active' AND persona.status='active' AND a.status='active' AND a.chain_account_kind='evm'
   AND can_account_access_activity_song(account.user_id,s.community_id,s.post_id)
   -- A committed pot is a candidate only while create_song_contribution_v2 could
   -- still admit a contribution: its frozen terms have not ended, and neither the
   -- leg nor this account has reached the profile's admitted-contribution limit.
   AND (s.target IS NULL OR (
     ((s.terms->>'ends_at')::TIMESTAMPTZ<=clock_timestamp()) IS NOT TRUE
     AND ((SELECT count(*) FROM song_megapot_contributions_v2 c WHERE c.pool_leg_id=s.target->>'pool_leg_id'
       AND c.state->>'fundingState'<>'nonce_closed_no_principal')
       >=least((p.policy->>'maxLegLiabilities')::BIGINT,(p.policy->>'maxAdmittedLeg')::BIGINT)) IS NOT TRUE
     AND ((SELECT count(*) FROM song_megapot_contributions_v2 c WHERE c.account_id=account.user_id
       AND c.pool_leg_id=s.target->>'pool_leg_id' AND c.state->>'fundingState'<>'nonce_closed_no_principal')
       >=(p.policy->>'maxAdmittedAccountLeg')::BIGINT) IS NOT TRUE))
   -- Skip an account, or the whole profile, without room for one more charged
   -- attempt, so an exhausted counter cannot raise for or block other candidates.
   AND NOT EXISTS(SELECT 1 FROM reward_context_work_counters_v2 counter
     WHERE counter.profile_id=p.profile_id AND counter.account_id IN ('',account.user_id)
       AND (counter.maximum_units IS DISTINCT FROM (CASE WHEN counter.account_id='' THEN template.operational_profile->>'maximumContextWorkGlobal'
             ELSE template.operational_profile->>'maximumContextWorkPerAccount' END)::BIGINT
         OR counter.used_units+(template.operational_profile->>'contextWorkPerAttempt')::BIGINT>counter.maximum_units))
   AND (s.target IS NOT NULL OR NOT EXISTS(SELECT 1 FROM song_reward_offers existing WHERE existing.community_id=s.community_id AND existing.post_id=s.post_id
     AND existing.status IN('draft','active','paused','operational_hold')))
   AND ((template.operational_profile->>'maximumContextAttempts')::BIGINT>0
     AND (template.operational_profile->>'contextLeaseMs')::BIGINT>0)
   AND (prior.work_id IS NULL OR (prior.attempts<(template.operational_profile->>'maximumContextAttempts')::BIGINT
     AND (prior.status<>'running' OR prior.lease_until<=clock_timestamp())
     AND NOT EXISTS(SELECT 1 FROM reward_funding_leg_snapshots_v2 fresh WHERE fresh.slot_id=s.slot_id
       AND fresh.profile_id=p.profile_id AND fresh.context->'actor'->>'wallet_assignment_id'=a.assignment_id
       AND (fresh.context->>'context_expires_at')::TIMESTAMPTZ>clock_timestamp()
       AND fresh.context->'context_ref'->'slot_generation'=to_jsonb(s.generation)
       AND fresh.refusal IS NULL)))
 ORDER BY prior.updated_at NULLS FIRST,s.slot_id,a.assignment_id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('song-context:'||candidate.slot_id||':'||candidate.assignment_id,0));
 SELECT * INTO STRICT slot FROM reward_song_slots_v2 WHERE slot_id=candidate.slot_id FOR SHARE;
 SELECT * INTO STRICT t FROM reward_shared_song_templates_v2 WHERE template_id=candidate.template_id FOR SHARE;
 SELECT * INTO STRICT profile FROM reward_funding_profiles_v2 WHERE profile_id=t.profile_id FOR SHARE;
 SELECT * INTO STRICT wallet FROM persona_wallet_assignments WHERE assignment_id=candidate.assignment_id AND status='active' FOR SHARE;
 SELECT * INTO STRICT deployment FROM megapot_deployment_attestations WHERE attestation_id=t.attestation_id AND status='active' AND retired_at IS NULL FOR SHARE;
 SELECT * INTO STRICT song_policy FROM song_owner_policies WHERE community_id=slot.community_id AND post_id=slot.post_id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM reward_shared_song_template_admissions_v2 a WHERE a.community_id=slot.community_id AND a.template_id=t.template_id
   AND a.accepted AND a.effective_at<=clock_timestamp() AND a.valid_until>clock_timestamp()) OR NOT profile.accepted OR profile.valid_until<=clock_timestamp() THEN
   RAISE EXCEPTION 'shared context policy changed' USING ERRCODE='PCV05'; END IF;
 max_attempts:=(t.operational_profile->>'maximumContextAttempts')::BIGINT; lease_ms:=(t.operational_profile->>'contextLeaseMs')::BIGINT;
 IF max_attempts<=0 OR lease_ms<=0 THEN RAISE EXCEPTION 'finite context work profile required' USING ERRCODE='PCV04'; END IF;
 work_key:='context:'||encode(sha256(convert_to(jsonb_build_array(slot.slot_id,wallet.assignment_id,t.template_id)::TEXT,'UTF8')),'hex');
 INSERT INTO reward_song_context_work_v2(work_id,slot_id,assignment_id,template_id,attempts,token,lease_until,status)
 VALUES(work_key,slot.slot_id,wallet.assignment_id,t.template_id,1,p_token,clock_timestamp()+lease_ms*interval '1 millisecond','running')
 ON CONFLICT(slot_id,assignment_id,template_id) DO UPDATE SET attempts=reward_song_context_work_v2.attempts+1,token=p_token,
   lease_until=clock_timestamp()+lease_ms*interval '1 millisecond',status='running',last_error=NULL,updated_at=clock_timestamp()
 WHERE reward_song_context_work_v2.attempts<max_attempts AND (reward_song_context_work_v2.status<>'running' OR reward_song_context_work_v2.lease_until<=clock_timestamp())
 RETURNING * INTO work;
 IF NOT FOUND THEN RETURN NULL; END IF;
 units:=(t.operational_profile->>'contextWorkPerAttempt')::BIGINT;
 IF units<=0 OR (t.operational_profile->>'maximumContextWorkPerAccount')::BIGINT<units
    OR (t.operational_profile->>'maximumContextWorkGlobal')::BIGINT<units THEN
   RAISE EXCEPTION 'positive finite context work budget required' USING ERRCODE='PCV04'; END IF;
 INSERT INTO reward_context_work_counters_v2(profile_id,account_id,maximum_units,used_units)
 SELECT profile.profile_id,v.account_id,v.maximum_units,units FROM (VALUES
   (''::TEXT,(t.operational_profile->>'maximumContextWorkGlobal')::BIGINT),
   (wallet.account_id,(t.operational_profile->>'maximumContextWorkPerAccount')::BIGINT)) v(account_id,maximum_units)
 ORDER BY v.account_id
 ON CONFLICT(profile_id,account_id) DO UPDATE SET used_units=reward_context_work_counters_v2.used_units+excluded.used_units
 WHERE reward_context_work_counters_v2.maximum_units=excluded.maximum_units
   AND reward_context_work_counters_v2.used_units+excluded.used_units<=reward_context_work_counters_v2.maximum_units;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>2 THEN RAISE EXCEPTION 'context work budget exhausted' USING ERRCODE='PCV04'; END IF;
 actor:=jsonb_build_object('account_id',wallet.account_id,'persona_id',wallet.persona_id,'community_id',slot.community_id,
   'wallet_assignment_id',wallet.assignment_id,'wallet_index',wallet.hd_wallet_index,'sender_address',wallet.address);
 target:=coalesce(slot.target,jsonb_build_object('kind','empty','community_id',slot.community_id,'post_id',slot.post_id,
   'canonical_song_id',slot.post_id,'audio_revision',song_policy.audio_revision,'slot_id',slot.slot_id,'slot_generation',slot.generation,'offer_id',NULL,'pool_leg_id',NULL));
 SELECT * INTO leg FROM song_reward_offer_legs WHERE leg_id=slot.target->>'pool_leg_id';
 SELECT coalesce(sum(r.amount_atomic),0) INTO total FROM reward_incoming_receipts_v2 r JOIN song_megapot_contributions_v2 c USING(contribution_id)
   WHERE c.pool_leg_id=leg.leg_id AND r.category='pool_principal';
 SELECT coalesce(sum(amount_atomic),0) INTO reserved FROM reward_contribution_reservations_v2 WHERE pool_leg_id=leg.leg_id AND disposition='held';
 budget:=jsonb_build_object('funded',total::TEXT,'spent',coalesce(leg.spent_atomic,0)::TEXT,
   'committedPurchases',coalesce(leg.reserved_atomic,0)::TEXT,'refunded',coalesce(leg.refunded_atomic,0)::TEXT,
   'otherObligations',coalesce(leg.fulfilled_atomic,0)::TEXT,'liveInboundReservations',reserved::TEXT);
 SELECT count(*) INTO capacity_revision FROM song_megapot_contributions_v2 WHERE pool_leg_id=leg.leg_id;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT;
 RETURN jsonb_build_object('workId',work.work_id,'token',work.token,'attempt',work.attempts,'templateHash',t.template_hash,
   'profileId',profile.profile_id,'validUntil',to_char(least(profile.valid_until,t.valid_until) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'noncePolicy',profile.nonce_policy,'operations',t.operational_profile,
   'qualificationDocuments',(SELECT jsonb_agg(jsonb_build_object('policyId',q.qualification_policy_version_id,'activity',q.activity_key,
      'kind',q.policy_kind,'document',q.policy_document) ORDER BY q.activity_key)
    FROM jsonb_array_elements(t.qualification_templates) b JOIN qualification_policy_versions q ON q.qualification_policy_version_id=b->>'qualification_policy_id'),
   'drawingStates',coalesce((SELECT jsonb_agg(jsonb_build_object('drawingId',d.drawing_id::TEXT,
      'state',CASE WHEN d.actual_ticket_cost_atomic>0 THEN 'settled'
        WHEN d.reserved_ticket_cost_atomic>0 THEN 'committed'
        WHEN d.status='entry_open' THEN 'uncommitted' ELSE 'cancelled' END,
      'reservedCostAtomic',CASE WHEN d.actual_ticket_cost_atomic=0 AND d.reserved_ticket_cost_atomic>0 THEN d.reserved_ticket_cost_atomic ELSE 0 END::TEXT,
      'entryCutoffAtMs',floor(extract(epoch FROM d.entry_cutoff_at)*1000)::BIGINT) ORDER BY d.drawing_id)
      FROM megapot_pool_drawings d WHERE d.pool_leg_id=leg.leg_id),'[]'::JSONB),
   'deployment',jsonb_build_object('attestationId',deployment.attestation_id,'environment',deployment.environment,'chainId',deployment.chain_id,
     'jackpotAddress',deployment.jackpot_address,'ticketNftAddress',deployment.ticket_nft_address,'usdcAddress',deployment.usdc_address,
     'custodyAddress',deployment.custody_address,'referrerAddress',deployment.referrer_address,'jackpotCodeHash',deployment.jackpot_code_hash,
     'ticketNftCodeHash',deployment.ticket_nft_code_hash,'usdcCodeHash',deployment.usdc_code_hash),
   'attestationBlock',deployment.attestation_block_number::TEXT,'attestationBlockHash',deployment.attestation_block_hash,
   'facts',jsonb_build_object('slot',target,'slotId',slot.slot_id,'slotGeneration',slot.generation,'committedTerms',slot.terms,
     'legSnapshotId',CASE WHEN slot.target IS NULL THEN NULL ELSE work.work_id||':'||work.attempts::TEXT END,
     'actor',actor,'walletAssignmentRevision',floor(extract(epoch FROM wallet.updated_at)*1000)::BIGINT,'lifecycleRevision',slot.generation,
     'capacityRevision',capacity_revision,'profileId',profile.profile_id,'profileHash',profile.profile_hash,
     'capacityProfile',profile.capacity_profile,'limitsPolicy',profile.policy-ARRAY['reconciliation'],
     'budget',budget,'costsReconciled',slot.target IS NULL OR (total=leg.funded_atomic
       AND leg.reserved_atomic=(SELECT coalesce(sum(d.reserved_ticket_cost_atomic),0) FROM megapot_pool_drawings d
         WHERE d.pool_leg_id=leg.leg_id AND d.actual_ticket_cost_atomic=0 AND d.reserved_ticket_cost_atomic>0)
       AND leg.spent_atomic=(SELECT coalesce(sum(d.actual_ticket_cost_atomic),0) FROM megapot_pool_drawings d WHERE d.pool_leg_id=leg.leg_id)
       AND NOT EXISTS(SELECT 1 FROM megapot_pool_drawings d WHERE d.pool_leg_id=leg.leg_id AND d.status='operational_hold')),
     'fundingPolicyRevision',song_policy.current_policy_revision,'fundingPolicyHash',song_policy.current_policy_hash,
     'rewardPolicyTemplateHash',t.template_hash,'qualificationTemplates',t.qualification_templates,
     'disclosureVersion',t.operational_profile->>'disclosureVersion','feePolicyId',t.operational_profile->>'feePolicyId',
     'chainId',deployment.chain_id,'tokenAddress',deployment.usdc_address,'custodyAddress',deployment.custody_address,'attestationId',deployment.attestation_id,
     -- Refund capacity is a selected, unexpired work envelope, not a claim that
     -- a missing custody/outbound interpreter has completed any obligation.
     'gasReady',EXISTS(SELECT 1 FROM reward_funding_work_envelopes_v2 envelope
       WHERE envelope.scope='global' AND envelope.scope_key='funding' AND envelope.profile_id=profile.profile_id
         AND envelope.valid_until>clock_timestamp() AND envelope.allocated-envelope.used-envelope.reserved>=(profile.policy->>'workPerInstruction')::BIGINT),
     'remainingEffects',greatest(0,(profile.policy->>'maxLegLiabilities')::BIGINT-capacity_revision),
     'pendingAccountSlots',greatest(0,(profile.policy->>'maxActiveAccount')::BIGINT-(SELECT count(*) FROM song_megapot_contributions_v2 c
       WHERE c.account_id=wallet.account_id AND NOT(c.state->>'nonceFinalized')::BOOLEAN))));
END $$;

-- CREATE OR REPLACE resets function settings. Restore 0284's exact pin.
DO $claim_path$
BEGIN
  EXECUTE format('ALTER FUNCTION claim_next_shared_song_context_v2(text) SECURITY DEFINER SET search_path TO %I, pg_catalog, pg_temp',current_schema());
END $claim_path$;
