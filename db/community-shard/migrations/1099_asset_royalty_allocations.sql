-- Royalty allocation ("ownership split"): per-recipient initial allocation
-- agreement + asset-level lifecycle state. Model proven on Aeneid (see
-- core/specs/domain/royalty-allocation.md). RTs distribute atomically at
-- registration. This table is the immutable agreement/audit, not live ownership.

-- Asset-level allocation lifecycle + observed Story vault facts.
ALTER TABLE assets
ADD COLUMN royalty_allocation_status TEXT NOT NULL DEFAULT 'none' CHECK (
    royalty_allocation_status IN (
        'none',
        'draft',
        'registration_pending',
        'verification_pending',
        'verified',
        'registration_failed',
        'verification_failed',
        'legacy_unverified'
    )
);

ALTER TABLE assets
ADD COLUMN royalty_allocation_fingerprint TEXT;

ALTER TABLE assets
ADD COLUMN royalty_allocation_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE assets
ADD COLUMN royalty_allocation_effect_key TEXT;

ALTER TABLE assets
ADD COLUMN royalty_allocation_tx_hash TEXT;

ALTER TABLE assets
ADD COLUMN ip_royalty_vault TEXT;

-- bigint stored as TEXT (SQLite INTEGER is 64-bit but RT math is bigint upstream).
ALTER TABLE assets
ADD COLUMN royalty_vault_total_supply TEXT;

ALTER TABLE assets
ADD COLUMN royalty_vault_decimals INTEGER;

ALTER TABLE assets
ADD COLUMN royalty_allocation_registered_at TEXT;

-- Per-recipient initial allocation agreement.
CREATE TABLE initial_royalty_allocations (
    allocation_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    recipient_kind TEXT NOT NULL CHECK (
        recipient_kind IN ('creator', 'collaborator')
    ),
    recipient_user_id TEXT,
    -- Wallet snapshot frozen at create time. Registration mints/distributes to this.
    wallet_attachment_id TEXT,
    wallet_address_normalized TEXT NOT NULL,
    wallet_address_display TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    role_label TEXT,
    share_bps INTEGER NOT NULL CHECK (
        share_bps > 0 AND share_bps <= 10000
    ),
    -- bps is the agreement. expected_rt_units is DERIVED after registration from
    -- the observed vault supply (= observed_total_supply * share_bps / 10000),
    -- so it is NULL during draft/registration_pending. bigint as TEXT.
    expected_rt_units TEXT,
    position INTEGER NOT NULL CHECK (
        position >= 0
    ),
    distribution_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        distribution_status IN ('pending', 'verified', 'failed')
    ),
    -- Observed on-chain RT balance at verification (bigint as TEXT).
    verified_rt_units TEXT,
    -- Fingerprint = hash(version, chainId, sort_by_address(address, share_bps)).
    -- Identity is per-asset via assets.royalty_allocation_effect_key, not per row.
    allocation_fingerprint TEXT NOT NULL,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    registered_at TEXT,
    FOREIGN KEY (asset_id) REFERENCES assets(asset_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

-- One allocation per wallet per asset (no duplicate recipients).
CREATE UNIQUE INDEX idx_initial_royalty_allocations_asset_wallet
    ON initial_royalty_allocations(asset_id, wallet_address_normalized);

-- Exactly one creator allocation per asset.
CREATE UNIQUE INDEX idx_initial_royalty_allocations_one_creator
    ON initial_royalty_allocations(asset_id)
    WHERE recipient_kind = 'creator';

-- Stable, unique positions per asset.
CREATE UNIQUE INDEX idx_initial_royalty_allocations_asset_position
    ON initial_royalty_allocations(asset_id, position);

CREATE INDEX idx_initial_royalty_allocations_asset
    ON initial_royalty_allocations(asset_id, position ASC);

CREATE INDEX idx_initial_royalty_allocations_recipient_user
    ON initial_royalty_allocations(recipient_user_id)
    WHERE recipient_user_id IS NOT NULL;

CREATE INDEX idx_initial_royalty_allocations_wallet
    ON initial_royalty_allocations(wallet_address_normalized);
