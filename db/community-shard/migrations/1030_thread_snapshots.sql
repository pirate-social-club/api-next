CREATE TABLE thread_snapshots (
    thread_snapshot_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    thread_root_post_id TEXT NOT NULL,
    snapshot_seq INTEGER NOT NULL,
    published_through_comment_created_at TEXT NOT NULL,
    comment_count INTEGER NOT NULL,
    swarm_manifest_ref TEXT NOT NULL,
    swarm_feed_ref TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (thread_root_post_id) REFERENCES posts(post_id)
);

CREATE UNIQUE INDEX idx_thread_snapshots_thread_seq
    ON thread_snapshots(thread_root_post_id, snapshot_seq);

CREATE INDEX idx_thread_snapshots_thread_created
    ON thread_snapshots(thread_root_post_id, created_at DESC);
