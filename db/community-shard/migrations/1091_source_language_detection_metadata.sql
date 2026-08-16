ALTER TABLE posts ADD COLUMN source_language_confidence REAL;
ALTER TABLE posts ADD COLUMN source_language_reliable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN source_language_detector TEXT;
ALTER TABLE posts ADD COLUMN source_language_detected_at TEXT;
ALTER TABLE posts ADD COLUMN source_language_source_hash TEXT;

ALTER TABLE comments ADD COLUMN source_language_confidence REAL;
ALTER TABLE comments ADD COLUMN source_language_reliable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN source_language_detector TEXT;
ALTER TABLE comments ADD COLUMN source_language_detected_at TEXT;
ALTER TABLE comments ADD COLUMN source_language_source_hash TEXT;
