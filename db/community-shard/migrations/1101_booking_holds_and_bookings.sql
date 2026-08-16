-- Paid 1:1 video bookings — per-community transaction data (community D1).
--
-- An individual booking is a transaction WITHIN a community: its settlement,
-- access entitlement, and 1:1 video session are all community-scoped, so the rows
-- are co-located with purchases/live_rooms in the per-community DB.
-- Host profile / availability / pricing are host-owned and live in the control
-- plane — see control-plane migration 0120.
--
-- Cross-DB ids (host_user_id, booker_user_id) reference control-plane users and
-- therefore carry NO foreign key — joins are enforced in service code.
-- Money is integer cents, fee is bps (NO REAL). Booking `status` mirrors the
-- @pirate/bookings-domain BookingState FSM exactly. See
-- core/specs/domain/paid-bookings.md.

-- Short-lived slot reservation held while the booker pays (FSM hold/quoted phase).
-- Auto-expires, consumed when a booking row is created from it.
CREATE TABLE booking_holds (
    hold_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    host_user_id TEXT NOT NULL,         -- control-plane user id (no FK, cross-DB)
    booker_user_id TEXT NOT NULL,       -- control-plane user id (no FK, cross-DB)
    slot_start_utc TEXT NOT NULL,       -- RFC3339 UTC
    slot_end_utc TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),   -- every booking is paid
    status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired')),
    expires_at_utc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (slot_end_utc > slot_start_utc),
    CHECK (expires_at_utc > created_at),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

-- Exactly one ACTIVE hold per (host, exact slot start) within a community — stops
-- two bookers reserving the same slot. Arbitrary time-range overlap is enforced in
-- service code (resolveSlots busy intervals), since SQLite/D1 has no EXCLUDE.
CREATE UNIQUE INDEX idx_booking_holds_active_slot
    ON booking_holds(community_id, host_user_id, slot_start_utc)
    WHERE status = 'active';

CREATE INDEX idx_booking_holds_expiry
    ON booking_holds(status, expires_at_utc);

CREATE INDEX idx_booking_holds_booker
    ON booking_holds(community_id, booker_user_id, slot_start_utc);

-- The durable booking lifecycle. Money fields are an integer snapshot taken at
-- confirmation. Custody/settlement refs reuse the PR0 server-verified funding path:
-- funding_tx_ref is the verified on-chain pay-in, payout/refund refs are the
-- operator-controlled custody outflows. quote_id/purchase_id reference the
-- per-community commerce rows (same DB) but are intentionally FK-free to avoid
-- coupling booking creation order to settlement.
CREATE TABLE bookings (
    booking_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    hold_id TEXT,                       -- community-local hold this was created from
    host_user_id TEXT NOT NULL,         -- control-plane user id (no FK, cross-DB)
    booker_user_id TEXT NOT NULL,       -- control-plane user id (no FK, cross-DB)
    slot_start_utc TEXT NOT NULL,
    slot_end_utc TEXT NOT NULL,
    -- money snapshot (integer cents / bps, no REAL)
    gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),   -- every booking is paid
    platform_fee_bps INTEGER NOT NULL CHECK (platform_fee_bps >= 0 AND platform_fee_bps <= 10000),
    platform_fee_cents INTEGER NOT NULL CHECK (platform_fee_cents >= 0),
    host_payout_cents INTEGER NOT NULL CHECK (host_payout_cents >= 0),
    refund_cents INTEGER CHECK (refund_cents IS NULL OR (refund_cents >= 0 AND refund_cents <= gross_cents)),
    -- lifecycle state — mirrors @pirate/bookings-domain BookingState exactly
    status TEXT NOT NULL CHECK (status IN (
        'hold',
        'quoted',
        'pending_payment',
        'confirmed',
        'live',
        'completed',
        'settled',
        'expired_hold',
        'cancelled_before_payment',
        'cancelled_by_host',
        'cancelled_by_booker',
        'no_show_host',
        'no_show_booker',
        'refunded',
        'disputed'
    )),
    -- commerce + custody/settlement refs (server-verified, reuses PR0 funding gate)
    quote_id TEXT,                      -- per-community purchase_quotes.quote_id
    purchase_id TEXT,                   -- per-community purchases.purchase_id once settled
    funding_tx_ref TEXT,                -- verified on-chain pay-in receipt (custody-in)
    payout_tx_ref TEXT,                 -- operator payout to host (custody-out)
    refund_tx_ref TEXT,                 -- operator refund to booker (custody-out)
    -- 1:1 video session, created only on `confirmed`
    live_room_id TEXT,                  -- per-community live_rooms.live_room_id
    confirmed_at TEXT,
    completed_at TEXT,
    settled_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (slot_end_utc > slot_start_utc),
    -- money snapshot must balance: fee + payout == gross (matches @pirate/bookings-domain
    -- computeAllocation, where hostPayout = gross - platformFee)
    CHECK (platform_fee_cents + host_payout_cents = gross_cents),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (hold_id) REFERENCES booking_holds(hold_id)
);

-- One forward/active booking per (host, exact slot start) within a community.
-- Excludes terminal/cancelled states so a released slot can be rebooked.
CREATE UNIQUE INDEX idx_bookings_active_slot
    ON bookings(community_id, host_user_id, slot_start_utc)
    WHERE status IN ('pending_payment', 'confirmed', 'live', 'completed', 'settled');

-- A consumed hold may produce at most one booking row (no fan-out).
CREATE UNIQUE INDEX idx_bookings_hold
    ON bookings(hold_id)
    WHERE hold_id IS NOT NULL;

CREATE INDEX idx_bookings_host
    ON bookings(community_id, host_user_id, slot_start_utc);

CREATE INDEX idx_bookings_booker
    ON bookings(community_id, booker_user_id, slot_start_utc);

CREATE INDEX idx_bookings_status
    ON bookings(community_id, status);
