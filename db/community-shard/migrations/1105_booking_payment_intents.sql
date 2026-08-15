-- Slice C payment hardening: a durable, immutable PAYMENT INTENT snapshotted at quote time so
-- confirmation validates the submitted transaction against what was quoted (chain/token/recipient/
-- amount), never mutable runtime config or client-provided fields. recipient_address is the custody
-- DEPOSIT (pay-in) address only -- never an operator key, signed transaction, or payout destination.
-- Addresses and transaction hashes are normalized (checksum/case) in application code. Timestamps are
-- ISO8601 UTC strings (the project canonical format).
CREATE TABLE booking_payment_intents (
    payment_intent_id TEXT PRIMARY KEY,                         -- deterministic bpi:<hold_id>
    hold_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    token_address TEXT NOT NULL,
    token_decimals INTEGER NOT NULL CHECK (token_decimals >= 0 AND token_decimals <= 36),
    token_symbol TEXT NOT NULL,
    recipient_address TEXT NOT NULL,                            -- custody deposit address only
    -- amount_atomic is a decimal-digit string: non-empty, non-negative, non-fractional, non-decimal.
    amount_atomic TEXT NOT NULL CHECK (length(amount_atomic) >= 1 AND amount_atomic NOT GLOB '*[^0-9]*'),
    gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),
    quote_expires_at TEXT NOT NULL,
    hold_expires_at TEXT NOT NULL,
    wallet_attachment_required INTEGER NOT NULL DEFAULT 1 CHECK (wallet_attachment_required IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'expired', 'superseded')),
    -- consumption audit: which transaction + wallet attachment consumed it, and when
    consumed_tx_ref TEXT,
    consumed_wallet_attachment_id TEXT,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (hold_id) REFERENCES booking_holds (hold_id)
);

-- Exactly one intent per hold. The deterministic PK already implies it plus an explicit unique guard.
CREATE UNIQUE INDEX idx_booking_payment_intents_hold
    ON booking_payment_intents (hold_id);

-- Reused-transaction protection: a funding transaction may consume AT MOST ONE intent. SQLite treats
-- NULLs as distinct in a unique index, so the many unconsumed (NULL) rows coexist while every
-- non-null consuming hash is unique.
CREATE UNIQUE INDEX idx_booking_payment_intents_consumed_tx
    ON booking_payment_intents (consumed_tx_ref);
