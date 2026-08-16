-- Snapshot the fee allocation durably on the payment intent so finalization persists the exact
-- allocation the booker accepted at quote time, never recomputed from the mutable host platform_fee_bps
-- after payment. A profile fee change between quote and confirmation can no longer alter the booking.
-- Additive nullable columns (ADD COLUMN, no recreation). Populated at intent creation (quote time).
ALTER TABLE booking_payment_intents ADD COLUMN platform_fee_bps INTEGER;
ALTER TABLE booking_payment_intents ADD COLUMN platform_fee_cents INTEGER;
ALTER TABLE booking_payment_intents ADD COLUMN host_payout_cents INTEGER;
