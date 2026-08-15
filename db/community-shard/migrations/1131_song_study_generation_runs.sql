CREATE TABLE song_study_generation_run (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    target_language TEXT NOT NULL,
    generation_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'ready', 'unavailable')
    ),
    job_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (job_id) REFERENCES community_jobs(job_id) ON DELETE SET NULL,
    CHECK (generation_version > 0),
    CHECK (attempt_count >= 0),
    UNIQUE (post_id, target_language, generation_version)
);

CREATE INDEX idx_song_study_generation_run_status
    ON song_study_generation_run(status, updated_at ASC);
