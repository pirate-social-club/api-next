ALTER TABLE communities
  ADD COLUMN study_enabled INTEGER NOT NULL DEFAULT 0 CHECK (study_enabled IN (0, 1));
