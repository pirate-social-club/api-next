-- A song published after its community's pot was provisioned has an open slot
-- but no leg work envelope, so create_song_contribution_v2 refuses it with
-- work_budget_exhausted. Previously the context claim still quoted it, charging
-- context work, and the reader showed that quote as ready. Both now apply the
-- same account, leg and global envelope check as the create path: the claim
-- skips such a candidate before charging, and the reader reports
-- work_budget_exhausted instead of a usable quote. Explicit provisioning of the
-- slot's envelope remains the only way to make the song fundable. Ownership and
-- grants are unchanged.
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
   -- Quote only what create_song_contribution_v2 could admit: the account, this
   -- slot's leg and the global funding envelope each hold one more instruction.
   -- A song published after provisioning has no leg envelope and is skipped
   -- before any context work is charged.
   AND (SELECT count(*) FROM reward_funding_work_envelopes_v2 envelope
     WHERE envelope.profile_id=p.profile_id AND envelope.valid_until>clock_timestamp()
       AND envelope.allocated-envelope.used-envelope.reserved>=(p.policy->>'workPerInstruction')::BIGINT
       AND (envelope.scope,envelope.scope_key) IN (('account',account.user_id),
         ('leg',coalesce(s.target->>'pool_leg_id','empty-slot:'||s.slot_id)),('global','funding')))=3
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
 -- PCV13 is only this concurrent-charge refusal. Configuration errors stay PCV04.
 IF affected<>2 THEN RAISE EXCEPTION 'context work budget exhausted' USING ERRCODE='PCV13'; END IF;
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

CREATE OR REPLACE FUNCTION read_song_contribution_context_v2(i JSONB,persona TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE snap reward_funding_leg_snapshots_v2; slot reward_song_slots_v2;
  p reward_funding_profiles_v2; w reward_funding_schedule_witnesses_v2;
  refusal TEXT; funded NUMERIC; reserved NUMERIC; paused BOOLEAN; owned BOOLEAN; fallback_target JSONB; fallback_audio BIGINT;
BEGIN
  IF NOT can_account_access_activity_song(i->>'accountId',i->>'communityId',i->>'postId') OR NOT EXISTS(
    SELECT 1 FROM personas owned_persona JOIN persona_community_bindings b USING(persona_id,account_id)
      JOIN users u ON u.user_id=owned_persona.account_id AND u.status='active'
    WHERE owned_persona.account_id=i->>'accountId' AND owned_persona.persona_id=persona AND b.community_id=i->>'communityId'
      AND owned_persona.status IN('active','pending_wallet')) THEN
    RAISE EXCEPTION 'private owned funding context required' USING ERRCODE='PCV02'; END IF;
  SELECT s.* INTO snap FROM reward_funding_leg_snapshots_v2 s JOIN reward_song_slots_v2 l USING(slot_id)
    WHERE l.community_id=i->>'communityId' AND l.post_id=i->>'postId'
      AND s.context->'actor'->>'account_id'=i->>'accountId' AND s.context->'actor'->>'persona_id'=persona
    ORDER BY s.created_at DESC,s.snapshot_id DESC LIMIT 1;
  IF NOT FOUND THEN
    SELECT * INTO slot FROM reward_song_slots_v2 WHERE community_id=i->>'communityId' AND post_id=i->>'postId';
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT audio_revision INTO fallback_audio FROM song_owner_policies WHERE community_id=slot.community_id AND post_id=slot.post_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    fallback_target:=coalesce(slot.target,jsonb_build_object('kind','empty','community_id',slot.community_id,'post_id',slot.post_id,
      'canonical_song_id',slot.post_id,'audio_revision',fallback_audio,'slot_id',slot.slot_id,'slot_generation',slot.generation,'offer_id',NULL,'pool_leg_id',NULL));
    refusal:=CASE WHEN NOT EXISTS(SELECT 1 FROM persona_wallet_assignments a WHERE a.account_id=i->>'accountId' AND a.persona_id=persona AND a.status='active')
      THEN 'wallet_not_ready' WHEN slot.target IS NULL AND EXISTS(SELECT 1 FROM song_reward_offers o WHERE o.community_id=slot.community_id
        AND o.post_id=slot.post_id AND o.status IN('draft','active','paused','operational_hold')) THEN 'legacy_pool_incompatible'
      -- An admitted community's song without room in the account, leg or global
      -- funding envelope is unfundable, not merely awaiting its first quote.
      WHEN EXISTS(SELECT 1 FROM reward_shared_song_template_admissions_v2 admission
        JOIN reward_shared_song_templates_v2 template USING(community_id,template_id)
        JOIN reward_funding_profiles_v2 admitted ON admitted.profile_id=template.profile_id
        WHERE admission.community_id=slot.community_id AND admission.accepted
          AND admission.effective_at<=statement_timestamp() AND admission.valid_until>statement_timestamp()
          AND (SELECT count(*) FROM reward_funding_work_envelopes_v2 envelope
            WHERE envelope.profile_id=admitted.profile_id AND envelope.valid_until>statement_timestamp()
              AND envelope.allocated-envelope.used-envelope.reserved>=(admitted.policy->>'workPerInstruction')::BIGINT
              AND (envelope.scope,envelope.scope_key) IN (('account',i->>'accountId'),
                ('leg',coalesce(slot.target->>'pool_leg_id','empty-slot:'||slot.slot_id)),('global','funding')))<>3)
        THEN 'work_budget_exhausted'
      ELSE 'policy_unavailable' END;
    RETURN jsonb_build_object('object','song_megapot_funding_context','version',2,'readiness','unavailable',
      'target',fallback_target,'persona_id',persona,'reason',refusal,'retry_after_seconds',NULL,'own_recovery_href',NULL);
  END IF;
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
    WHEN reward_wallet_nonce_ownership_open_v2((snap.context->>'chain_id')::BIGINT,snap.context->'actor'->>'sender_address') THEN 'wallet_nonce_busy'
    WHEN NOT slot.reward_policy_ready THEN 'mixed_objective_unavailable'
    WHEN slot.status<>'open' THEN 'recovery_required'
    -- The same envelopes create_song_contribution_v2 charges; a quote it would
    -- refuse is never shown as ready.
    WHEN (SELECT count(*) FROM reward_funding_work_envelopes_v2 envelope
      WHERE envelope.profile_id=p.profile_id AND envelope.valid_until>statement_timestamp()
        AND envelope.allocated-envelope.used-envelope.reserved>=(p.policy->>'workPerInstruction')::BIGINT
        AND (envelope.scope,envelope.scope_key) IN (('account',i->>'accountId'),
          ('leg',coalesce(slot.target->>'pool_leg_id','empty-slot:'||slot.slot_id)),('global','funding')))<>3
      THEN 'work_budget_exhausted'
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

-- CREATE OR REPLACE resets function settings. Restore 0328's and 0319's exact pins.
DO $context_paths$
BEGIN
  EXECUTE format('ALTER FUNCTION claim_next_shared_song_context_v2(text) SECURITY DEFINER SET search_path TO %I, pg_catalog, pg_temp',current_schema());
  EXECUTE format('ALTER FUNCTION %I.read_song_contribution_context_v2(jsonb,text) SET search_path TO pg_catalog,%I,pg_temp',current_schema(),current_schema());
END $context_paths$;
