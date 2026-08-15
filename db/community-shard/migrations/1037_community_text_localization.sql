CREATE TABLE community_localization_meta (
    community_localization_meta_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    field_key TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    source_language TEXT,
    translation_policy TEXT NOT NULL CHECK (
        translation_policy IN ('none', 'machine_allowed', 'human_only', 'hybrid')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (community_localization_meta_id),
    UNIQUE (community_id, field_key),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_localization_meta_updated
    ON community_localization_meta(community_id, updated_at DESC);

ALTER TABLE content_translations RENAME TO content_translations_legacy;

CREATE TABLE content_translations (
    content_translation_id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL CHECK (
        content_type IN ('post', 'comment', 'community_text')
    ),
    content_id TEXT NOT NULL,
    field_key TEXT NOT NULL DEFAULT '',
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
    updated_at TEXT NOT NULL,
    translated_title TEXT
);

INSERT INTO content_translations (
    content_translation_id,
    content_type,
    content_id,
    field_key,
    locale,
    source_hash,
    source_language,
    outcome,
    translated_body,
    translated_caption,
    provider,
    provider_model,
    provider_result_json,
    created_at,
    updated_at,
    translated_title
)
SELECT
    content_translation_id,
    content_type,
    content_id,
    '',
    locale,
    source_hash,
    source_language,
    outcome,
    translated_body,
    translated_caption,
    provider,
    provider_model,
    provider_result_json,
    created_at,
    updated_at,
    translated_title
FROM content_translations_legacy;

DROP TABLE content_translations_legacy;

CREATE UNIQUE INDEX idx_content_translations_lookup
    ON content_translations(content_type, content_id, field_key, locale, source_hash);

CREATE INDEX idx_content_translations_content_updated
    ON content_translations(content_type, content_id, field_key, updated_at DESC);
