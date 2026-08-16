-- Add the source-language fill-in-the-blank exercise payload and widen the
-- persisted review/attempt discriminators. Writer deployment remains gated on
-- this migration reaching every community shard.

PRAGMA foreign_keys = OFF;

CREATE TABLE song_study_unit_cloze (
    unit_id TEXT PRIMARY KEY,
    cloze_version INTEGER NOT NULL DEFAULT 1 CHECK (cloze_version > 0),
    status TEXT NOT NULL CHECK (status IN ('ready', 'unavailable')),
    source_text TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    segments_json TEXT,
    tokens_json TEXT,
    correct_placements_json TEXT,
    max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts > 0),
    generated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (unit_id) REFERENCES song_study_unit(id) ON DELETE CASCADE,
    CONSTRAINT song_study_unit_cloze_ready_payload_check CHECK (
        (status = 'ready'
            AND segments_json IS NOT NULL
            AND tokens_json IS NOT NULL
            AND correct_placements_json IS NOT NULL
            AND generated_at IS NOT NULL)
        OR status = 'unavailable'
    )
);

CREATE INDEX idx_song_study_unit_cloze_status
    ON song_study_unit_cloze(status, updated_at);

CREATE TABLE song_study_attempt_next (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    exercise_type TEXT NOT NULL CHECK (
        exercise_type IN ('say_it_back', 'translation_choice', 'fill_blank')
    ),
    target_language TEXT NOT NULL,
    study_pack_version INTEGER NOT NULL,
    attempt_number INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    selected_option_id TEXT,
    transcript TEXT,
    placements_json TEXT,
    outcome TEXT NOT NULL CHECK (
        outcome IN ('correct', 'incorrect', 'revealed')
    ),
    feedback_json TEXT,
    fsrs_rating TEXT CHECK (
        fsrs_rating IS NULL OR fsrs_rating IN ('again', 'hard', 'good', 'easy')
    ),
    created_at TEXT NOT NULL,
    study_session_id TEXT,
    presentation_number INTEGER,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    CONSTRAINT song_study_attempt_number_positive_check CHECK (attempt_number > 0),
    UNIQUE (user_id, idempotency_key)
);

INSERT INTO song_study_attempt_next (
    id, user_id, post_id, exercise_id, line_id, exercise_type,
    target_language, study_pack_version, attempt_number, idempotency_key,
    selected_option_id, transcript, outcome, feedback_json, fsrs_rating,
    created_at, study_session_id, presentation_number
)
SELECT
    id, user_id, post_id, exercise_id, line_id, exercise_type,
    target_language, study_pack_version, attempt_number, idempotency_key,
    selected_option_id, transcript, outcome, feedback_json, fsrs_rating,
    created_at, study_session_id, presentation_number
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

CREATE UNIQUE INDEX idx_song_study_attempt_session_presentation
    ON song_study_attempt(user_id, study_session_id, exercise_id, presentation_number)
    WHERE study_session_id IS NOT NULL;

CREATE TABLE song_study_review_state_next (
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    exercise_type TEXT NOT NULL CHECK (
        exercise_type IN ('say_it_back', 'translation_choice', 'fill_blank')
    ),
    target_language TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('new', 'learning', 'review', 'relearning')
    ),
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    due_at TEXT NOT NULL,
    last_reviewed_at TEXT,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    fsrs_params_version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    PRIMARY KEY (
        user_id,
        post_id,
        line_id,
        exercise_type,
        target_language
    ),
    CONSTRAINT song_study_review_state_reps_nonnegative_check CHECK (reps >= 0),
    CONSTRAINT song_study_review_state_lapses_nonnegative_check CHECK (lapses >= 0)
);

INSERT INTO song_study_review_state_next (
    user_id, post_id, line_id, exercise_type, target_language,
    state, stability, difficulty, due_at, last_reviewed_at,
    reps, lapses, fsrs_params_version, updated_at
)
SELECT
    user_id, post_id, line_id, exercise_type, target_language,
    state, stability, difficulty, due_at, last_reviewed_at,
    reps, lapses, fsrs_params_version, updated_at
FROM song_study_review_state;

DROP TABLE song_study_review_state;
ALTER TABLE song_study_review_state_next RENAME TO song_study_review_state;

CREATE INDEX idx_song_study_review_due
    ON song_study_review_state(user_id, due_at);

PRAGMA foreign_keys = ON;
