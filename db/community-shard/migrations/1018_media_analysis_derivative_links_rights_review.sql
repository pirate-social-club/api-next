CREATE TABLE media_analysis_results (
    media_analysis_result_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    source_post_id TEXT,
    source_asset_id TEXT,
    outcome TEXT NOT NULL CHECK (
        outcome IN ('allow', 'allow_with_required_reference', 'review_required', 'blocked')
    ),
    content_safety_state TEXT NOT NULL CHECK (
        content_safety_state IN ('pending', 'safe', 'sensitive', 'adult')
    ),
    age_gate_policy TEXT NOT NULL CHECK (
        age_gate_policy IN ('none', '18_plus')
    ),
    trigger_sources_json TEXT,
    acrcloud_music_match_json TEXT,
    acrcloud_custom_match_json TEXT,
    acrcloud_error_code TEXT,
    acrcloud_error_message TEXT,
    acrcloud_checked_at TEXT,
    safety_signals_json TEXT,
    authenticity_signals_json TEXT,
    policy_reason_code TEXT,
    policy_reason TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_media_analysis_results_post
    ON media_analysis_results(source_post_id);

CREATE INDEX idx_media_analysis_results_outcome
    ON media_analysis_results(outcome, created_at DESC);

CREATE INDEX idx_assets_community_primary_content_hash
    ON assets(community_id, primary_content_hash);

CREATE TABLE asset_derivative_links (
    asset_derivative_link_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    upstream_asset_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL CHECK (
        relationship_type IN ('remix_of', 'references_song', 'inspired_by', 'samples')
    ),
    created_at TEXT NOT NULL,
    FOREIGN KEY (asset_id) REFERENCES assets(asset_id)
);

CREATE INDEX idx_asset_derivative_links_asset
    ON asset_derivative_links(asset_id);

CREATE INDEX idx_asset_derivative_links_upstream
    ON asset_derivative_links(upstream_asset_id);

CREATE TABLE rights_review_cases (
    rights_review_case_id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL CHECK (
        subject_type IN ('asset', 'live_room', 'replay_asset')
    ),
    subject_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('open', 'under_review', 'resolved', 'blocked')
    ),
    trigger_source TEXT NOT NULL CHECK (
        trigger_source IN ('acrcloud_match', 'manual_report', 'operator_escalation')
    ),
    analysis_result_ref TEXT,
    submitted_evidence_refs_json TEXT,
    resolution TEXT CHECK (
        resolution IS NULL OR resolution IN ('clear', 'clear_with_upstream_refs', 'block', 'needs_more_evidence')
    ),
    resolver_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_rights_review_cases_subject
    ON rights_review_cases(subject_type, subject_id);

CREATE INDEX idx_rights_review_cases_status
    ON rights_review_cases(status, created_at DESC);

CREATE UNIQUE INDEX idx_rights_review_cases_open_subject_trigger
    ON rights_review_cases(subject_type, subject_id, trigger_source)
    WHERE status IN ('open', 'under_review');
