PRAGMA foreign_keys = OFF;

CREATE TABLE song_study_attempt_next (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    exercise_type TEXT NOT NULL CHECK (
        exercise_type IN ('say_it_back', 'translation_choice')
    ),
    target_language TEXT NOT NULL,
    study_pack_version INTEGER NOT NULL,
    attempt_number INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    selected_option_id TEXT,
    transcript TEXT,
    outcome TEXT NOT NULL CHECK (
        outcome IN ('correct', 'incorrect', 'revealed')
    ),
    feedback_json TEXT,
    fsrs_rating TEXT CHECK (
        fsrs_rating IS NULL OR fsrs_rating IN ('again', 'hard', 'good', 'easy')
    ),
    created_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    CHECK (attempt_number > 0),
    UNIQUE (user_id, idempotency_key)
);

INSERT INTO song_study_attempt_next (
    id, user_id, post_id, exercise_id, line_id,
    exercise_type, target_language, study_pack_version, attempt_number,
    idempotency_key, selected_option_id, transcript, outcome, feedback_json,
    fsrs_rating, created_at
)
SELECT
    id, user_id, post_id, exercise_id, line_id,
    exercise_type, target_language, study_pack_version, attempt_number,
    idempotency_key, selected_option_id, transcript, outcome, feedback_json,
    fsrs_rating, created_at
FROM song_study_attempt;

DROP TABLE song_study_attempt;
ALTER TABLE song_study_attempt_next RENAME TO song_study_attempt;

CREATE INDEX idx_song_study_attempt_review_unit
    ON song_study_attempt(
        user_id,
        post_id,
        line_id,
        exercise_type,
        target_language,
        created_at
    );

PRAGMA foreign_keys = ON;
