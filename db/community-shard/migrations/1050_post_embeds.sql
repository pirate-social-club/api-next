ALTER TABLE posts
    ADD COLUMN embeds_json TEXT;

CREATE TABLE post_embeds (
    embed_id TEXT PRIMARY KEY,
    embed_key TEXT NOT NULL UNIQUE,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (
        provider IN ('x', 'youtube', 'kalshi', 'polymarket')
    ),
    provider_ref TEXT,
    canonical_url TEXT NOT NULL,
    original_url TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('pending', 'preview', 'embed', 'unavailable')
    ),
    preview_json TEXT,
    oembed_html TEXT,
    oembed_cache_age INTEGER,
    unavailable_reason TEXT CHECK (
        unavailable_reason IS NULL OR unavailable_reason IN ('deleted', 'withheld', 'private', 'unsupported', 'unknown')
    ),
    last_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id)
);

CREATE INDEX idx_post_embeds_post
    ON post_embeds(post_id);

CREATE INDEX idx_post_embeds_provider_ref
    ON post_embeds(provider, provider_ref);

CREATE INDEX idx_post_embeds_recheck
    ON post_embeds(provider, state, last_checked_at);
