CREATE TABLE purchase_quotes (
    quote_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    buyer_user_id TEXT NOT NULL,
    asset_id TEXT,
    live_room_id TEXT,
    base_price_usd REAL NOT NULL CHECK (
        base_price_usd >= 0
    ),
    pricing_tier TEXT,
    final_price_usd REAL NOT NULL CHECK (
        final_price_usd >= 0
    ),
    funding_mode TEXT NOT NULL CHECK (
        funding_mode IN ('direct', 'routed')
    ),
    funding_asset_json TEXT,
    source_chain_json TEXT,
    route_provider TEXT,
    route_policy_compliant INTEGER NOT NULL CHECK (
        route_policy_compliant IN (0, 1)
    ),
    route_live_available INTEGER CHECK (
        route_live_available IN (0, 1)
    ),
    policy_origin TEXT NOT NULL CHECK (
        policy_origin IN ('default', 'explicit')
    ),
    destination_settlement_chain_json TEXT NOT NULL,
    destination_settlement_token TEXT NOT NULL,
    treasury_denomination TEXT,
    quote_ttl_seconds INTEGER NOT NULL CHECK (
        quote_ttl_seconds > 0
    ),
    route_required INTEGER NOT NULL CHECK (
        route_required IN (0, 1)
    ),
    route_status_policy TEXT NOT NULL CHECK (
        route_status_policy IN ('fail', 'fallback_display', 'queue')
    ),
    route_hop_tolerance INTEGER NOT NULL CHECK (
        route_hop_tolerance >= 0
    ),
    verification_snapshot_ref TEXT,
    pricing_policy_version TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'expired', 'consumed', 'failed')
    ),
    quoted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    failed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (listing_id) REFERENCES listings(listing_id),
    CHECK (
        (asset_id IS NOT NULL AND live_room_id IS NULL) OR
        (asset_id IS NULL AND live_room_id IS NOT NULL)
    )
);

CREATE INDEX idx_purchase_quotes_buyer_status
    ON purchase_quotes(buyer_user_id, status, expires_at DESC);

CREATE INDEX idx_purchase_quotes_listing_status
    ON purchase_quotes(listing_id, status, expires_at DESC);

CREATE INDEX idx_purchase_quotes_community_status
    ON purchase_quotes(community_id, status, expires_at DESC);

CREATE INDEX idx_purchase_quotes_status_expires
    ON purchase_quotes(status, expires_at DESC);
