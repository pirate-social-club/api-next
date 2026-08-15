-- Additive persistence for server-owned Song Study lesson orchestration.
-- Writer deployment remains gated on this migration reaching every community shard.

ALTER TABLE song_study_session
    ADD COLUMN session_revision INTEGER NOT NULL DEFAULT 0
    CHECK (session_revision >= 0);

ALTER TABLE song_study_session
    ADD COLUMN current_exercise_id TEXT;

ALTER TABLE song_study_session
    ADD COLUMN completion_reason TEXT
    CHECK (completion_reason IN ('all_resolved', 'presentation_budget'));

ALTER TABLE song_study_session_exercise
    ADD COLUMN appearance_ordinal INTEGER NOT NULL DEFAULT 0
    CHECK (appearance_ordinal >= 0);

ALTER TABLE song_study_session_exercise
    ADD COLUMN appearance_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (appearance_attempt_count >= 0 AND appearance_attempt_count <= 2);

ALTER TABLE song_study_session_exercise
    ADD COLUMN lesson_resolved INTEGER NOT NULL DEFAULT 0
    CHECK (lesson_resolved IN (0, 1));

ALTER TABLE song_study_session_exercise
    ADD COLUMN last_served_index INTEGER NOT NULL DEFAULT 0
    CHECK (last_served_index >= 0);

ALTER TABLE song_study_session_exercise
    ADD COLUMN qualifies_for_reward INTEGER NOT NULL DEFAULT 1
    CHECK (qualifies_for_reward IN (0, 1));

-- Classify completed sessions from their pre-v2 card state. Individual card
-- resolution wins when it and the global budget happen on the same attempt.
UPDATE song_study_session
SET completion_reason = CASE
    WHEN NOT EXISTS (
        SELECT 1
        FROM song_study_session_exercise e
        WHERE e.session_id = song_study_session.id
          AND e.mastered = 0
          AND e.presentation_count < 3
    ) THEN 'all_resolved'
    WHEN presentation_count >= max_presentations THEN 'presentation_budget'
    ELSE 'all_resolved'
END
WHERE status = 'completed';

-- Preserve completed lessons as resolved. For active lessons, cards already
-- mastered or exhausted retain those facts while all other cards remain open.
UPDATE song_study_session_exercise
SET lesson_resolved = 1
WHERE mastered = 1
   OR presentation_count >= 3
   OR session_id IN (
       SELECT id FROM song_study_session WHERE status = 'completed'
   );

-- Conservatively place previously served cards at the migration-time end of
-- their active session. This cannot make a retry eligible earlier than it was
-- before the upgrade; future graded writes replace it with the exact index.
UPDATE song_study_session_exercise
SET last_served_index = COALESCE((
    SELECT presentation_count
    FROM song_study_session
    WHERE song_study_session.id = song_study_session_exercise.session_id
), 0)
WHERE presentation_count > 0;

-- Migrated active sessions deliberately restart appearance-local state at zero.
-- Historical appearance boundaries and free re-record use cannot be reconstructed
-- from legacy rows. The loss is bounded by the three-presentation card cap and
-- the existing 24-hour session TTL; v2 persists exact state from its first turn.

-- A receipt, rather than an attempt event, spends the one free ungradable
-- re-record allowed during an appearance. An appearance can span two graded
-- presentations, so presentation_number is deliberately not part of this key.
CREATE TABLE song_study_ungradable_receipt (
    session_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    appearance_ordinal INTEGER NOT NULL CHECK (appearance_ordinal >= 0),
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, exercise_id, appearance_ordinal),
    UNIQUE (user_id, idempotency_key),
    FOREIGN KEY (session_id, exercise_id)
        REFERENCES song_study_session_exercise(session_id, exercise_id)
        ON DELETE CASCADE
);

-- The original response is retained so an equivalent retry replays the exact
-- transition snapshot even after another client advances the session. Initial
-- v2 retention is intentionally unbounded; compaction is later policy work.
CREATE TABLE song_study_attempt_response (
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    commit_token TEXT NOT NULL,
    response_status TEXT NOT NULL CHECK (response_status IN ('pending', 'final')),
    response_json TEXT NOT NULL,
    materialization_context_json TEXT,
    http_status INTEGER NOT NULL CHECK (http_status >= 100 AND http_status <= 599),
    result_kind TEXT NOT NULL CHECK (
        result_kind IN ('graded', 'ungradable', 'revision_conflict')
    ),
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, idempotency_key),
    FOREIGN KEY (session_id, exercise_id)
        REFERENCES song_study_session_exercise(session_id, exercise_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_song_study_attempt_response_session
    ON song_study_attempt_response(session_id, created_at);
