ALTER TABLE community_localization_meta ADD COLUMN source_language_confidence REAL;
ALTER TABLE community_localization_meta ADD COLUMN source_language_reliable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_localization_meta ADD COLUMN source_language_detector TEXT;
ALTER TABLE community_localization_meta ADD COLUMN source_language_detected_at TEXT;
