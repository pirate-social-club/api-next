-- Slice D1 data contract: durable money-OUT ledger, refund/payout destination snapshots, and
-- identity-bound attendance for paid bookings.

-- Durable operator custody ledger for booking payouts/refunds. Booking-shaped on purpose: the
-- commerce purchase_settlement_effects table requires non-null quote_id/purchase_id with a FK to
-- purchase_quotes, and bookings never create those rows. idempotency_key is the dedup handle the
-- adapter keys on (booking_refund:ID / booking_payout:ID) so a retry never double-sends.
CREATE TABLE booking_settlement_effects (
    booking_settlement_effect_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    effect_kind TEXT NOT NULL CHECK (effect_kind IN ('booking_payout', 'booking_refund')),
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    recipient_address TEXT NOT NULL,
    settlement_ref TEXT,                 -- on-chain tx hash once confirmed
    failure_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    submitted_at TEXT,
    confirmed_at TEXT,
    failed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (booking_id) REFERENCES bookings(booking_id)
);

CREATE UNIQUE INDEX idx_booking_settlement_effects_idempotency
    ON booking_settlement_effects(idempotency_key);

CREATE INDEX idx_booking_settlement_effects_booking
    ON booking_settlement_effects(booking_id, status);

-- Durable destination snapshots captured at confirm. Refund goes back to the address that actually
-- paid (verified on-chain sender). Host payout goes to the profile payout wallet snapshotted here.
-- Neither is re-resolved later, so changing a wallet after payment cannot redirect funds.
ALTER TABLE bookings ADD COLUMN funding_wallet_address TEXT;
ALTER TABLE bookings ADD COLUMN host_payout_wallet_address TEXT;

-- Identity-bound attendance for the booking 1:1 session. Each attach (or reconnect after a stale
-- gap) is a session row. Heartbeats extend last_seen_at. The evaluator derives host/booker OVERLAP
-- from these intervals -- not from a single attach timestamp -- so it can prove a real shared call.
CREATE TABLE booking_attendance_sessions (
    session_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    party TEXT NOT NULL CHECK (party IN ('host', 'booker')),
    user_id TEXT NOT NULL,
    agora_uid INTEGER,
    attached_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (booking_id) REFERENCES bookings(booking_id)
);

CREATE INDEX idx_booking_attendance_sessions_booking
    ON booking_attendance_sessions(booking_id, party);

-- Optional fine-grained liveness samples (one row per heartbeat) for audit and gap-aware overlap.
CREATE TABLE booking_attendance_heartbeats (
    heartbeat_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES booking_attendance_sessions(session_id)
);

CREATE INDEX idx_booking_attendance_heartbeats_session
    ON booking_attendance_heartbeats(session_id, seen_at);
