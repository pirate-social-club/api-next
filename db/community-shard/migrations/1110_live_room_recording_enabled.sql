ALTER TABLE live_rooms ADD COLUMN recording_enabled INTEGER DEFAULT 0 CHECK (recording_enabled IS NULL OR recording_enabled IN (0, 1));
