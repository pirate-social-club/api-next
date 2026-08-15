ALTER TABLE assets
ADD COLUMN story_publish_tx_ref TEXT;

ALTER TABLE assets
ADD COLUMN story_asset_version_id TEXT;

ALTER TABLE assets
ADD COLUMN story_cdr_vault_uuid INTEGER;

ALTER TABLE assets
ADD COLUMN story_namespace TEXT;

ALTER TABLE assets
ADD COLUMN story_entitlement_token_id TEXT;

ALTER TABLE assets
ADD COLUMN story_read_condition TEXT;

ALTER TABLE assets
ADD COLUMN story_write_condition TEXT;

CREATE INDEX idx_assets_story_asset_version_id
    ON assets(story_asset_version_id);
