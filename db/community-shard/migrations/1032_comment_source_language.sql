ALTER TABLE comments
ADD COLUMN source_language TEXT;

CREATE INDEX idx_comments_thread_source_language
    ON comments(thread_root_post_id, source_language, created_at DESC);
