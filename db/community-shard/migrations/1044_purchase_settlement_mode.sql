ALTER TABLE purchase_quotes
    ADD COLUMN settlement_mode TEXT NOT NULL DEFAULT 'delivery_only_story_settlement' CHECK (
        settlement_mode IN ('delivery_only_story_settlement', 'royalty_native_story_payment')
    );

ALTER TABLE purchases
    ADD COLUMN settlement_mode TEXT NOT NULL DEFAULT 'delivery_only_story_settlement' CHECK (
        settlement_mode IN ('delivery_only_story_settlement', 'royalty_native_story_payment')
    );
