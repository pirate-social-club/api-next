ALTER TABLE purchase_quotes
    ADD COLUMN allocation_snapshot_json TEXT;

CREATE TABLE purchase_allocation_legs (
    purchase_allocation_leg_id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    recipient_type TEXT NOT NULL CHECK (
        recipient_type IN ('creator', 'charity', 'community_treasury')
    ),
    recipient_ref TEXT,
    waterfall_position INTEGER NOT NULL CHECK (
        waterfall_position >= 0
    ),
    share_bps INTEGER NOT NULL CHECK (
        share_bps >= 0 AND share_bps <= 10000
    ),
    amount_usd REAL NOT NULL CHECK (
        amount_usd >= 0
    ),
    settlement_strategy TEXT NOT NULL CHECK (
        settlement_strategy IN ('story_payout', 'provider_payout', 'treasury_payout')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('quoted', 'pending', 'confirmed', 'failed')
    ),
    settlement_ref TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (purchase_id) REFERENCES purchases(purchase_id),
    FOREIGN KEY (quote_id) REFERENCES purchase_quotes(quote_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_purchase_allocation_legs_purchase
    ON purchase_allocation_legs(purchase_id, waterfall_position ASC, created_at ASC);
