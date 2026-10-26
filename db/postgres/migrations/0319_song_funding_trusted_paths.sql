-- Repair the context reader persona alias that collided with its local profile
-- record. Preserve all authorization, terms and lifecycle checks. The two284
-- replacements also lost their trusted paths; restore them without new grants,
-- roles, policies, captured terms or flags. The deferred accounting invariant
-- also needs owner-only read authority at COMMIT on PostgreSQL17. Keep its
-- body unchanged, pin its path and remove PUBLIC attachment authority.
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
        AND o.post_id=slot.post_id AND o.status IN('draft','active','paused','operational_hold')) THEN 'legacy_pool_incompatible' ELSE 'policy_unavailable' END;
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

DO $funding_paths$
DECLARE trusted TEXT:=current_schema(); signature TEXT;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'lock_song_contribution_context_v2(jsonb,text)',
  'read_song_contribution_context_v2(jsonb,text)'
 ] LOOP
  EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog,%I,pg_temp',trusted,signature,trusted);
 END LOOP;
END $funding_paths$;

-- Deferred constraint triggers on PostgreSQL17 run after the funding function
-- has restored its caller. Check the unchanged invariant as its trusted owner,
-- without exposing raw accounting tables to either funding login. PUBLIC must
-- not be able to attach this definer to an attacker-controlled table.
DO $funding_accounting$
DECLARE trusted TEXT:=current_schema();
BEGIN
 EXECUTE format('ALTER FUNCTION %I.validate_asset_bonus_leg_accounting() SECURITY DEFINER SET search_path TO pg_catalog,%I,pg_temp',trusted,trusted);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.validate_asset_bonus_leg_accounting() FROM PUBLIC',trusted);
END $funding_accounting$;
