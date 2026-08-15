-- A verified buyer payment freezes quote expiry while downstream settlement
-- completes. Effect disposition is deliberately nullable so legacy rows fail
-- closed: only an explicit failed_prebroadcast value may be auto-retried.
ALTER TABLE purchase_quotes
  ADD COLUMN funding_locked_at TEXT;

ALTER TABLE purchase_settlement_effects
  ADD COLUMN failure_disposition TEXT CHECK (
    failure_disposition IS NULL OR
    failure_disposition IN ('failed_prebroadcast', 'reconciliation_required')
  );

ALTER TABLE purchase_settlement_effects
  ADD COLUMN broadcast_tx_ref TEXT;

CREATE INDEX idx_purchase_settlement_effects_parent_recovery
  ON purchase_settlement_effects(status, failure_disposition, updated_at)
  WHERE effect_kind = 'story_parent_royalty_vault_transfer'
    AND status IN ('submitted', 'failed');
