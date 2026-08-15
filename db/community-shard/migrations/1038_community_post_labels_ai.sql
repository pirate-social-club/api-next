ALTER TABLE labels
ADD COLUMN color_token TEXT;

ALTER TABLE posts
ADD COLUMN label_assignment_status TEXT CHECK (
    label_assignment_status IS NULL
    OR label_assignment_status IN ('pending', 'assigned', 'failed', 'skipped')
);

ALTER TABLE posts
ADD COLUMN label_assigned_by TEXT CHECK (
    label_assigned_by IS NULL
    OR label_assigned_by IN ('ai', 'moderator')
);

ALTER TABLE posts
ADD COLUMN label_assigned_at TEXT;

ALTER TABLE posts
ADD COLUMN label_ai_confidence REAL;

ALTER TABLE posts
ADD COLUMN label_assignment_error TEXT;

ALTER TABLE posts
ADD COLUMN label_assignment_model TEXT;

ALTER TABLE posts
ADD COLUMN label_assignment_result_json TEXT;

UPDATE posts
SET label_assignment_status = CASE
    WHEN label_id IS NULL THEN 'pending'
    ELSE 'assigned'
END
WHERE label_assignment_status IS NULL;
