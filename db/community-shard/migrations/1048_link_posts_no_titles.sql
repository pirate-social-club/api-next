UPDATE posts
SET title = NULL
WHERE post_type = 'link'
  AND title IS NOT NULL;
