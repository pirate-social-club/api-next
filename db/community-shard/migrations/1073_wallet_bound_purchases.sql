PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

ALTER TABLE purchase_quotes RENAME TO purchase_quotes_old;

CREATE TABLE purchase_quotes (
    quote_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    buyer_kind TEXT NOT NULL DEFAULT 'user' CHECK (
        buyer_kind IN ('user', 'wallet')
    ),
    buyer_user_id TEXT,
    buyer_wallet_address TEXT,
    buyer_wallet_address_normalized TEXT,
    buyer_chain_ref TEXT,
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
    allocation_snapshot_json TEXT,
    destination_settlement_amount_atomic TEXT,
    destination_settlement_decimals INTEGER,
    settlement_mode TEXT NOT NULL DEFAULT 'delivery_only_story_settlement' CHECK (
        settlement_mode IN ('delivery_only_story_settlement', 'royalty_native_story_payment')
    ),
    funding_destination_address TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (listing_id) REFERENCES listings(listing_id),
    CHECK (
        buyer_user_id IS NOT NULL OR buyer_wallet_address_normalized IS NOT NULL
    ),
    CHECK (
        (buyer_kind = 'user' AND buyer_user_id IS NOT NULL AND buyer_wallet_address_normalized IS NULL) OR
        (buyer_kind = 'wallet' AND buyer_user_id IS NULL AND buyer_wallet_address_normalized IS NOT NULL)
    ),
    CHECK (
        (asset_id IS NOT NULL AND live_room_id IS NULL) OR
        (asset_id IS NULL AND live_room_id IS NOT NULL)
    )
);

INSERT INTO purchase_quotes (
    quote_id, community_id, listing_id, buyer_kind, buyer_user_id,
    asset_id, live_room_id, base_price_usd, pricing_tier, final_price_usd,
    funding_mode, funding_asset_json, source_chain_json, route_provider,
    route_policy_compliant, route_live_available, policy_origin,
    destination_settlement_chain_json, destination_settlement_token, treasury_denomination,
    quote_ttl_seconds, route_required, route_status_policy, route_hop_tolerance,
    verification_snapshot_ref, pricing_policy_version, status, quoted_at, expires_at,
    consumed_at, failed_at, created_at, updated_at, allocation_snapshot_json,
    destination_settlement_amount_atomic, destination_settlement_decimals, settlement_mode,
    funding_destination_address
)
SELECT
    quote_id, community_id, listing_id, 'user', buyer_user_id,
    asset_id, live_room_id, base_price_usd, pricing_tier, final_price_usd,
    funding_mode, funding_asset_json, source_chain_json, route_provider,
    route_policy_compliant, route_live_available, policy_origin,
    destination_settlement_chain_json, destination_settlement_token, treasury_denomination,
    quote_ttl_seconds, route_required, route_status_policy, route_hop_tolerance,
    verification_snapshot_ref, pricing_policy_version, status, quoted_at, expires_at,
    consumed_at, failed_at, created_at, updated_at, allocation_snapshot_json,
    destination_settlement_amount_atomic, destination_settlement_decimals, settlement_mode,
    funding_destination_address
FROM purchase_quotes_old;

DROP TABLE purchase_quotes_old;

CREATE INDEX idx_purchase_quotes_buyer_status
    ON purchase_quotes(buyer_user_id, status, expires_at DESC)
    WHERE buyer_kind = 'user';

CREATE INDEX idx_purchase_quotes_wallet_status
    ON purchase_quotes(buyer_chain_ref, buyer_wallet_address_normalized, status, expires_at DESC)
    WHERE buyer_kind = 'wallet';

CREATE INDEX idx_purchase_quotes_listing_status
    ON purchase_quotes(listing_id, status, expires_at DESC);

CREATE INDEX idx_purchase_quotes_community_status
    ON purchase_quotes(community_id, status, expires_at DESC);

CREATE INDEX idx_purchase_quotes_status_expires
    ON purchase_quotes(status, expires_at DESC);

ALTER TABLE purchases RENAME TO purchases_old;

CREATE TABLE purchases (
    purchase_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    asset_id TEXT,
    live_room_id TEXT,
    buyer_kind TEXT NOT NULL DEFAULT 'user' CHECK (
        buyer_kind IN ('user', 'wallet')
    ),
    buyer_user_id TEXT,
    buyer_wallet_address TEXT,
    buyer_wallet_address_normalized TEXT,
    buyer_chain_ref TEXT,
    settlement_wallet_attachment_id TEXT NOT NULL,
    purchase_price_usd REAL NOT NULL CHECK (
        purchase_price_usd >= 0
    ),
    pricing_tier TEXT,
    settlement_chain TEXT NOT NULL,
    settlement_token TEXT NOT NULL,
    settlement_tx_ref TEXT NOT NULL,
    donation_partner_id TEXT,
    donation_share_pct REAL CHECK (
        donation_share_pct IS NULL OR (donation_share_pct >= 0 AND donation_share_pct <= 100)
    ),
    donation_amount_usd REAL CHECK (
        donation_amount_usd IS NULL OR donation_amount_usd >= 0
    ),
    donation_settlement_ref TEXT,
    created_at TEXT NOT NULL,
    settlement_mode TEXT NOT NULL DEFAULT 'delivery_only_story_settlement' CHECK (
        settlement_mode IN ('delivery_only_story_settlement', 'royalty_native_story_payment')
    ),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    CHECK (
        buyer_user_id IS NOT NULL OR buyer_wallet_address_normalized IS NOT NULL
    ),
    CHECK (
        (buyer_kind = 'user' AND buyer_user_id IS NOT NULL AND buyer_wallet_address_normalized IS NULL) OR
        (buyer_kind = 'wallet' AND buyer_user_id IS NULL AND buyer_wallet_address_normalized IS NOT NULL)
    ),
    CHECK (
        (asset_id IS NOT NULL AND live_room_id IS NULL) OR
        (asset_id IS NULL AND live_room_id IS NOT NULL)
    )
);

INSERT INTO purchases (
    purchase_id, community_id, listing_id, asset_id, live_room_id, buyer_kind, buyer_user_id,
    settlement_wallet_attachment_id, purchase_price_usd, pricing_tier, settlement_chain,
    settlement_token, settlement_tx_ref, donation_partner_id, donation_share_pct,
    donation_amount_usd, donation_settlement_ref, created_at, settlement_mode
)
SELECT
    purchase_id, community_id, listing_id, asset_id, live_room_id, 'user', buyer_user_id,
    settlement_wallet_attachment_id, purchase_price_usd, pricing_tier, settlement_chain,
    settlement_token, settlement_tx_ref, donation_partner_id, donation_share_pct,
    donation_amount_usd, donation_settlement_ref, created_at, settlement_mode
FROM purchases_old;

DROP TABLE purchases_old;

CREATE INDEX idx_purchases_buyer_created
    ON purchases(buyer_user_id, created_at DESC)
    WHERE buyer_kind = 'user';

CREATE INDEX idx_purchases_wallet_created
    ON purchases(buyer_chain_ref, buyer_wallet_address_normalized, created_at DESC)
    WHERE buyer_kind = 'wallet';

CREATE INDEX idx_purchases_community_created
    ON purchases(community_id, created_at DESC);

ALTER TABLE purchase_entitlements RENAME TO purchase_entitlements_old;

CREATE TABLE purchase_entitlements (
    purchase_entitlement_id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    buyer_kind TEXT NOT NULL DEFAULT 'user' CHECK (
        buyer_kind IN ('user', 'wallet')
    ),
    buyer_user_id TEXT,
    buyer_wallet_address TEXT,
    buyer_wallet_address_normalized TEXT,
    buyer_chain_ref TEXT,
    entitlement_kind TEXT NOT NULL CHECK (
        entitlement_kind IN ('asset_access', 'live_room_access', 'replay_access', 'license')
    ),
    target_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'revoked', 'expired')
    ),
    granted_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (purchase_id) REFERENCES purchases(purchase_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    CHECK (
        buyer_user_id IS NOT NULL OR buyer_wallet_address_normalized IS NOT NULL
    ),
    CHECK (
        (buyer_kind = 'user' AND buyer_user_id IS NOT NULL AND buyer_wallet_address_normalized IS NULL) OR
        (buyer_kind = 'wallet' AND buyer_user_id IS NULL AND buyer_wallet_address_normalized IS NOT NULL)
    )
);

INSERT INTO purchase_entitlements (
    purchase_entitlement_id, purchase_id, community_id, buyer_kind, buyer_user_id,
    entitlement_kind, target_ref, status, granted_at, revoked_at, created_at, updated_at
)
SELECT
    purchase_entitlement_id, purchase_id, community_id, 'user', buyer_user_id,
    entitlement_kind, target_ref, status, granted_at, revoked_at, created_at, updated_at
FROM purchase_entitlements_old;

DROP TABLE purchase_entitlements_old;

CREATE INDEX idx_purchase_entitlements_buyer_status
    ON purchase_entitlements(buyer_user_id, status)
    WHERE buyer_kind = 'user';

CREATE INDEX idx_purchase_entitlements_wallet_status
    ON purchase_entitlements(buyer_chain_ref, buyer_wallet_address_normalized, status)
    WHERE buyer_kind = 'wallet';

CREATE INDEX idx_purchase_entitlements_target
    ON purchase_entitlements(entitlement_kind, target_ref, status);

ALTER TABLE purchase_quote_verification_snapshots RENAME TO purchase_quote_verification_snapshots_old;

CREATE TABLE purchase_quote_verification_snapshots (
    verification_snapshot_ref TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    buyer_kind TEXT NOT NULL DEFAULT 'user' CHECK (
        buyer_kind IN ('user', 'wallet')
    ),
    buyer_user_id TEXT,
    buyer_wallet_address TEXT,
    buyer_wallet_address_normalized TEXT,
    buyer_chain_ref TEXT,
    provider TEXT,
    nationality_state TEXT NOT NULL,
    nationality_value TEXT,
    pricing_tier TEXT,
    pricing_policy_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (quote_id) REFERENCES purchase_quotes(quote_id),
    CHECK (
        buyer_user_id IS NOT NULL OR buyer_wallet_address_normalized IS NOT NULL
    ),
    CHECK (
        (buyer_kind = 'user' AND buyer_user_id IS NOT NULL AND buyer_wallet_address_normalized IS NULL) OR
        (buyer_kind = 'wallet' AND buyer_user_id IS NULL AND buyer_wallet_address_normalized IS NOT NULL)
    )
);

INSERT INTO purchase_quote_verification_snapshots (
    verification_snapshot_ref, community_id, quote_id, buyer_kind, buyer_user_id,
    provider, nationality_state, nationality_value, pricing_tier,
    pricing_policy_version, snapshot_json, created_at, updated_at
)
SELECT
    verification_snapshot_ref, community_id, quote_id, 'user', buyer_user_id,
    provider, nationality_state, nationality_value, pricing_tier,
    pricing_policy_version, snapshot_json, created_at, updated_at
FROM purchase_quote_verification_snapshots_old;

DROP TABLE purchase_quote_verification_snapshots_old;

CREATE INDEX idx_purchase_quote_verification_snapshots_quote
    ON purchase_quote_verification_snapshots(quote_id);

ALTER TABLE purchase_allocation_legs RENAME TO purchase_allocation_legs_old;

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
    provider_receipt_ref TEXT,
    tax_receipt_ref TEXT,
    submitted_at TEXT,
    confirmed_at TEXT,
    failed_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (purchase_id) REFERENCES purchases(purchase_id),
    FOREIGN KEY (quote_id) REFERENCES purchase_quotes(quote_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

INSERT INTO purchase_allocation_legs (
    purchase_allocation_leg_id, purchase_id, quote_id, community_id, recipient_type, recipient_ref,
    waterfall_position, share_bps, amount_usd, settlement_strategy, status, settlement_ref,
    failure_reason, created_at, updated_at, provider_receipt_ref, tax_receipt_ref,
    submitted_at, confirmed_at, failed_at, attempt_count
)
SELECT
    purchase_allocation_leg_id, purchase_id, quote_id, community_id, recipient_type, recipient_ref,
    waterfall_position, share_bps, amount_usd, settlement_strategy, status, settlement_ref,
    failure_reason, created_at, updated_at, provider_receipt_ref, tax_receipt_ref,
    submitted_at, confirmed_at, failed_at, attempt_count
FROM purchase_allocation_legs_old;

DROP TABLE purchase_allocation_legs_old;

CREATE INDEX idx_purchase_allocation_legs_purchase
    ON purchase_allocation_legs(purchase_id, waterfall_position ASC, created_at ASC);

ALTER TABLE purchase_settlement_effects RENAME TO purchase_settlement_effects_old;

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

INSERT INTO purchase_settlement_effects (
    purchase_settlement_effect_id, community_id, quote_id, purchase_id, effect_kind,
    effect_key, idempotency_key, status, settlement_ref, provider_receipt_ref,
    tax_receipt_ref, metadata_json, failure_reason, attempt_count, submitted_at,
    confirmed_at, failed_at, created_at, updated_at
)
SELECT
    purchase_settlement_effect_id, community_id, quote_id, purchase_id, effect_kind,
    effect_key, idempotency_key, status, settlement_ref, provider_receipt_ref,
    tax_receipt_ref, metadata_json, failure_reason, attempt_count, submitted_at,
    confirmed_at, failed_at, created_at, updated_at
FROM purchase_settlement_effects_old;

DROP TABLE purchase_settlement_effects_old;

CREATE UNIQUE INDEX idx_purchase_settlement_effects_idempotency
    ON purchase_settlement_effects(idempotency_key);

CREATE UNIQUE INDEX idx_purchase_settlement_effects_quote_kind_key
    ON purchase_settlement_effects(community_id, quote_id, effect_kind, effect_key);

CREATE INDEX idx_purchase_settlement_effects_purchase
    ON purchase_settlement_effects(purchase_id, effect_kind, status);

ALTER TABLE purchase_settlement_attempts RENAME TO purchase_settlement_attempts_old;

CREATE TABLE purchase_settlement_attempts (
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

INSERT INTO purchase_settlement_attempts (
    attempt_id, quote_id, purchase_id, community_id, settlement_wallet_attachment_id,
    settlement_tx_ref, status, failure_reason, attempt_count, created_at, updated_at
)
SELECT
    attempt_id, quote_id, purchase_id, community_id, settlement_wallet_attachment_id,
    settlement_tx_ref, status, failure_reason, attempt_count, created_at, updated_at
FROM purchase_settlement_attempts_old;

DROP TABLE purchase_settlement_attempts_old;

CREATE INDEX idx_purchase_settlement_attempts_status_updated
    ON purchase_settlement_attempts(status, updated_at ASC);

PRAGMA foreign_keys = ON;
PRAGMA legacy_alter_table = OFF;
