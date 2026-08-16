CREATE TABLE rights_holds (
    rights_hold_id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL CHECK (
        subject_type IN ('asset', 'post', 'live_room', 'replay_asset')
    ),
    subject_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    hold_type TEXT NOT NULL CHECK (
        hold_type IN ('reference_required', 'review_hold', 'blocked')
    ),
    source_case_id TEXT,
    analysis_result_ref TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'released')),
    reason_code TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    released_at TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_rights_holds_active_subject
    ON rights_holds(subject_type, subject_id)
    WHERE status = 'active';

CREATE INDEX idx_rights_holds_subject
    ON rights_holds(subject_type, subject_id, status);

CREATE INDEX idx_rights_holds_case
    ON rights_holds(source_case_id)
    WHERE source_case_id IS NOT NULL;
