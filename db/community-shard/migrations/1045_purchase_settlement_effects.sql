CREATE TABLE purchase_settlement_effects (
    purchase_settlement_effect_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    purchase_id TEXT NOT NULL,
    effect_kind TEXT NOT NULL CHECK (
        effect_kind IN ('buyer_funding_receipt', 'charity_payout', 'story_royalty_payment', 'story_entitlement_mint')
    ),
    effect_key TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('submitted', 'confirmed', 'failed')
    ),
    settlement_ref TEXT,
    provider_receipt_ref TEXT,
    tax_receipt_ref TEXT,
    metadata_json TEXT,
    failure_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    submitted_at TEXT,
    confirmed_at TEXT,
    failed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (quote_id) REFERENCES purchase_quotes(quote_id)
);

CREATE UNIQUE INDEX idx_purchase_settlement_effects_idempotency
    ON purchase_settlement_effects(idempotency_key);

CREATE UNIQUE INDEX idx_purchase_settlement_effects_quote_kind_key
    ON purchase_settlement_effects(community_id, quote_id, effect_kind, effect_key);

CREATE INDEX idx_purchase_settlement_effects_purchase
    ON purchase_settlement_effects(purchase_id, effect_kind, status);
