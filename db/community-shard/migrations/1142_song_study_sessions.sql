CREATE TABLE song_study_session (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    target_language TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'expired')),
    exercise_count INTEGER NOT NULL CHECK (exercise_count > 0 AND exercise_count <= 10),
    required_correct_count INTEGER NOT NULL CHECK (
        required_correct_count > 0 AND required_correct_count <= exercise_count
    ),
    max_presentations INTEGER NOT NULL CHECK (
        max_presentations >= exercise_count AND max_presentations <= 20
    ),
    presentation_count INTEGER NOT NULL DEFAULT 0 CHECK (presentation_count >= 0),
    completed_exercise_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_exercise_count >= 0),
    first_pass_correct_count INTEGER NOT NULL DEFAULT 0 CHECK (first_pass_correct_count >= 0),
    mastered_exercise_count INTEGER NOT NULL DEFAULT 0 CHECK (mastered_exercise_count >= 0),
    qualified INTEGER NOT NULL DEFAULT 0 CHECK (qualified IN (0, 1)),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_song_study_session_active
    ON song_study_session(user_id, post_id, target_language)
    WHERE status = 'active';

CREATE INDEX idx_song_study_session_expiry
    ON song_study_session(status, expires_at);

CREATE TABLE song_study_session_exercise (
    session_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    presentation_count INTEGER NOT NULL DEFAULT 0 CHECK (
        presentation_count >= 0 AND presentation_count <= 3
    ),
    first_outcome TEXT CHECK (first_outcome IN ('correct', 'incorrect', 'revealed')),
    last_outcome TEXT CHECK (last_outcome IN ('correct', 'incorrect', 'revealed')),
    mastered INTEGER NOT NULL DEFAULT 0 CHECK (mastered IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, exercise_id),
    UNIQUE (session_id, ordinal),
    FOREIGN KEY (session_id) REFERENCES song_study_session(id) ON DELETE CASCADE
);

CREATE INDEX idx_song_study_session_exercise_queue
    ON song_study_session_exercise(session_id, mastered, presentation_count, ordinal);

ALTER TABLE song_study_attempt ADD COLUMN study_session_id TEXT;
ALTER TABLE song_study_attempt ADD COLUMN presentation_number INTEGER;

CREATE UNIQUE INDEX idx_song_study_attempt_session_presentation
    ON song_study_attempt(user_id, study_session_id, exercise_id, presentation_number)
    WHERE study_session_id IS NOT NULL;
