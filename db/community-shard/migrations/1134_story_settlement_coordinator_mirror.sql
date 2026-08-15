-- The wallet-scoped Story settlement coordinator is authoritative for nonce,
-- signed transaction, receipt, and finality state. Community shard rows are a
-- monotonic business-level mirror and deliberately never store signed bytes.
ALTER TABLE purchase_settlement_effects
  ADD COLUMN request_fingerprint TEXT;

ALTER TABLE purchase_settlement_effects
  ADD COLUMN coordinator_plan_ref TEXT;

ALTER TABLE purchase_settlement_effects
  ADD COLUMN coordinator_state TEXT;

ALTER TABLE purchase_settlement_effects
  ADD COLUMN coordinator_version INTEGER CHECK (
    coordinator_version IS NULL OR coordinator_version >= 0
  );

ALTER TABLE purchase_settlement_effects
  ADD COLUMN reconciliation_reason TEXT;

ALTER TABLE purchase_settlement_effects
  ADD COLUMN last_reconciled_at TEXT;

ALTER TABLE purchase_settlement_effects
  ADD COLUMN finality_confirmed_at TEXT;

CREATE TABLE purchase_settlement_transactions (
  purchase_settlement_transaction_id TEXT PRIMARY KEY,
  purchase_settlement_effect_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  step_kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  call_identity_hash TEXT NOT NULL,
  coordinator_step_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  chain_id INTEGER CHECK (chain_id IS NULL OR chain_id > 0),
  signer_address TEXT,
  nonce INTEGER CHECK (nonce IS NULL OR nonce >= 0),
  tx_hash TEXT,
  block_number INTEGER CHECK (block_number IS NULL OR block_number >= 0),
  block_hash TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  prepared_at TEXT,
  broadcast_at TEXT,
  mined_at TEXT,
  confirmed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (purchase_settlement_effect_id)
    REFERENCES purchase_settlement_effects(purchase_settlement_effect_id)
);

CREATE UNIQUE INDEX idx_purchase_settlement_transactions_effect_step
  ON purchase_settlement_transactions(purchase_settlement_effect_id, step_key);

CREATE UNIQUE INDEX idx_purchase_settlement_transactions_coordinator_step
  ON purchase_settlement_transactions(coordinator_step_ref);

CREATE UNIQUE INDEX idx_purchase_settlement_transactions_signer_nonce
  ON purchase_settlement_transactions(chain_id, signer_address, nonce)
  WHERE chain_id IS NOT NULL
    AND signer_address IS NOT NULL
    AND nonce IS NOT NULL;
