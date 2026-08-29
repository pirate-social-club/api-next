-- Fence every mutable Study review pointer and immutable session snapshot to
-- the exact account-scoped review key and compatible exercise version.

ALTER TABLE study_exercise_versions
  ADD CONSTRAINT study_exercise_version_review_identity_unique
    UNIQUE (exercise_version_id, exercise_review_key);

ALTER TABLE study_review_items
  ADD CONSTRAINT study_review_item_account_identity_unique
    UNIQUE (review_item_id, account_id, exercise_review_key),
  ADD CONSTRAINT study_review_current_version_identity_fk
    FOREIGN KEY (current_exercise_version_id, exercise_review_key)
    REFERENCES study_exercise_versions (exercise_version_id, exercise_review_key);

ALTER TABLE study_sessions_v2
  ADD CONSTRAINT study_session_account_identity_unique UNIQUE (session_id, account_id);

ALTER TABLE study_session_items_v2
  ADD COLUMN account_id TEXT;

UPDATE study_session_items_v2 AS item
   SET account_id = session.account_id
  FROM study_sessions_v2 AS session
 WHERE session.session_id = item.session_id;

ALTER TABLE study_session_items_v2
  ALTER COLUMN account_id SET NOT NULL,
  ADD CONSTRAINT study_session_item_session_account_fk
    FOREIGN KEY (session_id, account_id)
    REFERENCES study_sessions_v2 (session_id, account_id),
  ADD CONSTRAINT study_session_item_exercise_identity_fk
    FOREIGN KEY (exercise_version_id, exercise_review_key)
    REFERENCES study_exercise_versions (exercise_version_id, exercise_review_key),
  ADD CONSTRAINT study_session_item_review_identity_fk
    FOREIGN KEY (review_item_id, account_id, exercise_review_key)
    REFERENCES study_review_items (review_item_id, account_id, exercise_review_key);
