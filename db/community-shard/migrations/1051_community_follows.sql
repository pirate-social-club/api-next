ALTER TABLE communities
    ADD COLUMN cached_follower_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE community_follows (
    community_follow_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'inactive')
    ),
    unfollowed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_community_follows_unique
    ON community_follows(community_id, user_id);

CREATE INDEX idx_community_follows_user_status
    ON community_follows(user_id, status);

INSERT INTO community_follows (
    community_follow_id, community_id, user_id, status, unfollowed_at, created_at, updated_at
)
SELECT
    'flw_' || community_id || '_' || user_id,
    community_id,
    user_id,
    'active',
    NULL,
    COALESCE(joined_at, created_at),
    updated_at
FROM community_memberships
WHERE status = 'member'
ON CONFLICT(community_id, user_id) DO NOTHING;

UPDATE communities
SET cached_follower_count = (
    SELECT COUNT(*)
    FROM community_follows
    WHERE community_follows.community_id = communities.community_id
      AND community_follows.status = 'active'
);
