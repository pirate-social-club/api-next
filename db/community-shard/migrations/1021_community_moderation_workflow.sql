CREATE TABLE moderation_cases (
    moderation_case_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('open', 'resolved')
    ),
    queue_scope TEXT NOT NULL CHECK (
        queue_scope IN ('community', 'platform')
    ),
    priority TEXT NOT NULL CHECK (
        priority IN ('low', 'medium', 'high')
    ),
    opened_by TEXT NOT NULL CHECK (
        opened_by IN ('platform_analysis', 'user_report', 'mixed')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id)
);

CREATE INDEX idx_moderation_cases_community_status_updated
    ON moderation_cases(community_id, status, updated_at DESC);

CREATE INDEX idx_moderation_cases_post
    ON moderation_cases(post_id);

CREATE UNIQUE INDEX idx_moderation_cases_open
    ON moderation_cases(community_id, post_id)
    WHERE status = 'open';

CREATE TABLE moderation_signals (
    moderation_signal_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    moderation_case_id TEXT,
    analysis_result_ref TEXT,
    source TEXT NOT NULL CHECK (
        source IN ('platform_analysis')
    ),
    signal_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (
        severity IN ('low', 'medium', 'high')
    ),
    provider TEXT NOT NULL,
    provider_label TEXT NOT NULL,
    evidence_ref TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (moderation_case_id) REFERENCES moderation_cases(moderation_case_id)
);

CREATE INDEX idx_moderation_signals_post_created
    ON moderation_signals(post_id, created_at DESC);

CREATE INDEX idx_moderation_signals_case_created
    ON moderation_signals(moderation_case_id, created_at DESC);

CREATE INDEX idx_moderation_signals_analysis_result
    ON moderation_signals(analysis_result_ref);

CREATE TABLE user_reports (
    user_report_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    moderation_case_id TEXT,
    reporter_user_id TEXT NOT NULL,
    reason_code TEXT NOT NULL CHECK (
        reason_code IN (
            'spam',
            'harassment',
            'hate',
            'sexual_content',
            'graphic_content',
            'misleading',
            'other'
        )
    ),
    note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (moderation_case_id) REFERENCES moderation_cases(moderation_case_id)
);

CREATE INDEX idx_user_reports_post_created
    ON user_reports(post_id, created_at DESC);

CREATE INDEX idx_user_reports_case_created
    ON user_reports(moderation_case_id, created_at DESC);

CREATE UNIQUE INDEX idx_user_reports_unique_reporter
    ON user_reports(community_id, post_id, reporter_user_id);

ALTER TABLE moderation_actions RENAME TO moderation_actions_legacy;

DROP INDEX IF EXISTS idx_moderation_actions_community_created;

DROP INDEX IF EXISTS idx_moderation_actions_target_user;

CREATE TABLE moderation_actions (
    moderation_action_id TEXT PRIMARY KEY,
    moderation_case_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (
        action_type IN ('dismiss', 'hide', 'remove', 'restore', 'age_gate')
    ),
    note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (moderation_case_id) REFERENCES moderation_cases(moderation_case_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id)
);

CREATE INDEX idx_moderation_actions_case_created
    ON moderation_actions(moderation_case_id, created_at DESC);

CREATE INDEX idx_moderation_actions_community_created
    ON moderation_actions(community_id, created_at DESC);
