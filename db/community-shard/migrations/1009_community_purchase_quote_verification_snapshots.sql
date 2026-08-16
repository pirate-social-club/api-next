CREATE TABLE purchase_quote_verification_snapshots (
    verification_snapshot_ref TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    buyer_user_id TEXT NOT NULL,
    provider TEXT,
    nationality_state TEXT NOT NULL,
    nationality_value TEXT,
    pricing_tier TEXT,
    pricing_policy_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (quote_id) REFERENCES purchase_quotes(quote_id)
);

CREATE INDEX idx_purchase_quote_verification_snapshots_quote
    ON purchase_quote_verification_snapshots(quote_id);
