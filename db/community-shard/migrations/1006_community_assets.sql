CREATE TABLE assets (
    asset_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    source_post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT,
    creator_user_id TEXT NOT NULL,
    asset_kind TEXT NOT NULL CHECK (
        asset_kind IN ('song_audio')
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
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (source_post_id) REFERENCES posts(post_id)
);

CREATE UNIQUE INDEX idx_assets_source_post
    ON assets(source_post_id);

CREATE INDEX idx_assets_community_created
    ON assets(community_id, created_at DESC);

CREATE INDEX idx_assets_story_status
    ON assets(story_status, created_at DESC);
