CREATE TABLE IF NOT EXISTS purchase_settlement_attempts (
    attempt_id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL UNIQUE,
    purchase_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    settlement_wallet_attachment_id TEXT NOT NULL,
    settlement_tx_ref TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('attempting', 'finalized', 'failed')
    ),
    failure_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (quote_id) REFERENCES purchase_quotes(quote_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_settlement_attempts_status_updated
    ON purchase_settlement_attempts(status, updated_at ASC);
