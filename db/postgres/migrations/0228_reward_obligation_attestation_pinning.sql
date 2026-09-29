-- Outstanding rewards obligations are pinned to the attestation that created
-- them (api-megapot-obligation-attestation-pinning). Payout, refund and ERC20
-- receipt evidence guards previously required that attestation to still be
-- 'active', so a legitimate rotation stranded every obligation created under
-- the retired attestation even though its custody, chain and asset identity
-- were unchanged. The active-status requirement is removed from those three
-- guards; every identity check (chain, custody signer, token, solvency
-- linkage) is retained. Leg admission keeps requiring an active attestation,
-- so only the active attestation still admits new work.

CREATE OR REPLACE FUNCTION guard_reward_payout_effect() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE OR REPLACE FUNCTION guard_reward_refund_effect() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE OR REPLACE FUNCTION guard_reward_erc20_transfer_receipt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
