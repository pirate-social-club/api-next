-- Add a first-class, evidence-backed moderation action for changing a post's
-- content rating and its corresponding age gate as one audited transition.

ALTER TABLE moderation_actions RENAME TO moderation_actions_before_content_rating;

DROP INDEX IF EXISTS idx_moderation_actions_case_created;
DROP INDEX IF EXISTS idx_moderation_actions_community_created;
DROP INDEX IF EXISTS idx_moderation_actions_post_created;
DROP INDEX IF EXISTS idx_moderation_actions_comment_created;

CREATE TABLE moderation_actions (
    moderation_action_id TEXT PRIMARY KEY,
    moderation_case_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT,
    comment_id TEXT,
    actor_user_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (
        action_type IN ('dismiss', 'hide', 'remove', 'restore', 'age_gate', 'set_content_rating')
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
    previous_content_safety_state TEXT CHECK (
        previous_content_safety_state IN ('pending', 'safe', 'sensitive', 'adult')
    ),
    next_content_safety_state TEXT CHECK (
        next_content_safety_state IN ('safe', 'sensitive', 'adult')
    ),
    evidence_ref TEXT,
    FOREIGN KEY (moderation_case_id) REFERENCES moderation_cases(moderation_case_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (comment_id) REFERENCES comments(comment_id),
    CONSTRAINT moderation_actions_target_check CHECK (
        (post_id IS NOT NULL AND comment_id IS NULL)
        OR (post_id IS NULL AND comment_id IS NOT NULL)
    ),
    CONSTRAINT moderation_actions_content_rating_audit_check CHECK (
        action_type != 'set_content_rating'
        OR (
            post_id IS NOT NULL
            AND previous_content_safety_state IS NOT NULL
            AND next_content_safety_state IS NOT NULL
            AND previous_age_gate_policy IS NOT NULL
            AND next_age_gate_policy IS NOT NULL
            AND evidence_ref IS NOT NULL
            AND length(trim(evidence_ref)) > 0
        )
    )
);

INSERT INTO moderation_actions (
    moderation_action_id, moderation_case_id, community_id, post_id, comment_id,
    actor_user_id, action_type, note, created_at, previous_post_status,
    next_post_status, previous_age_gate_policy, next_age_gate_policy
)
SELECT
    moderation_action_id, moderation_case_id, community_id, post_id, comment_id,
    actor_user_id, action_type, note, created_at, previous_post_status,
    next_post_status, previous_age_gate_policy, next_age_gate_policy
FROM moderation_actions_before_content_rating;

CREATE INDEX idx_moderation_actions_case_created
    ON moderation_actions(moderation_case_id, created_at DESC);

CREATE INDEX idx_moderation_actions_community_created
    ON moderation_actions(community_id, created_at DESC);

CREATE INDEX idx_moderation_actions_post_created
    ON moderation_actions(post_id, created_at DESC);

CREATE INDEX idx_moderation_actions_comment_created
    ON moderation_actions(comment_id, created_at DESC);

DROP TABLE moderation_actions_before_content_rating;
