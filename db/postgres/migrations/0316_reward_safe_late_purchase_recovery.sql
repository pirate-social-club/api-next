-- An owner-executed Safe purchase can execute after its ticket-first drawing closed
-- unexecuted. Settlement then holds it in reconciliation_required with its reservation,
-- although the Safe paid for a real ticket, and the custody solvency observation counts
-- that reservation as an obligation on top of the funds the purchase already spent. In
-- the October 23 chain rehearsal three such purchases froze every payout.
--
-- An operator may now settle exactly that case, once, while operations are paused and
-- no run holds a live lease, with chain evidence a maintained command has just
-- verified: the canonical receipt of the original call, a ticket for the intended
-- drawing, owned by the Safe. One transaction confirms the effect, keeps the mint and
-- receipt evidence, keeps the ticket as a held asset and moves its cost from reserved
-- to spent. The closed drawing stays closed and its history untouched: entries never
-- open, no beneficiary snapshot exists, and the held ticket can never be claimed or
-- assigned until owner terms for late and empty drawings are ratified. Every other held
-- purchase, including one that landed in another drawing or whose receipt is orphaned,
-- stays held.

ALTER TABLE megapot_ticket_inventory
  DROP CONSTRAINT megapot_ticket_inventory_status_check,
  DROP CONSTRAINT megapot_ticket_inventory_terminal_shape;

ALTER TABLE megapot_ticket_inventory
  ADD CONSTRAINT megapot_ticket_inventory_status_check CHECK (
    status IN ('custodied', 'claim_pending', 'claimed', 'no_win', 'needs_review', 'held_late')
  ),
  ADD CONSTRAINT megapot_ticket_inventory_terminal_shape CHECK (
    (status IN ('custodied', 'claim_pending', 'held_late')
      AND claimed_transaction_hash IS NULL AND terminal_at IS NULL)
    OR (status = 'claimed' AND claimed_transaction_hash IS NOT NULL AND terminal_at IS NOT NULL)
    OR (status IN ('no_win', 'needs_review')
      AND claimed_transaction_hash IS NULL AND terminal_at IS NOT NULL)
  );

-- A held late ticket enters inventory only beside its recovery event and never moves:
-- no transition leaves held_late.
CREATE OR REPLACE FUNCTION guard_megapot_ticket_inventory() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  purchase_record megapot_ticket_purchase_effects%ROWTYPE;
  chain_record reward_chain_effects%ROWTYPE;
  attestation_record megapot_deployment_attestations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Megapot ticket inventory cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO purchase_record FROM megapot_ticket_purchase_effects
     WHERE purchase_effect_id = NEW.purchase_effect_id FOR SHARE;
    SELECT * INTO chain_record FROM reward_chain_effects
     WHERE effect_id = NEW.purchase_effect_id FOR SHARE;
    SELECT * INTO attestation_record FROM megapot_deployment_attestations
     WHERE attestation_id = NEW.attestation_id FOR SHARE;
    IF NEW.status = 'held_late' THEN
      IF chain_record.state IS DISTINCT FROM 'confirmed'
         OR chain_record.receipt_status IS DISTINCT FROM 'success'
         OR chain_record.execution_mode IS DISTINCT FROM 'safe_owner_v1'
         OR chain_record.transaction_hash IS DISTINCT FROM NEW.minted_transaction_hash
         OR purchase_record.pool_leg_id IS DISTINCT FROM NEW.pool_leg_id
         OR purchase_record.drawing_id IS DISTINCT FROM NEW.drawing_id
         OR purchase_record.attestation_id IS DISTINCT FROM NEW.attestation_id
         OR NEW.custody_address IS DISTINCT FROM attestation_record.custody_address
         OR NOT EXISTS (
           SELECT 1 FROM reward_chain_effect_transitions event
            WHERE event.effect_id = NEW.purchase_effect_id
              AND event.target_version = chain_record.version
              AND event.event_type = 'late_purchase_recovered'
              AND event.event->>'ticket_id' = NEW.ticket_id::TEXT
         )
         OR NOT EXISTS (
           SELECT 1 FROM megapot_pool_drawings drawing
            WHERE drawing.purchase_effect_id = NEW.purchase_effect_id
              AND drawing.status = 'closed_purchase_unavailable'
         ) THEN
        RAISE EXCEPTION 'held late Megapot ticket requires its recovery evidence';
      END IF;
      RETURN NEW;
    END IF;
    IF chain_record.state <> 'confirmed' OR chain_record.receipt_status <> 'success'
       OR chain_record.transaction_hash <> NEW.minted_transaction_hash
       OR purchase_record.pool_leg_id <> NEW.pool_leg_id
       OR purchase_record.drawing_id <> NEW.drawing_id
       OR purchase_record.attestation_id <> NEW.attestation_id
       OR NEW.custody_address <> attestation_record.custody_address
       OR NEW.status <> 'custodied' THEN
      RAISE EXCEPTION 'Megapot ticket inventory requires confirmed custody mint';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.attestation_id, NEW.ticket_id, NEW.purchase_effect_id,
    NEW.pool_leg_id, NEW.drawing_id, NEW.custody_address,
    NEW.owner_observation_block_number, NEW.owner_observation_block_hash,
    NEW.minted_transaction_hash, NEW.minted_log_index, NEW.acquired_at
  ) IS DISTINCT FROM ROW(
    OLD.attestation_id, OLD.ticket_id, OLD.purchase_effect_id,
    OLD.pool_leg_id, OLD.drawing_id, OLD.custody_address,
    OLD.owner_observation_block_number, OLD.owner_observation_block_hash,
    OLD.minted_transaction_hash, OLD.minted_log_index, OLD.acquired_at
  ) THEN
    RAISE EXCEPTION 'Megapot ticket inventory identity is immutable';
  END IF;
  IF NOT (
    (OLD.status = 'custodied' AND NEW.status IN ('claim_pending', 'no_win', 'needs_review'))
    OR (OLD.status = 'claim_pending' AND NEW.status IN ('claimed', 'needs_review'))
  ) THEN
    RAISE EXCEPTION 'invalid Megapot ticket inventory transition';
  END IF;
  RETURN NEW;
END
$$;

-- Owner-only. The arguments are what the command verified on chain moments before;
-- everything else is checked against what Pirate already recorded. PR004 refuses a
-- system that is not stopped; PR005 refuses evidence or state that does not match.
CREATE FUNCTION recover_late_safe_purchase_v1(
  expected_effect_id TEXT, expected_effect_version BIGINT, expected_brake_revision BIGINT,
  verified_ticket_id NUMERIC, verified_purchase_log_index INTEGER,
  verified_mint_log_index INTEGER, verified_block_number BIGINT, verified_block_hash TEXT,
  verified_receipt_hash TEXT, verified_confirmations INTEGER,
  verified_referral_fees_atomic NUMERIC, verified_lp_earnings_atomic NUMERIC,
  verified_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  brake reward_operations_control%ROWTYPE;
  lease reward_operations_run_lease%ROWTYPE;
  effect reward_chain_effects%ROWTYPE;
  purchase megapot_ticket_purchase_effects%ROWTYPE;
  drawing megapot_pool_drawings%ROWTYPE;
  leg song_reward_offer_legs%ROWTYPE;
  attestation megapot_deployment_attestations%ROWTYPE;
  observed_price NUMERIC;
  observed_at TIMESTAMPTZ;
BEGIN
  IF expected_effect_id IS NULL OR expected_effect_version IS NULL
     OR expected_brake_revision IS NULL OR verified_ticket_id IS NULL
     OR verified_purchase_log_index IS NULL OR verified_mint_log_index IS NULL
     OR verified_block_number IS NULL OR verified_block_hash IS NULL
     OR verified_receipt_hash IS NULL OR verified_confirmations IS NULL
     OR verified_referral_fees_atomic IS NULL OR verified_lp_earnings_atomic IS NULL
     OR verified_at IS NULL THEN
    RAISE EXCEPTION 'late purchase recovery requires exact versions and evidence'
      USING ERRCODE='PR005';
  END IF;
  -- The brake, then the lease, in 0242's order; then the effect and what it reserved.
  SELECT * INTO brake FROM reward_operations_control WHERE singleton FOR SHARE;
  SELECT * INTO lease FROM reward_operations_run_lease WHERE singleton FOR SHARE;
  observed_at := clock_timestamp();
  IF brake.paused IS DISTINCT FROM TRUE OR brake.revision IS DISTINCT FROM expected_brake_revision
     OR (lease.run_id IS NOT NULL AND observed_at < lease.expires_at
       AND observed_at < lease.absolute_deadline) THEN
    RAISE EXCEPTION 'late purchase recovery requires paused operations and no live run'
      USING ERRCODE='PR004';
  END IF;
  SELECT * INTO effect FROM reward_chain_effects WHERE effect_id = expected_effect_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'late purchase recovery effect missing' USING ERRCODE='PR005';
  END IF;
  SELECT * INTO purchase FROM megapot_ticket_purchase_effects
   WHERE purchase_effect_id = effect.effect_id FOR SHARE;
  SELECT * INTO drawing FROM megapot_pool_drawings
   WHERE purchase_effect_id = effect.effect_id FOR SHARE;
  SELECT * INTO leg FROM song_reward_offer_legs WHERE leg_id = purchase.pool_leg_id FOR UPDATE;
  SELECT * INTO attestation FROM megapot_deployment_attestations
   WHERE attestation_id = purchase.attestation_id;
  SELECT ticket_price_atomic INTO observed_price FROM megapot_drawing_observations
   WHERE observation_id = drawing.observation_id;
  IF effect.execution_mode IS DISTINCT FROM 'safe_owner_v1'
     OR effect.effect_kind IS DISTINCT FROM 'ticket_purchase'
     OR effect.state IS DISTINCT FROM 'reconciliation_required'
     OR effect.version IS DISTINCT FROM expected_effect_version
     OR effect.failure_reason IS DISTINCT FROM 'safe_purchase_after_close'
     OR effect.safe_execution_outcome IS DISTINCT FROM 'success'
     OR effect.transaction_hash IS NULL OR effect.safe_nonce IS NULL
     OR effect.safe_prepared_block_number IS NULL
     OR verified_block_number < effect.safe_prepared_block_number
     OR purchase.purchase_effect_id IS NULL
     OR purchase.ticket_price_atomic IS DISTINCT FROM effect.reserved_amount_atomic
     OR purchase.recipient_address IS DISTINCT FROM attestation.custody_address
     OR attestation.custody_address IS DISTINCT FROM effect.signer_address
     OR attestation.jackpot_address IS DISTINCT FROM effect.target_address
     OR attestation.chain_id IS DISTINCT FROM effect.chain_id
     OR drawing.purchase_order IS DISTINCT FROM 'ticket_first_v1'
     OR drawing.pool_leg_id IS DISTINCT FROM purchase.pool_leg_id
     OR drawing.drawing_id IS DISTINCT FROM purchase.drawing_id
     OR drawing.status IS DISTINCT FROM 'closed_purchase_unavailable'
     OR drawing.terminal_reason IS DISTINCT FROM 'safe_purchase_not_executed'
     OR drawing.reserved_ticket_cost_atomic IS DISTINCT FROM effect.reserved_amount_atomic
     OR drawing.actual_ticket_cost_atomic IS DISTINCT FROM 0
     OR observed_price IS DISTINCT FROM effect.reserved_amount_atomic
     OR leg.funding_source IS DISTINCT FROM 'leg_budget'
     OR leg.purchase_order IS DISTINCT FROM 'ticket_first_v1'
     OR leg.attestation_id IS DISTINCT FROM purchase.attestation_id
     OR leg.reserved_atomic < effect.reserved_amount_atomic
     OR EXISTS (SELECT 1 FROM megapot_ticket_inventory
       WHERE purchase_effect_id = effect.effect_id)
     OR EXISTS (SELECT 1 FROM megapot_purchase_receipt_evidence
       WHERE purchase_effect_id = effect.effect_id)
     OR verified_ticket_id < 0 OR verified_purchase_log_index < 0
     OR verified_mint_log_index < 0
     OR verified_purchase_log_index = verified_mint_log_index
     OR verified_block_hash !~ '^0x[0-9a-f]{64}$'
     OR verified_receipt_hash !~ '^[0-9a-f]{64}$'
     OR verified_confirmations < 1
     OR verified_referral_fees_atomic < 0 OR verified_lp_earnings_atomic < 0
     OR verified_at < observed_at - interval '60 seconds'
     OR verified_at > observed_at + interval '5 seconds' THEN
    RAISE EXCEPTION 'late purchase recovery scope or chain proof changed' USING ERRCODE='PR005';
  END IF;
  INSERT INTO reward_chain_effect_transitions (effect_id, target_version, event_type, event)
  VALUES (effect.effect_id, effect.version + 1, 'late_purchase_recovered', jsonb_build_object(
    'pool_leg_id', drawing.pool_leg_id, 'drawing_id', drawing.drawing_id::TEXT,
    'drawing_status', drawing.status, 'ticket_id', verified_ticket_id::TEXT,
    'ticket_disposition', 'held_late', 'transaction_hash', effect.transaction_hash,
    'safe_nonce', effect.safe_nonce::TEXT, 'block_number', verified_block_number::TEXT,
    'block_hash', verified_block_hash, 'receipt_hash', verified_receipt_hash,
    'confirmations', verified_confirmations, 'cost_atomic', effect.reserved_amount_atomic::TEXT,
    'brake_revision', brake.revision::TEXT, 'operator_role', session_user::TEXT,
    'verified_at', verified_at
  ));
  UPDATE reward_chain_effects
     SET state = 'confirmed', version = version + 1,
         settled_amount_atomic = reserved_amount_atomic, receipt_status = 'success',
         receipt_block_number = verified_block_number, receipt_block_hash = verified_block_hash,
         receipt_hash = verified_receipt_hash, confirmations = verified_confirmations,
         confirmed_at = observed_at, failure_class = NULL, failure_reason = NULL,
         updated_at = clock_timestamp()
   WHERE effect_id = effect.effect_id;
  INSERT INTO megapot_ticket_inventory (
    attestation_id, ticket_id, purchase_effect_id, pool_leg_id, drawing_id, custody_address,
    owner_observation_block_number, owner_observation_block_hash, minted_transaction_hash,
    minted_log_index, status, acquired_at
  ) VALUES (
    purchase.attestation_id, verified_ticket_id, effect.effect_id, purchase.pool_leg_id,
    purchase.drawing_id, attestation.custody_address, verified_block_number,
    verified_block_hash, effect.transaction_hash, verified_mint_log_index, 'held_late',
    observed_at
  );
  INSERT INTO megapot_purchase_receipt_evidence (
    purchase_effect_id, attestation_id, ticket_id, transaction_hash, purchase_log_index,
    mint_log_index, block_number, block_hash, receipt_hash, confirmations,
    referral_fees_atomic, lp_earnings_atomic, confirmed_at
  ) VALUES (
    effect.effect_id, purchase.attestation_id, verified_ticket_id, effect.transaction_hash,
    verified_purchase_log_index, verified_mint_log_index, verified_block_number,
    verified_block_hash, verified_receipt_hash, verified_confirmations,
    verified_referral_fees_atomic, verified_lp_earnings_atomic, observed_at
  );
  UPDATE song_reward_offer_legs
     SET reserved_atomic = reserved_atomic - effect.reserved_amount_atomic,
         spent_atomic = spent_atomic + effect.reserved_amount_atomic,
         updated_at = clock_timestamp()
   WHERE leg_id = leg.leg_id;
END
$$;

DO $late_purchase_recovery_permissions$
DECLARE
  role_name TEXT;
BEGIN
  REVOKE ALL ON FUNCTION recover_late_safe_purchase_v1(
    TEXT, BIGINT, BIGINT, NUMERIC, INTEGER, INTEGER, BIGINT, TEXT, TEXT, INTEGER, NUMERIC,
    NUMERIC, TIMESTAMPTZ
  ) FROM PUBLIC;
  FOR role_name IN
    SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = 'recover_late_safe_purchase_v1(text,bigint,bigint,numeric,integer,integer,bigint,text,text,integer,numeric,numeric,timestamptz)'::regprocedure
       AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION recover_late_safe_purchase_v1(TEXT,BIGINT,BIGINT,NUMERIC,INTEGER,INTEGER,BIGINT,TEXT,TEXT,INTEGER,NUMERIC,NUMERIC,TIMESTAMPTZ) FROM %I',
      role_name
    );
  END LOOP;
  EXECUTE format(
    'ALTER FUNCTION recover_late_safe_purchase_v1(TEXT,BIGINT,BIGINT,NUMERIC,INTEGER,INTEGER,BIGINT,TEXT,TEXT,INTEGER,NUMERIC,NUMERIC,TIMESTAMPTZ) SET search_path TO %I, pg_temp',
    current_schema()
  );
END
$late_purchase_recovery_permissions$;
