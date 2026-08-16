ALTER TABLE purchase_allocation_legs
    ADD COLUMN provider_receipt_ref TEXT;

ALTER TABLE purchase_allocation_legs
    ADD COLUMN tax_receipt_ref TEXT;

ALTER TABLE purchase_allocation_legs
    ADD COLUMN submitted_at TEXT;

ALTER TABLE purchase_allocation_legs
    ADD COLUMN confirmed_at TEXT;

ALTER TABLE purchase_allocation_legs
    ADD COLUMN failed_at TEXT;

ALTER TABLE purchase_allocation_legs
    ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE donation_partners
    ADD COLUMN payout_destination_ref TEXT;
