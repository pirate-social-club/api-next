PRAGMA foreign_keys = ON;

ALTER TABLE posts
    ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX idx_posts_author_idempotency
    ON posts(community_id, author_user_id, idempotency_key)
    WHERE author_user_id IS NOT NULL AND idempotency_key <> '';
