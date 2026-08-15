CREATE TABLE comments (
    comment_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    thread_root_post_id TEXT NOT NULL,
    parent_comment_id TEXT,
    author_user_id TEXT,
    identity_mode TEXT NOT NULL CHECK (
        identity_mode IN ('public', 'anonymous')
    ),
    anonymous_scope TEXT CHECK (
        anonymous_scope IS NULL OR anonymous_scope IN ('community_stable', 'thread_stable')
    ),
    anonymous_label TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('published', 'hidden', 'removed', 'deleted')
    ),
    depth INTEGER NOT NULL,
    direct_reply_count INTEGER NOT NULL DEFAULT 0,
    descendant_count INTEGER NOT NULL DEFAULT 0,
    upvote_count INTEGER NOT NULL DEFAULT 0,
    downvote_count INTEGER NOT NULL DEFAULT 0,
    score INTEGER NOT NULL DEFAULT 0,
    last_reply_at TEXT,
    content_hash TEXT,
    swarm_body_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (thread_root_post_id) REFERENCES posts(post_id),
    FOREIGN KEY (parent_comment_id) REFERENCES comments(comment_id)
);

CREATE INDEX idx_comments_thread_parent_created
    ON comments(thread_root_post_id, parent_comment_id, created_at);

CREATE INDEX idx_comments_thread_status_created
    ON comments(thread_root_post_id, status, created_at);

CREATE INDEX idx_comments_parent_created
    ON comments(parent_comment_id, created_at);

CREATE INDEX idx_comments_author_created
    ON comments(author_user_id, created_at DESC);

CREATE TABLE comment_votes (
    comment_vote_id TEXT PRIMARY KEY,
    comment_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    vote_value INTEGER NOT NULL CHECK (vote_value IN (-1, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (comment_id) REFERENCES comments(comment_id)
);

CREATE UNIQUE INDEX idx_comment_votes_unique
    ON comment_votes(comment_id, user_id);
