PRAGMA foreign_keys = ON;

CREATE TABLE communities (
    community_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'active', 'frozen', 'archived', 'deleted')
    ),
    artist_identity_id TEXT,
    artist_governance_state TEXT NOT NULL CHECK (
        artist_governance_state IN ('fan_run', 'claim_pending', 'artist_governed', 'org_governed')
    ),
    membership_mode TEXT NOT NULL CHECK (
        membership_mode IN ('open', 'request', 'gated')
    ),
    default_age_gate_policy TEXT NOT NULL CHECK (
        default_age_gate_policy IN ('none', '18_plus')
    ),
    allow_anonymous_identity INTEGER NOT NULL DEFAULT 0 CHECK (allow_anonymous_identity IN (0, 1)),
    anonymous_identity_scope TEXT CHECK (
        anonymous_identity_scope IS NULL OR anonymous_identity_scope IN ('community_stable', 'thread_stable', 'post_ephemeral')
    ),
    donation_partner_id TEXT,
    donation_policy_mode TEXT NOT NULL CHECK (
        donation_policy_mode IN ('none', 'optional_creator_sidecar', 'fundraiser_default')
    ),
    donation_partner_status TEXT NOT NULL CHECK (
        donation_partner_status IN ('unconfigured', 'active', 'inactive')
    ),
    governance_mode TEXT NOT NULL CHECK (
        governance_mode IN ('centralized', 'multisig', 'majeur')
    ),
    settings_json TEXT,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE community_memberships (
    membership_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('member', 'left', 'banned')
    ),
    joined_at TEXT,
    left_at TEXT,
    banned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_community_memberships_active_member
    ON community_memberships(community_id, user_id)
    WHERE status = 'member';

CREATE INDEX idx_community_memberships_user_status
    ON community_memberships(user_id, status);

CREATE TABLE membership_requests (
    membership_request_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    applicant_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'approved', 'rejected', 'canceled', 'expired')
    ),
    note TEXT,
    reviewed_by_user_id TEXT,
    review_reason TEXT,
    resolved_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_membership_requests_pending
    ON membership_requests(community_id, applicant_user_id)
    WHERE status = 'pending';

CREATE TABLE community_roles (
    role_assignment_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (
        role IN ('owner', 'admin', 'moderator')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('active', 'revoked')
    ),
    granted_by_user_id TEXT,
    granted_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_community_roles_active_unique
    ON community_roles(community_id, user_id, role)
    WHERE status = 'active';

CREATE TABLE namespace_bindings (
    namespace_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    namespace_verification_id TEXT NOT NULL,
    display_label TEXT NOT NULL,
    normalized_label TEXT NOT NULL,
    resolver_label TEXT,
    route_family TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'superseded', 'revoked')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_namespace_bindings_active_community
    ON namespace_bindings(community_id)
    WHERE status = 'active';

CREATE TABLE namespace_handle_policies (
    namespace_handle_policy_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    policy_template TEXT NOT NULL CHECK (
        policy_template IN ('standard', 'premium', 'membership_gated', 'custom')
    ),
    pricing_model TEXT CHECK (
        pricing_model IS NULL OR pricing_model IN ('free', 'flat_by_length', 'custom_curve', 'gated_then_flat')
    ),
    membership_required_for_claim INTEGER NOT NULL DEFAULT 1 CHECK (membership_required_for_claim IN (0, 1)),
    settings_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);

CREATE UNIQUE INDEX idx_namespace_handle_policies_namespace
    ON namespace_handle_policies(namespace_id);

CREATE TABLE community_handles (
    community_handle_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'grace_period', 'expired', 'revoked', 'reserved')
    ),
    issuance_source TEXT NOT NULL CHECK (
        issuance_source IN ('claim', 'auction', 'admin_grant')
    ),
    lease_started_at TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);

CREATE UNIQUE INDEX idx_community_handles_active_namespace_label
    ON community_handles(namespace_id, label_normalized)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_community_handles_active_user_namespace
    ON community_handles(namespace_id, user_id)
    WHERE status = 'active';

CREATE TABLE labels (
    label_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'archived')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_labels_club_status
    ON labels(community_id, status);

CREATE TABLE posts (
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
        post_type IN ('text', 'image', 'video', 'link', 'song')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'published', 'hidden', 'removed', 'deleted')
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
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (label_id) REFERENCES labels(label_id),
    FOREIGN KEY (parent_post_id) REFERENCES posts(post_id)
);

CREATE INDEX idx_posts_community_created
    ON posts(community_id, created_at DESC);

CREATE INDEX idx_posts_parent
    ON posts(parent_post_id, created_at);

CREATE INDEX idx_posts_author
    ON posts(author_user_id, created_at DESC);

CREATE TABLE post_votes (
    post_vote_id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    vote_value INTEGER NOT NULL CHECK (vote_value IN (-1, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_post_votes_unique
    ON post_votes(post_id, user_id);

CREATE TABLE post_reactions (
    post_reaction_id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    reaction_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_post_reactions_unique
    ON post_reactions(post_id, user_id, reaction_key);

CREATE TABLE moderation_actions (
    moderation_action_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT,
    target_user_id TEXT,
    actor_user_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    reason TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id)
);

CREATE INDEX idx_moderation_actions_community_created
    ON moderation_actions(community_id, created_at DESC);

CREATE INDEX idx_moderation_actions_target_user
    ON moderation_actions(target_user_id, created_at DESC);

CREATE TABLE community_jobs (
    job_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    job_type TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'succeeded', 'failed')
    ),
    payload_json TEXT,
    result_ref TEXT,
    error_code TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_jobs_status_available
    ON community_jobs(status, available_at);

CREATE INDEX idx_community_jobs_community
    ON community_jobs(community_id, status);

CREATE TABLE purchases (
    purchase_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    asset_id TEXT,
    live_room_id TEXT,
    buyer_user_id TEXT NOT NULL,
    settlement_wallet_attachment_id TEXT NOT NULL,
    purchase_price_usd REAL NOT NULL CHECK (
        purchase_price_usd >= 0
    ),
    pricing_tier TEXT,
    settlement_chain TEXT NOT NULL,
    settlement_token TEXT NOT NULL,
    settlement_tx_ref TEXT NOT NULL,
    donation_partner_id TEXT,
    donation_share_pct REAL CHECK (
        donation_share_pct IS NULL OR (donation_share_pct >= 0 AND donation_share_pct <= 100)
    ),
    donation_amount_usd REAL CHECK (
        donation_amount_usd IS NULL OR donation_amount_usd >= 0
    ),
    donation_settlement_ref TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    CHECK (
        (asset_id IS NOT NULL AND live_room_id IS NULL) OR
        (asset_id IS NULL AND live_room_id IS NOT NULL)
    )
);

CREATE INDEX idx_purchases_buyer_created
    ON purchases(buyer_user_id, created_at DESC);

CREATE INDEX idx_purchases_community_created
    ON purchases(community_id, created_at DESC);

CREATE TABLE purchase_entitlements (
    purchase_entitlement_id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    buyer_user_id TEXT NOT NULL,
    entitlement_kind TEXT NOT NULL CHECK (
        entitlement_kind IN ('asset_access', 'live_room_access', 'replay_access', 'license')
    ),
    target_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'revoked', 'expired')
    ),
    granted_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (purchase_id) REFERENCES purchases(purchase_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_purchase_entitlements_buyer_status
    ON purchase_entitlements(buyer_user_id, status);

CREATE INDEX idx_purchase_entitlements_target
    ON purchase_entitlements(entitlement_kind, target_ref, status);
