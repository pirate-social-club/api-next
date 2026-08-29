ALTER TABLE megapot_pool_drawings
  DROP CONSTRAINT megapot_pool_drawings_status_check,
  ADD CONSTRAINT megapot_pool_drawings_status_check CHECK (status IN (
    'entry_open', 'cutoff_frozen', 'committed', 'purchase_pending',
    'tickets_confirmed', 'drawing_pending', 'no_win', 'winnings_detected',
    'claim_pending', 'claimed', 'allocated', 'credited', 'closed_no_entries',
    'closed_unfunded', 'closed_fallback_ineligible',
    'closed_fallback_unavailable', 'closed_fallback_ceiling',
    'closed_purchase_unavailable', 'operational_hold'
  )),
  DROP CONSTRAINT megapot_pool_drawing_purchase_amount_shape,
  ADD CONSTRAINT megapot_pool_drawing_purchase_amount_shape CHECK (
    status = 'operational_hold'
    OR (status IN ('entry_open', 'closed_no_entries', 'closed_unfunded',
        'closed_fallback_ineligible', 'closed_fallback_unavailable',
        'closed_fallback_ceiling')
      AND reserved_ticket_cost_atomic = 0 AND actual_ticket_cost_atomic = 0)
    OR (status IN (
        'cutoff_frozen', 'committed', 'purchase_pending', 'closed_purchase_unavailable'
      ) AND reserved_ticket_cost_atomic > 0 AND actual_ticket_cost_atomic = 0)
    OR (status IN ('tickets_confirmed', 'drawing_pending', 'no_win',
        'winnings_detected', 'claim_pending', 'claimed', 'allocated', 'credited')
      AND reserved_ticket_cost_atomic > 0 AND actual_ticket_cost_atomic > 0)
  ),
  DROP CONSTRAINT megapot_pool_drawing_snapshot_shape,
  ADD CONSTRAINT megapot_pool_drawing_snapshot_shape CHECK (
    status = 'operational_hold'
    OR (status IN ('entry_open', 'closed_no_entries', 'closed_unfunded',
        'closed_fallback_ineligible', 'closed_fallback_unavailable',
        'closed_fallback_ceiling') AND snapshot_id IS NULL)
    OR (status IN ('cutoff_frozen', 'committed', 'purchase_pending',
        'tickets_confirmed', 'drawing_pending', 'no_win', 'winnings_detected',
        'claim_pending', 'claimed', 'allocated', 'credited',
        'closed_purchase_unavailable') AND snapshot_id IS NOT NULL)
  ),
  DROP CONSTRAINT megapot_pool_drawing_effect_shape,
  ADD CONSTRAINT megapot_pool_drawing_effect_shape CHECK (
    status = 'operational_hold'
    OR (status IN ('entry_open', 'cutoff_frozen', 'closed_no_entries', 'closed_unfunded',
        'closed_fallback_ineligible', 'closed_fallback_unavailable',
        'closed_fallback_ceiling') AND commitment_effect_id IS NULL
      AND purchase_effect_id IS NULL AND claim_effect_id IS NULL
      AND allocation_batch_id IS NULL)
    OR (status IN ('committed', 'closed_purchase_unavailable')
      AND commitment_effect_id IS NOT NULL AND purchase_effect_id IS NULL
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
  ),
  DROP CONSTRAINT megapot_pool_drawing_terminal_shape,
  ADD CONSTRAINT megapot_pool_drawing_terminal_shape CHECK (
    (status IN ('no_win', 'credited', 'closed_no_entries', 'closed_unfunded',
      'closed_fallback_ineligible', 'closed_fallback_unavailable',
      'closed_fallback_ceiling', 'closed_purchase_unavailable', 'operational_hold')
      AND terminal_at IS NOT NULL)
    OR (status NOT IN ('no_win', 'credited', 'closed_no_entries', 'closed_unfunded',
      'closed_fallback_ineligible', 'closed_fallback_unavailable',
      'closed_fallback_ceiling', 'closed_purchase_unavailable', 'operational_hold')
      AND terminal_at IS NULL)
  );

CREATE OR REPLACE FUNCTION guard_megapot_pool_drawing() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  leg_record song_reward_offer_legs%ROWTYPE;
  observation_record megapot_drawing_observations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Megapot pool drawings cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO leg_record FROM song_reward_offer_legs
     WHERE leg_id = NEW.pool_leg_id FOR SHARE;
    SELECT * INTO observation_record FROM megapot_drawing_observations
     WHERE observation_id = NEW.observation_id FOR SHARE;
    IF NEW.status <> 'entry_open' OR leg_record.kind <> 'megapot_pool'
       OR leg_record.status <> 'active'
       OR NEW.drawing_id < leg_record.participation_starts_drawing_id
       OR observation_record.observation_id IS NULL
       OR observation_record.attestation_id <> leg_record.attestation_id
       OR observation_record.drawing_id <> NEW.drawing_id
       OR observation_record.drawing_locked
       OR observation_record.expires_at <= clock_timestamp()
       OR NEW.entry_cutoff_at <> observation_record.drawing_time
            - make_interval(secs => leg_record.entry_cutoff_seconds)
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
    OR (OLD.status = 'purchase_pending' AND NEW.status IN ('tickets_confirmed', 'operational_hold'))
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
