-- An operator may release only an unsigned tail reservation on the test chain.
-- The old nonce remains in append-only transition evidence, never as a deletion.
ALTER TABLE megapot_pool_drawings
  DROP CONSTRAINT megapot_pool_drawing_effect_shape,
  ADD CONSTRAINT megapot_pool_drawing_effect_shape CHECK (
    status = 'operational_hold'
    OR (status IN ('entry_open', 'cutoff_frozen', 'closed_no_entries', 'closed_unfunded',
        'closed_fallback_ineligible', 'closed_fallback_unavailable',
        'closed_fallback_ceiling') AND commitment_effect_id IS NULL
      AND purchase_effect_id IS NULL AND claim_effect_id IS NULL
      AND allocation_batch_id IS NULL)
    OR (status = 'committed' AND commitment_effect_id IS NOT NULL
      AND purchase_effect_id IS NULL AND claim_effect_id IS NULL
      AND allocation_batch_id IS NULL)
    OR (status = 'closed_purchase_unavailable' AND commitment_effect_id IS NOT NULL
      AND claim_effect_id IS NULL AND allocation_batch_id IS NULL)
    OR (status IN ('purchase_pending', 'tickets_confirmed', 'drawing_pending', 'no_win',
        'winnings_detected') AND commitment_effect_id IS NOT NULL
      AND purchase_effect_id IS NOT NULL AND claim_effect_id IS NULL
      AND allocation_batch_id IS NULL)
    OR (status IN ('claim_pending', 'claimed') AND commitment_effect_id IS NOT NULL
      AND purchase_effect_id IS NOT NULL AND claim_effect_id IS NOT NULL
      AND allocation_batch_id IS NULL)
    OR (status IN ('allocated', 'credited') AND commitment_effect_id IS NOT NULL
      AND purchase_effect_id IS NOT NULL AND claim_effect_id IS NOT NULL
      AND allocation_batch_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION guard_reward_signer_nonce() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  operations_paused BOOLEAN;
  tail_release BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reward signer nonce fences cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.next_nonce < OLD.next_nonce THEN
    -- SECURITY DEFINER makes current_user the trigger owner. Inspect the actual
    -- login/SET ROLE identity instead; SET ROLE cannot impersonate an owner.
    tail_release :=
      (CASE WHEN current_setting('role') = 'none' THEN session_user::text
        ELSE current_setting('role') END)
        = pg_get_userbyid((SELECT relowner FROM pg_class
            WHERE oid = 'reward_signer_nonces'::regclass))
      AND NEW.next_nonce = OLD.next_nonce - 1
      AND EXISTS (
        SELECT 1 FROM reward_chain_effects effect
        JOIN reward_chain_effect_transitions event ON event.effect_id=effect.effect_id
          AND event.target_version=effect.version
        JOIN megapot_pool_drawings drawing ON drawing.purchase_effect_id=effect.effect_id
        WHERE effect.chain_id=OLD.chain_id AND effect.signer_address=OLD.signer_address
          AND effect.state='terminal_failed' AND effect.nonce IS NULL
          AND effect.signed_transaction IS NULL AND effect.transaction_hash IS NULL
          AND event.event_type='unsigned_purchase_released'
          AND event.event->>'nonce'=NEW.next_nonce::text
          AND event.event->>'nonce_fence'=OLD.fence_version::text
          AND drawing.status='closed_purchase_unavailable'
      );
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.chain_id <> OLD.chain_id OR NEW.signer_address <> OLD.signer_address
    OR (NEW.next_nonce < OLD.next_nonce AND NOT tail_release)
    OR NEW.fence_version <> OLD.fence_version + 1
    OR NEW.observed_block_number < OLD.observed_block_number
    OR NEW.observed_at < OLD.observed_at OR NEW.updated_at <= OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'invalid reward signer nonce fence update';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.next_nonce > OLD.next_nonce THEN
    SELECT paused INTO operations_paused FROM reward_operations_control WHERE singleton FOR SHARE;
    IF NOT FOUND OR operations_paused IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION guard_reward_signer_nonce() FROM PUBLIC;

CREATE OR REPLACE FUNCTION guard_megapot_pool_drawing() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  leg_record song_reward_offer_legs%ROWTYPE;
  offer_record song_reward_offers%ROWTYPE;
  observation_record megapot_drawing_observations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Megapot pool drawings cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO leg_record FROM song_reward_offer_legs
     WHERE leg_id = NEW.pool_leg_id FOR SHARE;
    SELECT * INTO offer_record FROM song_reward_offers
     WHERE offer_id = leg_record.offer_id FOR SHARE;
    SELECT * INTO observation_record FROM megapot_drawing_observations
     WHERE observation_id = NEW.observation_id FOR SHARE;
    IF NEW.status <> 'entry_open' OR leg_record.kind <> 'megapot_pool'
       OR leg_record.status <> 'active'
       OR offer_record.offer_id IS NULL
       OR offer_record.status <> 'active'
       OR NEW.drawing_id < leg_record.participation_starts_drawing_id
       OR observation_record.observation_id IS NULL
       OR observation_record.attestation_id <> leg_record.attestation_id
       OR observation_record.drawing_id <> NEW.drawing_id
       OR observation_record.drawing_locked
       OR observation_record.expires_at <= clock_timestamp()
       OR NEW.entry_cutoff_at <> observation_record.drawing_time
            - make_interval(secs => leg_record.entry_cutoff_seconds)
       OR NEW.entry_cutoff_at <= clock_timestamp()
       OR NEW.entry_cutoff_at > offer_record.ends_at
       OR NEW.ticket_price_ceiling_atomic <> leg_record.max_ticket_price_atomic THEN
      RAISE EXCEPTION 'Megapot pool drawing does not match live leg and observation';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.pool_leg_id, NEW.drawing_id, NEW.observation_id, NEW.entry_cutoff_at,
    NEW.ticket_price_ceiling_atomic, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.pool_leg_id, OLD.drawing_id, OLD.observation_id, OLD.entry_cutoff_at,
    OLD.ticket_price_ceiling_atomic, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Megapot pool drawing identity is immutable';
  END IF;
  IF OLD.status IN (
    'no_win', 'credited', 'closed_no_entries', 'closed_unfunded',
    'closed_fallback_ineligible', 'closed_fallback_unavailable',
    'closed_fallback_ceiling', 'closed_purchase_unavailable', 'operational_hold'
  ) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal Megapot pool drawing is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'Megapot pool drawing transition requires next version and time';
  END IF;
  IF OLD.status='purchase_pending' AND NEW.status='closed_purchase_unavailable' AND (
    NEW.purchase_effect_id IS DISTINCT FROM OLD.purchase_effect_id
    OR NEW.terminal_reason IS DISTINCT FROM 'unsigned_purchase_released'
    OR NOT EXISTS (SELECT 1 FROM reward_chain_effects effect
      JOIN reward_chain_effect_transitions event ON event.effect_id=effect.effect_id
        AND event.target_version=effect.version
      WHERE effect.effect_id=OLD.purchase_effect_id AND effect.state='terminal_failed'
        AND effect.nonce IS NULL AND effect.signed_transaction IS NULL
        AND effect.transaction_hash IS NULL AND event.event_type='unsigned_purchase_released')
  ) THEN
    RAISE EXCEPTION 'closing reserved purchase requires unsigned release evidence';
  END IF;
  IF NOT (
    (OLD.status = 'entry_open' AND NEW.status IN (
      'cutoff_frozen', 'closed_no_entries', 'closed_unfunded',
      'closed_fallback_ineligible', 'closed_fallback_unavailable',
      'closed_fallback_ceiling', 'operational_hold'
    ))
    OR (OLD.status = 'cutoff_frozen' AND NEW.status IN ('committed', 'operational_hold'))
    OR (OLD.status = 'committed' AND NEW.status IN (
      'purchase_pending', 'closed_purchase_unavailable', 'operational_hold'
    ))
    OR (OLD.status = 'purchase_pending' AND NEW.status IN ('tickets_confirmed', 'closed_purchase_unavailable', 'operational_hold'))
    OR (OLD.status = 'tickets_confirmed' AND NEW.status IN ('drawing_pending', 'operational_hold'))
    OR (OLD.status = 'drawing_pending' AND NEW.status IN (
      'no_win', 'winnings_detected', 'operational_hold'
    ))
    OR (OLD.status = 'winnings_detected' AND NEW.status IN ('claim_pending', 'operational_hold'))
    OR (OLD.status = 'claim_pending' AND NEW.status IN ('claimed', 'operational_hold'))
    OR (OLD.status = 'claimed' AND NEW.status IN ('allocated', 'operational_hold'))
    OR (OLD.status = 'allocated' AND NEW.status IN ('credited', 'operational_hold'))
  ) THEN
    RAISE EXCEPTION 'invalid Megapot pool drawing transition';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION release_unsigned_test_purchase_v1(
  expected_effect_id TEXT, expected_effect_version BIGINT,
  expected_nonce_fence BIGINT, expected_brake_revision BIGINT,
  observed_latest_nonce NUMERIC, observed_pending_nonce NUMERIC,
  observed_block_number BIGINT, observed_block_hash TEXT, observed_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  brake reward_operations_control%ROWTYPE;
  lease reward_operations_run_lease%ROWTYPE;
  effect reward_chain_effects%ROWTYPE;
  nonce_record reward_signer_nonces%ROWTYPE;
  drawing megapot_pool_drawings%ROWTYPE;
  leg song_reward_offer_legs%ROWTYPE;
  attestation_environment TEXT;
BEGIN
  IF expected_effect_id IS NULL OR expected_effect_version IS NULL
    OR expected_nonce_fence IS NULL OR expected_brake_revision IS NULL THEN
    RAISE EXCEPTION 'unsigned purchase recovery requires exact versions';
  END IF;
  SELECT * INTO brake FROM reward_operations_control WHERE singleton FOR SHARE;
  SELECT * INTO lease FROM reward_operations_run_lease WHERE singleton FOR SHARE;
  IF brake.paused IS DISTINCT FROM TRUE OR brake.revision <> expected_brake_revision
    OR lease.required IS DISTINCT FROM TRUE
    OR (lease.expires_at > clock_timestamp() AND lease.absolute_deadline > clock_timestamp()) THEN
    RAISE EXCEPTION 'unsigned purchase recovery requires paused isolated authority';
  END IF;
  SELECT * INTO effect FROM reward_chain_effects WHERE effect_id=expected_effect_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unsigned purchase recovery effect missing'; END IF;
  SELECT * INTO nonce_record FROM reward_signer_nonces
    WHERE chain_id=effect.chain_id AND signer_address=effect.signer_address FOR UPDATE;
  SELECT * INTO effect FROM reward_chain_effects WHERE effect_id=expected_effect_id FOR UPDATE;
  SELECT * INTO drawing FROM megapot_pool_drawings
    WHERE purchase_effect_id=expected_effect_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unsigned purchase recovery drawing missing'; END IF;
  SELECT * INTO leg FROM song_reward_offer_legs WHERE leg_id=drawing.pool_leg_id FOR UPDATE;
  SELECT environment INTO attestation_environment FROM megapot_deployment_attestations
    WHERE attestation_id=leg.attestation_id;
  IF effect.effect_kind <> 'ticket_purchase' OR effect.chain_id <> 84532
    OR attestation_environment IS DISTINCT FROM 'test'
    OR effect.state <> 'nonce_reserved' OR effect.version <> expected_effect_version
    OR effect.nonce IS NULL OR effect.calldata IS NOT NULL OR effect.calldata_hash IS NOT NULL
    OR effect.signed_transaction IS NOT NULL OR effect.signed_transaction_hash IS NOT NULL
    OR effect.transaction_hash IS NOT NULL OR effect.prepared_at IS NOT NULL
    OR effect.broadcast_at IS NOT NULL OR effect.replacement_of_effect_id IS NOT NULL
    OR effect.replaced_by_effect_id IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM megapot_ticket_purchase_effects purchase
      JOIN megapot_deployment_attestations attestation
        ON attestation.attestation_id=purchase.attestation_id
      WHERE purchase.purchase_effect_id=effect.effect_id
        AND purchase.pool_leg_id=drawing.pool_leg_id AND purchase.drawing_id=drawing.drawing_id
        AND purchase.attestation_id=leg.attestation_id
        AND attestation.custody_address=effect.signer_address
        AND attestation.jackpot_address=effect.target_address
        AND purchase.ticket_price_atomic=effect.reserved_amount_atomic)
    OR drawing.status <> 'purchase_pending' OR drawing.entry_cutoff_at > clock_timestamp()
    OR drawing.actual_ticket_cost_atomic <> 0 OR drawing.claim_effect_id IS NOT NULL
    OR drawing.fallback_beneficiary OR leg.funding_source <> 'leg_budget'
    OR leg.reserved_atomic < drawing.reserved_ticket_cost_atomic
    OR nonce_record.fence_version <> expected_nonce_fence
    OR nonce_record.next_nonce <> effect.nonce + 1
    OR observed_latest_nonce IS DISTINCT FROM effect.nonce
    OR observed_pending_nonce IS DISTINCT FROM effect.nonce
    OR observed_block_number IS NULL OR observed_block_number < nonce_record.observed_block_number
    OR observed_block_hash IS NULL OR observed_block_hash !~ '^0x[0-9a-f]{64}$'
    OR observed_at IS NULL OR observed_at < clock_timestamp() - interval '60 seconds'
    OR observed_at > clock_timestamp() + interval '5 seconds'
    OR EXISTS (SELECT 1 FROM reward_chain_effects other
      WHERE other.chain_id=effect.chain_id AND other.signer_address=effect.signer_address
        AND other.effect_id<>effect.effect_id AND other.nonce>=effect.nonce)
    OR EXISTS (SELECT 1 FROM megapot_ticket_inventory WHERE purchase_effect_id=effect.effect_id)
    OR EXISTS (SELECT 1 FROM megapot_purchase_receipt_evidence
      WHERE purchase_effect_id=effect.effect_id) THEN
    RAISE EXCEPTION 'unsigned purchase recovery scope or chain proof changed';
  END IF;
  INSERT INTO reward_chain_effect_transitions(effect_id,target_version,event_type,event)
    VALUES (effect.effect_id,effect.version+1,'unsigned_purchase_released',jsonb_build_object(
      'nonce',effect.nonce::text,'nonce_fence',nonce_record.fence_version::text,
      'brake_revision',brake.revision::text,'latest_nonce',observed_latest_nonce::text,
      'pending_nonce',observed_pending_nonce::text,'block_number',observed_block_number::text,
      'block_hash',observed_block_hash,'observed_at',observed_at));
  UPDATE reward_chain_effects SET state='terminal_failed',version=version+1,nonce=NULL,
    failure_class='unsigned_purchase_released',failure_reason='drawing-window-expired',
    updated_at=clock_timestamp() WHERE effect_id=effect.effect_id;
  INSERT INTO megapot_pool_drawing_transitions(pool_leg_id,drawing_id,target_version,event_type,event)
    VALUES (drawing.pool_leg_id,drawing.drawing_id,drawing.version+1,
      'closed_purchase_unavailable',jsonb_build_object(
        'reason','unsigned_purchase_released','effect_id',effect.effect_id));
  UPDATE megapot_pool_drawings SET status='closed_purchase_unavailable',version=version+1,
    terminal_reason='unsigned_purchase_released',terminal_at=clock_timestamp(),
    updated_at=clock_timestamp()
    WHERE pool_leg_id=drawing.pool_leg_id AND drawing_id=drawing.drawing_id;
  UPDATE song_reward_offer_legs SET reserved_atomic=reserved_atomic-drawing.reserved_ticket_cost_atomic,
    updated_at=clock_timestamp() WHERE leg_id=leg.leg_id;
  UPDATE reward_signer_nonces SET next_nonce=effect.nonce,fence_version=fence_version+1,
    observed_pending_nonce=release_unsigned_test_purchase_v1.observed_pending_nonce,
    observed_block_number=release_unsigned_test_purchase_v1.observed_block_number,
    observed_block_hash=release_unsigned_test_purchase_v1.observed_block_hash,
    observed_at=release_unsigned_test_purchase_v1.observed_at,updated_at=clock_timestamp()
    WHERE chain_id=effect.chain_id AND signer_address=effect.signer_address;
END
$$;
REVOKE ALL ON FUNCTION release_unsigned_test_purchase_v1(TEXT,BIGINT,BIGINT,BIGINT,NUMERIC,NUMERIC,BIGINT,TEXT,TIMESTAMPTZ) FROM PUBLIC;
DO $recovery_permissions$
DECLARE role_name TEXT;
BEGIN
  FOR role_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='release_unsigned_test_purchase_v1(text,bigint,bigint,bigint,numeric,numeric,bigint,text,timestamptz)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION release_unsigned_test_purchase_v1(TEXT,BIGINT,BIGINT,BIGINT,NUMERIC,NUMERIC,BIGINT,TEXT,TIMESTAMPTZ) FROM %I',role_name);
  END LOOP;
  EXECUTE format('ALTER FUNCTION guard_reward_signer_nonce() SET search_path TO %I, pg_temp',current_schema());
  EXECUTE format('ALTER FUNCTION release_unsigned_test_purchase_v1(TEXT,BIGINT,BIGINT,BIGINT,NUMERIC,NUMERIC,BIGINT,TEXT,TIMESTAMPTZ) SET search_path TO %I, pg_temp',current_schema());
END;
$recovery_permissions$;
