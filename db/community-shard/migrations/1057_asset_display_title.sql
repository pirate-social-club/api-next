ALTER TABLE assets
    ADD COLUMN display_title TEXT;

UPDATE assets
SET display_title = (
    SELECT NULLIF(TRIM(posts.title), '')
    FROM posts
    WHERE posts.post_id = assets.source_post_id
)
WHERE display_title IS NULL;
