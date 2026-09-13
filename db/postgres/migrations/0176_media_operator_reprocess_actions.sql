-- Operator reprocess authorization record. A submission escalated as
-- workflow_terminal_unconverged is non-retryable through the automatic path;
-- its only return to processing runs through an authorized operator action
-- whose audit row is committed in the same transaction as the transition.
CREATE TABLE media_operator_reprocess_actions (
    operation_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    expected_creation_revision BIGINT NOT NULL,
    resulting_creation_revision BIGINT NOT NULL,
    reason_code TEXT NOT NULL CHECK (reason_code IN ('workflow_terminal_unconverged')),
    evidence_ref TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (operation_id, resulting_creation_revision),
    UNIQUE (submission_id, resulting_creation_revision),
    CHECK (resulting_creation_revision = expected_creation_revision + 1),
    CHECK (evidence_ref <> '')
);
