CREATE TABLE IF NOT EXISTS community_handles (
    community_handle_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'grace_period', 'expired', 'revoked', 'reserved')
    ),
    issuance_source TEXT NOT NULL CHECK (
        issuance_source IN ('claim', 'auction', 'admin_grant')
    ),
    lease_started_at TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);

ALTER TABLE community_handles ADD COLUMN handle_claim_quote_id TEXT;
ALTER TABLE community_handles ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0);
ALTER TABLE community_handles ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE community_handles ADD COLUMN pricing_model TEXT CHECK (
    pricing_model IS NULL OR pricing_model IN ('free', 'flat_by_length', 'custom_curve', 'gated_then_flat')
);
ALTER TABLE community_handles ADD COLUMN pricing_tier TEXT;
ALTER TABLE community_handles ADD COLUMN settlement_wallet_attachment_id TEXT;
ALTER TABLE community_handles ADD COLUMN funding_tx_ref TEXT;
ALTER TABLE community_handles ADD COLUMN settlement_tx_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_community_handles_active_namespace_label
    ON community_handles(namespace_id, label_normalized)
    WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_community_handles_active_user_namespace
    ON community_handles(namespace_id, user_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_community_handles_user_status
    ON community_handles(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS community_handle_claim_quotes (
    handle_claim_quote_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('quoted', 'claimed', 'expired', 'failed')
    ),
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    pricing_model TEXT CHECK (
        pricing_model IS NULL OR pricing_model IN ('free', 'flat_by_length', 'custom_curve', 'gated_then_flat')
    ),
    pricing_tier TEXT,
    quote_ttl_seconds INTEGER NOT NULL CHECK (quote_ttl_seconds > 0),
    quoted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    claimed_at TEXT,
    settings_snapshot_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);

CREATE INDEX IF NOT EXISTS idx_community_handle_claim_quotes_user_status
    ON community_handle_claim_quotes(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_handle_claim_quotes_namespace_label
    ON community_handle_claim_quotes(namespace_id, label_normalized, status);
