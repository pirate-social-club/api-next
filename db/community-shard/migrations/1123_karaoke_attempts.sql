CREATE TABLE karaoke_attempt (
    id TEXT NOT NULL PRIMARY KEY,
    session_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    karaoke_revision_id TEXT NOT NULL,
    scoring_version INTEGER NOT NULL,
    scoring_provider TEXT NOT NULL,
    scoring_model TEXT NOT NULL,
    final_score INTEGER NOT NULL,
    lyrics_score INTEGER NOT NULL,
    timing_score INTEGER,
    timing_trend TEXT NOT NULL CHECK (
        timing_trend IN ('early', 'late', 'mixed', 'on_time')
    ),
    scored_line_count INTEGER NOT NULL,
    line_count INTEGER NOT NULL,
    uncertain_line_count INTEGER NOT NULL,
    no_recognition_line_count INTEGER NOT NULL,
    low_confidence_line_count INTEGER NOT NULL,
    completion_reason TEXT NOT NULL CHECK (
        completion_reason IN ('completed', 'session_error', 'provider_unavailable', 'abandoned')
    ),
    rank_eligible INTEGER NOT NULL CHECK (rank_eligible IN (0, 1)),
    activity_date TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, attempt_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_karaoke_attempt_rank
    ON karaoke_attempt(
        post_id,
        karaoke_revision_id,
        scoring_version,
        scoring_provider,
        scoring_model,
        rank_eligible,
        final_score DESC,
        completed_at
    );

CREATE INDEX idx_karaoke_attempt_user_post
    ON karaoke_attempt(user_id, post_id, completed_at DESC);
