-- Complete the whitelisted ERC-20 asset-bonus leg and qualification claim path.

ALTER TABLE reward_asset_whitelist
  ADD COLUMN plain_erc20_verified_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM reward_asset_whitelist WHERE asset_kind = 'bonus_asset') THEN
    RAISE EXCEPTION
      'existing bonus assets require explicit plain ERC20 verification before migration 0088';
  END IF;
END
$$;

DROP TRIGGER reward_asset_whitelist_change_guard ON reward_asset_whitelist;

UPDATE reward_asset_whitelist
   SET plain_erc20_verified_at = activated_at
 WHERE asset_kind = 'settlement_usdc';

CREATE TRIGGER reward_asset_whitelist_change_guard
BEFORE UPDATE OR DELETE ON reward_asset_whitelist
FOR EACH ROW EXECUTE FUNCTION guard_reward_asset_whitelist_change();

ALTER TABLE reward_asset_whitelist
  ALTER COLUMN plain_erc20_verified_at SET NOT NULL,
  ADD CONSTRAINT reward_asset_whitelist_plain_erc20_verification_order CHECK (
    plain_erc20_verified_at <= activated_at
  );

CREATE FUNCTION guard_reward_asset_verification_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plain_erc20_verified_at IS DISTINCT FROM OLD.plain_erc20_verified_at THEN
    RAISE EXCEPTION 'reward asset ERC20 verification is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_asset_verification_change_guard
BEFORE UPDATE ON reward_asset_whitelist
FOR EACH ROW EXECUTE FUNCTION guard_reward_asset_verification_change();

ALTER TABLE song_reward_offer_legs
  ADD COLUMN token_symbol TEXT,
  ADD COLUMN asset_policy_version TEXT;

ALTER TABLE song_reward_offer_actions
  DROP CONSTRAINT song_reward_offer_actions_endpoint_template_check,
  DROP CONSTRAINT song_reward_offer_action_result_shape,
  ADD CONSTRAINT song_reward_offer_actions_endpoint_template_check CHECK (endpoint_template IN (
    '/communities/:communityId/posts/:postId/reward-offers',
    '/reward-offers/:offerId/megapot-pool-legs',
    '/reward-offers/:offerId/asset-bonus-legs',
    '/reward-offer-legs/:legId/funding',
    '/reward-offer-legs/:legId/funding/:fundingEffectId/observations',
    '/asset-bonus-legs/:legId/funding/:fundingEffectId/observations',
    '/reward-offers/:offerId/pause',
    '/reward-offers/:offerId/end'
  )),
  ADD CONSTRAINT song_reward_offer_action_result_shape CHECK (
    (endpoint_template IN (
      '/communities/:communityId/posts/:postId/reward-offers',
      '/reward-offers/:offerId/pause',
      '/reward-offers/:offerId/end'
    ) AND leg_id IS NULL AND funding_effect_id IS NULL)
    OR (endpoint_template IN (
      '/reward-offers/:offerId/megapot-pool-legs',
      '/reward-offers/:offerId/asset-bonus-legs'
    ) AND leg_id IS NOT NULL AND funding_effect_id IS NULL)
    OR (endpoint_template IN (
      '/reward-offer-legs/:legId/funding',
      '/reward-offer-legs/:legId/funding/:fundingEffectId/observations',
      '/asset-bonus-legs/:legId/funding/:fundingEffectId/observations'
    ) AND leg_id IS NOT NULL AND funding_effect_id IS NOT NULL)
  );

CREATE INDEX custody_solvency_observations_asset_latest_idx
  ON custody_solvency_observations (
    attestation_id, token_address, block_number DESC, observation_id
  );

UPDATE song_reward_offer_legs leg
   SET token_symbol = asset.symbol,
       asset_policy_version = asset.policy_version
  FROM reward_asset_whitelist asset
 WHERE leg.kind = 'asset_bonus'
   AND asset.chain_id = leg.chain_id
   AND asset.token_address = leg.token_address;

ALTER TABLE song_reward_offer_legs
  DROP CONSTRAINT song_reward_leg_kind_shape,
  ADD CONSTRAINT song_reward_leg_kind_shape CHECK (
    (kind = 'asset_bonus'
      AND amount_per_claim_atomic > 0 AND max_claims BETWEEN 1 AND 9007199254740991
      AND token_symbol IS NOT NULL AND btrim(token_symbol) <> ''
      AND token_symbol = btrim(token_symbol) AND octet_length(token_symbol) <= 32
      AND asset_policy_version IS NOT NULL AND btrim(asset_policy_version) <> ''
      AND asset_policy_version = btrim(asset_policy_version)
      AND octet_length(asset_policy_version) <= 128
      AND tickets_per_drawing IS NULL AND max_ticket_price_atomic IS NULL
      AND entry_cutoff_seconds IS NULL AND beneficiary_algorithm_version IS NULL
      AND ticket_selection_version IS NULL AND attestation_id IS NULL
      AND participation_starts_drawing_id IS NULL AND eligible_activities IS NULL
      AND min_score_bps IS NULL AND empty_pool_policy IS NULL AND funding_source IS NULL
      AND fallback_beneficiary_account_id IS NULL AND fallback_payout_persona_id IS NULL
      AND referral_allocation_version IS NULL AND referral_policy_hash IS NULL
      AND referral_disclosed_at IS NULL AND legal_activation_gate = 'test_only')
    OR
    (kind = 'megapot_pool'
      AND token_symbol IS NULL AND asset_policy_version IS NULL
      AND amount_per_claim_atomic IS NULL AND max_claims IS NULL
      AND tickets_per_drawing = 1 AND max_ticket_price_atomic > 0
      AND entry_cutoff_seconds > 0
      AND beneficiary_algorithm_version = 'equal_v1'
      AND ticket_selection_version = 'keccak_packed_v1'
      AND attestation_id IS NOT NULL AND participation_starts_drawing_id >= 0
      AND reward_distinct_nonempty_text_array(eligible_activities)
      AND min_score_bps BETWEEN 7000 AND 10000
      AND empty_pool_policy IN ('no_purchase', 'funder_fallback')
      AND funding_source IN ('leg_budget', 'shared_sponsor_budget'))
  );

CREATE FUNCTION guard_asset_bonus_leg_asset() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  asset_record reward_asset_whitelist%ROWTYPE;
BEGIN
  IF NEW.kind <> 'asset_bonus' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO asset_record
    FROM reward_asset_whitelist
   WHERE chain_id = NEW.chain_id AND token_address = NEW.token_address
   FOR SHARE;
  IF asset_record.token_address IS NULL
     OR asset_record.asset_kind <> 'bonus_asset'
     OR asset_record.environment NOT IN ('test', 'staging')
     OR asset_record.decimals <> NEW.token_decimals
     OR asset_record.symbol <> NEW.token_symbol
     OR asset_record.policy_version <> NEW.asset_policy_version THEN
    RAISE EXCEPTION 'asset bonus leg requires exact active bonus asset';
  END IF;
  IF TG_OP = 'INSERT' AND asset_record.status <> 'active' THEN
    RAISE EXCEPTION 'asset bonus leg requires exact active bonus asset';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.token_symbol, NEW.asset_policy_version)
      IS DISTINCT FROM ROW(OLD.token_symbol, OLD.asset_policy_version) THEN
    RAISE EXCEPTION 'asset bonus leg terms are immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_reward_offer_asset_legs_asset_guard
BEFORE INSERT OR UPDATE ON song_reward_offer_legs
FOR EACH ROW EXECUTE FUNCTION guard_asset_bonus_leg_asset();

CREATE FUNCTION guard_song_reward_bundle_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  qualification_record activity_qualifications%ROWTYPE;
  offer_record song_reward_offers%ROWTYPE;
  eligibility_record reward_eligibility_decisions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'song reward bundle claims are append-only';
  END IF;
  SELECT * INTO qualification_record FROM activity_qualifications
   WHERE qualification_id = NEW.qualification_id FOR SHARE;
  SELECT * INTO offer_record FROM song_reward_offers
   WHERE offer_id = NEW.offer_id FOR SHARE;
  SELECT * INTO eligibility_record FROM reward_eligibility_decisions
   WHERE eligibility_decision_id = NEW.eligibility_decision_id FOR SHARE;
  IF qualification_record.qualification_id IS NULL
     OR offer_record.offer_id IS NULL
     OR qualification_record.account_id <> NEW.account_id
     OR qualification_record.persona_id <> NEW.persona_id
     OR qualification_record.community_id <> offer_record.community_id
     OR qualification_record.post_id <> offer_record.post_id
     OR qualification_record.audio_revision <> offer_record.audio_revision
     OR qualification_record.qualified_at < offer_record.starts_at
     OR qualification_record.qualified_at >= offer_record.ends_at
     OR eligibility_record.account_id <> NEW.account_id
     OR eligibility_record.persona_id <> NEW.persona_id
     OR eligibility_record.qualification_id <> NEW.qualification_id
     OR eligibility_record.purpose <> 'asset_claim'
     OR eligibility_record.drawing_id IS NOT NULL
     OR eligibility_record.expires_at <= NEW.created_at
     OR (NEW.state = 'credited' AND eligibility_record.outcome <> 'eligible')
     OR (NEW.state = 'ineligible' AND eligibility_record.outcome <> 'ineligible')
     OR NEW.state = 'reserved' THEN
    RAISE EXCEPTION 'song reward bundle claim is not exact qualification output';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_reward_bundle_claims_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON song_reward_bundle_claims
FOR EACH ROW EXECUTE FUNCTION guard_song_reward_bundle_claim();

CREATE FUNCTION guard_song_reward_bundle_claim_leg() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  claim_record song_reward_bundle_claims%ROWTYPE;
  leg_record song_reward_offer_legs%ROWTYPE;
  credit_record reward_ledger_credits%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'song reward bundle claim legs are append-only';
  END IF;
  SELECT * INTO claim_record FROM song_reward_bundle_claims
   WHERE account_id = NEW.account_id AND offer_id = NEW.offer_id FOR SHARE;
  SELECT * INTO leg_record FROM song_reward_offer_legs
   WHERE leg_id = NEW.leg_id FOR SHARE;
  IF claim_record.account_id IS NULL OR leg_record.leg_id IS NULL
     OR leg_record.offer_id <> NEW.offer_id OR leg_record.kind <> 'asset_bonus'
     OR NEW.amount_atomic <> leg_record.amount_per_claim_atomic
     OR (claim_record.state = 'credited' AND NEW.state <> 'credited')
     OR (claim_record.state = 'ineligible' AND NEW.state <> 'unavailable') THEN
    RAISE EXCEPTION 'song reward bundle claim leg is not exact';
  END IF;
  IF NEW.state = 'credited' THEN
    SELECT * INTO credit_record FROM reward_ledger_credits
     WHERE credit_id = NEW.credit_id FOR SHARE;
    IF credit_record.credit_id IS NULL
       OR credit_record.account_id <> NEW.account_id
       OR credit_record.payout_persona_id <> claim_record.persona_id
       OR credit_record.chain_id <> leg_record.chain_id
       OR credit_record.token_address <> leg_record.token_address
       OR credit_record.amount_atomic <> NEW.amount_atomic
       OR credit_record.source_kind <> 'asset_bonus'
       OR credit_record.source_reference <>
          (NEW.leg_id || ':' || claim_record.qualification_id) THEN
      RAISE EXCEPTION 'song reward bundle claim leg lacks exact credit';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_reward_bundle_claim_legs_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON song_reward_bundle_claim_legs
FOR EACH ROW EXECUTE FUNCTION guard_song_reward_bundle_claim_leg();

CREATE FUNCTION validate_asset_bonus_leg_accounting() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_leg_id TEXT;
  leg_record song_reward_offer_legs%ROWTYPE;
  credited_total NUMERIC(78, 0);
  credited_count BIGINT;
BEGIN
  target_leg_id := NEW.leg_id;
  SELECT * INTO leg_record FROM song_reward_offer_legs WHERE leg_id = target_leg_id;
  IF leg_record.kind <> 'asset_bonus' THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(amount_atomic), 0), count(*)
    INTO credited_total, credited_count
    FROM song_reward_bundle_claim_legs
   WHERE leg_id = target_leg_id AND state = 'credited';
  IF leg_record.fulfilled_atomic <> credited_total
     OR credited_count > leg_record.max_claims THEN
    RAISE EXCEPTION 'asset bonus leg accounting is not exact';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER song_reward_bundle_claim_leg_accounting
AFTER INSERT ON song_reward_bundle_claim_legs DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_asset_bonus_leg_accounting();
CREATE CONSTRAINT TRIGGER song_reward_asset_leg_accounting
AFTER UPDATE ON song_reward_offer_legs DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_asset_bonus_leg_accounting();

CREATE FUNCTION project_asset_bonus_claim_from_qualification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  candidate RECORD;
  asset_leg RECORD;
  evidence RECORD;
  existing_consumption reward_subject_consumptions%ROWTYPE;
  decided_at TIMESTAMPTZ := clock_timestamp();
  reason TEXT;
  decision_outcome TEXT;
  decision_id TEXT;
  eligibility_id TEXT;
  consumption_id TEXT;
  identity_digest TEXT;
  credit_id TEXT;
BEGIN
  SELECT offer.offer_id, offer.community_id, offer.reward_policy_version_id,
         offer.ends_at, policy.policy_hash, leg.leg_id
    INTO candidate
    FROM song_reward_offers offer
    JOIN song_reward_offer_legs leg ON leg.offer_id = offer.offer_id
    JOIN policy_versions policy
      ON policy.community_id = offer.community_id
     AND policy.policy_version_id = offer.reward_policy_version_id
     AND policy.policy_purpose = 'reward'
     AND policy.uniqueness_authority_id = offer.offer_id
   WHERE offer.community_id = NEW.community_id
     AND offer.post_id = NEW.post_id
     AND offer.audio_revision = NEW.audio_revision
     AND offer.status = 'active'
     AND decided_at < offer.ends_at
     AND NEW.qualified_at >= offer.starts_at
     AND NEW.qualified_at < offer.ends_at
     AND leg.kind = 'asset_bonus' AND leg.status = 'active'
     AND NEW.qualified_at >= leg.participation_starts_at
     AND leg.fulfilled_atomic / leg.amount_per_claim_atomic < leg.max_claims
     AND leg.funded_atomic - leg.reserved_atomic - leg.spent_atomic
       - leg.fulfilled_atomic - leg.refunded_atomic >= leg.amount_per_claim_atomic
   ORDER BY leg.leg_id
   LIMIT 1
   FOR UPDATE OF leg;

  IF candidate.offer_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.account_id || chr(31) || candidate.offer_id, 53000002
  ));
  IF EXISTS (
    SELECT 1 FROM song_reward_bundle_claims claim
     WHERE claim.account_id = NEW.account_id AND claim.offer_id = candidate.offer_id
  ) THEN
    RETURN NEW;
  END IF;

  identity_digest := md5(NEW.qualification_id || chr(31) || candidate.offer_id);
  decision_id := 'reward_decision_' || identity_digest;
  eligibility_id := 'reward_eligibility_' || identity_digest;
  consumption_id := 'reward_subject_' || identity_digest;

  WITH exact_evidence AS (
    SELECT DISTINCT ON (subject.subject_key_id)
           subject.subject_key_id, active_binding.binding_event_id,
           active_binding.binding_epoch, receipt.evidence_receipt_id,
           receipt.evidence_hash,
           LEAST(candidate.ends_at, receipt.expires_at,
             personhood.expires_at, subject_unique.expires_at) AS evidence_expires_at,
           receipt.observed_at
      FROM subject_keys subject
      JOIN active_subject_key_bindings active_binding
        ON active_binding.subject_key_id = subject.subject_key_id
       AND active_binding.user_id = NEW.account_id
      JOIN assertion_bindings binding
        ON binding.user_id = NEW.account_id AND binding.binding_mode = 'same_subject'
       AND binding.subject_key_id = subject.subject_key_id
       AND binding.subject_binding_event_id = active_binding.binding_event_id
       AND binding.subject_binding_epoch = active_binding.binding_epoch
      JOIN assertions personhood
        ON personhood.binding_group_id = binding.binding_group_id
       AND personhood.user_id = NEW.account_id
       AND personhood.subject_key_id = subject.subject_key_id
       AND personhood.claim_id = 'human.personhood'
       AND personhood.assertion_value = '{"personhood": true}'::jsonb
       AND personhood.assurance = 'provider_attested'
      JOIN assertions subject_unique
        ON subject_unique.binding_group_id = binding.binding_group_id
       AND subject_unique.user_id = NEW.account_id
       AND subject_unique.subject_key_id = subject.subject_key_id
       AND subject_unique.evidence_receipt_id = personhood.evidence_receipt_id
       AND subject_unique.claim_id = 'credential.subject_unique'
       AND subject_unique.assertion_value = '{"subject_unique": true}'::jsonb
       AND subject_unique.assurance = 'provider_attested'
      JOIN evidence_receipts receipt
        ON receipt.evidence_receipt_id = personhood.evidence_receipt_id
       AND receipt.user_id = NEW.account_id
       AND receipt.subject_key_id = subject.subject_key_id
       AND receipt.subject_binding_event_id = active_binding.binding_event_id
       AND receipt.subject_binding_epoch = active_binding.binding_epoch
       AND receipt.provider_id = 'very.web'
       AND receipt.issuer = 'https://verify.very.org'
       AND receipt.method = 'palm_web'
       AND receipt.scope_kind = 'issuer_rp_scope'
       AND receipt.issuer_rp_scope = 'pirate-social'
       AND receipt.issuer_rp_action_scope IS NULL
       AND receipt.protocol_version = 'very-web-v1'
       AND receipt.evidence_kind = 'very.web.server-verified.v1'
       AND receipt.provenance_kind = 'proof_session'
      JOIN proof_sessions session
        ON session.proof_session_id = receipt.proof_session_id
       AND session.actor_id = NEW.account_id
       AND session.status = 'completed' AND session.completed_at = session.terminal_at
       AND session.provider_id = receipt.provider_id AND session.issuer = receipt.issuer
       AND session.method = receipt.method AND session.scope_kind = receipt.scope_kind
       AND session.issuer_rp_scope = receipt.issuer_rp_scope
       AND session.issuer_rp_action_scope IS NOT DISTINCT FROM receipt.issuer_rp_action_scope
       AND session.protocol_version = receipt.protocol_version
       AND session.requested_requirements =
         '[{"claim_id":"credential.subject_unique"},{"claim_id":"human.personhood"}]'::jsonb
       AND session.requested_claim_ids =
         '["credential.subject_unique","human.personhood"]'::jsonb
     WHERE subject.issuer = 'https://verify.very.org'
       AND subject.method = 'palm_web' AND subject.scope_kind = 'issuer_rp_scope'
       AND subject.issuer_rp_scope = 'pirate-social'
       AND subject.issuer_rp_action_scope IS NULL
       AND (receipt.expires_at IS NULL OR receipt.expires_at > decided_at + interval '5 seconds')
       AND (personhood.expires_at IS NULL OR personhood.expires_at > decided_at + interval '5 seconds')
       AND (subject_unique.expires_at IS NULL OR subject_unique.expires_at > decided_at + interval '5 seconds')
       AND COALESCE((SELECT revalidation.outcome
          FROM assertion_revalidation_events revalidation
         WHERE revalidation.assertion_id = personhood.assertion_id
         ORDER BY revalidation.observed_at DESC,
                  revalidation.assertion_revalidation_event_id DESC LIMIT 1), 'accepted') = 'accepted'
       AND COALESCE((SELECT revalidation.outcome
          FROM assertion_revalidation_events revalidation
         WHERE revalidation.assertion_id = subject_unique.assertion_id
         ORDER BY revalidation.observed_at DESC,
                  revalidation.assertion_revalidation_event_id DESC LIMIT 1), 'accepted') = 'accepted'
     ORDER BY subject.subject_key_id, receipt.observed_at DESC,
              receipt.evidence_receipt_id DESC
  )
  SELECT exact_evidence.*, count(*) OVER () AS evidence_count
    INTO evidence FROM exact_evidence
   ORDER BY exact_evidence.observed_at DESC, exact_evidence.subject_key_id LIMIT 1;

  IF evidence.subject_key_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM subject_keys subject
      JOIN active_subject_key_bindings active_binding
        ON active_binding.subject_key_id = subject.subject_key_id
       AND active_binding.user_id = NEW.account_id
      JOIN assertions personhood ON personhood.subject_key_id = subject.subject_key_id
       AND personhood.user_id = NEW.account_id AND personhood.claim_id = 'human.personhood'
       AND personhood.assertion_value = '{"personhood": true}'::jsonb
      JOIN assertions subject_unique
        ON subject_unique.binding_group_id = personhood.binding_group_id
       AND subject_unique.evidence_receipt_id = personhood.evidence_receipt_id
       AND subject_unique.subject_key_id = subject.subject_key_id
       AND subject_unique.user_id = NEW.account_id
       AND subject_unique.claim_id = 'credential.subject_unique'
       AND subject_unique.assertion_value = '{"subject_unique": true}'::jsonb
      WHERE subject.issuer = 'https://verify.very.org' AND subject.method = 'palm_web'
        AND subject.scope_kind = 'issuer_rp_scope'
        AND subject.issuer_rp_scope = 'pirate-social'
    ) THEN
      reason := 'verification_stale'; decision_outcome := 'needs_evidence';
    ELSIF EXISTS (
      SELECT 1 FROM subject_keys subject
      JOIN active_subject_key_bindings active_binding
        ON active_binding.subject_key_id = subject.subject_key_id
       AND active_binding.user_id = NEW.account_id
      WHERE subject.issuer = 'https://verify.very.org' AND subject.method = 'palm_web'
        AND subject.scope_kind = 'issuer_rp_scope'
        AND subject.issuer_rp_scope = 'pirate-social'
    ) THEN
      reason := 'verification_failed'; decision_outcome := 'fail';
    ELSE
      reason := 'verification_missing'; decision_outcome := 'needs_evidence';
    END IF;
  ELSIF evidence.evidence_count <> 1 THEN
    reason := 'verification_failed'; decision_outcome := 'fail';
  ELSE
    PERFORM 1 FROM subject_keys WHERE subject_key_id = evidence.subject_key_id FOR UPDATE;
    SELECT * INTO existing_consumption FROM reward_subject_consumptions
     WHERE campaign_id = candidate.offer_id AND subject_key_id = evidence.subject_key_id
     FOR UPDATE;
    IF existing_consumption.reward_subject_consumption_id IS NULL THEN
      INSERT INTO reward_subject_consumptions (
        reward_subject_consumption_id,campaign_id,subject_key_id,user_id,
        binding_event_id,binding_epoch,evidence_receipt_id,consumed_at,created_at
      ) VALUES (
        consumption_id,candidate.offer_id,evidence.subject_key_id,NEW.account_id,
        evidence.binding_event_id,evidence.binding_epoch,evidence.evidence_receipt_id,
        decided_at,decided_at
      );
    ELSIF existing_consumption.user_id <> NEW.account_id THEN
      reason := 'subject_already_consumed'; decision_outcome := 'fail';
    END IF;
  END IF;

  IF reason IS NOT NULL THEN
    INSERT INTO decision_records (
      decision_record_id,community_id,user_id,policy_version_id,policy_hash,
      evaluation_mode,outcome,winning_witness,trace,indeterminate_reason,request_id,created_at
    ) VALUES (
      decision_id,candidate.community_id,NEW.account_id,candidate.reward_policy_version_id,
      candidate.policy_hash,'enforce',decision_outcome,'[]'::jsonb,
      jsonb_build_array(jsonb_build_object('reason',reason)),reason,
      'asset-claim:' || identity_digest,decided_at
    );
    INSERT INTO reward_eligibility_decisions (
      eligibility_decision_id,leg_id,account_id,persona_id,purpose,qualification_id,
      decision_record_id,outcome,reason,policy_version,evidence_hash,decided_at,expires_at
    ) VALUES (
      eligibility_id,candidate.leg_id,NEW.account_id,NEW.persona_id,'asset_claim',
      NEW.qualification_id,decision_id,'ineligible',reason,
      candidate.reward_policy_version_id,COALESCE(evidence.evidence_hash,candidate.policy_hash),
      decided_at,candidate.ends_at
    );
    INSERT INTO song_reward_bundle_claims (
      account_id,offer_id,persona_id,qualification_id,eligibility_decision_id,
      state,terminal_reason,created_at,updated_at
    ) VALUES (
      NEW.account_id,candidate.offer_id,NEW.persona_id,NEW.qualification_id,
      eligibility_id,'ineligible',reason,decided_at,decided_at
    );
    FOR asset_leg IN
      SELECT leg.* FROM song_reward_offer_legs leg
       WHERE leg.offer_id = candidate.offer_id AND leg.kind = 'asset_bonus'
         AND leg.status = 'active' AND NEW.qualified_at >= leg.participation_starts_at
         AND leg.fulfilled_atomic / leg.amount_per_claim_atomic < leg.max_claims
         AND leg.funded_atomic - leg.reserved_atomic - leg.spent_atomic
           - leg.fulfilled_atomic - leg.refunded_atomic >= leg.amount_per_claim_atomic
       ORDER BY leg.leg_id FOR UPDATE
    LOOP
      INSERT INTO song_reward_bundle_claim_legs (
        account_id,offer_id,leg_id,amount_atomic,state,terminal_reason,created_at
      ) VALUES (
        NEW.account_id,candidate.offer_id,asset_leg.leg_id,
        asset_leg.amount_per_claim_atomic,'unavailable',reason,decided_at
      );
    END LOOP;
    RETURN NEW;
  END IF;

  INSERT INTO decision_records (
    decision_record_id,community_id,user_id,policy_version_id,policy_hash,
    evaluation_mode,outcome,winning_witness,trace,request_id,created_at
  ) VALUES (
    decision_id,candidate.community_id,NEW.account_id,candidate.reward_policy_version_id,
    candidate.policy_hash,'enforce','pass',
    jsonb_build_array(jsonb_build_object('subject_key_id',evidence.subject_key_id,
      'evidence_receipt_id',evidence.evidence_receipt_id)),
    jsonb_build_array(jsonb_build_object('result','eligible')),
    'asset-claim:' || identity_digest,decided_at
  );
  INSERT INTO reward_eligibility_decisions (
    eligibility_decision_id,leg_id,account_id,persona_id,purpose,qualification_id,
    decision_record_id,outcome,policy_version,evidence_hash,decided_at,expires_at
  ) VALUES (
    eligibility_id,candidate.leg_id,NEW.account_id,NEW.persona_id,'asset_claim',
    NEW.qualification_id,decision_id,'eligible',candidate.reward_policy_version_id,
    evidence.evidence_hash,decided_at,evidence.evidence_expires_at
  );
  INSERT INTO song_reward_bundle_claims (
    account_id,offer_id,persona_id,qualification_id,eligibility_decision_id,
    state,created_at,updated_at
  ) VALUES (
    NEW.account_id,candidate.offer_id,NEW.persona_id,NEW.qualification_id,
    eligibility_id,'credited',decided_at,decided_at
  );

  FOR asset_leg IN
    SELECT leg.* FROM song_reward_offer_legs leg
     WHERE leg.offer_id = candidate.offer_id AND leg.kind = 'asset_bonus'
       AND leg.status = 'active' AND NEW.qualified_at >= leg.participation_starts_at
       AND leg.fulfilled_atomic / leg.amount_per_claim_atomic < leg.max_claims
       AND leg.funded_atomic - leg.reserved_atomic - leg.spent_atomic
         - leg.fulfilled_atomic - leg.refunded_atomic >= leg.amount_per_claim_atomic
     ORDER BY leg.leg_id FOR UPDATE
  LOOP
    credit_id := 'reward_credit_' || md5(
      NEW.account_id || chr(31) || asset_leg.leg_id || chr(31) || NEW.qualification_id
    );
    INSERT INTO reward_ledger_credits (
      credit_id,account_id,payout_persona_id,chain_id,token_address,amount_atomic,
      source_kind,source_reference,state,created_at,updated_at
    ) VALUES (
      credit_id,NEW.account_id,NEW.persona_id,asset_leg.chain_id,
      asset_leg.token_address,asset_leg.amount_per_claim_atomic,'asset_bonus',
      asset_leg.leg_id || ':' || NEW.qualification_id,'credited',decided_at,decided_at
    );
    INSERT INTO song_reward_bundle_claim_legs (
      account_id,offer_id,leg_id,amount_atomic,credit_id,state,created_at
    ) VALUES (
      NEW.account_id,candidate.offer_id,asset_leg.leg_id,
      asset_leg.amount_per_claim_atomic,credit_id,'credited',decided_at
    );
    UPDATE song_reward_offer_legs
       SET fulfilled_atomic = fulfilled_atomic + asset_leg.amount_per_claim_atomic,
           status = CASE
             WHEN (fulfilled_atomic + asset_leg.amount_per_claim_atomic)
                    / amount_per_claim_atomic >= max_claims
               OR funded_atomic - reserved_atomic - spent_atomic - refunded_atomic
                    - (fulfilled_atomic + asset_leg.amount_per_claim_atomic)
                    < amount_per_claim_atomic
             THEN 'exhausted' ELSE status END,
           participation_ends_at = CASE
             WHEN (fulfilled_atomic + asset_leg.amount_per_claim_atomic)
                    / amount_per_claim_atomic >= max_claims
               OR funded_atomic - reserved_atomic - spent_atomic - refunded_atomic
                    - (fulfilled_atomic + asset_leg.amount_per_claim_atomic)
                    < amount_per_claim_atomic
             THEN decided_at ELSE participation_ends_at END,
           updated_at = decided_at
     WHERE leg_id = asset_leg.leg_id;
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER activity_qualifications_project_asset_bonus_claim
AFTER INSERT ON activity_qualifications
FOR EACH ROW EXECUTE FUNCTION project_asset_bonus_claim_from_qualification();

-- The custody deployment identifies the signer and chain. The transferred asset
-- is independently pinned by the whitelist, credit or leg, effect target, and
-- token-specific solvency observation; it need not be the Megapot USDC token.
CREATE OR REPLACE FUNCTION guard_reward_payout_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
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
  SELECT COALESCE(sum(funded_atomic + winnings_credited_atomic
      - spent_atomic - withdrawn_atomic), 0) INTO live_shared_sponsorship
    FROM platform_sponsorship_budgets
   WHERE chain_id=credit_record.chain_id AND token_address=credit_record.token_address;
  IF chain_record.effect_kind <> 'reward_payout'
     OR chain_record.reserved_amount_atomic <> NEW.amount_atomic
     OR chain_record.chain_id <> credit_record.chain_id
     OR chain_record.signer_address <> attestation_record.custody_address
     OR chain_record.target_address <> credit_record.token_address
     OR attestation_record.status <> 'active'
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

CREATE OR REPLACE FUNCTION guard_reward_erc20_transfer_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
  attestation_record megapot_deployment_attestations%ROWTYPE;
  payout_record reward_payout_effects%ROWTYPE;
  refund_record reward_refund_effects%ROWTYPE;
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
     OR attestation_record.status <> 'active'
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
    IF refund_record.attestation_id <> NEW.attestation_id
       OR refund_record.destination_address <> NEW.recipient_address
       OR refund_record.amount_atomic <> NEW.amount_atomic THEN
      RAISE EXCEPTION 'reward refund receipt does not match refund reservation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION guard_reward_refund_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
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
     OR attestation_record.status <> 'active'
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
