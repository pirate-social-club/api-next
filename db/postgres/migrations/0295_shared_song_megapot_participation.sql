-- A participant read, not an admission, allocation or payment authority. Every
-- SELECT below uses the calling statement's snapshot. No existing trigger or
-- funded policy is changed, and no runtime role receives a grant here.
CREATE FUNCTION read_shared_song_megapot_participation_v2(
  p_account TEXT,p_community TEXT,p_post TEXT
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  now_at TIMESTAMPTZ:=statement_timestamp();
  slot reward_song_slots_v2; leg song_reward_offer_legs; offer song_reward_offers;
  deployment megapot_deployment_attestations; binding JSONB;
  qualification qualification_policy_versions; registry activity_registry;
  documents JSONB:='[]'; drawings JSONB:='[]'; planned TEXT;
  drawing megapot_pool_drawings; original_observation megapot_drawing_observations;
  observation megapot_drawing_observations; snapshot megapot_pool_beneficiary_snapshots;
  commitment megapot_pool_commitment_effects; ticket megapot_ticket_inventory;
  batch megapot_allocation_batches; allocation megapot_allocations;
  credit reward_ledger_credits; claim megapot_participant_claims;
  custody_claim megapot_claim_effects; custody_receipt megapot_claim_receipt_evidence;
  chain_effect reward_chain_effects;
  contributed NUMERIC; remaining NUMERIC; available BOOLEAN; policy_available BOOLEAN;
  share_held BOOLEAN; beneficiaries INTEGER; public_state TEXT; credit_json JSONB;
  payout_state TEXT; gross NUMERIC; global_tickets NUMERIC; observed_at TIMESTAMPTZ;
BEGIN
  -- Match the activity access authority without its command-side FOR SHARE.
  -- The participant read must keep every access and reward read in this snapshot.
  IF NOT EXISTS(SELECT 1 FROM users u WHERE u.user_id=p_account AND u.status='active')
    OR NOT EXISTS(SELECT 1 FROM posts p WHERE p.community_id=p_community AND p.post_id=p_post
      AND p.post_type='song' AND p.status='published' AND p.visibility='public'
      AND can_account_view_content_rating_v1(p_account,p.content_rating) IS TRUE) THEN
    RETURN jsonb_build_object('status','not_found');
  END IF;
  SELECT s.* INTO slot FROM reward_song_slots_v2 s
    WHERE s.community_id=p_community AND s.post_id=p_post;
  IF slot.slot_id IS NULL OR slot.target IS NULL OR slot.target->>'kind'<>'committed' THEN
    RETURN NULL;
  END IF;
  SELECT l.* INTO leg FROM song_reward_offer_legs l WHERE l.leg_id=slot.target->>'pool_leg_id';
  SELECT o.* INTO offer FROM song_reward_offers o WHERE o.offer_id=leg.offer_id;
  SELECT a.* INTO deployment FROM megapot_deployment_attestations a WHERE a.attestation_id=leg.attestation_id;
  IF (leg.qualification_family_v2='shared_song' AND leg.kind='megapot_pool'
    AND leg.funding_source='leg_budget' AND leg.empty_pool_policy='no_purchase'
    AND leg.shared_song_terms_v2=slot.terms AND leg.min_score_bps IS NULL
    AND leg.leg_terms_hash='0x'||(slot.terms->>'terms_hash')
    AND offer.offer_id=slot.target->>'offer_id' AND offer.community_id=p_community
    AND offer.post_id=p_post AND offer.audio_revision=(slot.target->>'audio_revision')::BIGINT
    AND slot.target->>'community_id'=p_community AND slot.target->>'post_id'=p_post
    AND deployment.chain_id=leg.chain_id AND deployment.usdc_address=leg.token_address
    AND leg.token_decimals=6 AND offer.status<>'draft' AND leg.status<>'draft'
    AND jsonb_array_length(slot.terms->'qualification_bindings')=3
    AND jsonb_array_length(slot.terms->'planned_drawing_ids') BETWEEN 1 AND 30
    AND EXISTS(SELECT 1 FROM policy_versions p
      WHERE p.policy_version_id=offer.reward_policy_version_id AND p.community_id=p_community
        AND p.policy_purpose='reward' AND p.uniqueness_authority_id=offer.offer_id
        AND p.policy_hash=slot.terms->>'reward_policy_hash')) IS NOT TRUE THEN
    RAISE EXCEPTION 'shared participant provenance unavailable' USING ERRCODE='PCV05';
  END IF;
  SELECT coalesce(sum(r.amount_atomic),0) INTO contributed
    FROM reward_incoming_receipts_v2 r JOIN song_megapot_contributions_v2 c USING(contribution_id)
    WHERE c.pool_leg_id=leg.leg_id AND r.category='pool_principal';
  remaining:=leg.funded_atomic-leg.reserved_atomic-leg.spent_atomic-leg.fulfilled_atomic-leg.refunded_atomic;
  IF contributed IS DISTINCT FROM leg.funded_atomic OR remaining<0 THEN
    RAISE EXCEPTION 'shared participant budget unavailable' USING ERRCODE='PCV05';
  END IF;
  available:=offer.status='active' AND leg.status='active' AND deployment.status='active'
    AND now_at>=offer.starts_at AND now_at<offer.ends_at
    AND (SELECT paused FROM reward_operations_control WHERE singleton) IS FALSE;
  FOR binding IN SELECT value FROM jsonb_array_elements(slot.terms->'qualification_bindings') LOOP
    SELECT q.* INTO qualification FROM qualification_policy_versions q
      WHERE q.qualification_policy_version_id=binding->>'qualification_policy_id'
        AND q.activity_key=binding->>'activity';
    IF qualification.qualification_policy_version_id IS NULL THEN
      RAISE EXCEPTION 'frozen participant policy unavailable' USING ERRCODE='PCV05';
    END IF;
    SELECT r.* INTO registry FROM activity_registry r WHERE r.activity_key=qualification.activity_key;
    policy_available:=coalesce(registry.status='active'
      AND registry.current_policy_version_id=qualification.qualification_policy_version_id,FALSE);
    IF qualification.activity_key='dance' THEN
      policy_available:=policy_available AND EXISTS(
        SELECT 1 FROM dance_review_policy_admissions_v1 admission
        JOIN dance_review_policy_versions_v1 policy USING(policy_id)
        WHERE admission.community_id=p_community AND admission.accepted
          AND admission.effective_at<=now_at AND admission.valid_until>now_at
          AND policy.valid_from<=now_at AND policy.valid_until>now_at
          AND policy.qualification_policy_version_id=qualification.qualification_policy_version_id
          AND policy.review_policy->>'qualificationHash'=binding->>'qualification_policy_hash'
          AND policy.review_policy->>'admission'='money_admitted'
          AND policy.review_policy->>'admissionVersion'=binding->>'admission_id'
          AND policy.review_policy->>'admissionHash'=binding->>'admission_hash'
          AND policy.review_policy->>'producerId'=registry.producer_version);
    END IF;
    documents:=documents||jsonb_build_array(jsonb_build_object(
      'binding_id',binding->>'binding_id','policy_id',qualification.qualification_policy_version_id,
      'activity',qualification.activity_key,'kind',qualification.policy_kind,
      'policy_hash',binding->>'qualification_policy_hash','document',qualification.policy_document,
      'currently_available',policy_available));
  END LOOP;
  available:=available AND EXISTS(SELECT 1 FROM jsonb_array_elements(documents) d
    WHERE (d->>'currently_available')::BOOLEAN IS TRUE);
  FOR planned IN SELECT value FROM jsonb_array_elements_text(slot.terms->'planned_drawing_ids') LOOP
    SELECT d.* INTO drawing FROM megapot_pool_drawings d
      WHERE d.pool_leg_id=leg.leg_id AND d.drawing_id=planned::NUMERIC;
    IF drawing.pool_leg_id IS NULL THEN
      drawings:=drawings||jsonb_build_array(jsonb_build_object('kind','not_open','planned_drawing_id',planned));
      CONTINUE;
    END IF;
    SELECT o.* INTO original_observation FROM megapot_drawing_observations o
      WHERE o.observation_id=drawing.observation_id;
    IF (original_observation.attestation_id=leg.attestation_id
      AND original_observation.chain_id=leg.chain_id AND original_observation.drawing_id=drawing.drawing_id
      AND drawing.entry_cutoff_at=original_observation.drawing_time-make_interval(secs=>leg.entry_cutoff_seconds)
      AND drawing.fallback_beneficiary IS NOT TRUE) IS NOT TRUE THEN
      RAISE EXCEPTION 'participant drawing lineage unavailable' USING ERRCODE='PCV05';
    END IF;
    SELECT s.* INTO snapshot FROM megapot_pool_beneficiary_snapshots s WHERE s.snapshot_id=drawing.snapshot_id;
    IF drawing.snapshot_id IS NOT NULL AND (snapshot.pool_leg_id=leg.leg_id
      AND snapshot.drawing_id=drawing.drawing_id AND snapshot.terms_hash=leg.leg_terms_hash
      AND snapshot.leaf_count=drawing.frozen_share_count AND snapshot.fallback IS FALSE
      AND snapshot.algorithm_version='equal_v1') IS NOT TRUE THEN
      RAISE EXCEPTION 'participant snapshot lineage unavailable' USING ERRCODE='PCV05';
    END IF;
    IF drawing.status='entry_open' THEN
      SELECT count(*)::INTEGER INTO beneficiaries FROM megapot_pool_shares s
        WHERE s.pool_leg_id=leg.leg_id AND s.drawing_id=drawing.drawing_id;
      SELECT EXISTS(SELECT 1 FROM megapot_pool_shares s WHERE s.pool_leg_id=leg.leg_id
        AND s.drawing_id=drawing.drawing_id AND s.account_id=p_account) INTO share_held;
    ELSE
      beneficiaries:=coalesce(drawing.frozen_share_count,0);
      SELECT EXISTS(SELECT 1 FROM megapot_pool_snapshot_private_leaves s
        WHERE s.snapshot_id=snapshot.snapshot_id AND s.account_id=p_account) INTO share_held;
    END IF;
    SELECT o.* INTO observation FROM megapot_drawing_observations o
      WHERE o.attestation_id=leg.attestation_id AND o.drawing_id=drawing.drawing_id
      ORDER BY o.block_number DESC,o.observed_at DESC,o.observation_id LIMIT 1;
    gross:=NULL;global_tickets:=NULL;observed_at:=NULL;
    IF observation.gross_prize_pool_atomic IS NOT NULL AND observation.global_tickets_bought IS NOT NULL
      AND (drawing.terminal_at IS NOT NULL OR observation.expires_at>now_at) THEN
      gross:=observation.gross_prize_pool_atomic;global_tickets:=observation.global_tickets_bought;
      observed_at:=observation.observed_at;
    END IF;
    SELECT c.* INTO commitment FROM megapot_pool_commitment_effects c
      WHERE c.commitment_effect_id=drawing.commitment_effect_id;
    IF commitment.commitment_effect_id IS NOT NULL AND commitment.snapshot_id IS DISTINCT FROM drawing.snapshot_id THEN
      RAISE EXCEPTION 'participant commitment lineage unavailable' USING ERRCODE='PCV05';
    END IF;
    SELECT t.* INTO ticket FROM megapot_ticket_inventory t
      WHERE t.pool_leg_id=leg.leg_id AND t.drawing_id=drawing.drawing_id;
    IF ticket.ticket_id IS NOT NULL AND (ticket.attestation_id=leg.attestation_id
      AND ticket.custody_address=deployment.custody_address
      AND ticket.purchase_effect_id=drawing.purchase_effect_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'participant ticket lineage unavailable' USING ERRCODE='PCV05';
    END IF;
    credit_json:=NULL;
    SELECT b.* INTO batch FROM megapot_allocation_batches b WHERE b.allocation_batch_id=drawing.allocation_batch_id;
    IF drawing.allocation_batch_id IS NOT NULL THEN
      IF (batch.pool_leg_id=leg.leg_id AND batch.drawing_id=drawing.drawing_id
        AND batch.snapshot_id=drawing.snapshot_id AND batch.claim_effect_id=drawing.claim_effect_id
        AND batch.net_winnings_atomic=drawing.net_winnings_atomic) IS NOT TRUE THEN
        RAISE EXCEPTION 'participant allocation lineage unavailable' USING ERRCODE='PCV05';
      END IF;
      IF batch.state='credited' THEN
        SELECT c.* INTO custody_claim FROM megapot_claim_effects c WHERE c.claim_effect_id=batch.claim_effect_id;
        SELECT r.* INTO custody_receipt FROM megapot_claim_receipt_evidence r WHERE r.claim_effect_id=batch.claim_effect_id;
        SELECT e.* INTO chain_effect FROM reward_chain_effects e WHERE e.effect_id=batch.claim_effect_id;
        IF (custody_claim.pool_leg_id=leg.leg_id AND custody_claim.drawing_id=drawing.drawing_id
          AND custody_claim.attestation_id=leg.attestation_id AND custody_claim.ticket_id=ticket.ticket_id
          AND custody_claim.received_atomic=batch.net_winnings_atomic
          AND custody_receipt.attestation_id=leg.attestation_id AND custody_receipt.ticket_id=ticket.ticket_id
          AND custody_receipt.net_winnings_atomic=batch.net_winnings_atomic
          AND custody_receipt.custody_balance_after_atomic-custody_receipt.custody_balance_before_atomic=batch.net_winnings_atomic
          AND chain_effect.effect_kind='winnings_claim' AND chain_effect.state='confirmed'
          AND chain_effect.chain_id=leg.chain_id AND chain_effect.receipt_status='success'
          AND chain_effect.transaction_hash=custody_receipt.transaction_hash
          AND chain_effect.receipt_hash=custody_receipt.receipt_hash
          AND chain_effect.receipt_block_hash=custody_receipt.block_hash
          AND chain_effect.receipt_block_number=custody_receipt.block_number
          AND chain_effect.confirmations=custody_receipt.confirmations
          AND ticket.status='claimed' AND ticket.claimed_transaction_hash=custody_receipt.transaction_hash) IS NOT TRUE THEN
          RAISE EXCEPTION 'participant custody receipt unavailable' USING ERRCODE='PCV05';
        END IF;
        SELECT a.* INTO allocation FROM megapot_allocations a
          WHERE a.allocation_batch_id=batch.allocation_batch_id AND a.account_id=p_account;
        IF allocation.account_id IS NOT NULL THEN
          SELECT c.* INTO credit FROM reward_ledger_credits c WHERE c.credit_id=allocation.credit_id;
          IF (share_held AND allocation.allocation_kind='participant' AND allocation.amount_atomic>0
            AND EXISTS(SELECT 1 FROM megapot_pool_snapshot_private_leaves leaf
              WHERE leaf.snapshot_id=snapshot.snapshot_id AND leaf.account_id=p_account
                AND leaf.ordinal=allocation.ordinal AND leaf.persona_id=allocation.persona_id)
            AND credit.account_id=p_account AND credit.payout_persona_id=allocation.persona_id
            AND credit.chain_id=leg.chain_id AND credit.token_address=leg.token_address
            AND credit.amount_atomic=allocation.amount_atomic AND credit.source_kind='megapot_allocation'
            AND credit.source_reference=batch.allocation_batch_id||':'||allocation.ordinal::TEXT) IS NOT TRUE THEN
            RAISE EXCEPTION 'participant credit ownership unavailable' USING ERRCODE='PCV05';
          END IF;
          SELECT c.* INTO claim FROM megapot_participant_claims c WHERE c.credit_id=credit.credit_id;
          IF claim.credit_id IS NOT NULL AND (claim.account_id=p_account AND claim.pool_leg_id=leg.leg_id
            AND claim.drawing_id=drawing.drawing_id) IS NOT TRUE THEN
            RAISE EXCEPTION 'participant claim ownership unavailable' USING ERRCODE='PCV05';
          END IF;
          IF claim.credit_id IS NULL AND (credit.state<>'credited' OR credit.paid_atomic<>0 OR credit.reserved_atomic<>0) THEN
            RAISE EXCEPTION 'participant claim evidence unavailable' USING ERRCODE='PCV05';
          END IF;
          payout_state:=NULL;
          IF claim.status='accepted' THEN
            payout_state:=CASE credit.state WHEN 'sent' THEN 'confirmed' WHEN 'payout_pending' THEN 'submitted'
              WHEN 'payout_reserved' THEN 'pending' WHEN 'reconciliation_required' THEN 'failed_retrying'
              ELSE CASE WHEN NOT EXISTS(SELECT 1 FROM persona_wallet_assignments wallet
                WHERE wallet.account_id=p_account AND wallet.persona_id=credit.payout_persona_id
                  AND wallet.chain_account_kind='evm' AND wallet.status='active') THEN 'recipient_pending'
                WHEN EXISTS(SELECT 1 FROM reward_payout_effects payout JOIN reward_chain_effects effect
                  ON effect.effect_id=payout.payout_effect_id WHERE payout.credit_id=credit.credit_id
                  AND effect.state IN('reverted','replaced','reclaimable_failed','terminal_failed')) THEN 'failed_retrying'
                ELSE 'pending' END END;
          END IF;
          credit_json:=jsonb_build_object('credit_id',credit.credit_id,'amount_atomic',credit.amount_atomic::TEXT,
            'state',credit.state,'claim',jsonb_build_object('status',coalesce(claim.status,'unclaimed'),'payout_status',payout_state));
        ELSIF share_held THEN
          -- Positive-only v2 allocation storage cannot prove a rounded zero.
          -- Missing evidence never becomes a zero credit or a Claim action.
          RAISE EXCEPTION 'participant allocation evidence unavailable' USING ERRCODE='PCV05';
        END IF;
      END IF;
    END IF;
    public_state:=CASE
      WHEN drawing.status='entry_open' THEN CASE WHEN drawing.entry_cutoff_at>now_at THEN 'entry_open' ELSE 'entry_closed' END
      WHEN drawing.status IN('cutoff_frozen','closed_no_entries','closed_unfunded','closed_fallback_ineligible',
        'closed_fallback_unavailable','closed_fallback_ceiling','closed_purchase_unavailable') THEN 'entry_closed'
      WHEN drawing.status IN('committed','purchase_pending') THEN 'committed'
      WHEN drawing.status='tickets_confirmed' THEN 'ticket_purchased'
      WHEN drawing.status='drawing_pending' THEN 'drawing_pending'
      WHEN drawing.status='no_win' THEN 'no_win'
      WHEN drawing.status IN('winnings_detected','claim_pending','claimed','allocated','credited') THEN 'won'
      ELSE 'operational_hold' END;
    drawings:=drawings||jsonb_build_array(jsonb_build_object('kind','materialized','planned_drawing_id',planned,
      'drawing_at',to_char(original_observation.drawing_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'drawing',jsonb_build_object('object','megapot_pool_drawing_projection','drawing_id',planned,
        'lifecycle_status',CASE WHEN drawing.status='closed_purchase_unavailable' THEN 'operational_hold' ELSE drawing.status END,
        'state',public_state,'entry_cutoff_at',to_char(drawing.entry_cutoff_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'beneficiary_count',beneficiaries,'ticket_price_ceiling_atomic',drawing.ticket_price_ceiling_atomic::TEXT,
        'actual_ticket_cost_atomic',drawing.actual_ticket_cost_atomic::TEXT,'net_winnings_atomic',drawing.net_winnings_atomic::TEXT,
        'gross_prize_pool_atomic',gross::TEXT,'global_tickets_bought',global_tickets::TEXT,
        'prize_pool_observed_at',to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'prize_pool_basis','gross_observed_before_referral_win_share_terminal_last_observed_pre_rollover',
        'global_tickets_basis','drawing_wide_all_megapot_buyers',
        'commitment_reference',CASE WHEN commitment.state='published' THEN commitment.public_reference ELSE NULL END,
        'snapshot_hash',snapshot.snapshot_hash,'ticket_id',ticket.ticket_id::TEXT,
        'purchase_transaction_hash',ticket.minted_transaction_hash,'claim_transaction_hash',ticket.claimed_transaction_hash),
      'standing',jsonb_build_object('share_held',share_held,'credit',credit_json)));
  END LOOP;
  RETURN jsonb_build_object('projection',jsonb_build_object(
    'object','shared_song_megapot_participation','version',2,
    'as_of',to_char(now_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'target',slot.target,'terms',slot.terms,'chain_id',leg.chain_id,
    'token_address',leg.token_address,'token_decimals',leg.token_decimals,
    'offer_status',offer.status,'leg_status',leg.status,'confirmed_contributed_atomic',contributed::TEXT,
    'remaining_budget_atomic',remaining::TEXT,'participation_available',available,
    'qualification_rules','[]'::JSONB,'drawings',drawings),'qualification_documents',documents);
END $$;
DO $acl$
DECLARE f RECORD;r RECORD;trusted TEXT:=current_schema();
BEGIN
  FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p
    WHERE p.pronamespace=trusted::regnamespace AND p.proname='read_shared_song_megapot_participation_v2' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
    FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name
      FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a
      WHERE a.grantee NOT IN(0,f.proowner) LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name);
    END LOOP;
  END LOOP;
END $acl$;
