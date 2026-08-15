-- Durable operator review state for attendance-ambiguous booking settlement.
--
-- The unattended evaluator moves ambiguous paid bookings to status='disputed' with a pending
-- settlement review. Operator resolution CASes on settlement_review_version, records attribution,
-- then transitions to one of the existing unfinished settlement intent states for canonical
-- idempotency-keyed payout/refund reconciliation.

ALTER TABLE bookings ADD COLUMN settlement_review_status TEXT
    CHECK (settlement_review_status IS NULL OR settlement_review_status IN ('pending', 'resolved'));
ALTER TABLE bookings ADD COLUMN settlement_review_reason TEXT
    CHECK (settlement_review_reason IS NULL OR settlement_review_reason IN ('attendance_ambiguous'));
ALTER TABLE bookings ADD COLUMN settlement_review_resolution TEXT
    CHECK (settlement_review_resolution IS NULL OR settlement_review_resolution IN ('completed', 'no_show_host', 'no_show_booker'));
ALTER TABLE bookings ADD COLUMN settlement_review_opened_at TEXT;
ALTER TABLE bookings ADD COLUMN settlement_review_resolved_at TEXT;
ALTER TABLE bookings ADD COLUMN settlement_review_operator_credential_id TEXT;
ALTER TABLE bookings ADD COLUMN settlement_review_operator_actor_id TEXT;
ALTER TABLE bookings ADD COLUMN settlement_review_note TEXT;
ALTER TABLE bookings ADD COLUMN settlement_review_version INTEGER NOT NULL DEFAULT 0
    CHECK (settlement_review_version >= 0);

CREATE INDEX idx_bookings_settlement_review_pending
    ON bookings(community_id, settlement_review_status, updated_at)
    WHERE settlement_review_status = 'pending';
