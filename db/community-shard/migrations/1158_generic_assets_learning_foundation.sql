-- Install the generic asset, enforcement, and dormant learning foundation in
-- one fleet sweep. New FK holders are created only after posts and assets have
-- their canonical names again.
PRAGMA foreign_keys = OFF;

CREATE TABLE posts_next (
    post_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    author_user_id TEXT,
    identity_mode TEXT NOT NULL CHECK (identity_mode IN ('public', 'anonymous')),
    anonymous_scope TEXT CHECK (
        anonymous_scope IS NULL OR anonymous_scope IN ('community_stable', 'thread_stable', 'post_ephemeral')
    ),
    anonymous_label TEXT,
    disclosed_qualifiers_json TEXT,
    label_id TEXT,
    post_type TEXT NOT NULL CHECK (
        post_type IN ('text', 'image', 'video', 'link', 'song', 'crosspost', 'file', 'deck')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'processing', 'published', 'failed', 'hidden', 'removed', 'deleted')
    ),
    song_mode TEXT CHECK (song_mode IS NULL OR song_mode IN ('original', 'remix')),
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
    age_gate_policy TEXT NOT NULL CHECK (age_gate_policy IN ('none', '18_plus')),
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
            'internal_error',
            'payload_verification_failed',
            'payload_safety_blocked',
            'payload_safety_review_required',
            'payload_claim_failed',
            'deck_package_generation_failed',
            'deck_package_hash_mismatch'
        )
    ),
    publish_failure_message TEXT,
    publish_failure_retryable INTEGER CHECK (
        publish_failure_retryable IS NULL OR publish_failure_retryable IN (0, 1)
    ),
    publish_failed_at TEXT,
    flair_id TEXT,
    access_mode TEXT CHECK (access_mode IS NULL OR access_mode IN ('public', 'locked')),
    upstream_asset_refs_json TEXT,
    comment_count INTEGER NOT NULL DEFAULT 0,
    top_level_comment_count INTEGER NOT NULL DEFAULT 0,
    last_comment_at TEXT,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'members_only')),
    authorship_mode TEXT NOT NULL DEFAULT 'human_direct' CHECK (
        authorship_mode IN ('human_direct', 'user_agent')
    ),
    agent_id TEXT,
    agent_ownership_record_id TEXT,
    agent_display_name_snapshot TEXT,
    agent_owner_handle_snapshot TEXT,
    agent_ownership_provider_snapshot TEXT,
    label_assignment_status TEXT CHECK (
        label_assignment_status IS NULL OR label_assignment_status IN ('pending', 'assigned', 'failed', 'skipped')
    ),
    label_assigned_by TEXT CHECK (
        label_assigned_by IS NULL OR label_assigned_by IN ('ai', 'moderator')
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
    lyrics_language TEXT,
    lyrics_language_confidence REAL,
    lyrics_language_reliable INTEGER NOT NULL DEFAULT 0,
    lyrics_language_detector TEXT,
    lyrics_language_detected_at TEXT,
    lyrics_language_source_hash TEXT,
    age_gate_source TEXT CHECK (
        age_gate_source IS NULL OR age_gate_source IN (
            'author', 'community_default', 'post_moderation', 'bundle_moderation',
            'moderator', 'legacy_unknown'
        )
    ),
    age_gate_evidence_ref TEXT,
    age_gate_set_at TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (label_id) REFERENCES labels(label_id),
    FOREIGN KEY (parent_post_id) REFERENCES posts_next(post_id)
);

INSERT INTO posts_next (
    post_id, community_id, author_user_id, identity_mode, anonymous_scope,
    anonymous_label, disclosed_qualifiers_json, label_id, post_type, status,
    song_mode, title, body, caption, lyrics, link_url, media_refs_json,
    song_artifact_bundle_id, source_language, translation_policy, rights_basis,
    asset_id, parent_post_id, analysis_state, analysis_result_ref,
    content_safety_state, age_gate_policy, created_at, updated_at,
    idempotency_key, idempotency_body_hash, publish_failure_code,
    publish_failure_message, publish_failure_retryable, publish_failed_at,
    flair_id, access_mode, upstream_asset_refs_json, comment_count,
    top_level_comment_count, last_comment_at, visibility, authorship_mode,
    agent_id, agent_ownership_record_id, agent_display_name_snapshot,
    agent_owner_handle_snapshot, agent_ownership_provider_snapshot,
    label_assignment_status, label_assigned_by, label_assigned_at,
    label_ai_confidence, label_assignment_error, label_assignment_model,
    label_assignment_result_json, agent_handle_snapshot, link_og_image_url,
    link_og_title, embeds_json, link_enrichment_snapshot_json,
    link_enrichment_synced_at, song_title, song_cover_art_ref, song_duration_ms,
    crosspost_source_json, song_annotations_url, source_start_ms,
    source_duration_ms, sync_offset_ms, source_language_confidence,
    source_language_reliable, source_language_detector,
    source_language_detected_at, source_language_source_hash,
    song_instrumental_audio_json, song_vocal_audio_json, lyrics_language,
    lyrics_language_confidence, lyrics_language_reliable,
    lyrics_language_detector, lyrics_language_detected_at,
    lyrics_language_source_hash, age_gate_source, age_gate_evidence_ref,
    age_gate_set_at
)
SELECT
    post_id, community_id, author_user_id, identity_mode, anonymous_scope,
    anonymous_label, disclosed_qualifiers_json, label_id, post_type, status,
    song_mode, title, body, caption, lyrics, link_url, media_refs_json,
    song_artifact_bundle_id, source_language, translation_policy, rights_basis,
    asset_id, parent_post_id, analysis_state, analysis_result_ref,
    content_safety_state, age_gate_policy, created_at, updated_at,
    idempotency_key, idempotency_body_hash, publish_failure_code,
    publish_failure_message, publish_failure_retryable, publish_failed_at,
    flair_id, access_mode, upstream_asset_refs_json, comment_count,
    top_level_comment_count, last_comment_at, visibility, authorship_mode,
    agent_id, agent_ownership_record_id, agent_display_name_snapshot,
    agent_owner_handle_snapshot, agent_ownership_provider_snapshot,
    label_assignment_status, label_assigned_by, label_assigned_at,
    label_ai_confidence, label_assignment_error, label_assignment_model,
    label_assignment_result_json, agent_handle_snapshot, link_og_image_url,
    link_og_title, embeds_json, link_enrichment_snapshot_json,
    link_enrichment_synced_at, song_title, song_cover_art_ref, song_duration_ms,
    crosspost_source_json, song_annotations_url, source_start_ms,
    source_duration_ms, sync_offset_ms, source_language_confidence,
    source_language_reliable, source_language_detector,
    source_language_detected_at, source_language_source_hash,
    song_instrumental_audio_json, song_vocal_audio_json, lyrics_language,
    lyrics_language_confidence, lyrics_language_reliable,
    lyrics_language_detector, lyrics_language_detected_at,
    lyrics_language_source_hash, age_gate_source, age_gate_evidence_ref,
    age_gate_set_at
FROM posts;
DROP TABLE posts;
ALTER TABLE posts_next RENAME TO posts;

CREATE INDEX idx_posts_community_created ON posts(community_id, created_at DESC);
CREATE INDEX idx_posts_parent ON posts(parent_post_id, created_at);
CREATE INDEX idx_posts_author ON posts(author_user_id, created_at DESC);
CREATE UNIQUE INDEX idx_posts_author_idempotency
    ON posts(community_id, author_user_id, idempotency_key)
    WHERE author_user_id IS NOT NULL AND idempotency_key <> '';
CREATE INDEX idx_posts_agent_authorship ON posts(authorship_mode, agent_id, created_at DESC);

CREATE TABLE assets_next (
    asset_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    source_post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT,
    creator_user_id TEXT NOT NULL,
    asset_kind TEXT NOT NULL CHECK (
        asset_kind IN ('song_audio', 'video_file', 'download_file', 'learning_deck')
    ),
    rights_basis TEXT NOT NULL CHECK (
        rights_basis IN ('none', 'original', 'derivative', 'attribution_only')
    ),
    access_mode TEXT NOT NULL CHECK (access_mode IN ('public', 'locked')),
    primary_content_ref TEXT,
    primary_content_hash TEXT,
    publication_status TEXT NOT NULL CHECK (
        publication_status IN ('draft', 'story_requested', 'story_published', 'story_failed', 'withdrawn')
    ),
    story_status TEXT NOT NULL CHECK (story_status IN ('none', 'requested', 'published', 'failed')),
    story_error TEXT,
    story_ip_id TEXT,
    locked_delivery_status TEXT NOT NULL CHECK (
        locked_delivery_status IN ('none', 'requested', 'ready', 'failed')
    ),
    locked_delivery_ref TEXT,
    locked_delivery_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    story_publish_tx_ref TEXT,
    story_asset_version_id TEXT,
    story_cdr_vault_uuid INTEGER,
    story_namespace TEXT,
    story_entitlement_token_id TEXT,
    story_read_condition TEXT,
    story_write_condition TEXT,
    preview_audio_json TEXT,
    cover_art_json TEXT,
    canvas_video_json TEXT,
    locked_delivery_payload_json TEXT,
    locked_delivery_storage_ref TEXT,
    locked_delivery_secret_json TEXT,
    story_ip_nft_contract TEXT,
    story_ip_nft_token_id TEXT,
    story_publish_model TEXT NOT NULL DEFAULT 'pirate_v1' CHECK (
        story_publish_model IN ('pirate_v1', 'story_ip_v1')
    ),
    story_license_terms_id TEXT,
    story_license_template TEXT,
    story_royalty_policy TEXT,
    story_derivative_registered_at TEXT,
    story_revenue_token TEXT,
    story_cdr_encrypted_cid TEXT,
    story_cdr_allocate_tx_ref TEXT,
    story_cdr_write_tx_ref TEXT,
    story_royalty_policy_id TEXT,
    story_derivative_parent_ip_ids_json TEXT,
    story_royalty_registration_status TEXT NOT NULL DEFAULT 'none' CHECK (
        story_royalty_registration_status IN ('none', 'pending', 'registered', 'failed')
    ),
    license_preset TEXT CHECK (
        license_preset IN ('non-commercial', 'commercial-use', 'commercial-remix')
    ),
    commercial_rev_share_pct INTEGER CHECK (
        commercial_rev_share_pct IS NULL OR (commercial_rev_share_pct >= 0 AND commercial_rev_share_pct <= 100)
    ),
    display_title TEXT,
    royalty_allocation_status TEXT NOT NULL DEFAULT 'none' CHECK (
        royalty_allocation_status IN (
            'none', 'draft', 'registration_pending', 'verification_pending', 'verified',
            'registration_failed', 'verification_failed', 'legacy_unverified'
        )
    ),
    royalty_allocation_fingerprint TEXT,
    royalty_allocation_version INTEGER NOT NULL DEFAULT 1,
    royalty_allocation_effect_key TEXT,
    royalty_allocation_tx_hash TEXT,
    ip_royalty_vault TEXT,
    royalty_vault_total_supply TEXT,
    royalty_vault_decimals INTEGER,
    royalty_allocation_registered_at TEXT,
    royalty_allocation_projection_synced INTEGER NOT NULL DEFAULT 1 CHECK (
        royalty_allocation_projection_synced IN (0, 1)
    ),
    story_ip_metadata_uri TEXT,
    story_ip_metadata_hash TEXT,
    story_nft_metadata_uri TEXT,
    story_nft_metadata_hash TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (source_post_id) REFERENCES posts(post_id),
    CONSTRAINT assets_primary_content_ref_kind_check CHECK (
        (asset_kind IN ('song_audio', 'video_file') AND primary_content_ref IS NOT NULL)
        OR
        (asset_kind IN ('download_file', 'learning_deck') AND primary_content_ref IS NULL)
    )
);

INSERT INTO assets_next (
    asset_id, community_id, source_post_id, song_artifact_bundle_id,
    creator_user_id, asset_kind, rights_basis, access_mode,
    primary_content_ref, primary_content_hash, preview_audio_json,
    cover_art_json, canvas_video_json, publication_status, story_status,
    story_error, story_ip_id, story_publish_tx_ref, story_asset_version_id,
    story_cdr_vault_uuid, story_namespace, story_entitlement_token_id,
    story_read_condition, story_write_condition, story_ip_nft_contract,
    story_ip_nft_token_id, story_publish_model, story_license_terms_id,
    story_license_template, story_royalty_policy,
    story_derivative_registered_at, story_revenue_token,
    story_cdr_encrypted_cid, story_cdr_allocate_tx_ref,
    story_cdr_write_tx_ref, story_royalty_policy_id,
    story_derivative_parent_ip_ids_json, story_royalty_registration_status,
    license_preset, commercial_rev_share_pct, locked_delivery_status,
    locked_delivery_ref, locked_delivery_error, locked_delivery_payload_json,
    locked_delivery_storage_ref, locked_delivery_secret_json, display_title,
    created_at, updated_at, royalty_allocation_status,
    royalty_allocation_fingerprint, royalty_allocation_version,
    royalty_allocation_effect_key, royalty_allocation_tx_hash,
    ip_royalty_vault, royalty_vault_total_supply, royalty_vault_decimals,
    royalty_allocation_registered_at, royalty_allocation_projection_synced,
    story_ip_metadata_uri, story_ip_metadata_hash, story_nft_metadata_uri,
    story_nft_metadata_hash
)
SELECT
    asset_id, community_id, source_post_id, song_artifact_bundle_id,
    creator_user_id, asset_kind, rights_basis, access_mode,
    primary_content_ref, primary_content_hash, preview_audio_json,
    cover_art_json, canvas_video_json, publication_status, story_status,
    story_error, story_ip_id, story_publish_tx_ref, story_asset_version_id,
    story_cdr_vault_uuid, story_namespace, story_entitlement_token_id,
    story_read_condition, story_write_condition, story_ip_nft_contract,
    story_ip_nft_token_id, story_publish_model, story_license_terms_id,
    story_license_template, story_royalty_policy,
    story_derivative_registered_at, story_revenue_token,
    story_cdr_encrypted_cid, story_cdr_allocate_tx_ref,
    story_cdr_write_tx_ref, story_royalty_policy_id,
    story_derivative_parent_ip_ids_json, story_royalty_registration_status,
    license_preset, commercial_rev_share_pct, locked_delivery_status,
    locked_delivery_ref, locked_delivery_error, locked_delivery_payload_json,
    locked_delivery_storage_ref, locked_delivery_secret_json, display_title,
    created_at, updated_at, royalty_allocation_status,
    royalty_allocation_fingerprint, royalty_allocation_version,
    royalty_allocation_effect_key, royalty_allocation_tx_hash,
    ip_royalty_vault, royalty_vault_total_supply, royalty_vault_decimals,
    royalty_allocation_registered_at, royalty_allocation_projection_synced,
    story_ip_metadata_uri, story_ip_metadata_hash, story_nft_metadata_uri,
    story_nft_metadata_hash
FROM assets;
DROP TABLE assets;
ALTER TABLE assets_next RENAME TO assets;

CREATE UNIQUE INDEX idx_assets_source_post ON assets(source_post_id);
CREATE INDEX idx_assets_community_created ON assets(community_id, created_at DESC);
CREATE INDEX idx_assets_story_status ON assets(story_status, created_at DESC);
CREATE INDEX idx_assets_story_asset_version_id ON assets(story_asset_version_id);
CREATE INDEX idx_assets_community_primary_content_hash ON assets(community_id, primary_content_hash);
CREATE INDEX idx_assets_story_publish_model ON assets(story_publish_model, created_at DESC);
CREATE INDEX idx_assets_story_ip_nft ON assets(story_ip_nft_contract, story_ip_nft_token_id);

CREATE TABLE post_publish_requests_next (
    post_publish_request_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    publish_mode TEXT NOT NULL CHECK (publish_mode IN ('sync', 'async')),
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
            'internal_error',
            'payload_verification_failed',
            'payload_safety_blocked',
            'payload_safety_review_required',
            'payload_claim_failed',
            'deck_package_generation_failed',
            'deck_package_hash_mismatch'
        )
    ),
    failure_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    UNIQUE (community_id, post_id)
);

INSERT INTO post_publish_requests_next (
    post_publish_request_id, community_id, post_id, publish_mode,
    request_body_hash, listing_draft_json, publish_options_json, status,
    failure_code, failure_message, created_at, updated_at
)
SELECT
    post_publish_request_id, community_id, post_id, publish_mode,
    request_body_hash, listing_draft_json, publish_options_json, status,
    failure_code, failure_message, created_at, updated_at
FROM post_publish_requests;
DROP TABLE post_publish_requests;
ALTER TABLE post_publish_requests_next RENAME TO post_publish_requests;
CREATE INDEX idx_post_publish_requests_status
    ON post_publish_requests(community_id, status, updated_at);

CREATE TABLE moderation_actions_next (
    moderation_action_id TEXT PRIMARY KEY,
    moderation_case_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT,
    comment_id TEXT,
    actor_user_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (
        action_type IN (
            'dismiss', 'hide', 'remove', 'restore', 'age_gate', 'set_content_rating',
            'quarantine_asset', 'block_asset', 'restore_asset'
        )
    ),
    note TEXT,
    created_at TEXT NOT NULL,
    previous_post_status TEXT CHECK (
        previous_post_status IN ('draft', 'published', 'hidden', 'removed', 'deleted')
    ),
    next_post_status TEXT CHECK (
        next_post_status IN ('draft', 'published', 'hidden', 'removed', 'deleted')
    ),
    previous_age_gate_policy TEXT CHECK (previous_age_gate_policy IN ('none', '18_plus')),
    next_age_gate_policy TEXT CHECK (next_age_gate_policy IN ('none', '18_plus')),
    previous_content_safety_state TEXT CHECK (
        previous_content_safety_state IN ('pending', 'safe', 'sensitive', 'adult')
    ),
    next_content_safety_state TEXT CHECK (
        next_content_safety_state IN ('safe', 'sensitive', 'adult')
    ),
    evidence_ref TEXT,
    asset_id TEXT,
    previous_asset_enforcement_state TEXT CHECK (
        previous_asset_enforcement_state IN ('active', 'quarantined', 'blocked')
    ),
    next_asset_enforcement_state TEXT CHECK (
        next_asset_enforcement_state IN ('active', 'quarantined', 'blocked')
    ),
    FOREIGN KEY (moderation_case_id) REFERENCES moderation_cases(moderation_case_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (comment_id) REFERENCES comments(comment_id),
    FOREIGN KEY (asset_id) REFERENCES assets(asset_id),
    CONSTRAINT moderation_actions_target_check CHECK (
        (comment_id IS NOT NULL AND post_id IS NULL AND asset_id IS NULL)
        OR
        (comment_id IS NULL AND post_id IS NOT NULL)
    ),
    CONSTRAINT moderation_actions_content_rating_audit_check CHECK (
        action_type != 'set_content_rating'
        OR (
            post_id IS NOT NULL
            AND previous_content_safety_state IS NOT NULL
            AND next_content_safety_state IS NOT NULL
            AND previous_age_gate_policy IS NOT NULL
            AND next_age_gate_policy IS NOT NULL
            AND evidence_ref IS NOT NULL
            AND length(trim(evidence_ref)) > 0
        )
    ),
    CONSTRAINT moderation_actions_asset_audit_check CHECK (
        (asset_id IS NULL
            AND previous_asset_enforcement_state IS NULL
            AND next_asset_enforcement_state IS NULL)
        OR
        (asset_id IS NOT NULL
            AND post_id IS NOT NULL
            AND previous_post_status IS NOT NULL
            AND next_post_status IS NOT NULL
            AND (
                previous_asset_enforcement_state IS NOT NULL
                OR action_type IN ('hide', 'remove', 'quarantine_asset', 'block_asset')
            )
            AND next_asset_enforcement_state IS NOT NULL
            AND evidence_ref IS NOT NULL
            AND length(trim(evidence_ref)) > 0)
    ),
    CONSTRAINT moderation_actions_asset_action_check CHECK (
        (action_type NOT IN ('quarantine_asset', 'block_asset', 'restore_asset'))
        OR asset_id IS NOT NULL
    ),
    CONSTRAINT moderation_actions_asset_transition_check CHECK (
        (asset_id IS NULL)
        OR (action_type IN ('hide', 'quarantine_asset')
            AND next_post_status = 'hidden'
            AND next_asset_enforcement_state = 'quarantined')
        OR (action_type IN ('remove', 'block_asset')
            AND next_post_status = 'removed'
            AND next_asset_enforcement_state = 'blocked')
        OR (action_type IN ('restore', 'restore_asset')
            AND next_post_status = 'published'
            AND next_asset_enforcement_state = 'active')
    )
);

INSERT INTO moderation_actions_next (
    moderation_action_id, moderation_case_id, community_id, post_id, comment_id,
    actor_user_id, action_type, note, created_at, previous_post_status,
    next_post_status, previous_age_gate_policy, next_age_gate_policy,
    previous_content_safety_state, next_content_safety_state, evidence_ref
)
SELECT
    moderation_action_id, moderation_case_id, community_id, post_id, comment_id,
    actor_user_id, action_type, note, created_at, previous_post_status,
    next_post_status, previous_age_gate_policy, next_age_gate_policy,
    previous_content_safety_state, next_content_safety_state, evidence_ref
FROM moderation_actions;

DROP TABLE moderation_actions;
ALTER TABLE moderation_actions_next RENAME TO moderation_actions;
CREATE INDEX idx_moderation_actions_case_created
    ON moderation_actions(moderation_case_id, created_at DESC);
CREATE INDEX idx_moderation_actions_community_created
    ON moderation_actions(community_id, created_at DESC);
CREATE INDEX idx_moderation_actions_post_created
    ON moderation_actions(post_id, created_at DESC);
CREATE INDEX idx_moderation_actions_comment_created
    ON moderation_actions(comment_id, created_at DESC);
CREATE INDEX idx_moderation_actions_asset_created
    ON moderation_actions(asset_id, created_at DESC);

CREATE TABLE asset_payloads (
    asset_payload_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('primary', 'preview', 'supplementary')),
    payload_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'withdrawn')),
    content_blob_ref TEXT NOT NULL,
    payload_format TEXT NOT NULL,
    delivery_behavior TEXT NOT NULL CHECK (
        delivery_behavior IN ('download', 'app_native', 'audio', 'video')
    ),
    display_filename TEXT,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE,
    UNIQUE (asset_id, role, payload_version),
    CONSTRAINT asset_payloads_download_filename_check CHECK (
        delivery_behavior <> 'download' OR display_filename IS NOT NULL
    )
);

CREATE UNIQUE INDEX idx_asset_payloads_active_primary
    ON asset_payloads(asset_id)
    WHERE role = 'primary' AND status = 'active';
CREATE INDEX idx_asset_payloads_content_blob_ref ON asset_payloads(content_blob_ref);

CREATE TABLE asset_enforcement (
    asset_id TEXT PRIMARY KEY,
    enforcement_state TEXT NOT NULL CHECK (
        enforcement_state IN ('active', 'quarantined', 'blocked')
    ),
    reason_code TEXT,
    authority_kind TEXT NOT NULL CHECK (
        authority_kind IN ('asset_create', 'analysis_result', 'moderation_action', 'legal_hold')
    ),
    authority_ref TEXT NOT NULL,
    moderation_action_id TEXT,
    actor_role TEXT,
    evidence_ref TEXT,
    decided_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE,
    FOREIGN KEY (moderation_action_id) REFERENCES moderation_actions(moderation_action_id),
    CONSTRAINT asset_enforcement_reason_check CHECK (
        enforcement_state = 'active' OR reason_code IS NOT NULL
    ),
    CONSTRAINT asset_enforcement_authority_check CHECK (
        (authority_kind = 'moderation_action') = (moderation_action_id IS NOT NULL)
    )
);

CREATE INDEX idx_asset_enforcement_state_updated
    ON asset_enforcement(enforcement_state, updated_at);

CREATE TRIGGER moderation_actions_asset_previous_state_match_guard
BEFORE INSERT ON moderation_actions
WHEN NEW.asset_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM asset_enforcement
    WHERE asset_id = NEW.asset_id
      AND enforcement_state IS NOT NEW.previous_asset_enforcement_state
)
BEGIN
    SELECT RAISE(ABORT, 'asset enforcement state changed concurrently');
END;

CREATE TRIGGER moderation_actions_asset_missing_state_guard
BEFORE INSERT ON moderation_actions
WHEN NEW.asset_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM asset_enforcement WHERE asset_id = NEW.asset_id)
  AND (
      NEW.previous_asset_enforcement_state IS NOT NULL
      OR NEW.action_type NOT IN ('hide', 'remove', 'quarantine_asset', 'block_asset')
  )
BEGIN
    SELECT RAISE(ABORT, 'asset enforcement state is missing');
END;

CREATE TABLE learning_decks (
    learning_deck_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    creator_user_id TEXT NOT NULL,
    source_post_id TEXT,
    asset_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
    active_draft_version INTEGER NOT NULL DEFAULT 1,
    published_version INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (source_post_id) REFERENCES posts(post_id),
    FOREIGN KEY (asset_id) REFERENCES assets(asset_id),
    CONSTRAINT learning_decks_publication_shape_check CHECK (
        (status = 'draft' AND source_post_id IS NULL AND asset_id IS NULL AND published_version IS NULL)
        OR
        (status IN ('published', 'archived') AND source_post_id IS NOT NULL
            AND asset_id IS NOT NULL AND published_version IS NOT NULL)
    )
);

CREATE INDEX idx_learning_decks_community_status
    ON learning_decks(community_id, status, updated_at DESC);
CREATE INDEX idx_learning_decks_source_post ON learning_decks(source_post_id);
CREATE INDEX idx_learning_decks_asset ON learning_decks(asset_id);

CREATE TABLE learning_deck_versions (
    learning_deck_version_id TEXT PRIMARY KEY,
    learning_deck_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'validating', 'ready', 'published', 'failed')
    ),
    content_hash TEXT,
    card_count INTEGER NOT NULL DEFAULT 0,
    canonical_blob_ref TEXT,
    validation_error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT,
    FOREIGN KEY (learning_deck_id) REFERENCES learning_decks(learning_deck_id) ON DELETE CASCADE,
    UNIQUE (learning_deck_id, version)
);

CREATE INDEX idx_learning_deck_versions_status
    ON learning_deck_versions(learning_deck_id, status, version DESC);

CREATE TABLE learning_cards (
    learning_card_id TEXT PRIMARY KEY,
    learning_deck_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    retired_at TEXT,
    FOREIGN KEY (learning_deck_id) REFERENCES learning_decks(learning_deck_id) ON DELETE CASCADE
);

CREATE INDEX idx_learning_cards_deck ON learning_cards(learning_deck_id, created_at);

CREATE TABLE learning_card_versions (
    learning_deck_version_id TEXT NOT NULL,
    learning_card_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    card_type TEXT NOT NULL CHECK (card_type IN ('basic', 'cloze')),
    prompt_json TEXT NOT NULL,
    answer_json TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (learning_deck_version_id, learning_card_id),
    FOREIGN KEY (learning_deck_version_id)
        REFERENCES learning_deck_versions(learning_deck_version_id) ON DELETE CASCADE,
    FOREIGN KEY (learning_card_id) REFERENCES learning_cards(learning_card_id) ON DELETE CASCADE,
    UNIQUE (learning_deck_version_id, ordinal)
);

CREATE INDEX idx_learning_card_versions_card ON learning_card_versions(learning_card_id);

CREATE TABLE learning_review_items (
    review_item_id TEXT PRIMARY KEY,
    item_kind TEXT NOT NULL CHECK (item_kind IN ('deck_card', 'song_exercise')),
    subject_ref TEXT NOT NULL,
    content_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (item_kind, subject_ref)
);

CREATE TABLE learning_review_events (
    learning_review_event_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    review_item_id TEXT NOT NULL,
    learning_deck_id TEXT,
    learning_deck_version_id TEXT,
    learning_session_id TEXT,
    idempotency_key TEXT NOT NULL,
    item_event_sequence INTEGER NOT NULL CHECK (item_event_sequence > 0),
    rating TEXT NOT NULL CHECK (rating IN ('again', 'hard', 'good', 'easy')),
    reviewed_at TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    parameters_version INTEGER NOT NULL,
    content_version INTEGER NOT NULL,
    prior_state_hash TEXT,
    resulting_state_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (review_item_id) REFERENCES learning_review_items(review_item_id),
    FOREIGN KEY (learning_deck_id) REFERENCES learning_decks(learning_deck_id),
    FOREIGN KEY (learning_deck_version_id)
        REFERENCES learning_deck_versions(learning_deck_version_id),
    UNIQUE (user_id, idempotency_key),
    UNIQUE (user_id, review_item_id, item_event_sequence)
);

CREATE INDEX idx_learning_review_events_item_sequence
    ON learning_review_events(user_id, review_item_id, item_event_sequence DESC);
CREATE INDEX idx_learning_review_events_deck_reviewed
    ON learning_review_events(user_id, learning_deck_id, reviewed_at DESC);

CREATE TABLE learning_review_state (
    user_id TEXT NOT NULL,
    review_item_id TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    parameters_version INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('new', 'learning', 'review', 'relearning')),
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    learning_step INTEGER,
    scheduled_interval_days REAL NOT NULL,
    due_at TEXT NOT NULL,
    last_reviewed_at TEXT,
    reps INTEGER NOT NULL,
    lapses INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    last_review_event_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, review_item_id),
    FOREIGN KEY (review_item_id) REFERENCES learning_review_items(review_item_id),
    FOREIGN KEY (last_review_event_id)
        REFERENCES learning_review_events(learning_review_event_id)
);

CREATE INDEX idx_learning_review_state_due ON learning_review_state(user_id, due_at);

CREATE TABLE learning_sessions (
    learning_session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('deck', 'community_due')),
    scope_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'expired')),
    session_revision INTEGER NOT NULL,
    current_item_id TEXT,
    item_count INTEGER NOT NULL,
    reviewed_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (current_item_id) REFERENCES learning_review_items(review_item_id)
);

CREATE INDEX idx_learning_sessions_user_status
    ON learning_sessions(user_id, status, expires_at);
CREATE INDEX idx_learning_sessions_scope
    ON learning_sessions(scope_kind, scope_ref, status);

CREATE TABLE learning_session_items (
    learning_session_id TEXT NOT NULL,
    review_item_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    due_at_snapshot TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'current', 'revealed', 'reviewed')),
    revealed_at TEXT,
    reviewed_event_id TEXT,
    PRIMARY KEY (learning_session_id, review_item_id),
    FOREIGN KEY (learning_session_id) REFERENCES learning_sessions(learning_session_id) ON DELETE CASCADE,
    FOREIGN KEY (review_item_id) REFERENCES learning_review_items(review_item_id),
    UNIQUE (learning_session_id, ordinal)
);

CREATE INDEX idx_learning_session_items_status
    ON learning_session_items(learning_session_id, status, ordinal);

-- Published version rows and their card snapshots are immutable evidence.
CREATE TRIGGER learning_deck_versions_published_no_update
BEFORE UPDATE ON learning_deck_versions
WHEN OLD.status = 'published'
BEGIN
    SELECT RAISE(ABORT, 'published learning deck versions are immutable');
END;

CREATE TRIGGER learning_deck_versions_published_no_delete
BEFORE DELETE ON learning_deck_versions
WHEN OLD.status = 'published'
BEGIN
    SELECT RAISE(ABORT, 'published learning deck versions cannot be deleted');
END;

CREATE TRIGGER learning_card_versions_published_no_update
BEFORE UPDATE ON learning_card_versions
WHEN EXISTS (
    SELECT 1 FROM learning_deck_versions
    WHERE learning_deck_version_id = OLD.learning_deck_version_id
      AND status = 'published'
)
BEGIN
    SELECT RAISE(ABORT, 'published learning card versions are immutable');
END;

CREATE TRIGGER learning_card_versions_published_no_insert
BEFORE INSERT ON learning_card_versions
WHEN EXISTS (
    SELECT 1 FROM learning_deck_versions
    WHERE learning_deck_version_id = NEW.learning_deck_version_id
      AND status = 'published'
)
BEGIN
    SELECT RAISE(ABORT, 'published learning card versions are immutable');
END;

CREATE TRIGGER learning_card_versions_published_no_delete
BEFORE DELETE ON learning_card_versions
WHEN EXISTS (
    SELECT 1 FROM learning_deck_versions
    WHERE learning_deck_version_id = OLD.learning_deck_version_id
      AND status = 'published'
)
BEGIN
    SELECT RAISE(ABORT, 'published learning card versions cannot be deleted');
END;

CREATE TRIGGER learning_cards_published_no_delete
BEFORE DELETE ON learning_cards
WHEN EXISTS (
    SELECT 1
    FROM learning_card_versions card_version
    JOIN learning_deck_versions deck_version
      ON deck_version.learning_deck_version_id = card_version.learning_deck_version_id
    WHERE card_version.learning_card_id = OLD.learning_card_id
      AND deck_version.status = 'published'
)
BEGIN
    SELECT RAISE(ABORT, 'published learning cards cannot be deleted');
END;

CREATE TRIGGER learning_decks_published_no_delete
BEFORE DELETE ON learning_decks
WHEN OLD.status IN ('published', 'archived')
BEGIN
    SELECT RAISE(ABORT, 'published learning decks cannot be deleted');
END;

PRAGMA foreign_keys = ON;
