ALTER TABLE comments
    ADD COLUMN media_refs_json TEXT NOT NULL DEFAULT '[]';
