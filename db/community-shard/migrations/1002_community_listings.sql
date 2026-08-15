CREATE TABLE listings (
    listing_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    asset_id TEXT,
    live_room_id TEXT,
    listing_mode TEXT NOT NULL CHECK (
        listing_mode IN ('fixed_price')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'active', 'paused', 'archived')
    ),
    price_usd REAL NOT NULL CHECK (
        price_usd >= 0
    ),
    regional_pricing_policy_json TEXT,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    CHECK (
        (asset_id IS NOT NULL AND live_room_id IS NULL) OR
        (asset_id IS NULL AND live_room_id IS NOT NULL)
    )
);

CREATE INDEX idx_listings_community_status
    ON listings(community_id, status, created_at DESC);

CREATE INDEX idx_listings_asset
    ON listings(asset_id)
    WHERE asset_id IS NOT NULL;

CREATE INDEX idx_listings_live_room
    ON listings(live_room_id)
    WHERE live_room_id IS NOT NULL;
