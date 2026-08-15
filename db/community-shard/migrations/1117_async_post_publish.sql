PRAGMA foreign_keys = OFF;

CREATE TABLE posts_next (
    post_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    author_user_id TEXT,
    identity_mode TEXT NOT NULL CHECK (
        identity_mode IN ('public', 'anonymous')
    ),
    anonymous_scope TEXT CHECK (
        anonymous_scope IS NULL OR anonymous_scope IN ('community_stable', 'thread_stable', 'post_ephemeral')
    ),
    anonymous_label TEXT,
    disclosed_qualifiers_json TEXT,
    label_id TEXT,
    post_type TEXT NOT NULL CHECK (
        post_type IN ('text', 'image', 'video', 'link', 'song', 'crosspost')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'processing', 'published', 'failed', 'hidden', 'removed', 'deleted')
    ),
    song_mode TEXT CHECK (
        song_mode IS NULL OR song_mode IN ('original', 'remix')
    ),
    title TEXT,
    body TEXT,
    caption TEXT,
    lyrics TEXT,
    link_url TEXT,
    media_refs_json TEXT,
    song_artifact_bundle_id TEXT,
    source_language TEXT,
    translation_policy TEXT CHECK (
        translation_policy IS NULL OR translation_policy IN ('none', 'machine_allowed', 'human_only', 'hybrid')
    ),
    rights_basis TEXT CHECK (
        rights_basis IS NULL OR rights_basis IN ('none', 'original', 'derivative', 'attribution_only')
    ),
    asset_id TEXT,
    parent_post_id TEXT,
    analysis_state TEXT NOT NULL CHECK (
        analysis_state IN ('pending', 'allow', 'allow_with_required_reference', 'review_required', 'blocked')
    ),
    analysis_result_ref TEXT,
    content_safety_state TEXT NOT NULL CHECK (
        content_safety_state IN ('pending', 'safe', 'sensitive', 'adult')
    ),
    age_gate_policy TEXT NOT NULL CHECK (
        age_gate_policy IN ('none', '18_plus')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL DEFAULT '',
    idempotency_body_hash TEXT,
    publish_failure_code TEXT CHECK (
        publish_failure_code IS NULL OR publish_failure_code IN (
            'song_analysis_blocked',
            'song_analysis_review_required',
            'song_rights_reference_required',
            'song_preview_generation_failed',
            'text_moderation_blocked',
            'story_royalty_registration_failed',
            'story_locked_delivery_failed',
            'listing_creation_failed',
            'catalog_sync_failed',
            'provider_unavailable',
            'internal_error'
        )
    ),
    publish_failure_message TEXT,
    publish_failure_retryable INTEGER CHECK (
        publish_failure_retryable IS NULL OR publish_failure_retryable IN (0, 1)
    ),
    publish_failed_at TEXT,
    flair_id TEXT,
    access_mode TEXT CHECK (
        access_mode IS NULL OR access_mode IN ('public', 'locked')
    ),
    upstream_asset_refs_json TEXT,
    comment_count INTEGER NOT NULL DEFAULT 0,
    top_level_comment_count INTEGER NOT NULL DEFAULT 0,
    last_comment_at TEXT,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (
        visibility IN ('public', 'members_only')
    ),
    authorship_mode TEXT NOT NULL DEFAULT 'human_direct' CHECK (
        authorship_mode IN ('human_direct', 'user_agent')
    ),
    agent_id TEXT,
    agent_ownership_record_id TEXT,
    agent_display_name_snapshot TEXT,
    agent_owner_handle_snapshot TEXT,
    agent_ownership_provider_snapshot TEXT,
    label_assignment_status TEXT CHECK (
        label_assignment_status IS NULL
        OR label_assignment_status IN ('pending', 'assigned', 'failed', 'skipped')
    ),
    label_assigned_by TEXT CHECK (
        label_assigned_by IS NULL
        OR label_assigned_by IN ('ai', 'moderator')
    ),
    label_assigned_at TEXT,
    label_ai_confidence REAL,
    label_assignment_error TEXT,
    label_assignment_model TEXT,
    label_assignment_result_json TEXT,
    agent_handle_snapshot TEXT,
    link_og_image_url TEXT,
    link_og_title TEXT,
    embeds_json TEXT,
    link_enrichment_snapshot_json TEXT,
    link_enrichment_synced_at TEXT,
    song_title TEXT,
    song_cover_art_ref TEXT,
    song_duration_ms INTEGER,
    crosspost_source_json TEXT,
    song_annotations_url TEXT,
    source_start_ms INTEGER,
    source_duration_ms INTEGER,
    sync_offset_ms INTEGER,
    source_language_confidence REAL,
    source_language_reliable INTEGER NOT NULL DEFAULT 0,
    source_language_detector TEXT,
    source_language_detected_at TEXT,
    source_language_source_hash TEXT,
    song_instrumental_audio_json TEXT,
    song_vocal_audio_json TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (label_id) REFERENCES labels(label_id),
    FOREIGN KEY (parent_post_id) REFERENCES posts_next(post_id)
);

INSERT INTO posts_next (
    post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
    disclosed_qualifiers_json, label_id, post_type, status, song_mode, title, body, caption,
    lyrics, link_url, media_refs_json, song_artifact_bundle_id, source_language,
    translation_policy, rights_basis, asset_id, parent_post_id, analysis_state,
    analysis_result_ref, content_safety_state, age_gate_policy, created_at, updated_at,
    idempotency_key, flair_id, access_mode, upstream_asset_refs_json, comment_count,
    top_level_comment_count, last_comment_at, visibility, authorship_mode, agent_id,
    agent_ownership_record_id, agent_display_name_snapshot, agent_owner_handle_snapshot,
    agent_ownership_provider_snapshot, label_assignment_status, label_assigned_by,
    label_assigned_at, label_ai_confidence, label_assignment_error, label_assignment_model,
    label_assignment_result_json, agent_handle_snapshot, link_og_image_url, link_og_title,
    embeds_json, link_enrichment_snapshot_json, link_enrichment_synced_at, song_title,
    song_cover_art_ref, song_duration_ms, crosspost_source_json, song_annotations_url,
    source_start_ms, source_duration_ms, sync_offset_ms, source_language_confidence,
    source_language_reliable, source_language_detector, source_language_detected_at,
    source_language_source_hash, song_instrumental_audio_json, song_vocal_audio_json
)
SELECT
    post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
    disclosed_qualifiers_json, label_id, post_type, status, song_mode, title, body, caption,
    lyrics, link_url, media_refs_json, song_artifact_bundle_id, source_language,
    translation_policy, rights_basis, asset_id, parent_post_id, analysis_state,
    analysis_result_ref, content_safety_state, age_gate_policy, created_at, updated_at,
    idempotency_key, flair_id, access_mode, upstream_asset_refs_json, comment_count,
    top_level_comment_count, last_comment_at, visibility, authorship_mode, agent_id,
    agent_ownership_record_id, agent_display_name_snapshot, agent_owner_handle_snapshot,
    agent_ownership_provider_snapshot, label_assignment_status, label_assigned_by,
    label_assigned_at, label_ai_confidence, label_assignment_error, label_assignment_model,
    label_assignment_result_json, agent_handle_snapshot, link_og_image_url, link_og_title,
    embeds_json, link_enrichment_snapshot_json, link_enrichment_synced_at, song_title,
    song_cover_art_ref, song_duration_ms, crosspost_source_json, song_annotations_url,
    source_start_ms, source_duration_ms, sync_offset_ms, source_language_confidence,
    source_language_reliable, source_language_detector, source_language_detected_at,
    source_language_source_hash, song_instrumental_audio_json, song_vocal_audio_json
FROM posts;

DROP TABLE posts;
ALTER TABLE posts_next RENAME TO posts;

CREATE INDEX idx_posts_community_created
    ON posts(community_id, created_at DESC);

CREATE INDEX idx_posts_parent
    ON posts(parent_post_id, created_at);

CREATE INDEX idx_posts_author
    ON posts(author_user_id, created_at DESC);

CREATE UNIQUE INDEX idx_posts_author_idempotency
    ON posts(community_id, author_user_id, idempotency_key)
    WHERE author_user_id IS NOT NULL AND idempotency_key <> '';

CREATE INDEX idx_posts_agent_authorship
    ON posts(authorship_mode, agent_id, created_at DESC);

CREATE TABLE post_publish_requests (
    post_publish_request_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    publish_mode TEXT NOT NULL CHECK (
        publish_mode IN ('sync', 'async')
    ),
    request_body_hash TEXT NOT NULL,
    listing_draft_json TEXT,
    publish_options_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'running', 'succeeded', 'failed')
    ),
    failure_code TEXT CHECK (
        failure_code IS NULL OR failure_code IN (
            'song_analysis_blocked',
            'song_analysis_review_required',
            'song_rights_reference_required',
            'song_preview_generation_failed',
            'text_moderation_blocked',
            'story_royalty_registration_failed',
            'story_locked_delivery_failed',
            'listing_creation_failed',
            'catalog_sync_failed',
            'provider_unavailable',
            'internal_error'
        )
    ),
    failure_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    UNIQUE (community_id, post_id)
);

CREATE INDEX idx_post_publish_requests_status
    ON post_publish_requests(community_id, status, updated_at);

CREATE UNIQUE INDEX idx_community_jobs_active_subject
    ON community_jobs(community_id, job_type, subject_type, subject_id)
    WHERE status IN ('queued', 'running');

PRAGMA foreign_keys = ON;
