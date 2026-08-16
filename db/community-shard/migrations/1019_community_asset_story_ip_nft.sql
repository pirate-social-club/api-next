ALTER TABLE assets
ADD COLUMN story_ip_nft_contract TEXT;

ALTER TABLE assets
ADD COLUMN story_ip_nft_token_id TEXT;

ALTER TABLE assets
ADD COLUMN story_publish_model TEXT NOT NULL DEFAULT 'pirate_v1'
    CHECK (story_publish_model IN ('pirate_v1', 'story_ip_v1'));

ALTER TABLE assets
ADD COLUMN story_license_terms_id TEXT;

ALTER TABLE assets
ADD COLUMN story_license_template TEXT;

ALTER TABLE assets
ADD COLUMN story_royalty_policy TEXT;

ALTER TABLE assets
ADD COLUMN story_derivative_registered_at TEXT;

ALTER TABLE assets
ADD COLUMN story_revenue_token TEXT;

CREATE INDEX idx_assets_story_publish_model
    ON assets(story_publish_model, created_at DESC);

CREATE INDEX idx_assets_story_ip_nft
    ON assets(story_ip_nft_contract, story_ip_nft_token_id);
