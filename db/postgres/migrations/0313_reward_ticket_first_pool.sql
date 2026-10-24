-- Ticket-first pool legs for owner-executed Safe custody (draft Spec 015 section 5.2b).
-- The owner's Safe buys the drawing's ticket before entries open; participants join
-- only a drawing whose ticket is confirmed, so a late Safe execution can never move
-- them into another drawing. After the commitment there is no purchase step. A
-- drawing with no qualifiers is held, never allocated, until the owner's ratified
-- empty-drawing terms exist. Commit-first legs keep their exact rules: every
-- existing shape expression below is the current one, scoped to commit_first.

ALTER TABLE song_reward_offer_legs
  ADD COLUMN purchase_order TEXT NOT NULL DEFAULT 'commit_first'
    CHECK (purchase_order IN ('commit_first', 'ticket_first_v1')),
  ADD CONSTRAINT song_reward_leg_purchase_order_shape CHECK (
    purchase_order = 'commit_first'
    OR (kind = 'megapot_pool' AND funding_source = 'leg_budget'
      AND empty_pool_policy = 'no_purchase')
  );

CREATE FUNCTION guard_song_reward_leg_purchase_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purchase_order IS DISTINCT FROM OLD.purchase_order THEN
    RAISE EXCEPTION 'reward leg purchase order is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_reward_offer_legs_purchase_order_guard
BEFORE UPDATE ON song_reward_offer_legs
FOR EACH ROW EXECUTE FUNCTION guard_song_reward_leg_purchase_order();

ALTER TABLE megapot_pool_drawings
  ADD COLUMN purchase_order TEXT NOT NULL DEFAULT 'commit_first'
    CHECK (purchase_order IN ('commit_first', 'ticket_first_v1')),
  DROP CONSTRAINT megapot_pool_drawings_status_check,
  ADD CONSTRAINT megapot_pool_drawings_status_check CHECK (
    status = ANY (ARRAY['entry_open'::text, 'cutoff_frozen'::text, 'committed'::text, 'purchase_pending'::text, 'tickets_confirmed'::text, 'drawing_pending'::text, 'no_win'::text, 'winnings_detected'::text, 'claim_pending'::text, 'claimed'::text, 'allocated'::text, 'credited'::text, 'closed_no_entries'::text, 'closed_unfunded'::text, 'closed_fallback_ineligible'::text, 'closed_fallback_unavailable'::text, 'closed_fallback_ceiling'::text, 'closed_purchase_unavailable'::text, 'operational_hold'::text, 'ticket_pending'::text])
  );

ALTER TABLE megapot_pool_drawings
  DROP CONSTRAINT megapot_pool_drawing_effect_shape,
  ADD CONSTRAINT megapot_pool_drawing_effect_shape CHECK (
    (purchase_order = 'commit_first' AND (((status = 'operational_hold'::text) OR ((status = ANY (ARRAY['entry_open'::text, 'cutoff_frozen'::text, 'closed_no_entries'::text, 'closed_unfunded'::text, 'closed_fallback_ineligible'::text, 'closed_fallback_unavailable'::text, 'closed_fallback_ceiling'::text])) AND (commitment_effect_id IS NULL) AND (purchase_effect_id IS NULL) AND (claim_effect_id IS NULL) AND (allocation_batch_id IS NULL)) OR ((status = 'committed'::text) AND (commitment_effect_id IS NOT NULL) AND (purchase_effect_id IS NULL) AND (claim_effect_id IS NULL) AND (allocation_batch_id IS NULL)) OR ((status = 'closed_purchase_unavailable'::text) AND (commitment_effect_id IS NOT NULL) AND (claim_effect_id IS NULL) AND (allocation_batch_id IS NULL)) OR ((status = ANY (ARRAY['purchase_pending'::text, 'tickets_confirmed'::text, 'drawing_pending'::text, 'no_win'::text, 'winnings_detected'::text])) AND (commitment_effect_id IS NOT NULL) AND (purchase_effect_id IS NOT NULL) AND (claim_effect_id IS NULL) AND (allocation_batch_id IS NULL)) OR ((status = ANY (ARRAY['claim_pending'::text, 'claimed'::text])) AND (commitment_effect_id IS NOT NULL) AND (purchase_effect_id IS NOT NULL) AND (claim_effect_id IS NOT NULL) AND (allocation_batch_id IS NULL)) OR ((status = ANY (ARRAY['allocated'::text, 'credited'::text])) AND (commitment_effect_id IS NOT NULL) AND (purchase_effect_id IS NOT NULL) AND (claim_effect_id IS NOT NULL) AND (allocation_batch_id IS NOT NULL)))))
    OR (purchase_order = 'ticket_first_v1' AND (
      status = 'operational_hold'
      OR (status IN ('ticket_pending', 'entry_open', 'cutoff_frozen', 'closed_purchase_unavailable')
        AND commitment_effect_id IS NULL AND purchase_effect_id IS NOT NULL
        AND claim_effect_id IS NULL AND allocation_batch_id IS NULL)
      OR (status IN ('committed', 'drawing_pending', 'no_win', 'winnings_detected')
        AND commitment_effect_id IS NOT NULL AND purchase_effect_id IS NOT NULL
        AND claim_effect_id IS NULL AND allocation_batch_id IS NULL)
      OR (status IN ('claim_pending', 'claimed')
        AND commitment_effect_id IS NOT NULL AND purchase_effect_id IS NOT NULL
        AND claim_effect_id IS NOT NULL AND allocation_batch_id IS NULL)
      OR (status IN ('allocated', 'credited')
        AND commitment_effect_id IS NOT NULL AND purchase_effect_id IS NOT NULL
        AND claim_effect_id IS NOT NULL AND allocation_batch_id IS NOT NULL)
    ))
  );

ALTER TABLE megapot_pool_drawings
  DROP CONSTRAINT megapot_pool_drawing_purchase_amount_shape,
  ADD CONSTRAINT megapot_pool_drawing_purchase_amount_shape CHECK (
    (purchase_order = 'commit_first' AND (((status = 'operational_hold'::text) OR ((status = ANY (ARRAY['entry_open'::text, 'closed_no_entries'::text, 'closed_unfunded'::text, 'closed_fallback_ineligible'::text, 'closed_fallback_unavailable'::text, 'closed_fallback_ceiling'::text])) AND (reserved_ticket_cost_atomic = (0)::numeric) AND (actual_ticket_cost_atomic = (0)::numeric)) OR ((status = ANY (ARRAY['cutoff_frozen'::text, 'committed'::text, 'purchase_pending'::text, 'closed_purchase_unavailable'::text])) AND (reserved_ticket_cost_atomic > (0)::numeric) AND (actual_ticket_cost_atomic = (0)::numeric)) OR ((status = ANY (ARRAY['tickets_confirmed'::text, 'drawing_pending'::text, 'no_win'::text, 'winnings_detected'::text, 'claim_pending'::text, 'claimed'::text, 'allocated'::text, 'credited'::text])) AND (reserved_ticket_cost_atomic > (0)::numeric) AND (actual_ticket_cost_atomic > (0)::numeric)))))
    OR (purchase_order = 'ticket_first_v1' AND (
      status = 'operational_hold'
      OR (status IN ('ticket_pending', 'closed_purchase_unavailable')
        AND reserved_ticket_cost_atomic > 0 AND actual_ticket_cost_atomic = 0)
      OR (status IN ('entry_open', 'cutoff_frozen', 'committed', 'drawing_pending', 'no_win',
          'winnings_detected', 'claim_pending', 'claimed', 'allocated', 'credited')
        AND reserved_ticket_cost_atomic > 0 AND actual_ticket_cost_atomic > 0)
    ))
  );

ALTER TABLE megapot_pool_drawings
  DROP CONSTRAINT megapot_pool_drawing_snapshot_shape,
  ADD CONSTRAINT megapot_pool_drawing_snapshot_shape CHECK (
    (purchase_order = 'commit_first' AND (((status = 'operational_hold'::text) OR ((status = ANY (ARRAY['entry_open'::text, 'closed_no_entries'::text, 'closed_unfunded'::text, 'closed_fallback_ineligible'::text, 'closed_fallback_unavailable'::text, 'closed_fallback_ceiling'::text])) AND (snapshot_id IS NULL)) OR ((status = ANY (ARRAY['cutoff_frozen'::text, 'committed'::text, 'purchase_pending'::text, 'tickets_confirmed'::text, 'drawing_pending'::text, 'no_win'::text, 'winnings_detected'::text, 'claim_pending'::text, 'claimed'::text, 'allocated'::text, 'credited'::text, 'closed_purchase_unavailable'::text])) AND (snapshot_id IS NOT NULL)))))
    OR (purchase_order = 'ticket_first_v1' AND (
      status = 'operational_hold'
      OR (status IN ('ticket_pending', 'entry_open', 'closed_purchase_unavailable')
        AND snapshot_id IS NULL)
      OR (status IN ('cutoff_frozen', 'committed', 'drawing_pending', 'no_win',
          'winnings_detected', 'claim_pending', 'claimed', 'allocated', 'credited')
        AND snapshot_id IS NOT NULL)
    ))
  );

ALTER TABLE megapot_pool_drawings
  DROP CONSTRAINT megapot_pool_drawing_freeze_shape,
  ADD CONSTRAINT megapot_pool_drawing_freeze_shape CHECK (
    (purchase_order = 'commit_first' AND ((((status = 'entry_open'::text) AND (frozen_share_count IS NULL) AND (fallback_beneficiary IS NULL) AND (snapshot_id IS NULL) AND (cutoff_frozen_at IS NULL)) OR (status = 'operational_hold'::text) OR ((status <> ALL (ARRAY['entry_open'::text, 'operational_hold'::text])) AND (frozen_share_count IS NOT NULL) AND (frozen_share_count >= 0) AND (fallback_beneficiary IS NOT NULL) AND (cutoff_frozen_at IS NOT NULL)))))
    OR (purchase_order = 'ticket_first_v1' AND (
      status = 'operational_hold'
      OR (status IN ('ticket_pending', 'entry_open', 'closed_purchase_unavailable')
        AND frozen_share_count IS NULL AND fallback_beneficiary IS NULL
        AND snapshot_id IS NULL AND cutoff_frozen_at IS NULL)
      OR (status NOT IN ('ticket_pending', 'entry_open', 'closed_purchase_unavailable',
          'operational_hold')
        AND frozen_share_count IS NOT NULL AND frozen_share_count > 0
        AND fallback_beneficiary = false AND cutoff_frozen_at IS NOT NULL)
    ))
  );

CREATE OR REPLACE FUNCTION guard_megapot_pool_drawing() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  leg_record song_reward_offer_legs%ROWTYPE;
  offer_record song_reward_offers%ROWTYPE;
  observation_record megapot_drawing_observations%ROWTYPE;
  purchase_record reward_chain_effects%ROWTYPE;
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
    IF NEW.purchase_order IS DISTINCT FROM leg_record.purchase_order THEN
      RAISE EXCEPTION 'Megapot pool drawing purchase order must match its leg';
    END IF;
    IF leg_record.purchase_order = 'ticket_first_v1' THEN
      -- A ticket-first drawing exists only for its prepared owner-executed purchase;
      -- entries open later, when that ticket is confirmed in this drawing.
      SELECT * INTO purchase_record FROM reward_chain_effects
       WHERE effect_id = NEW.purchase_effect_id FOR SHARE;
      IF NEW.status <> 'ticket_pending' OR purchase_record.effect_id IS NULL
         OR purchase_record.effect_kind <> 'ticket_purchase'
         OR purchase_record.execution_mode <> 'safe_owner_v1'
         OR purchase_record.state <> 'prepared'
         OR NEW.reserved_ticket_cost_atomic <> purchase_record.reserved_amount_atomic
         OR NEW.reserved_ticket_cost_atomic > leg_record.max_ticket_price_atomic THEN
        RAISE EXCEPTION 'ticket-first Megapot pool drawing requires its prepared Safe purchase';
      END IF;
    ELSIF NEW.status <> 'entry_open' THEN
      RAISE EXCEPTION 'Megapot pool drawing does not match live leg and observation';
    END IF;
    IF leg_record.kind <> 'megapot_pool'
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
    NEW.ticket_price_ceiling_atomic, NEW.created_at, NEW.purchase_order
  ) IS DISTINCT FROM ROW(
    OLD.pool_leg_id, OLD.drawing_id, OLD.observation_id, OLD.entry_cutoff_at,
    OLD.ticket_price_ceiling_atomic, OLD.created_at, OLD.purchase_order
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
  IF OLD.purchase_order = 'ticket_first_v1' THEN
    -- The ticket is bought before entries open, so there is no purchase step after
    -- the commitment, and a closed drawing keeps watching its unexecuted call.
    IF NEW.purchase_effect_id IS DISTINCT FROM OLD.purchase_effect_id
       OR NEW.reserved_ticket_cost_atomic <> OLD.reserved_ticket_cost_atomic THEN
      RAISE EXCEPTION 'ticket-first Megapot purchase is fixed when the drawing is created';
    END IF;
    IF NOT (
      (OLD.status = 'ticket_pending' AND NEW.status IN (
        'entry_open', 'closed_purchase_unavailable', 'operational_hold'
      ))
      OR (OLD.status = 'entry_open' AND NEW.status IN ('cutoff_frozen', 'operational_hold'))
      OR (OLD.status = 'cutoff_frozen' AND NEW.status IN ('committed', 'operational_hold'))
      OR (OLD.status = 'committed' AND NEW.status IN ('drawing_pending', 'operational_hold'))
      OR (OLD.status = 'drawing_pending' AND NEW.status IN (
        'no_win', 'winnings_detected', 'operational_hold'
      ))
      OR (OLD.status = 'winnings_detected' AND NEW.status IN ('claim_pending', 'operational_hold'))
      OR (OLD.status = 'claim_pending' AND NEW.status IN ('claimed', 'operational_hold'))
      OR (OLD.status = 'claimed' AND NEW.status IN ('allocated', 'operational_hold'))
      OR (OLD.status = 'allocated' AND NEW.status IN ('credited', 'operational_hold'))
    ) THEN
      RAISE EXCEPTION 'invalid ticket-first Megapot pool drawing transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status='closed_purchase_unavailable' AND NEW.purchase_effect_id IS NOT NULL
    AND OLD.status <> 'purchase_pending' THEN
    RAISE EXCEPTION 'only an unsigned reserved purchase may retain its effect when closed';
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

-- A ticket-first purchase precedes the beneficiary snapshot and commitment.
ALTER TABLE megapot_ticket_purchase_effects
  ALTER COLUMN snapshot_id DROP NOT NULL,
  ALTER COLUMN commitment_effect_id DROP NOT NULL,
  ADD CONSTRAINT megapot_ticket_purchase_commitment_pair CHECK (
    (snapshot_id IS NULL) = (commitment_effect_id IS NULL)
  );

CREATE FUNCTION guard_megapot_purchase_effect_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  leg_order TEXT;
  chain_mode TEXT;
BEGIN
  SELECT purchase_order INTO leg_order FROM song_reward_offer_legs
   WHERE leg_id = NEW.pool_leg_id FOR SHARE;
  SELECT execution_mode INTO chain_mode FROM reward_chain_effects
   WHERE effect_id = NEW.purchase_effect_id FOR SHARE;
  IF (leg_order = 'ticket_first_v1') <> (NEW.snapshot_id IS NULL)
     OR (leg_order = 'ticket_first_v1' AND chain_mode IS DISTINCT FROM 'safe_owner_v1') THEN
    RAISE EXCEPTION 'Megapot purchase order does not match its leg';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_ticket_purchase_effects_order_guard
BEFORE INSERT ON megapot_ticket_purchase_effects
FOR EACH ROW EXECUTE FUNCTION guard_megapot_purchase_effect_order();

-- The owner's Safe cannot sign a beneficiary commitment. A ticket-first commitment is
-- published unsigned and says so, rather than carrying an invented signature.
ALTER TABLE megapot_pool_commitment_effects
  ALTER COLUMN signature DROP NOT NULL,
  DROP CONSTRAINT megapot_pool_commitment_effects_signature_check,
  ADD CONSTRAINT megapot_pool_commitment_effects_signature_check CHECK (
    (signing_key_id = 'unsigned_owner_safe_v1' AND signature IS NULL)
    OR (signing_key_id <> 'unsigned_owner_safe_v1' AND signature IS NOT NULL
      AND btrim(signature) <> '')
  );

CREATE FUNCTION guard_megapot_unsigned_commitment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signing_key_id = 'unsigned_owner_safe_v1' AND NOT EXISTS (
    SELECT 1 FROM megapot_pool_beneficiary_snapshots snapshot
      JOIN song_reward_offer_legs leg ON leg.leg_id = snapshot.pool_leg_id
     WHERE snapshot.snapshot_id = NEW.snapshot_id
       AND leg.purchase_order = 'ticket_first_v1'
  ) THEN
    RAISE EXCEPTION 'only a ticket-first pool may publish an unsigned commitment';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_commitment_effects_unsigned_guard
BEFORE INSERT ON megapot_pool_commitment_effects
FOR EACH ROW EXECUTE FUNCTION guard_megapot_unsigned_commitment();
