ALTER TABLE communities
  ADD COLUMN karaoke_enabled INTEGER NOT NULL DEFAULT 0 CHECK (karaoke_enabled IN (0, 1));
