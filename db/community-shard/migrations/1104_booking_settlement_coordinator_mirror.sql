-- Slice D5 Finding 2 (DO coordinator): the wallet-scoped operator signing coordinator (a Durable
-- Object) owns the authoritative signed transaction + nonce. The community booking_settlement_effects
-- row becomes a booking-scoped MIRROR that points at the coordinator record and reflects its state.
-- coordinator_ref is the coordinator effect identity. coordinator_state mirrors the coordinator
-- outcome (broadcast/confirmed/replaced/failed_onchain) WITHOUT overloading signed_tx (which stays
-- owned by the DO) or the row status (so terminal coordinator failures are never eligible for the
-- failed -> retry path).
ALTER TABLE booking_settlement_effects ADD COLUMN coordinator_ref TEXT;
ALTER TABLE booking_settlement_effects ADD COLUMN coordinator_state TEXT;
