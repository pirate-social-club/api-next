PRAGMA foreign_keys = ON;

ALTER TABLE comments
    ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX idx_comments_author_idempotency
    ON comments(community_id, author_user_id, idempotency_key)
    WHERE author_user_id IS NOT NULL AND idempotency_key <> '';
