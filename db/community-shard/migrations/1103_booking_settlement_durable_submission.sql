-- Slice D5 Finding 2: durable submission for booking settlement effects.
-- The operator signs the USDC transfer and persists the raw signed transaction (and its nonce)
-- BEFORE broadcasting. A crash in the broadcast window is then recoverable: a retry re-broadcasts
-- the identical signed tx, which is idempotent by nonce (the network mines at most one), so money
-- is never moved twice and the ledger is never permanently stuck without a reference.
ALTER TABLE booking_settlement_effects ADD COLUMN signed_tx TEXT;
ALTER TABLE booking_settlement_effects ADD COLUMN broadcast_nonce INTEGER;
