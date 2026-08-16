ALTER TABLE purchase_quotes
    ADD COLUMN destination_settlement_amount_atomic TEXT;

ALTER TABLE purchase_quotes
    ADD COLUMN destination_settlement_decimals INTEGER;
