-- Idempotency receipt for cross-shard user consolidation. Account-owned study and
-- activity rows are merged by the API before this receipt is committed.
CREATE TABLE user_account_merge_receipts (
    user_account_merge_id TEXT PRIMARY KEY,
    source_user_id TEXT NOT NULL,
    canonical_user_id TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CONSTRAINT user_account_merge_receipts_distinct_users_check
        CHECK (source_user_id <> canonical_user_id)
);

CREATE INDEX idx_user_account_merge_receipts_canonical
    ON user_account_merge_receipts(canonical_user_id, completed_at);
