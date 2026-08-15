CREATE TABLE content_translations (
    content_translation_id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL CHECK (
        content_type IN ('post', 'comment')
    ),
    content_id TEXT NOT NULL,
    locale TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    source_language TEXT,
    outcome TEXT NOT NULL CHECK (
        outcome IN ('translated', 'same_language')
    ),
    translated_body TEXT,
    translated_caption TEXT,
    provider TEXT,
    provider_model TEXT,
    provider_result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_content_translations_lookup
    ON content_translations(content_type, content_id, locale, source_hash);

CREATE INDEX idx_content_translations_content_updated
    ON content_translations(content_type, content_id, updated_at DESC);
