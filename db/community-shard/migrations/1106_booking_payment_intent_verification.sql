-- Confirmation reservation/CAS state machine: extend booking_payment_intents with the verifying and
-- verification_failed states and the reservation fields so a confirmation can atomically claim an
-- intent for chain verification WITHOUT holding a DB transaction across the RPC. A crash mid-verify
-- is recoverable by claim expiry, and a successful on-chain payment is resumable without re-paying.
-- SQLite cannot alter a CHECK constraint in place, so the table is recreated (it is not yet deployed,
-- so the copy is a safe no-op in practice). claimed_tx_ref subsumes the old consumed_tx_ref and is the
-- single normalized funding hash claimed by an intent (reserved at verifying, kept at consumed) with a
-- UNIQUE index for reused-transaction protection across intents.
ALTER TABLE booking_payment_intents RENAME TO booking_payment_intents_v1;

CREATE TABLE booking_payment_intents (
    payment_intent_id TEXT PRIMARY KEY,
    hold_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    token_address TEXT NOT NULL,
    token_decimals INTEGER NOT NULL CHECK (token_decimals >= 0 AND token_decimals <= 36),
    token_symbol TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    amount_atomic TEXT NOT NULL CHECK (length(amount_atomic) >= 1 AND amount_atomic NOT GLOB '*[^0-9]*'),
    gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),
    quote_expires_at TEXT NOT NULL,
    hold_expires_at TEXT NOT NULL,
    wallet_attachment_required INTEGER NOT NULL DEFAULT 1 CHECK (wallet_attachment_required IN (0, 1)),
    -- States: active (quoted) -> verifying (claimed, RPC in flight) -> verified (durable, evidence
    -- recorded, ready to finalize) -> consumed (booking created + hold consumed). verification_failed
    -- is a retryable transient/pending outcome that keeps the claimed hash. verification_rejected is
    -- a terminal definitive mismatch (a new payment requires a superseded/new intent). The verified
    -- state lets a crash after the RPC resume finalization WITHOUT another RPC or payment.
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'verifying', 'verified', 'verification_failed', 'verification_rejected', 'consumed', 'expired', 'superseded')),
    -- verification reservation (CAS): a single confirmation claims the intent before chain RPC.
    -- Claim token + expiry are cleared once the intent reaches verified (finalization no longer needs them).
    verification_claim_token TEXT,
    verification_claim_expires_at TEXT,
    claimed_tx_ref TEXT,
    -- durable verification evidence recorded at the verifying -> verified transition, so finalization
    -- needs no further RPC: the verified on-chain sender (= booking refund destination) and timestamp.
    verified_sender_address TEXT,
    verified_at TEXT,
    consumed_wallet_attachment_id TEXT,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (hold_id) REFERENCES booking_holds (hold_id)
);

INSERT INTO booking_payment_intents (
    payment_intent_id, hold_id, version, chain_id, token_address, token_decimals, token_symbol,
    recipient_address, amount_atomic, gross_cents, quote_expires_at, hold_expires_at,
    wallet_attachment_required, status, claimed_tx_ref, consumed_wallet_attachment_id, consumed_at,
    created_at, updated_at
)
SELECT
    payment_intent_id, hold_id, version, chain_id, token_address, token_decimals, token_symbol,
    recipient_address, amount_atomic, gross_cents, quote_expires_at, hold_expires_at,
    wallet_attachment_required, status, consumed_tx_ref, consumed_wallet_attachment_id, consumed_at,
    created_at, updated_at
FROM booking_payment_intents_v1;

DROP TABLE booking_payment_intents_v1;

CREATE UNIQUE INDEX idx_booking_payment_intents_hold ON booking_payment_intents (hold_id);
CREATE UNIQUE INDEX idx_booking_payment_intents_claimed_tx ON booking_payment_intents (claimed_tx_ref);
