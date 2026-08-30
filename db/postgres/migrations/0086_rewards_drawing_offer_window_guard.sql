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
