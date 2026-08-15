ALTER TABLE posts
    ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE posts
    ADD COLUMN top_level_comment_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE posts
    ADD COLUMN last_comment_at TEXT;
