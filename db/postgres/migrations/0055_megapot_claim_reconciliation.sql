-- Persist Megapot custody-integrity failures instead of retrying them forever.

ALTER TABLE reward_chain_effects
  DROP CONSTRAINT reward_chain_effect_prepared_shape,
  ADD CONSTRAINT reward_chain_effect_prepared_shape CHECK (
    (state = 'planned' AND nonce IS NULL AND calldata IS NULL AND calldata_hash IS NULL
      AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
      AND transaction_hash IS NULL AND prepared_at IS NULL)
    OR (state = 'nonce_reserved' AND nonce IS NOT NULL AND calldata IS NULL
      AND calldata_hash IS NULL AND signed_transaction IS NULL
      AND signed_transaction_hash IS NULL AND transaction_hash IS NULL
      AND prepared_at IS NULL)
    OR (state IN ('prepared', 'broadcast_pending', 'confirming', 'confirmed', 'reverted',
        'replaced', 'reconciliation_required')
      AND nonce IS NOT NULL AND calldata ~ '^0x([0-9a-f]{2})*$'
      AND calldata_hash ~ '^[0-9a-f]{64}$'
      AND signed_transaction ~ '^0x([0-9a-f]{2})+$'
      AND signed_transaction_hash ~ '^0x[0-9a-f]{64}$'
      AND prepared_at IS NOT NULL)
    OR (state IN ('reclaimable_failed', 'terminal_failed')
      AND ((nonce IS NULL AND calldata IS NULL AND calldata_hash IS NULL
          AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
          AND prepared_at IS NULL)
        OR (nonce IS NOT NULL AND calldata IS NULL AND calldata_hash IS NULL
          AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
          AND prepared_at IS NULL)
        OR (nonce IS NOT NULL AND calldata ~ '^0x([0-9a-f]{2})*$'
          AND calldata_hash ~ '^[0-9a-f]{64}$'
          AND signed_transaction ~ '^0x([0-9a-f]{2})+$'
          AND signed_transaction_hash ~ '^0x[0-9a-f]{64}$'
          AND prepared_at IS NOT NULL)))
  );

ALTER TABLE megapot_ticket_inventory
  DROP CONSTRAINT megapot_ticket_inventory_status_check,
  DROP CONSTRAINT megapot_ticket_inventory_terminal_shape;

ALTER TABLE megapot_ticket_inventory
  ADD CONSTRAINT megapot_ticket_inventory_status_check CHECK (
    status IN ('custodied', 'claim_pending', 'claimed', 'no_win', 'needs_review')
  ),
  ADD CONSTRAINT megapot_ticket_inventory_terminal_shape CHECK (
    (status IN ('custodied', 'claim_pending')
      AND claimed_transaction_hash IS NULL AND terminal_at IS NULL)
    OR (status = 'claimed' AND claimed_transaction_hash IS NOT NULL AND terminal_at IS NOT NULL)
    OR (status IN ('no_win', 'needs_review')
      AND claimed_transaction_hash IS NULL AND terminal_at IS NOT NULL)
  );

CREATE TABLE megapot_ticket_review_evidence (
  review_id TEXT PRIMARY KEY CHECK (
    btrim(review_id) <> '' AND review_id = btrim(review_id)
    AND octet_length(review_id) <= 128
  ),
  attestation_id TEXT NOT NULL,
  ticket_id NUMERIC(78, 0) NOT NULL,
  pool_leg_id TEXT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL CHECK (drawing_id >= 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('sweep', 'claim')),
  source_operation_id TEXT NOT NULL CHECK (
    btrim(source_operation_id) <> '' AND source_operation_id = btrim(source_operation_id)
    AND octet_length(source_operation_id) <= 128
  ),
  claim_effect_id TEXT REFERENCES reward_chain_effects (effect_id),
  reason TEXT NOT NULL CHECK (reason IN ('ticket_owner_mismatch', 'no_tickets_to_claim')),
  observation_block_number BIGINT NOT NULL CHECK (observation_block_number >= 0),
  observation_block_hash TEXT NOT NULL CHECK (
    observation_block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  observed_owner_address TEXT NOT NULL CHECK (
    observed_owner_address ~ '^0x[0-9a-f]{40}$'
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attestation_id, ticket_id),
  FOREIGN KEY (attestation_id, ticket_id)
    REFERENCES megapot_ticket_inventory (attestation_id, ticket_id),
  FOREIGN KEY (pool_leg_id, drawing_id)
    REFERENCES megapot_pool_drawings (pool_leg_id, drawing_id),
  CONSTRAINT megapot_ticket_review_source_shape CHECK (
    (source_kind = 'sweep' AND reason = 'ticket_owner_mismatch' AND claim_effect_id IS NULL)
    OR source_kind = 'claim'
  )
);

CREATE FUNCTION guard_megapot_ticket_review_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ticket_record megapot_ticket_inventory%ROWTYPE;
  drawing_record megapot_pool_drawings%ROWTYPE;
  claim_record megapot_claim_effects%ROWTYPE;
  chain_record reward_chain_effects%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Megapot ticket review evidence is append-only';
  END IF;
  SELECT * INTO ticket_record FROM megapot_ticket_inventory
   WHERE attestation_id=NEW.attestation_id AND ticket_id=NEW.ticket_id FOR SHARE;
  SELECT * INTO drawing_record FROM megapot_pool_drawings
   WHERE pool_leg_id=NEW.pool_leg_id AND drawing_id=NEW.drawing_id FOR SHARE;
  IF ticket_record.attestation_id IS NULL
     OR ticket_record.pool_leg_id <> NEW.pool_leg_id
     OR ticket_record.drawing_id <> NEW.drawing_id
     OR ticket_record.status <> 'needs_review'
     OR drawing_record.status <> 'operational_hold'
     OR drawing_record.terminal_reason <> NEW.reason THEN
    RAISE EXCEPTION 'Megapot ticket review evidence identity mismatch';
  END IF;
  IF NEW.claim_effect_id IS NOT NULL THEN
    SELECT * INTO claim_record FROM megapot_claim_effects
     WHERE claim_effect_id=NEW.claim_effect_id FOR SHARE;
    SELECT * INTO chain_record FROM reward_chain_effects
     WHERE effect_id=NEW.claim_effect_id FOR SHARE;
    IF claim_record.claim_effect_id IS NULL
       OR claim_record.attestation_id <> NEW.attestation_id
       OR claim_record.ticket_id <> NEW.ticket_id
       OR claim_record.pool_leg_id <> NEW.pool_leg_id
       OR claim_record.drawing_id <> NEW.drawing_id
       OR chain_record.state <> 'terminal_failed' THEN
      RAISE EXCEPTION 'Megapot ticket review claim evidence mismatch';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_ticket_review_evidence_append_only
BEFORE INSERT OR UPDATE OR DELETE ON megapot_ticket_review_evidence
FOR EACH ROW EXECUTE FUNCTION guard_megapot_ticket_review_evidence();

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
