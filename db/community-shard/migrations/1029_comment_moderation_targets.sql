ALTER TABLE moderation_cases RENAME TO moderation_cases_old;

DROP INDEX IF EXISTS idx_moderation_cases_community_status_updated;
DROP INDEX IF EXISTS idx_moderation_cases_post;
DROP INDEX IF EXISTS idx_moderation_cases_open;

CREATE TABLE moderation_cases (
    moderation_case_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT,
    comment_id TEXT,
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
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (comment_id) REFERENCES comments(comment_id),
    CHECK (
        (post_id IS NOT NULL AND comment_id IS NULL)
        OR (post_id IS NULL AND comment_id IS NOT NULL)
    )
);

INSERT INTO moderation_cases (
    moderation_case_id, community_id, post_id, comment_id, status, queue_scope, priority, opened_by,
    created_at, updated_at, resolved_at
)
SELECT
    moderation_case_id, community_id, post_id, NULL, status, queue_scope, priority, opened_by,
    created_at, updated_at, resolved_at
FROM moderation_cases_old;

CREATE INDEX idx_moderation_cases_community_status_updated
    ON moderation_cases(community_id, status, updated_at DESC);

CREATE INDEX idx_moderation_cases_post
    ON moderation_cases(post_id);

CREATE INDEX idx_moderation_cases_comment
    ON moderation_cases(comment_id);

CREATE UNIQUE INDEX idx_moderation_cases_open
    ON moderation_cases(community_id, COALESCE(post_id, ''), COALESCE(comment_id, ''))
    WHERE status = 'open';

ALTER TABLE moderation_signals RENAME TO moderation_signals_old;

DROP INDEX IF EXISTS idx_moderation_signals_post_created;
DROP INDEX IF EXISTS idx_moderation_signals_case_created;
DROP INDEX IF EXISTS idx_moderation_signals_analysis_result;

CREATE TABLE moderation_signals (
    moderation_signal_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT,
    comment_id TEXT,
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
    FOREIGN KEY (comment_id) REFERENCES comments(comment_id),
    FOREIGN KEY (moderation_case_id) REFERENCES moderation_cases(moderation_case_id),
    CHECK (
        (post_id IS NOT NULL AND comment_id IS NULL)
        OR (post_id IS NULL AND comment_id IS NOT NULL)
    )
);

INSERT INTO moderation_signals (
    moderation_signal_id, community_id, post_id, comment_id, moderation_case_id, analysis_result_ref,
    source, signal_type, severity, provider, provider_label, evidence_ref, created_at
)
SELECT
    moderation_signal_id, community_id, post_id, NULL, moderation_case_id, analysis_result_ref,
    source, signal_type, severity, provider, provider_label, evidence_ref, created_at
FROM moderation_signals_old;

CREATE INDEX idx_moderation_signals_post_created
    ON moderation_signals(post_id, created_at DESC);

CREATE INDEX idx_moderation_signals_comment_created
    ON moderation_signals(comment_id, created_at DESC);

CREATE INDEX idx_moderation_signals_case_created
    ON moderation_signals(moderation_case_id, created_at DESC);

CREATE INDEX idx_moderation_signals_analysis_result
    ON moderation_signals(analysis_result_ref);

ALTER TABLE user_reports RENAME TO user_reports_old;

DROP INDEX IF EXISTS idx_user_reports_post_created;
DROP INDEX IF EXISTS idx_user_reports_case_created;
DROP INDEX IF EXISTS idx_user_reports_unique_reporter;

CREATE TABLE user_reports (
    user_report_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT,
    comment_id TEXT,
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
    FOREIGN KEY (comment_id) REFERENCES comments(comment_id),
    FOREIGN KEY (moderation_case_id) REFERENCES moderation_cases(moderation_case_id),
    CHECK (
        (post_id IS NOT NULL AND comment_id IS NULL)
        OR (post_id IS NULL AND comment_id IS NOT NULL)
    )
);

INSERT INTO user_reports (
    user_report_id, community_id, post_id, comment_id, moderation_case_id, reporter_user_id, reason_code, note, created_at
)
SELECT
    user_report_id, community_id, post_id, NULL, moderation_case_id, reporter_user_id, reason_code, note, created_at
FROM user_reports_old;

CREATE INDEX idx_user_reports_post_created
    ON user_reports(post_id, created_at DESC);

CREATE INDEX idx_user_reports_comment_created
    ON user_reports(comment_id, created_at DESC);

CREATE INDEX idx_user_reports_case_created
    ON user_reports(moderation_case_id, created_at DESC);

CREATE UNIQUE INDEX idx_user_reports_unique_reporter
    ON user_reports(community_id, COALESCE(post_id, ''), COALESCE(comment_id, ''), reporter_user_id);

ALTER TABLE moderation_actions RENAME TO moderation_actions_old;

DROP INDEX IF EXISTS idx_moderation_actions_case_created;
DROP INDEX IF EXISTS idx_moderation_actions_community_created;

CREATE TABLE moderation_actions (
    moderation_action_id TEXT PRIMARY KEY,
    moderation_case_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT,
    comment_id TEXT,
    actor_user_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (
        action_type IN ('dismiss', 'hide', 'remove', 'restore', 'age_gate')
    ),
    note TEXT,
    created_at TEXT NOT NULL,
    previous_post_status TEXT CHECK (
        previous_post_status IN ('draft', 'published', 'hidden', 'removed', 'deleted')
    ),
    next_post_status TEXT CHECK (
        next_post_status IN ('draft', 'published', 'hidden', 'removed', 'deleted')
    ),
    previous_age_gate_policy TEXT CHECK (
        previous_age_gate_policy IN ('none', '18_plus')
    ),
    next_age_gate_policy TEXT CHECK (
        next_age_gate_policy IN ('none', '18_plus')
    ),
    FOREIGN KEY (moderation_case_id) REFERENCES moderation_cases(moderation_case_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (comment_id) REFERENCES comments(comment_id),
    CHECK (
        (post_id IS NOT NULL AND comment_id IS NULL)
        OR (post_id IS NULL AND comment_id IS NOT NULL)
    )
);

INSERT INTO moderation_actions (
    moderation_action_id, moderation_case_id, community_id, post_id, comment_id, actor_user_id, action_type, note,
    created_at, previous_post_status, next_post_status, previous_age_gate_policy, next_age_gate_policy
)
SELECT
    moderation_action_id, moderation_case_id, community_id, post_id, NULL, actor_user_id, action_type, note,
    created_at, previous_post_status, next_post_status, previous_age_gate_policy, next_age_gate_policy
FROM moderation_actions_old;

CREATE INDEX idx_moderation_actions_case_created
    ON moderation_actions(moderation_case_id, created_at DESC);

CREATE INDEX idx_moderation_actions_community_created
    ON moderation_actions(community_id, created_at DESC);

CREATE INDEX idx_moderation_actions_post_created
    ON moderation_actions(post_id, created_at DESC);

CREATE INDEX idx_moderation_actions_comment_created
    ON moderation_actions(comment_id, created_at DESC);

DROP TABLE moderation_signals_old;
DROP TABLE user_reports_old;
DROP TABLE moderation_actions_old;
DROP TABLE moderation_cases_old;
