PRAGMA foreign_keys = OFF;

CREATE TABLE assets_next (
    asset_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    source_post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT,
    creator_user_id TEXT NOT NULL,
    asset_kind TEXT NOT NULL CHECK (
        asset_kind IN ('song_audio', 'video_file')
    ),
    rights_basis TEXT NOT NULL CHECK (
        rights_basis IN ('none', 'original', 'derivative', 'attribution_only')
    ),
    access_mode TEXT NOT NULL CHECK (
        access_mode IN ('public', 'locked')
    ),
    primary_content_ref TEXT NOT NULL,
    primary_content_hash TEXT,
    publication_status TEXT NOT NULL CHECK (
        publication_status IN ('draft', 'story_requested', 'story_published', 'story_failed', 'withdrawn')
    ),
    story_status TEXT NOT NULL CHECK (
        story_status IN ('none', 'requested', 'published', 'failed')
    ),
    story_error TEXT,
    story_ip_id TEXT,
    locked_delivery_status TEXT NOT NULL CHECK (
        locked_delivery_status IN ('none', 'requested', 'ready', 'failed')
    ),
    locked_delivery_ref TEXT,
    locked_delivery_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    story_publish_tx_ref TEXT,
    story_asset_version_id TEXT,
    story_cdr_vault_uuid INTEGER,
    story_namespace TEXT,
    story_entitlement_token_id TEXT,
    story_read_condition TEXT,
    story_write_condition TEXT,
    preview_audio_json TEXT,
    cover_art_json TEXT,
    canvas_video_json TEXT,
    locked_delivery_payload_json TEXT,
    locked_delivery_storage_ref TEXT,
    locked_delivery_secret_json TEXT,
    story_ip_nft_contract TEXT,
    story_ip_nft_token_id TEXT,
    story_publish_model TEXT NOT NULL DEFAULT 'pirate_v1'
        CHECK (story_publish_model IN ('pirate_v1', 'story_ip_v1')),
    story_license_terms_id TEXT,
    story_license_template TEXT,
    story_royalty_policy TEXT,
    story_derivative_registered_at TEXT,
    story_revenue_token TEXT,
    story_cdr_encrypted_cid TEXT,
    story_cdr_allocate_tx_ref TEXT,
    story_cdr_write_tx_ref TEXT,
    story_royalty_policy_id TEXT,
    story_derivative_parent_ip_ids_json TEXT,
    story_royalty_registration_status TEXT NOT NULL DEFAULT 'none' CHECK (
        story_royalty_registration_status IN ('none', 'pending', 'registered', 'failed')
    ),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (source_post_id) REFERENCES posts(post_id)
);

INSERT INTO assets_next (
    asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id, asset_kind,
    rights_basis, access_mode, primary_content_ref, primary_content_hash, publication_status,
    story_status, story_error, story_ip_id, locked_delivery_status, locked_delivery_ref,
    locked_delivery_error, created_at, updated_at, story_publish_tx_ref, story_asset_version_id,
    story_cdr_vault_uuid, story_namespace, story_entitlement_token_id, story_read_condition,
    story_write_condition, preview_audio_json, cover_art_json, canvas_video_json,
    locked_delivery_payload_json, locked_delivery_storage_ref, locked_delivery_secret_json,
    story_ip_nft_contract, story_ip_nft_token_id, story_publish_model, story_license_terms_id,
    story_license_template, story_royalty_policy, story_derivative_registered_at, story_revenue_token,
    story_cdr_encrypted_cid, story_cdr_allocate_tx_ref, story_cdr_write_tx_ref,
    story_royalty_policy_id, story_derivative_parent_ip_ids_json, story_royalty_registration_status
)
SELECT
    asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id, asset_kind,
    rights_basis, access_mode, primary_content_ref, primary_content_hash, publication_status,
    story_status, story_error, story_ip_id, locked_delivery_status, locked_delivery_ref,
    locked_delivery_error, created_at, updated_at, story_publish_tx_ref, story_asset_version_id,
    story_cdr_vault_uuid, story_namespace, story_entitlement_token_id, story_read_condition,
    story_write_condition, preview_audio_json, cover_art_json, canvas_video_json,
    locked_delivery_payload_json, locked_delivery_storage_ref, locked_delivery_secret_json,
    story_ip_nft_contract, story_ip_nft_token_id, story_publish_model, story_license_terms_id,
    story_license_template, story_royalty_policy, story_derivative_registered_at, story_revenue_token,
    story_cdr_encrypted_cid, story_cdr_allocate_tx_ref, story_cdr_write_tx_ref,
    story_royalty_policy_id, story_derivative_parent_ip_ids_json, story_royalty_registration_status
FROM assets;

DROP TABLE assets;

ALTER TABLE assets_next RENAME TO assets;

CREATE UNIQUE INDEX idx_assets_source_post
    ON assets(source_post_id);

CREATE INDEX idx_assets_community_created
    ON assets(community_id, created_at DESC);

CREATE INDEX idx_assets_story_status
    ON assets(story_status, created_at DESC);

CREATE INDEX idx_assets_story_asset_version_id
    ON assets(story_asset_version_id);

CREATE INDEX idx_assets_community_primary_content_hash
    ON assets(community_id, primary_content_hash);

CREATE INDEX idx_assets_story_publish_model
    ON assets(story_publish_model, created_at DESC);

CREATE INDEX idx_assets_story_ip_nft
    ON assets(story_ip_nft_contract, story_ip_nft_token_id);

PRAGMA foreign_keys = ON;
