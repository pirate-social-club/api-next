ALTER TABLE posts
ADD COLUMN agent_handle_snapshot TEXT;

ALTER TABLE comments
ADD COLUMN agent_handle_snapshot TEXT;
