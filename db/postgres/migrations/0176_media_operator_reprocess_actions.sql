-- Operator reprocess authorization record. A submission escalated as
-- workflow_terminal_unconverged is non-retryable through the automatic path;
-- its only return to processing runs through an authorized operator action
-- whose audit row is committed in the same transaction as the transition.
--
-- Request identity, not revision uniqueness, makes a repeated request
-- idempotent: the same (operation_id, idempotency_key) with the same
-- request_hash replays the original action, while the same key with a
-- different hash is an idempotency conflict and a stale expected revision is
-- rejected by the store's creation-revision fence. The unique result identity
-- remains the integrity guard against two different actions committing the
-- same resulting revision.
CREATE TABLE media_operator_reprocess_actions (
    operation_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    expected_creation_revision BIGINT NOT NULL,
    resulting_creation_revision BIGINT NOT NULL,
    resulting_workflow_revision BIGINT NOT NULL,
    reason_code TEXT NOT NULL CHECK (reason_code IN ('workflow_terminal_unconverged')),
    evidence_ref TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (operation_id, resulting_creation_revision),
    UNIQUE (operation_id, idempotency_key),
    UNIQUE (submission_id, resulting_creation_revision),
    CHECK (resulting_creation_revision = expected_creation_revision + 1),
    CHECK (evidence_ref <> ''),
    CHECK (idempotency_key <> ''),
    CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
