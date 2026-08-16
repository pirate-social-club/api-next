-- Restore the rights-review queue dropped by 1053_drop_unwired_community_scaffolding.
-- 1018 created media_analysis_results + asset_derivative_links + rights_review_cases
-- as a designed-ahead rights pipeline; 1053 removed only rights_review_cases because
-- nothing wrote to it. The video attribution guardrail now wires the pipeline
-- (ACRCloud match on video soundtracks -> media_analysis_results outcome ->
-- review case), so the queue table returns.
--
-- Successor changes vs the 1018 original:
--   - subject_type gains 'post': public videos may not have an assets row
--     (asset creation requires access_mode), so a case must be able to point
--     at the post directly.
--   - trigger_source gains 'declared_reference_mismatch': ACR matched a
--     different catalog song than the poster declared.
-- Everything else (status/resolution enums, unique open-case-per-subject
-- index) is byte-compatible with 1018 so pre-1053 code assumptions hold.

CREATE TABLE rights_review_cases (
    rights_review_case_id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL CHECK (
        subject_type IN ('asset', 'post', 'live_room', 'replay_asset')
    ),
    subject_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('open', 'under_review', 'resolved', 'blocked')
    ),
    trigger_source TEXT NOT NULL CHECK (
        trigger_source IN ('acrcloud_match', 'declared_reference_mismatch', 'manual_report', 'operator_escalation')
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
