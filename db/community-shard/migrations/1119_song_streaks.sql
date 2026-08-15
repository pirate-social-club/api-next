CREATE TABLE song_engagement_days (
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    activity_date TEXT NOT NULL,
    study_attempt_count INTEGER NOT NULL DEFAULT 0,
    study_correct_count INTEGER NOT NULL DEFAULT 0,
    study_target_count INTEGER NOT NULL DEFAULT 10,
    karaoke_pass_count INTEGER NOT NULL DEFAULT 0,
    qualified INTEGER NOT NULL DEFAULT 0 CHECK (qualified IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, post_id, activity_date),
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_song_engagement_days_user_post
    ON song_engagement_days(user_id, post_id, activity_date);

CREATE TABLE song_streaks (
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    current_streak INTEGER NOT NULL,
    best_streak INTEGER NOT NULL,
    last_qualified_date TEXT NOT NULL,
    streak_started_date TEXT NOT NULL,
    total_qualified_days INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, post_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_song_streaks_board
    ON song_streaks(
        post_id,
        current_streak DESC,
        best_streak DESC,
        streak_started_date,
        user_id
    );
