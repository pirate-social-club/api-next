-- Append-only, shard-local reward qualifications. Control-plane ingestion is
-- checkpointed by the monotonic sequence and idempotent by event_id.
CREATE TABLE reward_qualification_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT NOT NULL,
    activity TEXT NOT NULL CHECK (activity IN ('study', 'karaoke')),
    qualified_at TEXT NOT NULL,
    reward_period_key TEXT NOT NULL,
    qualification_policy_version TEXT NOT NULL,
    evidence_summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    UNIQUE (user_id, post_id, activity, reward_period_key)
);

CREATE INDEX idx_reward_qualification_outbox_sequence
    ON reward_qualification_outbox(sequence);
