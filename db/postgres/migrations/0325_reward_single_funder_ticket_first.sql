-- Prospective single-funder ticket-first disposition, adopted October 28.
-- Existing shared terms, held drawings and receipt history are unchanged.


ALTER TABLE song_reward_offer_legs DROP CONSTRAINT song_reward_pool_fallback_shape,
 ADD CONSTRAINT song_reward_pool_fallback_shape CHECK (
    kind <> 'megapot_pool'
    OR (empty_pool_policy = 'no_purchase'
      AND funding_source = 'leg_budget'
      AND fallback_beneficiary_account_id IS NULL
      AND fallback_payout_persona_id IS NULL
      AND referral_allocation_version IS NULL
      AND referral_policy_hash IS NULL
      AND referral_disclosed_at IS NULL)
    OR (empty_pool_policy = 'funder_fallback'
      AND fallback_beneficiary_account_id IS NOT NULL
      AND ((funding_source = 'leg_budget'
          AND fallback_beneficiary_account_id = funder_account_id
          AND fallback_payout_persona_id IS NOT NULL
          AND min_score_bps = 7000
          AND referral_allocation_version IS NOT NULL
          AND btrim(referral_allocation_version) <> ''
          AND referral_policy_hash ~ '^[0-9a-f]{64}$'
          AND referral_disclosed_at IS NOT NULL)
        OR (funding_source = 'shared_sponsor_budget'
          AND fallback_payout_persona_id IS NULL
          AND funded_atomic = 0 AND reserved_atomic = 0 AND spent_atomic = 0
          AND fulfilled_atomic = 0 AND refunded_atomic = 0)))

    OR (purchase_order='ticket_first_v1' AND qualification_family_v2='shared_song'
      AND shared_song_terms_v2->>'empty_behavior'='single_funder_ticket_first_v1'
      AND empty_pool_policy='funder_fallback' AND funding_source='leg_budget'
      AND fallback_beneficiary_account_id=funder_account_id AND fallback_payout_persona_id IS NOT NULL
      AND min_score_bps IS NULL AND referral_allocation_version='net_to_single_funder_v1'
      AND referral_policy_hash=shared_song_terms_v2->>'terms_hash' AND referral_disclosed_at IS NOT NULL)
);

ALTER TABLE song_reward_offer_legs DROP CONSTRAINT shared_song_leg_family_v2,
 ADD CONSTRAINT shared_song_leg_family_v2 CHECK((
 (qualification_family_v2='numeric' AND shared_song_terms_v2 IS NULL)
 OR (qualification_family_v2='shared_song' AND kind='megapot_pool' AND min_score_bps IS NULL
   AND funding_source='leg_budget' AND eligible_activities=ARRAY['study','karaoke','dance']::TEXT[]
   AND jsonb_typeof(shared_song_terms_v2)='object'
   AND shared_song_terms_v2->>'version'='shared-song-megapot-v2'
   AND shared_song_terms_v2->>'terms_hash'=substring(leg_terms_hash FROM 3)
   AND ((empty_pool_policy='no_purchase' AND shared_song_terms_v2->>'empty_behavior'='no_purchase')
     OR (purchase_order='ticket_first_v1' AND empty_pool_policy='funder_fallback'
       AND shared_song_terms_v2->>'empty_behavior'='single_funder_ticket_first_v1')))) IS TRUE);
ALTER TABLE song_reward_offer_legs DROP CONSTRAINT song_reward_leg_purchase_order_shape,
 ADD CONSTRAINT song_reward_leg_purchase_order_shape CHECK (
  purchase_order='commit_first' OR (kind='megapot_pool' AND funding_source='leg_budget'
    AND (empty_pool_policy='no_purchase' OR (empty_pool_policy='funder_fallback'
      AND shared_song_terms_v2->>'empty_behavior'='single_funder_ticket_first_v1'))));

ALTER TABLE megapot_pool_drawings DROP CONSTRAINT megapot_pool_drawing_freeze_shape,
 ADD CONSTRAINT megapot_pool_drawing_freeze_shape CHECK (
    (purchase_order = 'commit_first' AND ((((status = 'entry_open'::text) AND (frozen_share_count IS NULL) AND (fallback_beneficiary IS NULL) AND (snapshot_id IS NULL) AND (cutoff_frozen_at IS NULL)) OR (status = 'operational_hold'::text) OR ((status <> ALL (ARRAY['entry_open'::text, 'operational_hold'::text])) AND (frozen_share_count IS NOT NULL) AND (frozen_share_count >= 0) AND (fallback_beneficiary IS NOT NULL) AND (cutoff_frozen_at IS NOT NULL)))))
    OR (purchase_order = 'ticket_first_v1' AND (
      status = 'operational_hold'
      OR (status IN ('ticket_pending', 'entry_open', 'closed_purchase_unavailable')
        AND frozen_share_count IS NULL AND fallback_beneficiary IS NULL
        AND snapshot_id IS NULL AND cutoff_frozen_at IS NULL)
      OR (status NOT IN ('ticket_pending', 'entry_open', 'closed_purchase_unavailable',
          'operational_hold')
        AND frozen_share_count IS NOT NULL AND ((frozen_share_count > 0 AND fallback_beneficiary = false)
          OR (frozen_share_count = 0 AND fallback_beneficiary = true)) AND cutoff_frozen_at IS NOT NULL)
    ))
  );

CREATE OR REPLACE FUNCTION bind_initial_shared_song_pot_v2(p_identity JSONB,p_snapshot TEXT,p_state JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
<<binding>>
DECLARE snapshot reward_funding_leg_snapshots_v2; slot reward_song_slots_v2; template JSONB;
 r JSONB:=p_state->'receipt'; terms JSONB:=r->'committed_terms'; target JSONB:=r->'target'; prospectus JSONB;
 profile reward_funding_profiles_v2;
 asset reward_asset_whitelist; policy_head song_owner_policies; transition_at TIMESTAMPTZ;
BEGIN
 SELECT * INTO STRICT snapshot FROM reward_funding_leg_snapshots_v2 WHERE snapshot_id=p_snapshot;
 SELECT * INTO STRICT slot FROM reward_song_slots_v2 WHERE slot_id=snapshot.slot_id FOR UPDATE;
 IF slot.target IS NOT NULL THEN
   IF slot.target IS DISTINCT FROM target OR slot.terms IS DISTINCT FROM terms THEN
     RAISE EXCEPTION 'shared slot already bound differently' USING ERRCODE='PCV06'; END IF;
   RETURN;
 END IF;
 prospectus:=snapshot.context->'quote'->'prospective_terms';
 template:=load_shared_song_reward_template_v2(p_snapshot,prospectus->>'reward_policy_template_hash');
 IF (slot.status='open' AND snapshot.context->'actor'=p_state->'owner'
   AND slot.community_id=p_identity->>'communityId' AND slot.post_id=p_identity->>'postId'
   AND snapshot.context->'actor'->>'account_id'=p_identity->>'accountId'
   AND (terms->>'origin_slot_generation')::BIGINT=slot.generation
   AND terms->>'origin_prospective_terms_hash'=snapshot.context->'quote'->>'prospective_terms_hash'
   AND terms->>'starts_at'=r->>'created_at' AND terms->>'ends_at'=prospectus->>'fixed_ends_at'
   AND terms->'planned_drawing_ids'=prospectus->'planned_drawing_ids'
   AND terms->>'profile_id'=snapshot.profile_id AND terms->>'profile_hash'=prospectus->>'profile_hash'
   AND terms->>'funding_policy_hash'=prospectus->>'funding_policy_hash'
   AND target->>'kind'='committed' AND target->>'community_id'=slot.community_id AND target->>'post_id'=slot.post_id
   AND target->>'canonical_song_id'=prospectus->'target'->>'canonical_song_id'
   AND target->'audio_revision'=prospectus->'target'->'audio_revision'
   AND (terms->>'starts_at')::TIMESTAMPTZ<=clock_timestamp() AND (terms->>'ends_at')::TIMESTAMPTZ>clock_timestamp()) IS NOT TRUE THEN
   RAISE EXCEPTION 'immutable initial pot provenance required' USING ERRCODE='PCV06'; END IF;
 IF EXISTS(SELECT 1 FROM song_reward_offers offer WHERE offer.community_id=slot.community_id AND offer.post_id=slot.post_id
    AND offer.status IN('draft','active','paused','operational_hold')) THEN
   RAISE EXCEPTION 'existing pool cannot be converted or displaced' USING ERRCODE='PCV06'; END IF;
 SELECT * INTO STRICT policy_head FROM song_owner_policies WHERE community_id=slot.community_id AND post_id=slot.post_id FOR SHARE;
 IF terms->>'funding_policy_hash' IS DISTINCT FROM snapshot.context->'context_ref'->>'funding_policy_hash'
   OR terms->'funding_policy_revision' IS DISTINCT FROM prospectus->'funding_policy_revision'
   OR policy_head.audio_revision IS DISTINCT FROM (target->>'audio_revision')::BIGINT THEN
   RAISE EXCEPTION 'song revision or open funding policy changed' USING ERRCODE='PCV06'; END IF;
 -- third_party_reward_legs and pool_leg are historical V1 fields, never V2
 -- funding permission. Derivative-video rights retain their independent guard.
 SELECT * INTO STRICT asset FROM reward_asset_whitelist WHERE chain_id=(r->'instruction'->>'chain_id')::BIGINT
   AND token_address=r->'instruction'->>'to_token' AND status='active' AND asset_kind='settlement_usdc' FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM policy_versions WHERE policy_version_id='shared-policy:'||(target->>'offer_id')
    AND policy_hash=terms->>'reward_policy_hash' AND community_id=slot.community_id) THEN
   RAISE EXCEPTION 'instantiated shared policy required' USING ERRCODE='PCV05'; END IF;
 IF terms->>'empty_behavior' IS DISTINCT FROM prospectus->>'empty_behavior'
   OR terms->>'empty_behavior' IS DISTINCT FROM coalesce(template->'operational_profile'->>'emptyBehavior','no_purchase') THEN
   RAISE EXCEPTION 'frozen empty-drawing disposition mismatch' USING ERRCODE='PCV06'; END IF;
 IF terms->>'empty_behavior'='single_funder_ticket_first_v1' THEN
   SELECT * INTO STRICT profile FROM reward_funding_profiles_v2 WHERE profile_id=terms->>'profile_id';
   IF (profile.policy->>'maxActiveAccount')::BIGINT IS DISTINCT FROM 1
     OR (profile.policy->>'maxActiveAccountLeg')::BIGINT IS DISTINCT FROM 1
     OR (profile.policy->>'maxLegLiabilities')::BIGINT IS DISTINCT FROM 1
     OR (profile.policy->>'maxAdmittedLeg')::BIGINT IS DISTINCT FROM 1
     OR (profile.policy->>'maxAdmittedAccountLeg')::BIGINT IS DISTINCT FROM 1
     OR (profile.capacity_profile->>'maxDrawings')::BIGINT IS DISTINCT FROM 1
     OR jsonb_array_length(terms->'planned_drawing_ids')<>1 THEN
     RAISE EXCEPTION 'single-funder ticket-first profile required' USING ERRCODE='PCV06'; END IF;
 END IF;
 INSERT INTO song_reward_offers(offer_id,community_id,post_id,audio_revision,created_by_account_id,status,starts_at,ends_at,
   owner_policy_snapshot,terms_hash,reward_policy_version_id,created_at,updated_at)
 VALUES(target->>'offer_id',slot.community_id,slot.post_id,(target->>'audio_revision')::BIGINT,p_identity->>'accountId','draft',
   (terms->>'starts_at')::TIMESTAMPTZ,(terms->>'ends_at')::TIMESTAMPTZ,
   jsonb_build_object('policy_revision',policy_head.current_policy_revision,'policy_hash',policy_head.current_policy_hash),
   terms->>'terms_hash','shared-policy:'||(target->>'offer_id'),clock_timestamp(),clock_timestamp());
 INSERT INTO song_reward_offer_legs(leg_id,offer_id,kind,status,funder_account_id,refund_policy,leg_terms_hash,participation_starts_at,
   chain_id,token_address,token_decimals,tickets_per_drawing,max_ticket_price_atomic,entry_cutoff_seconds,beneficiary_algorithm_version,
   ticket_selection_version,attestation_id,participation_starts_drawing_id,eligible_activities,min_score_bps,empty_pool_policy,funding_source,
   legal_activation_gate,owner_policy_kind,owner_policy_revision,owner_policy_hash,qualification_family_v2,shared_song_terms_v2,
   fallback_beneficiary_account_id,fallback_payout_persona_id,referral_allocation_version,referral_policy_hash,referral_disclosed_at)
 VALUES(target->>'pool_leg_id',target->>'offer_id','megapot_pool','draft',p_identity->>'accountId','refund_to_funders_pro_rata',
   '0x'||(terms->>'terms_hash'),(terms->>'starts_at')::TIMESTAMPTZ,(r->'instruction'->>'chain_id')::BIGINT,
   r->'instruction'->>'to_token',asset.decimals,1,(terms->>'ticket_price_ceiling_atomic')::NUMERIC,
   (template->'operational_profile'->>'entryCutoffSeconds')::INTEGER,'equal_v1','keccak_packed_v1',r->'instruction'->>'attestation_id',
   (terms->>'first_drawing_id')::NUMERIC,ARRAY['study','karaoke','dance'],NULL,CASE WHEN terms->>'empty_behavior'='single_funder_ticket_first_v1' THEN 'funder_fallback' ELSE 'no_purchase' END,'leg_budget',
   template->'operational_profile'->>'legalActivationGate','frozen_policy',policy_head.current_policy_revision,policy_head.current_policy_hash,'shared_song',terms,
   CASE WHEN terms->>'empty_behavior'='single_funder_ticket_first_v1' THEN p_identity->>'accountId' END,
   CASE WHEN terms->>'empty_behavior'='single_funder_ticket_first_v1' THEN p_state->'owner'->>'persona_id' END,
   CASE WHEN terms->>'empty_behavior'='single_funder_ticket_first_v1' THEN 'net_to_single_funder_v1' END,
   CASE WHEN terms->>'empty_behavior'='single_funder_ticket_first_v1' THEN terms->>'terms_hash' END,
   CASE WHEN terms->>'empty_behavior'='single_funder_ticket_first_v1' THEN (terms->>'starts_at')::TIMESTAMPTZ END);
 transition_at:=clock_timestamp();
 UPDATE song_reward_offers SET status='active',updated_at=transition_at WHERE offer_id=target->>'offer_id';
 UPDATE song_reward_offer_legs SET status='funding',updated_at=transition_at WHERE leg_id=target->>'pool_leg_id';
 -- The explicitly allocated empty-slot work budget is the SAME leg envelope.
 UPDATE reward_funding_work_envelopes_v2 SET scope_key=target->>'pool_leg_id'
   WHERE scope='leg' AND scope_key='empty-slot:'||slot.slot_id AND profile_id=snapshot.profile_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'selected leg work envelope unavailable' USING ERRCODE='PCV04'; END IF;
 UPDATE reward_song_slots_v2 SET target=binding.target,terms=binding.terms,generation=generation+1,reward_policy_ready=TRUE WHERE slot_id=slot.slot_id;
END $$;

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
      IF NEW.empty_pool_policy = 'funder_fallback' AND NEW.purchase_order='commit_first'
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

CREATE FUNCTION guard_ticket_first_funder_snapshot_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE leg song_reward_offer_legs;
BEGIN
 IF NEW.purchase_order='ticket_first_v1' AND NEW.fallback_beneficiary THEN
   SELECT * INTO STRICT leg FROM song_reward_offer_legs WHERE leg_id=NEW.pool_leg_id;
   IF leg.shared_song_terms_v2->>'empty_behavior' IS DISTINCT FROM 'single_funder_ticket_first_v1'
     OR leg.empty_pool_policy<>'funder_fallback' OR leg.fallback_beneficiary_account_id IS DISTINCT FROM leg.funder_account_id
     OR leg.fallback_payout_persona_id IS NULL OR NEW.frozen_share_count<>0 THEN
     RAISE EXCEPTION 'ticket-first funder snapshot requires frozen prospective terms'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ticket_first_funder_snapshot_guard BEFORE UPDATE ON megapot_pool_drawings
 FOR EACH ROW EXECUTE FUNCTION guard_ticket_first_funder_snapshot_v1();
DO $acl$
BEGIN
 EXECUTE format('ALTER FUNCTION bind_initial_shared_song_pot_v2(jsonb,text,jsonb) SET search_path TO pg_catalog,%I,pg_temp',current_schema());
 REVOKE ALL ON FUNCTION guard_ticket_first_funder_snapshot_v1() FROM PUBLIC;
END $acl$;

CREATE OR REPLACE FUNCTION validate_megapot_fallback_cutoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  leg_record song_reward_offer_legs%ROWTYPE;
  offer_record song_reward_offers%ROWTYPE;
  evidence_record megapot_fallback_cutoff_evidence%ROWTYPE;
  decision_record reward_eligibility_decisions%ROWTYPE;
  activity TEXT;
  activity_count INTEGER;
BEGIN
  IF NEW.fallback_beneficiary IS DISTINCT FROM TRUE
     OR NEW.status NOT IN ('cutoff_frozen', 'committed', 'purchase_pending',
       'tickets_confirmed', 'drawing_pending', 'winnings_detected', 'claim_pending',
       'claimed', 'allocated', 'credited') THEN
    RETURN NULL;
  END IF;
  SELECT * INTO leg_record FROM song_reward_offer_legs WHERE leg_id = NEW.pool_leg_id;
  IF NEW.purchase_order='ticket_first_v1' THEN
    IF leg_record.shared_song_terms_v2->>'empty_behavior' IS DISTINCT FROM 'single_funder_ticket_first_v1'
      OR NEW.frozen_share_count<>0 OR leg_record.fallback_beneficiary_account_id IS DISTINCT FROM leg_record.funder_account_id
      OR (SELECT count(*) FROM song_megapot_contributions_v2 c
        JOIN reward_incoming_receipts_v2 r USING(contribution_id)
        WHERE c.pool_leg_id=NEW.pool_leg_id AND r.category='pool_principal'
          AND c.account_id=leg_record.fallback_beneficiary_account_id
          AND c.state->'owner'->>'persona_id'=leg_record.fallback_payout_persona_id
          AND (c.state->>'nonceFinalized')::BOOLEAN AND r.amount_atomic=leg_record.funded_atomic)<>1 THEN
      RAISE EXCEPTION 'ticket-first fallback requires its single original funder'; END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO offer_record FROM song_reward_offers WHERE offer_id = leg_record.offer_id;
  SELECT * INTO evidence_record FROM megapot_fallback_cutoff_evidence
   WHERE pool_leg_id = NEW.pool_leg_id AND drawing_id = NEW.drawing_id;
  SELECT * INTO decision_record FROM reward_eligibility_decisions
   WHERE eligibility_decision_id = evidence_record.eligibility_decision_id;
  IF evidence_record.pool_leg_id IS NULL
     OR leg_record.empty_pool_policy <> 'funder_fallback'
     OR evidence_record.sponsor_account_id <> leg_record.fallback_beneficiary_account_id
     OR evidence_record.payout_persona_id IS DISTINCT FROM leg_record.fallback_payout_persona_id
     OR decision_record.leg_id <> NEW.pool_leg_id
     OR decision_record.account_id <> evidence_record.sponsor_account_id
     OR decision_record.purpose <> 'fallback_cutoff'
     OR decision_record.drawing_id <> NEW.drawing_id
     OR decision_record.outcome <> 'eligible'
     OR decision_record.expires_at <= evidence_record.checked_at
     OR NOT EXISTS (
       SELECT 1 FROM sponsor_daily_ticket_totals total
        WHERE total.sponsor_account_id = evidence_record.sponsor_account_id
          AND total.sponsor_day = evidence_record.sponsor_day
          AND total.sponsor_kind = evidence_record.sponsor_kind
          AND total.confirmed_ticket_count + total.reserved_ticket_count
                - total.released_ticket_count >= 1
          AND total.confirmed_spend_atomic + total.reserved_spend_atomic
                - total.released_spend_atomic >= NEW.reserved_ticket_cost_atomic
     )
     OR NOT EXISTS (
       SELECT 1 FROM posts post
        WHERE post.community_id = offer_record.community_id
          AND post.post_id = offer_record.post_id
          AND post.post_type = 'song' AND post.status = 'published'
          AND post.visibility = 'public'
     ) THEN
    RAISE EXCEPTION 'Megapot fallback cutoff evidence is invalid';
  END IF;
  SELECT count(*) INTO activity_count
    FROM megapot_fallback_cutoff_activity_evidence activity_evidence
   WHERE activity_evidence.pool_leg_id = NEW.pool_leg_id
     AND activity_evidence.drawing_id = NEW.drawing_id;
  IF activity_count <> cardinality(leg_record.eligible_activities) THEN
    RAISE EXCEPTION 'Megapot fallback cutoff activity evidence is incomplete';
  END IF;
  FOREACH activity IN ARRAY leg_record.eligible_activities
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM megapot_fallback_cutoff_activity_evidence activity_evidence
        JOIN reward_activity_availability_observations availability
          ON availability.availability_observation_id =
             activity_evidence.availability_observation_id
       WHERE activity_evidence.pool_leg_id = NEW.pool_leg_id
         AND activity_evidence.drawing_id = NEW.drawing_id
         AND activity_evidence.activity_key = activity
         AND availability.community_id = offer_record.community_id
         AND availability.post_id = offer_record.post_id
         AND availability.audio_revision = offer_record.audio_revision
         AND availability.activity_key = activity
         AND availability.state = 'available'
         AND availability.observed_at <= evidence_record.checked_at
         AND availability.expires_at > evidence_record.checked_at
    ) THEN
      RAISE EXCEPTION 'Megapot fallback cutoff activity is unavailable';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
DO $fallback_acl$ BEGIN
 EXECUTE format('ALTER FUNCTION validate_megapot_fallback_cutoff() SET search_path TO pg_catalog,%I,pg_temp',current_schema());
 REVOKE ALL ON FUNCTION validate_megapot_fallback_cutoff() FROM PUBLIC;
END $fallback_acl$;
