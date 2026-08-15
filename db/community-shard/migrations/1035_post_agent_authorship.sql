ALTER TABLE posts
ADD COLUMN authorship_mode TEXT NOT NULL DEFAULT 'human_direct' CHECK (
    authorship_mode IN ('human_direct', 'user_agent')
);

ALTER TABLE posts
ADD COLUMN agent_id TEXT;

ALTER TABLE posts
ADD COLUMN agent_ownership_record_id TEXT;

ALTER TABLE posts
ADD COLUMN agent_display_name_snapshot TEXT;

ALTER TABLE posts
ADD COLUMN agent_owner_handle_snapshot TEXT;

ALTER TABLE posts
ADD COLUMN agent_ownership_provider_snapshot TEXT;

CREATE INDEX idx_posts_agent_authorship
    ON posts(authorship_mode, agent_id, created_at DESC);
