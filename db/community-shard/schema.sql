-- Generated from db/community-shard/migrations; do not edit by hand.

PRAGMA foreign_keys = ON;

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

CREATE TABLE "assets" (
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

CREATE TABLE booking_attendance_heartbeats (
    heartbeat_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES booking_attendance_sessions(session_id)
);

CREATE TABLE booking_attendance_sessions (
    session_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    party TEXT NOT NULL CHECK (party IN ('host', 'booker')),
    user_id TEXT NOT NULL,
    agora_uid INTEGER,
    attached_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (booking_id) REFERENCES bookings(booking_id)
);

CREATE TABLE booking_holds (
    hold_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    host_user_id TEXT NOT NULL,         -- control-plane user id (no FK, cross-DB)
    booker_user_id TEXT NOT NULL,       -- control-plane user id (no FK, cross-DB)
    slot_start_utc TEXT NOT NULL,       -- RFC3339 UTC
    slot_end_utc TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),   -- every booking is paid
    status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired')),
    expires_at_utc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (slot_end_utc > slot_start_utc),
    CHECK (expires_at_utc > created_at),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE booking_payment_intents (
    payment_intent_id TEXT PRIMARY KEY,
    hold_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    token_address TEXT NOT NULL,
    token_decimals INTEGER NOT NULL CHECK (token_decimals >= 0 AND token_decimals <= 36),
    token_symbol TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    amount_atomic TEXT NOT NULL CHECK (length(amount_atomic) >= 1 AND amount_atomic NOT GLOB '*[^0-9]*'),
    gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),
    quote_expires_at TEXT NOT NULL,
    hold_expires_at TEXT NOT NULL,
    wallet_attachment_required INTEGER NOT NULL DEFAULT 1 CHECK (wallet_attachment_required IN (0, 1)),
    -- States: active (quoted) -> verifying (claimed, RPC in flight) -> verified (durable, evidence
    -- recorded, ready to finalize) -> consumed (booking created + hold consumed). verification_failed
    -- is a retryable transient/pending outcome that keeps the claimed hash. verification_rejected is
    -- a terminal definitive mismatch (a new payment requires a superseded/new intent). The verified
    -- state lets a crash after the RPC resume finalization WITHOUT another RPC or payment.
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'verifying', 'verified', 'verification_failed', 'verification_rejected', 'consumed', 'expired', 'superseded')),
    -- verification reservation (CAS): a single confirmation claims the intent before chain RPC.
    -- Claim token + expiry are cleared once the intent reaches verified (finalization no longer needs them).
    verification_claim_token TEXT,
    verification_claim_expires_at TEXT,
    claimed_tx_ref TEXT,
    -- durable verification evidence recorded at the verifying -> verified transition, so finalization
    -- needs no further RPC: the verified on-chain sender (= booking refund destination) and timestamp.
    verified_sender_address TEXT,
    verified_at TEXT,
    consumed_wallet_attachment_id TEXT,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, platform_fee_bps INTEGER, platform_fee_cents INTEGER, host_payout_cents INTEGER,
    FOREIGN KEY (hold_id) REFERENCES booking_holds (hold_id)
);

CREATE TABLE booking_settlement_effects (
    booking_settlement_effect_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    effect_kind TEXT NOT NULL CHECK (effect_kind IN ('booking_payout', 'booking_refund')),
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    recipient_address TEXT NOT NULL,
    settlement_ref TEXT,                 -- on-chain tx hash once confirmed
    failure_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    submitted_at TEXT,
    confirmed_at TEXT,
    failed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, signed_tx TEXT, broadcast_nonce INTEGER, coordinator_ref TEXT, coordinator_state TEXT,
    FOREIGN KEY (booking_id) REFERENCES bookings(booking_id)
);

CREATE TABLE bookings (
    booking_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    hold_id TEXT,                       -- community-local hold this was created from
    host_user_id TEXT NOT NULL,         -- control-plane user id (no FK, cross-DB)
    booker_user_id TEXT NOT NULL,       -- control-plane user id (no FK, cross-DB)
    slot_start_utc TEXT NOT NULL,
    slot_end_utc TEXT NOT NULL,
    -- money snapshot (integer cents / bps, no REAL)
    gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),   -- every booking is paid
    platform_fee_bps INTEGER NOT NULL CHECK (platform_fee_bps >= 0 AND platform_fee_bps <= 10000),
    platform_fee_cents INTEGER NOT NULL CHECK (platform_fee_cents >= 0),
    host_payout_cents INTEGER NOT NULL CHECK (host_payout_cents >= 0),
    refund_cents INTEGER CHECK (refund_cents IS NULL OR (refund_cents >= 0 AND refund_cents <= gross_cents)),
    -- lifecycle state — mirrors @pirate/bookings-domain BookingState exactly
    status TEXT NOT NULL CHECK (status IN (
        'hold',
        'quoted',
        'pending_payment',
        'confirmed',
        'live',
        'completed',
        'settled',
        'expired_hold',
        'cancelled_before_payment',
        'cancelled_by_host',
        'cancelled_by_booker',
        'no_show_host',
        'no_show_booker',
        'refunded',
        'disputed'
    )),
    -- commerce + custody/settlement refs (server-verified, reuses PR0 funding gate)
    quote_id TEXT,                      -- per-community purchase_quotes.quote_id
    purchase_id TEXT,                   -- per-community purchases.purchase_id once settled
    funding_tx_ref TEXT,                -- verified on-chain pay-in receipt (custody-in)
    payout_tx_ref TEXT,                 -- operator payout to host (custody-out)
    refund_tx_ref TEXT,                 -- operator refund to booker (custody-out)
    -- 1:1 video session, created only on `confirmed`
    live_room_id TEXT,                  -- per-community live_rooms.live_room_id
    confirmed_at TEXT,
    completed_at TEXT,
    settled_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, funding_wallet_address TEXT, host_payout_wallet_address TEXT, settlement_review_status TEXT
    CHECK (settlement_review_status IS NULL OR settlement_review_status IN ('pending', 'resolved')), settlement_review_reason TEXT
    CHECK (settlement_review_reason IS NULL OR settlement_review_reason IN ('attendance_ambiguous')), settlement_review_resolution TEXT
    CHECK (settlement_review_resolution IS NULL OR settlement_review_resolution IN ('completed', 'no_show_host', 'no_show_booker')), settlement_review_opened_at TEXT, settlement_review_resolved_at TEXT, settlement_review_operator_credential_id TEXT, settlement_review_operator_actor_id TEXT, settlement_review_note TEXT, settlement_review_version INTEGER NOT NULL DEFAULT 0
    CHECK (settlement_review_version >= 0),
    CHECK (slot_end_utc > slot_start_utc),
    -- money snapshot must balance: fee + payout == gross (matches @pirate/bookings-domain
    -- computeAllocation, where hostPayout = gross - platformFee)
    CHECK (platform_fee_cents + host_payout_cents = gross_cents),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (hold_id) REFERENCES booking_holds(hold_id)
);

CREATE TABLE comment_closure (
    ancestor_comment_id TEXT NOT NULL,
    descendant_comment_id TEXT NOT NULL,
    distance INTEGER NOT NULL,
    PRIMARY KEY (ancestor_comment_id, descendant_comment_id),
    FOREIGN KEY (ancestor_comment_id) REFERENCES comments(comment_id),
    FOREIGN KEY (descendant_comment_id) REFERENCES comments(comment_id)
);

CREATE TABLE comment_votes (
    comment_vote_id TEXT PRIMARY KEY,
    comment_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    vote_value INTEGER NOT NULL CHECK (vote_value IN (-1, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (comment_id) REFERENCES comments(comment_id)
);

CREATE TABLE comments (
    comment_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    thread_root_post_id TEXT NOT NULL,
    parent_comment_id TEXT,
    author_user_id TEXT,
    identity_mode TEXT NOT NULL CHECK (
        identity_mode IN ('public', 'anonymous')
    ),
    anonymous_scope TEXT CHECK (
        anonymous_scope IS NULL OR anonymous_scope IN ('community_stable', 'thread_stable')
    ),
    anonymous_label TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('published', 'hidden', 'removed', 'deleted')
    ),
    depth INTEGER NOT NULL,
    direct_reply_count INTEGER NOT NULL DEFAULT 0,
    descendant_count INTEGER NOT NULL DEFAULT 0,
    upvote_count INTEGER NOT NULL DEFAULT 0,
    downvote_count INTEGER NOT NULL DEFAULT 0,
    score INTEGER NOT NULL DEFAULT 0,
    last_reply_at TEXT,
    content_hash TEXT,
    swarm_body_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, source_language TEXT, authorship_mode TEXT NOT NULL DEFAULT 'human_direct' CHECK (
    authorship_mode IN ('human_direct', 'user_agent', 'guest')
), agent_id TEXT, agent_ownership_record_id TEXT, agent_display_name_snapshot TEXT, agent_owner_handle_snapshot TEXT, agent_ownership_provider_snapshot TEXT, agent_handle_snapshot TEXT, idempotency_key TEXT NOT NULL DEFAULT '', media_refs_json TEXT NOT NULL DEFAULT '[]', source_language_confidence REAL, source_language_reliable INTEGER NOT NULL DEFAULT 0, source_language_detector TEXT, source_language_detected_at TEXT, source_language_source_hash TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (thread_root_post_id) REFERENCES posts(post_id),
    FOREIGN KEY (parent_comment_id) REFERENCES comments(comment_id)
);

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
, cached_member_count INTEGER, cached_qualified_member_count INTEGER, avatar_ref TEXT, banner_ref TEXT, cached_follower_count INTEGER NOT NULL DEFAULT 0, karaoke_enabled INTEGER NOT NULL DEFAULT 0 CHECK (karaoke_enabled IN (0, 1)), karaoke_scoring_enabled INTEGER NOT NULL DEFAULT 0 CHECK (karaoke_scoring_enabled IN (0, 1)), karaoke_stt_provider TEXT NOT NULL DEFAULT 'assistant' CHECK (
    karaoke_stt_provider IN ('assistant', 'elevenlabs', 'mistral', 'openai', 'none')
  ), karaoke_stt_model TEXT NOT NULL DEFAULT '', karaoke_voice_coach_enabled INTEGER NOT NULL DEFAULT 0 CHECK (karaoke_voice_coach_enabled IN (0, 1)), karaoke_audio_retention TEXT NOT NULL DEFAULT 'not_stored' CHECK (
    karaoke_audio_retention = 'not_stored'
  ), study_enabled INTEGER NOT NULL DEFAULT 0 CHECK (study_enabled IN (0, 1)));

CREATE TABLE community_assistant_chats (
    chat_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'archived', 'deleted')
    ),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE community_assistant_messages (
    message_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (
        role IN ('user', 'assistant', 'system')
    ),
    content TEXT NOT NULL,
    model_id TEXT,
    provider_message_id TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES community_assistant_chats(chat_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE "community_assistant_policy" (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    community_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    display_name TEXT NOT NULL,
    short_bio TEXT NOT NULL DEFAULT '',
    avatar_ref TEXT,
    system_prompt TEXT NOT NULL DEFAULT '',
    default_prompt TEXT NOT NULL DEFAULT '',
    starter_prompts TEXT NOT NULL DEFAULT '[]',
    selected_model_id TEXT NOT NULL DEFAULT '',
    context_mode TEXT NOT NULL DEFAULT 'live_sql' CHECK (
        context_mode IN ('live_sql', 'summary_cache', 'hybrid_vector')
    ),
    context_sources TEXT NOT NULL DEFAULT '{}',
    max_context_threads INTEGER NOT NULL DEFAULT 8 CHECK (
        max_context_threads BETWEEN 1 AND 50
    ),
    max_lookback_days INTEGER CHECK (
        max_lookback_days IS NULL OR max_lookback_days BETWEEN 1 AND 365
    ),
    memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (memory_enabled IN (0, 1)),
    retention_mode TEXT NOT NULL DEFAULT 'per_user_private' CHECK (
        retention_mode IN ('per_user_private', 'community_visible_to_mods', 'ephemeral')
    ),
    retention_days INTEGER NOT NULL DEFAULT 180 CHECK (
        retention_days BETWEEN 1 AND 3650
    ),
    save_chats_to_community_db INTEGER NOT NULL DEFAULT 1 CHECK (
        save_chats_to_community_db IN (0, 1)
    ),
    action_mode TEXT NOT NULL DEFAULT 'answer_only' CHECK (
        action_mode IN ('answer_only', 'draft_only', 'confirmed_writes')
    ),
    require_moderator_approval_for_writes INTEGER NOT NULL DEFAULT 1 CHECK (
        require_moderator_approval_for_writes IN (0, 1)
    ),
    per_user_daily_message_cap INTEGER CHECK (
        per_user_daily_message_cap IS NULL OR per_user_daily_message_cap BETWEEN 1 AND 10000
    ),
    voice_mode TEXT NOT NULL DEFAULT 'off' CHECK (
        voice_mode IN ('off', 'transcription_only', 'voice_replies', 'text_and_voice_replies')
    ),
    stt_provider TEXT NOT NULL DEFAULT 'elevenlabs' CHECK (
        stt_provider IN ('elevenlabs', 'mistral', 'openai', 'none')
    ),
    stt_model TEXT NOT NULL DEFAULT 'scribe_v2',
    tts_provider TEXT NOT NULL DEFAULT 'elevenlabs' CHECK (
        tts_provider IN ('elevenlabs', 'none')
    ),
    tts_voice TEXT NOT NULL DEFAULT '',
    include_in_sovereign_export INTEGER NOT NULL DEFAULT 1 CHECK (
        include_in_sovereign_export IN (0, 1)
    ),
    policy_origin TEXT NOT NULL DEFAULT 'default' CHECK (
        policy_origin IN ('default', 'explicit')
    ),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, telegram_private_assistant_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (telegram_private_assistant_enabled IN (0, 1)), telegram_preview_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (telegram_preview_enabled IN (0, 1)), telegram_preview_daily_cap INTEGER NOT NULL DEFAULT 5
        CHECK (telegram_preview_daily_cap BETWEEN 0 AND 50), telegram_preview_prompt_suffix_json TEXT,
    UNIQUE (community_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE community_assistant_prompt_revisions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    community_id TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    default_prompt TEXT NOT NULL,
    starter_prompts TEXT NOT NULL DEFAULT '[]',
    actor_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE community_follows (
    community_follow_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'inactive')
    ),
    unfollowed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE community_gate_policies (
    community_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (
        scope IN ('membership', 'viewer', 'posting')
    ),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
    expression_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (community_id, scope),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE community_handle_claim_quotes (
    handle_claim_quote_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('quoted', 'claimed', 'expired', 'failed')
    ),
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    pricing_model TEXT CHECK (
        pricing_model IS NULL OR pricing_model IN ('free', 'flat_by_length', 'custom_curve', 'gated_then_flat')
    ),
    pricing_tier TEXT,
    quote_ttl_seconds INTEGER NOT NULL CHECK (quote_ttl_seconds > 0),
    quoted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    claimed_at TEXT,
    settings_snapshot_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, handle_claim_intent_id TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);

CREATE TABLE community_handle_label_reservations (
    handle_label_reservation_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    user_id TEXT NOT NULL,
    handle_claim_quote_id TEXT UNIQUE,
    purpose TEXT NOT NULL CHECK (
        purpose IN ('payment', 'claim', 'admin_reserve')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('active', 'consumed', 'released')
    ),
    reserved_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    released_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, handle_claim_intent_id TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id),
    FOREIGN KEY (handle_claim_quote_id) REFERENCES community_handle_claim_quotes(handle_claim_quote_id)
);

CREATE TABLE community_handle_protocol_issuances (
    community_handle_protocol_issuance_id TEXT PRIMARY KEY,
    community_handle_id TEXT NOT NULL,
    protocol_issuance_batch_id TEXT,
    community_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    public_status TEXT NOT NULL CHECK (
        public_status IN ('issuing', 'issued', 'failed')
    ),
    parent_space TEXT NOT NULL,
    sname TEXT NOT NULL,
    script_pubkey_hex TEXT NOT NULL,
    cert_ref TEXT,
    certificate_payload_ref TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    issued_at TEXT,
    FOREIGN KEY (community_handle_id) REFERENCES community_handles(community_handle_id) ON DELETE CASCADE,
    FOREIGN KEY (protocol_issuance_batch_id) REFERENCES protocol_issuance_batches(protocol_issuance_batch_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);

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
    updated_at TEXT NOT NULL, handle_claim_quote_id TEXT, price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0), currency TEXT NOT NULL DEFAULT 'USD', pricing_model TEXT CHECK (
    pricing_model IS NULL OR pricing_model IN ('free', 'flat_by_length', 'custom_curve', 'gated_then_flat')
), pricing_tier TEXT, settlement_wallet_attachment_id TEXT, funding_tx_ref TEXT, settlement_tx_ref TEXT, protocol_owner_wallet_attachment_id TEXT, handle_claim_intent_id TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);

CREATE TABLE community_job_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES community_jobs(job_id),
  FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

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
    updated_at TEXT NOT NULL, last_checkpoint TEXT, last_checkpoint_at TEXT, attempt_started_at TEXT, attempt_deadline_at TEXT, attempt_id TEXT, lease_expires_at TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

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
    updated_at TEXT NOT NULL, source_language_confidence REAL, source_language_reliable INTEGER NOT NULL DEFAULT 0, source_language_detector TEXT, source_language_detected_at TEXT,
    PRIMARY KEY (community_localization_meta_id),
    UNIQUE (community_id, field_key),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
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

CREATE TABLE community_rules (
    rule_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'archived')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, report_reason TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

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

CREATE TABLE "dance_attempt" (
    dance_attempt_id TEXT NOT NULL PRIMARY KEY,
    dance_attempt_session_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT NOT NULL,
    dance_choreography_revision_id TEXT NOT NULL,
    activity_date TEXT NOT NULL,
    activity_timezone TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('passed', 'rejected', 'failed')),
    score_bps INTEGER CHECK (score_bps IS NULL OR score_bps BETWEEN 0 AND 10000),
    rank_eligible INTEGER NOT NULL CHECK (rank_eligible IN (0, 1)),
    quality_outcome TEXT NOT NULL CHECK (quality_outcome IN ('passed', 'rejected', 'failed')),
    integrity_outcome TEXT NOT NULL CHECK (
        integrity_outcome IN ('passed', 'reference_replay', 'duplicate_attempt', 'unavailable')
    ),
    reason_code TEXT CHECK (
        reason_code IS NULL OR reason_code IN (
            'video_invalid', 'upload_invalid', 'duration_out_of_range',
            'insufficient_coverage', 'insufficient_pose_presence', 'multiple_people',
            'reference_replay', 'duplicate_attempt', 'scoring_unavailable',
            'below_platform_floor', 'version_mismatch', 'insufficient_motion',
            'insufficient_alignment', 'start_cue_mismatch'
        )
    ),
    coverage_bps INTEGER CHECK (coverage_bps IS NULL OR coverage_bps BETWEEN 0 AND 10000),
    pose_detection_bps INTEGER CHECK (pose_detection_bps IS NULL OR pose_detection_bps BETWEEN 0 AND 10000),
    duration_ratio_bps INTEGER CHECK (duration_ratio_bps IS NULL OR duration_ratio_bps BETWEEN 0 AND 20000),
    selected_mirror TEXT CHECK (selected_mirror IS NULL OR selected_mirror IN ('canonical', 'mirrored')),
    temporal_offset_ms INTEGER,
    temporal_warp_bps INTEGER CHECK (temporal_warp_bps IS NULL OR temporal_warp_bps BETWEEN 0 AND 10000),
    unmatched_coverage_bps INTEGER CHECK (unmatched_coverage_bps IS NULL OR unmatched_coverage_bps BETWEEN 0 AND 10000),
    reference_content_sha256 TEXT NOT NULL CHECK (length(reference_content_sha256) = 64 AND reference_content_sha256 NOT GLOB '*[^0-9a-f]*'),
    reference_feature_sha256 TEXT NOT NULL CHECK (length(reference_feature_sha256) = 64 AND reference_feature_sha256 NOT GLOB '*[^0-9a-f]*'),
    pose_model_version TEXT NOT NULL,
    pose_model_sha256 TEXT NOT NULL CHECK (length(pose_model_sha256) = 64 AND pose_model_sha256 NOT GLOB '*[^0-9a-f]*'),
    feature_schema_version TEXT NOT NULL,
    scorer_version TEXT NOT NULL,
    calibration_version TEXT NOT NULL,
    calibration_checksum TEXT NOT NULL CHECK (length(calibration_checksum) = 64 AND calibration_checksum NOT GLOB '*[^0-9a-f]*'),
    calibration_admitted INTEGER NOT NULL CHECK (calibration_admitted IN (0, 1)),
    fingerprint_policy_version TEXT NOT NULL,
    integrity_policy_version TEXT NOT NULL,
    whole_attempt_fingerprint_hmac TEXT CHECK (whole_attempt_fingerprint_hmac IS NULL OR (length(whole_attempt_fingerprint_hmac) = 64 AND whole_attempt_fingerprint_hmac NOT GLOB '*[^0-9a-f]*')),
    segment_fingerprint_hmac_json TEXT,
    grader_result_digest TEXT NOT NULL CHECK (length(grader_result_digest) = 64 AND grader_result_digest NOT GLOB '*[^0-9a-f]*'),
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    start_cue_policy_version TEXT,
    start_cue_kind TEXT,
    start_cue_outcome TEXT,
    scored_window_start_ms INTEGER,
    CONSTRAINT dance_attempt_status_fields_check CHECK (
        (status = 'passed' AND score_bps IS NOT NULL AND quality_outcome = 'passed' AND integrity_outcome = 'passed')
        OR (status IN ('rejected', 'failed') AND rank_eligible = 0)
    ),
    CONSTRAINT dance_attempt_rank_calibration_check CHECK (rank_eligible = 0 OR calibration_admitted = 1),
    CONSTRAINT dance_attempt_segment_fingerprint_json_check CHECK (
        segment_fingerprint_hmac_json IS NULL OR (json_valid(segment_fingerprint_hmac_json) AND json_type(segment_fingerprint_hmac_json) = 'array' AND json_array_length(segment_fingerprint_hmac_json) <= 32)
    ),
    CONSTRAINT dance_attempt_start_cue_evidence_check CHECK (
        (start_cue_policy_version IS NULL AND start_cue_kind IS NULL AND start_cue_outcome IS NULL AND scored_window_start_ms IS NULL)
        OR (start_cue_policy_version = 'dance_start_cue_gross_body_v1' AND start_cue_kind IN ('hands_on_head', 'arms_t', 'hands_on_hips') AND ((start_cue_outcome = 'passed' AND scored_window_start_ms BETWEEN 0 AND 5000) OR (start_cue_outcome = 'failed' AND scored_window_start_ms IS NULL)))
    ),
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE donation_partners (
    donation_partner_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('endaoment')),
    provider_partner_ref TEXT,
    image_url TEXT,
    review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'approved', 'rejected')),
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'retired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
, payout_destination_ref TEXT);

CREATE TABLE initial_royalty_allocations (
    allocation_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    recipient_kind TEXT NOT NULL CHECK (
        recipient_kind IN ('creator', 'collaborator')
    ),
    recipient_user_id TEXT,
    -- Wallet snapshot frozen at create time. Registration mints/distributes to this.
    wallet_attachment_id TEXT,
    wallet_address_normalized TEXT NOT NULL,
    wallet_address_display TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    role_label TEXT,
    share_bps INTEGER NOT NULL CHECK (
        share_bps > 0 AND share_bps <= 10000
    ),
    -- bps is the agreement. expected_rt_units is DERIVED after registration from
    -- the observed vault supply (= observed_total_supply * share_bps / 10000),
    -- so it is NULL during draft/registration_pending. bigint as TEXT.
    expected_rt_units TEXT,
    position INTEGER NOT NULL CHECK (
        position >= 0
    ),
    distribution_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        distribution_status IN ('pending', 'verified', 'failed')
    ),
    -- Observed on-chain RT balance at verification (bigint as TEXT).
    verified_rt_units TEXT,
    -- Fingerprint = hash(version, chainId, sort_by_address(address, share_bps)).
    -- Identity is per-asset via assets.royalty_allocation_effect_key, not per row.
    allocation_fingerprint TEXT NOT NULL,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    registered_at TEXT,
    FOREIGN KEY (asset_id) REFERENCES assets(asset_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE karaoke_attempt (
    id TEXT NOT NULL PRIMARY KEY,
    session_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    karaoke_revision_id TEXT NOT NULL,
    scoring_version INTEGER NOT NULL,
    scoring_provider TEXT NOT NULL,
    scoring_model TEXT NOT NULL,
    final_score INTEGER NOT NULL,
    lyrics_score INTEGER NOT NULL,
    timing_score INTEGER,
    timing_trend TEXT NOT NULL CHECK (
        timing_trend IN ('early', 'late', 'mixed', 'on_time')
    ),
    scored_line_count INTEGER NOT NULL,
    line_count INTEGER NOT NULL,
    uncertain_line_count INTEGER NOT NULL,
    no_recognition_line_count INTEGER NOT NULL,
    low_confidence_line_count INTEGER NOT NULL,
    completion_reason TEXT NOT NULL CHECK (
        completion_reason IN ('completed', 'session_error', 'provider_unavailable', 'abandoned')
    ),
    rank_eligible INTEGER NOT NULL CHECK (rank_eligible IN (0, 1)),
    activity_date TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL, scoring_diagnostics_json TEXT,
    UNIQUE(session_id, attempt_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE labels (
    label_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'archived')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, color_token TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

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

CREATE TABLE learning_cards (
    learning_card_id TEXT PRIMARY KEY,
    learning_deck_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    retired_at TEXT,
    FOREIGN KEY (learning_deck_id) REFERENCES learning_decks(learning_deck_id) ON DELETE CASCADE
);

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

CREATE TABLE listings (
    listing_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    asset_id TEXT,
    live_room_id TEXT,
    replay_asset_id TEXT,
    listing_mode TEXT NOT NULL CHECK (listing_mode IN ('fixed_price')),
    status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'archived')),
    price_cents INTEGER NOT NULL CHECK (typeof(price_cents) = 'integer' AND price_cents >= 0),
    regional_pricing_policy_json TEXT,
    vinyl_release_provider TEXT CHECK (
        vinyl_release_provider IS NULL OR vinyl_release_provider IN ('elasticstage')
    ),
    vinyl_release_url TEXT,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    CONSTRAINT chk_listings_exactly_one_subject CHECK (
        (asset_id IS NOT NULL AND live_room_id IS NULL AND replay_asset_id IS NULL) OR
        (asset_id IS NULL AND live_room_id IS NOT NULL AND replay_asset_id IS NULL) OR
        (asset_id IS NULL AND live_room_id IS NULL AND replay_asset_id IS NOT NULL)
    )
);

CREATE TABLE live_room_guest_invites (
    guest_invite_id TEXT PRIMARY KEY,
    live_room_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    guest_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
    accepted_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
);

CREATE TABLE live_room_performer_allocations (
    allocation_id TEXT PRIMARY KEY,
    live_room_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('host', 'guest')),
    share_bps INTEGER NOT NULL CHECK (share_bps >= 0 AND share_bps <= 10000),
    created_at TEXT NOT NULL,
    FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
);

CREATE TABLE live_room_recordings (
    recording_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    live_room_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'agora' CHECK (provider IN ('agora')),
    provider_resource_id TEXT,
    provider_session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('starting', 'recording', 'stopping', 'captured', 'ingesting', 'failed')),
    started_at INTEGER,
    stopped_at INTEGER,
    raw_artifact_ref TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
);

CREATE TABLE live_room_replay_allocations (
    allocation_id TEXT PRIMARY KEY,
    replay_asset_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    participant_user_id TEXT,
    external_party_ref TEXT,
    role TEXT NOT NULL,
    share_bps INTEGER NOT NULL CHECK (share_bps >= 0 AND share_bps <= 10000),
    rights_basis TEXT NOT NULL DEFAULT 'performer_default',
    approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (replay_asset_id) REFERENCES live_room_replay_assets(replay_asset_id),
    CHECK (participant_user_id IS NOT NULL OR external_party_ref IS NOT NULL)
);

CREATE TABLE live_room_replay_assets (
    replay_asset_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    live_room_id TEXT NOT NULL,
    source_recording_id TEXT NOT NULL,
    publication_status TEXT NOT NULL CHECK (publication_status IN ('draft', 'published', 'failed')),
    title TEXT NOT NULL,
    caption TEXT,
    duration_ms INTEGER,
    preview_ref TEXT,
    access_mode TEXT NOT NULL CHECK (access_mode IN ('free', 'included_with_ticket', 'paid')),
    primary_content_ref TEXT NOT NULL,
    locked_delivery_status TEXT NOT NULL DEFAULT 'none' CHECK (locked_delivery_status IN ('none', 'requested', 'ready', 'failed')),
    locked_delivery_storage_ref TEXT,
    story_cdr_vault_uuid TEXT,
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, locked_delivery_secret_json TEXT, story_namespace TEXT, story_entitlement_token_id TEXT, story_read_condition TEXT, story_write_condition TEXT, locked_delivery_error TEXT,
    FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id),
    FOREIGN KEY (source_recording_id) REFERENCES live_room_recordings(recording_id)
);

CREATE TABLE live_room_setlist_items (
    setlist_item_id TEXT PRIMARY KEY,
    setlist_id TEXT NOT NULL,
    live_room_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    song_artifact_bundle_id TEXT,
    title TEXT NOT NULL,
    artist TEXT,
    rights_basis TEXT NOT NULL CHECK (rights_basis IN ('original', 'licensed', 'cover', 'public_domain', 'unknown')),
    license_ref TEXT,
    rights_status TEXT NOT NULL CHECK (rights_status IN ('pending', 'ready', 'blocked')),
    blocking_rights_failure INTEGER NOT NULL DEFAULT 0 CHECK (blocking_rights_failure IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, source_asset_ref TEXT,
    FOREIGN KEY (setlist_id) REFERENCES live_room_setlists(setlist_id),
    FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
);

CREATE TABLE live_room_setlists (
    setlist_id TEXT PRIMARY KEY,
    live_room_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'locked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
);

CREATE TABLE live_room_viewer_sessions (
    community_id TEXT NOT NULL,
    live_room_id TEXT NOT NULL,
    viewer_user_id TEXT NOT NULL,
    agora_uid INTEGER NOT NULL CHECK (agora_uid >= 0 AND agora_uid <= 4294967295),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (community_id, live_room_id, viewer_user_id),
    FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
);

CREATE TABLE live_rooms (
    live_room_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    anchor_post_id TEXT NOT NULL,
    host_user_id TEXT NOT NULL,
    guest_user_id TEXT,
    room_kind TEXT NOT NULL CHECK (room_kind IN ('solo', 'duet')),
    status TEXT NOT NULL CHECK (status IN ('scheduled', 'live', 'ended', 'canceled')),
    access_mode TEXT NOT NULL CHECK (access_mode IN ('free', 'gated', 'paid')),
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted')),
    title TEXT NOT NULL,
    description TEXT,
    cover_ref TEXT,
    event_start_at INTEGER,
    live_started_at INTEGER,
    ended_at INTEGER,
    canceled_at INTEGER,
    broadcast_ref TEXT,
    replay_status TEXT NOT NULL CHECK (replay_status IN ('none', 'processing', 'review_pending', 'published', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, store_url TEXT, store_label TEXT, recording_enabled INTEGER DEFAULT 0 CHECK (recording_enabled IS NULL OR recording_enabled IN (0, 1)), replay_asset_id TEXT, replay_listing_id TEXT, audience_gate_json TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (anchor_post_id) REFERENCES posts(post_id)
);

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

CREATE TABLE "moderation_actions" (
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

CREATE TABLE "moderation_actions_legacy" (
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

CREATE TABLE moderation_cases (
    moderation_case_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT,
    comment_id TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('open', 'resolved')
    ),
    queue_scope TEXT NOT NULL CHECK (
        queue_scope IN ('community', 'platform')
    ),
    priority TEXT NOT NULL CHECK (
        priority IN ('low', 'medium', 'high')
    ),
    opened_by TEXT NOT NULL CHECK (
        opened_by IN ('platform_analysis', 'user_report', 'mixed')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (comment_id) REFERENCES comments(comment_id),
    CHECK (
        (post_id IS NOT NULL AND comment_id IS NULL)
        OR (post_id IS NULL AND comment_id IS NOT NULL)
    )
);

CREATE TABLE moderation_signals (
    moderation_signal_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT,
    comment_id TEXT,
    moderation_case_id TEXT,
    analysis_result_ref TEXT,
    source TEXT NOT NULL CHECK (
        source IN ('platform_analysis')
    ),
    signal_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (
        severity IN ('low', 'medium', 'high')
    ),
    provider TEXT NOT NULL,
    provider_label TEXT NOT NULL,
    evidence_ref TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (comment_id) REFERENCES comments(comment_id),
    FOREIGN KEY (moderation_case_id) REFERENCES moderation_cases(moderation_case_id),
    CHECK (
        (post_id IS NOT NULL AND comment_id IS NULL)
        OR (post_id IS NULL AND comment_id IS NOT NULL)
    )
);

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
    updated_at TEXT NOT NULL, namespace_role TEXT NOT NULL DEFAULT 'primary'
    CHECK (namespace_role IN ('primary', 'mirror')),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE namespace_handle_claim_gate_policies (
    claim_gate_expression_ref TEXT PRIMARY KEY,
    namespace_handle_policy_id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
    expression_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (namespace_handle_policy_id)
        REFERENCES namespace_handle_policies(namespace_handle_policy_id)
);

CREATE TABLE namespace_handle_label_claim_rules (
    label_claim_rule_id TEXT PRIMARY KEY,
    namespace_handle_policy_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    selector_type TEXT NOT NULL CHECK (selector_type IN ('exact', 'any')),
    selector_labels_json TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
    expression_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (namespace_handle_policy_id)
        REFERENCES namespace_handle_policies(namespace_handle_policy_id)
);

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
    updated_at TEXT NOT NULL, claims_enabled INTEGER NOT NULL DEFAULT 1 CHECK (claims_enabled IN (0, 1)), claim_gate_mode TEXT NOT NULL DEFAULT 'none' CHECK (
        claim_gate_mode IN ('none', 'inherit_community', 'explicit')
    ), claim_gate_expression_ref TEXT, eligibility_timing TEXT NOT NULL DEFAULT 'claim_time' CHECK (
        eligibility_timing IN ('claim_time', 'continuous')
    ), revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);

CREATE TABLE post_embeds (
    embed_id TEXT PRIMARY KEY,
    embed_key TEXT NOT NULL UNIQUE,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (
        provider IN ('x', 'youtube', 'kalshi', 'polymarket')
    ),
    provider_ref TEXT,
    canonical_url TEXT NOT NULL,
    original_url TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('pending', 'preview', 'embed', 'unavailable')
    ),
    preview_json TEXT,
    oembed_html TEXT,
    oembed_cache_age INTEGER,
    unavailable_reason TEXT CHECK (
        unavailable_reason IS NULL OR unavailable_reason IN ('deleted', 'withheld', 'private', 'unsupported', 'unknown')
    ),
    last_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id)
);

CREATE TABLE post_events (
    post_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    event_start_at INTEGER NOT NULL,
    event_end_at INTEGER,
    event_timezone TEXT NOT NULL,
    location_name TEXT,
    address TEXT,
    is_online INTEGER NOT NULL DEFAULT 0 CHECK (is_online IN (0, 1)),
    event_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('scheduled', 'canceled', 'postponed', 'ended')),
    place_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE post_market_context_markets (
    market_context_market_id TEXT PRIMARY KEY,
    post_market_context_id TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    provider_market_id TEXT NOT NULL,
    provider_event_id TEXT,
    question TEXT NOT NULL,
    outcome_yes_price TEXT NOT NULL,
    liquidity_score TEXT,
    resolve_date TEXT,
    market_url TEXT NOT NULL,
    match_confidence REAL NOT NULL CHECK (
        match_confidence >= 0 AND match_confidence <= 1
    ),
    snapshot_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'removed_by_mod', 'pinned')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_market_context_id) REFERENCES post_market_contexts(post_market_context_id)
);

CREATE TABLE post_market_contexts (
    post_market_context_id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('none', 'pending', 'attached', 'no_match', 'detached')
    ),
    claim_summary TEXT,
    matching_evidence_json TEXT,
    snapshot_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE "post_publish_requests" (
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

CREATE TABLE "posts" (
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
    FOREIGN KEY (parent_post_id) REFERENCES "posts"(post_id)
);

CREATE TABLE protocol_issuance_batches (
    protocol_issuance_batch_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    parent_space TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('open', 'processing', 'published', 'failed')
    ),
    worker_checkpoint TEXT NOT NULL CHECK (
        worker_checkpoint IN (
            'pending_stage',
            'staged',
            'batched',
            'committed',
            'proving_submitted',
            'proving_complete',
            'broadcast',
            'confirming',
            'published',
            'failed'
        )
    ),
    subsd_root_before TEXT,
    subsd_root_after TEXT,
    proof_required INTEGER NOT NULL DEFAULT 0 CHECK (proof_required IN (0, 1)),
    runpod_job_id TEXT,
    runpod_status TEXT,
    proof_input_ref TEXT,
    proof_receipt_ref TEXT,
    bitcoin_txid TEXT,
    bitcoin_commit_ref TEXT,
    fabric_submission_ref TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    committed_at TEXT,
    proving_submitted_at TEXT,
    proving_completed_at TEXT,
    broadcast_at TEXT,
    published_at TEXT, proof_jobs_submitted INTEGER NOT NULL DEFAULT 0 CHECK (proof_jobs_submitted >= 0),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);

CREATE TABLE purchase_allocation_legs (
    purchase_allocation_leg_id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    recipient_type TEXT NOT NULL CHECK (
        recipient_type IN ('creator', 'performer', 'charity', 'community_treasury')
    ),
    recipient_ref TEXT,
    waterfall_position INTEGER NOT NULL CHECK (waterfall_position >= 0),
    share_bps INTEGER NOT NULL CHECK (
        typeof(share_bps) = 'integer' AND share_bps >= 0 AND share_bps <= 10000
    ),
    amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
    settlement_strategy TEXT NOT NULL CHECK (
        settlement_strategy IN ('story_payout', 'provider_payout', 'treasury_payout')
    ),
    status TEXT NOT NULL CHECK (status IN ('quoted', 'pending', 'confirmed', 'failed')),
    settlement_ref TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    provider_receipt_ref TEXT,
    tax_receipt_ref TEXT,
    submitted_at TEXT,
    confirmed_at TEXT,
    failed_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (purchase_id) REFERENCES purchases(purchase_id),
    FOREIGN KEY (quote_id) REFERENCES purchase_quotes(quote_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE purchase_entitlements (
    purchase_entitlement_id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    buyer_kind TEXT NOT NULL DEFAULT 'user' CHECK (
        buyer_kind IN ('user', 'wallet')
    ),
    buyer_user_id TEXT,
    buyer_wallet_address TEXT,
    buyer_wallet_address_normalized TEXT,
    buyer_chain_ref TEXT,
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
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    CHECK (
        buyer_user_id IS NOT NULL OR buyer_wallet_address_normalized IS NOT NULL
    ),
    CHECK (
        (buyer_kind = 'user' AND buyer_user_id IS NOT NULL AND buyer_wallet_address_normalized IS NULL) OR
        (buyer_kind = 'wallet' AND buyer_user_id IS NULL AND buyer_wallet_address_normalized IS NOT NULL)
    )
);

CREATE TABLE purchase_quote_verification_snapshots (
    verification_snapshot_ref TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    buyer_kind TEXT NOT NULL DEFAULT 'user' CHECK (
        buyer_kind IN ('user', 'wallet')
    ),
    buyer_user_id TEXT,
    buyer_wallet_address TEXT,
    buyer_wallet_address_normalized TEXT,
    buyer_chain_ref TEXT,
    provider TEXT,
    nationality_state TEXT NOT NULL,
    nationality_value TEXT,
    pricing_tier TEXT,
    pricing_policy_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (quote_id) REFERENCES purchase_quotes(quote_id),
    CHECK (
        buyer_user_id IS NOT NULL OR buyer_wallet_address_normalized IS NOT NULL
    ),
    CHECK (
        (buyer_kind = 'user' AND buyer_user_id IS NOT NULL AND buyer_wallet_address_normalized IS NULL) OR
        (buyer_kind = 'wallet' AND buyer_user_id IS NULL AND buyer_wallet_address_normalized IS NOT NULL)
    )
);

CREATE TABLE purchase_quotes (
    quote_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    buyer_kind TEXT NOT NULL DEFAULT 'user' CHECK (buyer_kind IN ('user', 'wallet')),
    buyer_user_id TEXT,
    buyer_wallet_address TEXT,
    buyer_wallet_address_normalized TEXT,
    buyer_chain_ref TEXT,
    asset_id TEXT,
    live_room_id TEXT,
    replay_asset_id TEXT,
    base_price_cents INTEGER NOT NULL CHECK (
        typeof(base_price_cents) = 'integer' AND base_price_cents >= 0
    ),
    pricing_tier TEXT,
    final_price_cents INTEGER NOT NULL CHECK (
        typeof(final_price_cents) = 'integer' AND final_price_cents >= 0
    ),
    funding_mode TEXT NOT NULL CHECK (funding_mode IN ('direct', 'routed')),
    funding_asset_json TEXT,
    source_chain_json TEXT,
    route_provider TEXT,
    route_policy_compliant INTEGER NOT NULL CHECK (route_policy_compliant IN (0, 1)),
    route_live_available INTEGER CHECK (route_live_available IN (0, 1)),
    policy_origin TEXT NOT NULL CHECK (policy_origin IN ('default', 'explicit')),
    destination_settlement_chain_json TEXT NOT NULL,
    destination_settlement_token TEXT NOT NULL,
    treasury_denomination TEXT,
    quote_ttl_seconds INTEGER NOT NULL CHECK (quote_ttl_seconds > 0),
    route_required INTEGER NOT NULL CHECK (route_required IN (0, 1)),
    route_status_policy TEXT NOT NULL CHECK (
        route_status_policy IN ('fail', 'fallback_display', 'queue')
    ),
    route_hop_tolerance INTEGER NOT NULL CHECK (route_hop_tolerance >= 0),
    verification_snapshot_ref TEXT,
    pricing_policy_version TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'consumed', 'failed')),
    quoted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    failed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    allocation_snapshot_json TEXT,
    destination_settlement_amount_atomic TEXT,
    destination_settlement_decimals INTEGER,
    settlement_mode TEXT NOT NULL DEFAULT 'delivery_only_story_settlement' CHECK (
        settlement_mode IN ('delivery_only_story_settlement', 'royalty_native_story_payment')
    ),
    funding_destination_address TEXT,
    funding_locked_at TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (listing_id) REFERENCES listings(listing_id),
    CONSTRAINT chk_purchase_quotes_buyer_identity_present CHECK (
        buyer_user_id IS NOT NULL OR buyer_wallet_address_normalized IS NOT NULL
    ),
    CONSTRAINT chk_purchase_quotes_buyer_kind_identity CHECK (
        (buyer_kind = 'user' AND buyer_user_id IS NOT NULL AND buyer_wallet_address_normalized IS NULL) OR
        (buyer_kind = 'wallet' AND buyer_user_id IS NULL AND buyer_wallet_address_normalized IS NOT NULL)
    ),
    CONSTRAINT chk_purchase_quotes_exactly_one_subject CHECK (
        (asset_id IS NOT NULL AND live_room_id IS NULL AND replay_asset_id IS NULL) OR
        (asset_id IS NULL AND live_room_id IS NOT NULL AND replay_asset_id IS NULL) OR
        (asset_id IS NULL AND live_room_id IS NULL AND replay_asset_id IS NOT NULL)
    )
);

CREATE TABLE purchase_settlement_attempts (
    attempt_id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL UNIQUE,
    purchase_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    settlement_wallet_attachment_id TEXT NOT NULL,
    settlement_tx_ref TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('attempting', 'finalized', 'failed')
    ),
    failure_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (quote_id) REFERENCES purchase_quotes(quote_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE purchase_settlement_effects (
    purchase_settlement_effect_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    purchase_id TEXT NOT NULL,
    effect_kind TEXT NOT NULL CHECK (
        effect_kind IN ('buyer_funding_receipt', 'charity_payout', 'story_royalty_payment', 'story_parent_royalty_vault_transfer', 'story_entitlement_mint')
    ),
    effect_key TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed')),
    settlement_ref TEXT,
    provider_receipt_ref TEXT,
    tax_receipt_ref TEXT,
    metadata_json TEXT,
    failure_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    submitted_at TEXT,
    confirmed_at TEXT,
    failed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
, failure_disposition TEXT CHECK (
    failure_disposition IS NULL OR
    failure_disposition IN ('failed_prebroadcast', 'reconciliation_required')
  ), broadcast_tx_ref TEXT, request_fingerprint TEXT, coordinator_plan_ref TEXT, coordinator_state TEXT, coordinator_version INTEGER CHECK (
    coordinator_version IS NULL OR coordinator_version >= 0
  ), reconciliation_reason TEXT, last_reconciled_at TEXT, finality_confirmed_at TEXT);

CREATE TABLE purchase_settlement_transactions (
  purchase_settlement_transaction_id TEXT PRIMARY KEY,
  purchase_settlement_effect_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  step_kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  call_identity_hash TEXT NOT NULL,
  coordinator_step_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  chain_id INTEGER CHECK (chain_id IS NULL OR chain_id > 0),
  signer_address TEXT,
  nonce INTEGER CHECK (nonce IS NULL OR nonce >= 0),
  tx_hash TEXT,
  block_number INTEGER CHECK (block_number IS NULL OR block_number >= 0),
  block_hash TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  prepared_at TEXT,
  broadcast_at TEXT,
  mined_at TEXT,
  confirmed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (purchase_settlement_effect_id)
    REFERENCES purchase_settlement_effects(purchase_settlement_effect_id)
);

CREATE TABLE purchases (
    purchase_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    asset_id TEXT,
    live_room_id TEXT,
    replay_asset_id TEXT,
    buyer_kind TEXT NOT NULL DEFAULT 'user' CHECK (buyer_kind IN ('user', 'wallet')),
    buyer_user_id TEXT,
    buyer_wallet_address TEXT,
    buyer_wallet_address_normalized TEXT,
    buyer_chain_ref TEXT,
    settlement_wallet_attachment_id TEXT NOT NULL,
    purchase_price_cents INTEGER NOT NULL CHECK (
        typeof(purchase_price_cents) = 'integer' AND purchase_price_cents >= 0
    ),
    pricing_tier TEXT,
    settlement_chain TEXT NOT NULL,
    settlement_token TEXT NOT NULL,
    settlement_tx_ref TEXT NOT NULL,
    donation_partner_id TEXT,
    donation_share_bps INTEGER CHECK (
        donation_share_bps IS NULL OR (
            typeof(donation_share_bps) = 'integer' AND
            donation_share_bps >= 0 AND donation_share_bps <= 10000
        )
    ),
    donation_amount_cents INTEGER CHECK (
        donation_amount_cents IS NULL OR (
            typeof(donation_amount_cents) = 'integer' AND donation_amount_cents >= 0
        )
    ),
    donation_settlement_ref TEXT,
    vinyl_release_provider TEXT CHECK (
        vinyl_release_provider IS NULL OR vinyl_release_provider IN ('elasticstage')
    ),
    vinyl_release_url TEXT,
    created_at TEXT NOT NULL,
    settlement_mode TEXT NOT NULL DEFAULT 'delivery_only_story_settlement' CHECK (
        settlement_mode IN ('delivery_only_story_settlement', 'royalty_native_story_payment')
    ),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    CONSTRAINT chk_purchases_buyer_identity_present CHECK (
        buyer_user_id IS NOT NULL OR buyer_wallet_address_normalized IS NOT NULL
    ),
    CONSTRAINT chk_purchases_buyer_kind_identity CHECK (
        (buyer_kind = 'user' AND buyer_user_id IS NOT NULL AND buyer_wallet_address_normalized IS NULL) OR
        (buyer_kind = 'wallet' AND buyer_user_id IS NULL AND buyer_wallet_address_normalized IS NOT NULL)
    ),
    CONSTRAINT chk_purchases_exactly_one_subject CHECK (
        (asset_id IS NOT NULL AND live_room_id IS NULL AND replay_asset_id IS NULL) OR
        (asset_id IS NULL AND live_room_id IS NOT NULL AND replay_asset_id IS NULL) OR
        (asset_id IS NULL AND live_room_id IS NULL AND replay_asset_id IS NOT NULL)
    )
);

CREATE TABLE reward_qualification_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT NOT NULL,
    activity TEXT NOT NULL CHECK (activity IN ('study', 'karaoke')),
    qualified_at TEXT NOT NULL,
    reward_period_key TEXT NOT NULL,
    qualification_policy_version TEXT NOT NULL,
    evidence_summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    UNIQUE (user_id, post_id, activity, reward_period_key)
);

CREATE TABLE rights_holds (
    rights_hold_id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL CHECK (
        subject_type IN ('asset', 'post', 'live_room', 'replay_asset')
    ),
    subject_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    hold_type TEXT NOT NULL CHECK (
        hold_type IN ('reference_required', 'review_hold', 'blocked')
    ),
    source_case_id TEXT,
    analysis_result_ref TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'released')),
    reason_code TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    released_at TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

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

CREATE TABLE song_engagement_days (
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    activity_date TEXT NOT NULL,
    study_attempt_count INTEGER NOT NULL DEFAULT 0,
    study_correct_count INTEGER NOT NULL DEFAULT 0,
    study_target_count INTEGER NOT NULL DEFAULT 10,
    karaoke_pass_count INTEGER NOT NULL DEFAULT 0,
    qualified INTEGER NOT NULL DEFAULT 0 CHECK (qualified IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, activity_timezone TEXT,
    PRIMARY KEY (user_id, post_id, activity_date),
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE song_streaks (
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    current_streak INTEGER NOT NULL,
    best_streak INTEGER NOT NULL,
    last_qualified_date TEXT NOT NULL,
    streak_started_date TEXT NOT NULL,
    total_qualified_days INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, timezone TEXT, timezone_updated_at TEXT, active_until_at TEXT,
    PRIMARY KEY (user_id, post_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE "song_study_attempt" (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    exercise_type TEXT NOT NULL CHECK (
        exercise_type IN ('say_it_back', 'translation_choice', 'fill_blank')
    ),
    target_language TEXT NOT NULL,
    study_pack_version INTEGER NOT NULL,
    attempt_number INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    selected_option_id TEXT,
    transcript TEXT,
    placements_json TEXT,
    outcome TEXT NOT NULL CHECK (
        outcome IN ('correct', 'incorrect', 'revealed')
    ),
    feedback_json TEXT,
    fsrs_rating TEXT CHECK (
        fsrs_rating IS NULL OR fsrs_rating IN ('again', 'hard', 'good', 'easy')
    ),
    created_at TEXT NOT NULL,
    study_session_id TEXT,
    presentation_number INTEGER,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    CONSTRAINT song_study_attempt_number_positive_check CHECK (attempt_number > 0),
    UNIQUE (user_id, idempotency_key)
);

CREATE TABLE song_study_attempt_response (
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    commit_token TEXT NOT NULL,
    response_status TEXT NOT NULL CHECK (response_status IN ('pending', 'final')),
    response_json TEXT NOT NULL,
    materialization_context_json TEXT,
    http_status INTEGER NOT NULL CHECK (http_status >= 100 AND http_status <= 599),
    result_kind TEXT NOT NULL CHECK (
        result_kind IN ('graded', 'ungradable', 'revision_conflict')
    ),
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, idempotency_key),
    FOREIGN KEY (session_id, exercise_id)
        REFERENCES song_study_session_exercise(session_id, exercise_id)
        ON DELETE CASCADE
);

CREATE TABLE song_study_generation_run (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    target_language TEXT NOT NULL,
    generation_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'ready', 'unavailable')
    ),
    job_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (job_id) REFERENCES community_jobs(job_id) ON DELETE SET NULL,
    CHECK (generation_version > 0),
    CHECK (attempt_count >= 0),
    UNIQUE (post_id, target_language, generation_version)
);

CREATE TABLE "song_study_review_state" (
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    exercise_type TEXT NOT NULL CHECK (
        exercise_type IN ('say_it_back', 'translation_choice', 'fill_blank')
    ),
    target_language TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('new', 'learning', 'review', 'relearning')
    ),
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    due_at TEXT NOT NULL,
    last_reviewed_at TEXT,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    fsrs_params_version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    PRIMARY KEY (
        user_id,
        post_id,
        line_id,
        exercise_type,
        target_language
    ),
    CONSTRAINT song_study_review_state_reps_nonnegative_check CHECK (reps >= 0),
    CONSTRAINT song_study_review_state_lapses_nonnegative_check CHECK (lapses >= 0)
);

CREATE TABLE song_study_session (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    target_language TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'expired')),
    exercise_count INTEGER NOT NULL CHECK (exercise_count > 0 AND exercise_count <= 10),
    required_correct_count INTEGER NOT NULL CHECK (
        required_correct_count > 0 AND required_correct_count <= exercise_count
    ),
    max_presentations INTEGER NOT NULL CHECK (
        max_presentations >= exercise_count AND max_presentations <= 20
    ),
    presentation_count INTEGER NOT NULL DEFAULT 0 CHECK (presentation_count >= 0),
    completed_exercise_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_exercise_count >= 0),
    first_pass_correct_count INTEGER NOT NULL DEFAULT 0 CHECK (first_pass_correct_count >= 0),
    mastered_exercise_count INTEGER NOT NULL DEFAULT 0 CHECK (mastered_exercise_count >= 0),
    qualified INTEGER NOT NULL DEFAULT 0 CHECK (qualified IN (0, 1)),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL, session_revision INTEGER NOT NULL DEFAULT 0
    CHECK (session_revision >= 0), current_exercise_id TEXT, completion_reason TEXT
    CHECK (completion_reason IN ('all_resolved', 'presentation_budget')),
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE song_study_session_exercise (
    session_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    presentation_count INTEGER NOT NULL DEFAULT 0 CHECK (
        presentation_count >= 0 AND presentation_count <= 3
    ),
    first_outcome TEXT CHECK (first_outcome IN ('correct', 'incorrect', 'revealed')),
    last_outcome TEXT CHECK (last_outcome IN ('correct', 'incorrect', 'revealed')),
    mastered INTEGER NOT NULL DEFAULT 0 CHECK (mastered IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, appearance_ordinal INTEGER NOT NULL DEFAULT 0
    CHECK (appearance_ordinal >= 0), appearance_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (appearance_attempt_count >= 0 AND appearance_attempt_count <= 2), lesson_resolved INTEGER NOT NULL DEFAULT 0
    CHECK (lesson_resolved IN (0, 1)), last_served_index INTEGER NOT NULL DEFAULT 0
    CHECK (last_served_index >= 0), qualifies_for_reward INTEGER NOT NULL DEFAULT 1
    CHECK (qualifies_for_reward IN (0, 1)),
    PRIMARY KEY (session_id, exercise_id),
    UNIQUE (session_id, ordinal),
    FOREIGN KEY (session_id) REFERENCES song_study_session(id) ON DELETE CASCADE
);

CREATE TABLE song_study_ungradable_receipt (
    session_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    appearance_ordinal INTEGER NOT NULL CHECK (appearance_ordinal >= 0),
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, exercise_id, appearance_ordinal),
    UNIQUE (user_id, idempotency_key),
    FOREIGN KEY (session_id, exercise_id)
        REFERENCES song_study_session_exercise(session_id, exercise_id)
        ON DELETE CASCADE
);

CREATE TABLE song_study_unit (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    line_index INTEGER NOT NULL,
    source_language TEXT,
    prompt_text TEXT NOT NULL,
    reference_text TEXT NOT NULL,
    say_it_back_status TEXT NOT NULL DEFAULT 'ready' CHECK (
        say_it_back_status IN ('ready', 'unavailable')
    ),
    unit_version INTEGER NOT NULL DEFAULT 1,
    max_attempts INTEGER NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    CHECK (max_attempts > 0),
    UNIQUE (post_id, line_id)
);

CREATE TABLE song_study_unit_cloze (
    unit_id TEXT PRIMARY KEY,
    cloze_version INTEGER NOT NULL DEFAULT 1 CHECK (cloze_version > 0),
    status TEXT NOT NULL CHECK (status IN ('ready', 'unavailable')),
    source_text TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    segments_json TEXT,
    tokens_json TEXT,
    correct_placements_json TEXT,
    max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts > 0),
    generated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (unit_id) REFERENCES song_study_unit(id) ON DELETE CASCADE,
    CONSTRAINT song_study_unit_cloze_ready_payload_check CHECK (
        (status = 'ready'
            AND segments_json IS NOT NULL
            AND tokens_json IS NOT NULL
            AND correct_placements_json IS NOT NULL
            AND generated_at IS NOT NULL)
        OR status = 'unavailable'
    )
);

CREATE TABLE song_study_unit_localization (
    id TEXT PRIMARY KEY,
    unit_id TEXT NOT NULL,
    target_language TEXT NOT NULL,
    localization_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (
        status IN ('ready', 'processing', 'unavailable')
    ),
    question TEXT,
    translation_text TEXT,
    options_json TEXT,
    correct_option_id TEXT,
    explanation_text TEXT,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    generated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (unit_id) REFERENCES song_study_unit(id) ON DELETE CASCADE,
    CHECK (max_attempts > 0),
    UNIQUE (unit_id, target_language)
);

CREATE TABLE story_registration_effects (
  story_registration_effect_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  effect_key TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL,
  registration_kind TEXT NOT NULL CHECK (registration_kind IN ('original', 'derivative')),
  creator_wallet_address TEXT NOT NULL,
  primary_content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('executing', 'confirmed', 'failed_prebroadcast', 'reconciliation_required')
  ),
  provider_tx_ref TEXT,
  result_json TEXT,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT, chain_id INTEGER NOT NULL DEFAULT 0, signer_address TEXT NOT NULL DEFAULT '', call_data_hash TEXT NOT NULL DEFAULT '', durable_request_json TEXT,
  FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE thread_snapshots (
    thread_snapshot_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    thread_root_post_id TEXT NOT NULL,
    snapshot_seq INTEGER NOT NULL,
    published_through_comment_created_at TEXT NOT NULL,
    comment_count INTEGER NOT NULL,
    swarm_manifest_ref TEXT NOT NULL,
    swarm_feed_ref TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (thread_root_post_id) REFERENCES posts(post_id)
);

CREATE TABLE user_account_merge_receipts (
    user_account_merge_id TEXT PRIMARY KEY,
    source_user_id TEXT NOT NULL,
    canonical_user_id TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CONSTRAINT user_account_merge_receipts_distinct_users_check
        CHECK (source_user_id <> canonical_user_id)
);

CREATE TABLE user_reports (
    user_report_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT,
    comment_id TEXT,
    moderation_case_id TEXT,
    reporter_user_id TEXT NOT NULL,
    reason_code TEXT NOT NULL CHECK (
        reason_code IN (
            'spam',
            'harassment',
            'hate',
            'sexual_content',
            'graphic_content',
            'misleading',
            'other'
        )
    ),
    note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (post_id) REFERENCES posts(post_id),
    FOREIGN KEY (comment_id) REFERENCES comments(comment_id),
    FOREIGN KEY (moderation_case_id) REFERENCES moderation_cases(moderation_case_id),
    CHECK (
        (post_id IS NOT NULL AND comment_id IS NULL)
        OR (post_id IS NULL AND comment_id IS NOT NULL)
    )
);

CREATE INDEX idx_asset_derivative_links_asset
    ON asset_derivative_links(asset_id);

CREATE INDEX idx_asset_derivative_links_upstream
    ON asset_derivative_links(upstream_asset_id);

CREATE INDEX idx_asset_enforcement_state_updated
    ON asset_enforcement(enforcement_state, updated_at);

CREATE UNIQUE INDEX idx_asset_payloads_active_primary
    ON asset_payloads(asset_id)
    WHERE role = 'primary' AND status = 'active';

CREATE INDEX idx_asset_payloads_content_blob_ref ON asset_payloads(content_blob_ref);

CREATE INDEX idx_assets_community_created ON assets(community_id, created_at DESC);

CREATE INDEX idx_assets_community_primary_content_hash ON assets(community_id, primary_content_hash);

CREATE UNIQUE INDEX idx_assets_source_post ON assets(source_post_id);

CREATE INDEX idx_assets_story_asset_version_id ON assets(story_asset_version_id);

CREATE INDEX idx_assets_story_ip_nft ON assets(story_ip_nft_contract, story_ip_nft_token_id);

CREATE INDEX idx_assets_story_publish_model ON assets(story_publish_model, created_at DESC);

CREATE INDEX idx_assets_story_status ON assets(story_status, created_at DESC);

CREATE INDEX idx_assistant_chats_user
    ON community_assistant_chats(community_id, user_id, updated_at DESC, chat_id DESC);

CREATE INDEX idx_assistant_messages_chat
    ON community_assistant_messages(chat_id, created_at ASC, message_id ASC);

CREATE INDEX idx_assistant_messages_user_daily
    ON community_assistant_messages(community_id, user_id, role, created_at DESC);

CREATE INDEX idx_assistant_prompt_revisions_community
    ON community_assistant_prompt_revisions(community_id, created_at DESC);

CREATE INDEX idx_booking_attendance_heartbeats_session
    ON booking_attendance_heartbeats(session_id, seen_at);

CREATE INDEX idx_booking_attendance_sessions_booking
    ON booking_attendance_sessions(booking_id, party);

CREATE UNIQUE INDEX idx_booking_holds_active_slot
    ON booking_holds(community_id, host_user_id, slot_start_utc)
    WHERE status = 'active';

CREATE INDEX idx_booking_holds_booker
    ON booking_holds(community_id, booker_user_id, slot_start_utc);

CREATE INDEX idx_booking_holds_expiry
    ON booking_holds(status, expires_at_utc);

CREATE UNIQUE INDEX idx_booking_payment_intents_claimed_tx ON booking_payment_intents (claimed_tx_ref);

CREATE UNIQUE INDEX idx_booking_payment_intents_hold ON booking_payment_intents (hold_id);

CREATE INDEX idx_booking_settlement_effects_booking
    ON booking_settlement_effects(booking_id, status);

CREATE UNIQUE INDEX idx_booking_settlement_effects_idempotency
    ON booking_settlement_effects(idempotency_key);

CREATE UNIQUE INDEX idx_bookings_active_slot
    ON bookings(community_id, host_user_id, slot_start_utc)
    WHERE status IN ('pending_payment', 'confirmed', 'live', 'completed', 'settled');

CREATE INDEX idx_bookings_booker
    ON bookings(community_id, booker_user_id, slot_start_utc);

CREATE UNIQUE INDEX idx_bookings_hold
    ON bookings(hold_id)
    WHERE hold_id IS NOT NULL;

CREATE INDEX idx_bookings_host
    ON bookings(community_id, host_user_id, slot_start_utc);

CREATE INDEX idx_bookings_settlement_review_pending
    ON bookings(community_id, settlement_review_status, updated_at)
    WHERE settlement_review_status = 'pending';

CREATE INDEX idx_bookings_status
    ON bookings(community_id, status);

CREATE INDEX idx_comment_closure_ancestor_distance
    ON comment_closure(ancestor_comment_id, distance, descendant_comment_id);

CREATE INDEX idx_comment_closure_descendant
    ON comment_closure(descendant_comment_id, ancestor_comment_id);

CREATE UNIQUE INDEX idx_comment_votes_unique
    ON comment_votes(comment_id, user_id);

CREATE INDEX idx_comments_agent_authorship
    ON comments(authorship_mode, agent_id, created_at DESC);

CREATE INDEX idx_comments_author_created
    ON comments(author_user_id, created_at DESC);

CREATE UNIQUE INDEX idx_comments_author_idempotency
    ON comments(community_id, author_user_id, idempotency_key)
    WHERE author_user_id IS NOT NULL AND idempotency_key <> '';

CREATE INDEX idx_comments_parent_created
    ON comments(parent_comment_id, created_at);

CREATE INDEX idx_comments_thread_parent_created
    ON comments(thread_root_post_id, parent_comment_id, created_at);

CREATE INDEX idx_comments_thread_source_language
    ON comments(thread_root_post_id, source_language, created_at DESC);

CREATE INDEX idx_comments_thread_status_created
    ON comments(thread_root_post_id, status, created_at);

CREATE UNIQUE INDEX idx_community_follows_unique
    ON community_follows(community_id, user_id);

CREATE INDEX idx_community_follows_user_status
    ON community_follows(user_id, status);

CREATE INDEX idx_community_gate_policies_scope_updated
    ON community_gate_policies(scope, updated_at);

CREATE INDEX idx_community_handle_claim_quotes_intent
    ON community_handle_claim_quotes(handle_claim_intent_id, created_at DESC);

CREATE INDEX idx_community_handle_claim_quotes_namespace_label
    ON community_handle_claim_quotes(namespace_id, label_normalized, status);

CREATE INDEX idx_community_handle_claim_quotes_user_status
    ON community_handle_claim_quotes(user_id, status, created_at DESC);

CREATE INDEX idx_community_handle_label_reservations_active_expiry
    ON community_handle_label_reservations(expires_at)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_community_handle_label_reservations_active_intent
    ON community_handle_label_reservations(handle_claim_intent_id)
    WHERE status = 'active' AND handle_claim_intent_id IS NOT NULL;

CREATE UNIQUE INDEX idx_community_handle_label_reservations_active_label
    ON community_handle_label_reservations(namespace_id, label_normalized)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_community_handle_label_reservations_active_payment_user
    ON community_handle_label_reservations(user_id)
    WHERE status = 'active' AND purpose = 'payment';

CREATE UNIQUE INDEX idx_community_handles_active_namespace_label
    ON community_handles(namespace_id, label_normalized)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_community_handles_active_user_namespace
    ON community_handles(namespace_id, user_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_community_handles_claim_blocking_namespace_label
    ON community_handles(namespace_id, label_normalized)
    WHERE status IN ('active', 'reserved');

CREATE UNIQUE INDEX idx_community_handles_claim_intent_once
    ON community_handles(handle_claim_intent_id)
    WHERE handle_claim_intent_id IS NOT NULL;

CREATE INDEX idx_community_handles_user_status
    ON community_handles(user_id, status, created_at DESC);

CREATE INDEX idx_community_job_events_community
  ON community_job_events(community_id, created_at DESC);

CREATE INDEX idx_community_job_events_job
  ON community_job_events(job_id, created_at ASC);

CREATE UNIQUE INDEX idx_community_jobs_active_subject
    ON community_jobs(community_id, job_type, subject_type, subject_id)
    WHERE status IN ('queued', 'running');

CREATE INDEX idx_community_jobs_community
    ON community_jobs(community_id, status);

CREATE INDEX idx_community_jobs_running_checkpoint
  ON community_jobs(status, last_checkpoint_at)
  WHERE status = 'running';

CREATE INDEX idx_community_jobs_running_deadline
  ON community_jobs(status, attempt_deadline_at)
  WHERE status = 'running';

CREATE INDEX idx_community_jobs_running_lease
  ON community_jobs(status, lease_expires_at)
  WHERE status = 'running';

CREATE INDEX idx_community_jobs_status_available
    ON community_jobs(status, available_at);

CREATE INDEX idx_community_localization_meta_updated
    ON community_localization_meta(community_id, updated_at DESC);

CREATE UNIQUE INDEX idx_community_memberships_active_member
    ON community_memberships(community_id, user_id)
    WHERE status = 'member';

CREATE INDEX idx_community_memberships_state_lookup
    ON community_memberships(community_id, user_id, created_at DESC);

CREATE INDEX idx_community_memberships_user_status
    ON community_memberships(user_id, status);

CREATE UNIQUE INDEX idx_community_roles_active_owner_unique
    ON community_roles(community_id)
    WHERE status = 'active' AND role = 'owner';

CREATE UNIQUE INDEX idx_community_roles_active_unique
    ON community_roles(community_id, user_id, role)
    WHERE status = 'active';

CREATE INDEX idx_community_roles_state_lookup
    ON community_roles(community_id, user_id, created_at DESC);

CREATE INDEX idx_community_rules_order
    ON community_rules(community_id, status, position);

CREATE INDEX idx_content_translations_content_updated
    ON content_translations(content_type, content_id, field_key, updated_at DESC);

CREATE UNIQUE INDEX idx_content_translations_lookup
    ON content_translations(content_type, content_id, field_key, locale, source_hash);

CREATE INDEX idx_dance_attempt_revision_score ON dance_attempt(dance_choreography_revision_id, rank_eligible, score_bps DESC, completed_at);

CREATE INDEX idx_dance_attempt_user_post ON dance_attempt(user_id, post_id, completed_at DESC);

CREATE INDEX idx_initial_royalty_allocations_asset
    ON initial_royalty_allocations(asset_id, position ASC);

CREATE UNIQUE INDEX idx_initial_royalty_allocations_asset_position
    ON initial_royalty_allocations(asset_id, position);

CREATE UNIQUE INDEX idx_initial_royalty_allocations_asset_wallet
    ON initial_royalty_allocations(asset_id, wallet_address_normalized);

CREATE UNIQUE INDEX idx_initial_royalty_allocations_one_creator
    ON initial_royalty_allocations(asset_id)
    WHERE recipient_kind = 'creator';

CREATE INDEX idx_initial_royalty_allocations_recipient_user
    ON initial_royalty_allocations(recipient_user_id)
    WHERE recipient_user_id IS NOT NULL;

CREATE INDEX idx_initial_royalty_allocations_wallet
    ON initial_royalty_allocations(wallet_address_normalized);

CREATE INDEX idx_karaoke_attempt_rank
    ON karaoke_attempt(
        post_id,
        karaoke_revision_id,
        scoring_version,
        scoring_provider,
        scoring_model,
        rank_eligible,
        final_score DESC,
        completed_at
    );

CREATE INDEX idx_karaoke_attempt_user_post
    ON karaoke_attempt(user_id, post_id, completed_at DESC);

CREATE INDEX idx_labels_club_status
    ON labels(community_id, status);

CREATE INDEX idx_learning_card_versions_card ON learning_card_versions(learning_card_id);

CREATE INDEX idx_learning_cards_deck ON learning_cards(learning_deck_id, created_at);

CREATE INDEX idx_learning_deck_versions_status
    ON learning_deck_versions(learning_deck_id, status, version DESC);

CREATE INDEX idx_learning_decks_asset ON learning_decks(asset_id);

CREATE INDEX idx_learning_decks_community_status
    ON learning_decks(community_id, status, updated_at DESC);

CREATE INDEX idx_learning_decks_source_post ON learning_decks(source_post_id);

CREATE INDEX idx_learning_review_events_deck_reviewed
    ON learning_review_events(user_id, learning_deck_id, reviewed_at DESC);

CREATE INDEX idx_learning_review_events_item_sequence
    ON learning_review_events(user_id, review_item_id, item_event_sequence DESC);

CREATE INDEX idx_learning_review_state_due ON learning_review_state(user_id, due_at);

CREATE INDEX idx_learning_session_items_status
    ON learning_session_items(learning_session_id, status, ordinal);

CREATE INDEX idx_learning_sessions_scope
    ON learning_sessions(scope_kind, scope_ref, status);

CREATE INDEX idx_learning_sessions_user_status
    ON learning_sessions(user_id, status, expires_at);

CREATE UNIQUE INDEX idx_listings_community_asset_unique
    ON listings(community_id, asset_id)
    WHERE asset_id IS NOT NULL;

CREATE INDEX idx_listings_community_status
    ON listings(community_id, status, created_at DESC);

CREATE INDEX idx_listings_live_room
    ON listings(live_room_id) WHERE live_room_id IS NOT NULL;

CREATE INDEX idx_listings_replay_asset
    ON listings(replay_asset_id) WHERE replay_asset_id IS NOT NULL;

CREATE UNIQUE INDEX idx_live_room_allocations_role
    ON live_room_performer_allocations(live_room_id, role);

CREATE UNIQUE INDEX idx_live_room_guest_invites_active
    ON live_room_guest_invites(live_room_id, guest_user_id)
    WHERE status IN ('pending', 'accepted');

CREATE INDEX idx_live_room_recordings_community_status
    ON live_room_recordings(community_id, status, updated_at DESC);

CREATE UNIQUE INDEX idx_live_room_recordings_room
    ON live_room_recordings(live_room_id);

CREATE INDEX idx_live_room_replay_allocations_asset
    ON live_room_replay_allocations(replay_asset_id);

CREATE INDEX idx_live_room_replay_assets_community_status
    ON live_room_replay_assets(community_id, publication_status, updated_at DESC);

CREATE UNIQUE INDEX idx_live_room_replay_assets_room
    ON live_room_replay_assets(live_room_id);

CREATE UNIQUE INDEX idx_live_room_setlist_items_position
    ON live_room_setlist_items(setlist_id, position);

CREATE UNIQUE INDEX idx_live_room_setlists_room
    ON live_room_setlists(live_room_id);

CREATE UNIQUE INDEX idx_live_room_viewer_sessions_uid
    ON live_room_viewer_sessions(community_id, live_room_id, agora_uid);

CREATE INDEX idx_live_room_viewer_sessions_viewer
    ON live_room_viewer_sessions(community_id, viewer_user_id, updated_at DESC);

CREATE INDEX idx_live_rooms_community_status
    ON live_rooms(community_id, status, created_at DESC);

CREATE INDEX idx_media_analysis_results_outcome
    ON media_analysis_results(outcome, created_at DESC);

CREATE INDEX idx_media_analysis_results_post
    ON media_analysis_results(source_post_id);

CREATE UNIQUE INDEX idx_membership_requests_pending
    ON membership_requests(community_id, applicant_user_id)
    WHERE status = 'pending';

CREATE INDEX idx_moderation_actions_asset_created
    ON moderation_actions(asset_id, created_at DESC);

CREATE INDEX idx_moderation_actions_case_created
    ON moderation_actions(moderation_case_id, created_at DESC);

CREATE INDEX idx_moderation_actions_comment_created
    ON moderation_actions(comment_id, created_at DESC);

CREATE INDEX idx_moderation_actions_community_created
    ON moderation_actions(community_id, created_at DESC);

CREATE INDEX idx_moderation_actions_post_created
    ON moderation_actions(post_id, created_at DESC);

CREATE INDEX idx_moderation_cases_comment
    ON moderation_cases(comment_id);

CREATE INDEX idx_moderation_cases_community_status_updated
    ON moderation_cases(community_id, status, updated_at DESC);

CREATE UNIQUE INDEX idx_moderation_cases_open
    ON moderation_cases(community_id, COALESCE(post_id, ''), COALESCE(comment_id, ''))
    WHERE status = 'open';

CREATE INDEX idx_moderation_cases_post
    ON moderation_cases(post_id);

CREATE INDEX idx_moderation_signals_analysis_result
    ON moderation_signals(analysis_result_ref);

CREATE INDEX idx_moderation_signals_case_created
    ON moderation_signals(moderation_case_id, created_at DESC);

CREATE INDEX idx_moderation_signals_comment_created
    ON moderation_signals(comment_id, created_at DESC);

CREATE INDEX idx_moderation_signals_post_created
    ON moderation_signals(post_id, created_at DESC);

CREATE UNIQUE INDEX idx_namespace_bindings_active_primary_community
  ON namespace_bindings(community_id)
  WHERE status = 'active' AND namespace_role = 'primary';

CREATE UNIQUE INDEX idx_namespace_bindings_active_verification
  ON namespace_bindings(namespace_verification_id)
  WHERE status = 'active';

CREATE INDEX idx_namespace_handle_claim_gate_policies_updated
    ON namespace_handle_claim_gate_policies(updated_at);

CREATE UNIQUE INDEX idx_namespace_handle_label_claim_rules_position
    ON namespace_handle_label_claim_rules(namespace_handle_policy_id, position);

CREATE INDEX idx_namespace_handle_label_claim_rules_updated
    ON namespace_handle_label_claim_rules(updated_at);

CREATE UNIQUE INDEX idx_namespace_handle_policies_namespace
    ON namespace_handle_policies(namespace_id);

CREATE INDEX idx_post_embeds_post
    ON post_embeds(post_id);

CREATE INDEX idx_post_embeds_provider_ref
    ON post_embeds(provider, provider_ref);

CREATE INDEX idx_post_embeds_recheck
    ON post_embeds(provider, state, last_checked_at);

CREATE INDEX idx_post_events_community_start
    ON post_events(community_id, event_start_at, post_id);

CREATE INDEX idx_post_market_context_markets_context_status
    ON post_market_context_markets(post_market_context_id, status, snapshot_at DESC);

CREATE UNIQUE INDEX idx_post_market_context_markets_unique_provider_market
    ON post_market_context_markets(post_market_context_id, provider_key, provider_market_id);

CREATE INDEX idx_post_market_contexts_community_status
    ON post_market_contexts(community_id, status, updated_at DESC);

CREATE UNIQUE INDEX idx_post_market_contexts_post
    ON post_market_contexts(post_id);

CREATE INDEX idx_post_publish_requests_status
    ON post_publish_requests(community_id, status, updated_at);

CREATE UNIQUE INDEX idx_post_reactions_unique
    ON post_reactions(post_id, user_id, reaction_key);

CREATE UNIQUE INDEX idx_post_votes_unique
    ON post_votes(post_id, user_id);

CREATE INDEX idx_posts_agent_authorship ON posts(authorship_mode, agent_id, created_at DESC);

CREATE INDEX idx_posts_author ON posts(author_user_id, created_at DESC);

CREATE UNIQUE INDEX idx_posts_author_idempotency
    ON posts(community_id, author_user_id, idempotency_key)
    WHERE author_user_id IS NOT NULL AND idempotency_key <> '';

CREATE INDEX idx_posts_community_created ON posts(community_id, created_at DESC);

CREATE INDEX idx_posts_parent ON posts(parent_post_id, created_at);

CREATE UNIQUE INDEX idx_protocol_issuance_batches_bitcoin_tx
    ON protocol_issuance_batches(bitcoin_txid)
    WHERE bitcoin_txid IS NOT NULL;

CREATE INDEX idx_protocol_issuance_batches_parent_checkpoint
    ON protocol_issuance_batches(parent_space, worker_checkpoint, created_at);

CREATE UNIQUE INDEX idx_protocol_issuance_batches_runpod_job
    ON protocol_issuance_batches(runpod_job_id)
    WHERE runpod_job_id IS NOT NULL;

CREATE INDEX idx_protocol_issuance_batches_status
    ON protocol_issuance_batches(status, updated_at);

CREATE INDEX idx_protocol_issuances_batch
    ON community_handle_protocol_issuances(protocol_issuance_batch_id);

CREATE UNIQUE INDEX idx_protocol_issuances_handle_once
    ON community_handle_protocol_issuances(community_handle_id);

CREATE INDEX idx_protocol_issuances_pending_parent
    ON community_handle_protocol_issuances(parent_space, public_status, created_at)
    WHERE protocol_issuance_batch_id IS NULL;

CREATE UNIQUE INDEX idx_protocol_issuances_sname_active
    ON community_handle_protocol_issuances(parent_space, sname)
    WHERE public_status IN ('issuing', 'issued');

CREATE INDEX idx_purchase_allocation_legs_purchase
    ON purchase_allocation_legs(purchase_id, waterfall_position ASC, created_at ASC);

CREATE INDEX idx_purchase_entitlements_buyer_status
    ON purchase_entitlements(buyer_user_id, status)
    WHERE buyer_kind = 'user';

CREATE INDEX idx_purchase_entitlements_target
    ON purchase_entitlements(entitlement_kind, target_ref, status);

CREATE INDEX idx_purchase_entitlements_wallet_status
    ON purchase_entitlements(buyer_chain_ref, buyer_wallet_address_normalized, status)
    WHERE buyer_kind = 'wallet';

CREATE INDEX idx_purchase_quote_verification_snapshots_quote
    ON purchase_quote_verification_snapshots(quote_id);

CREATE INDEX idx_purchase_quotes_buyer_status
    ON purchase_quotes(buyer_user_id, status, expires_at DESC) WHERE buyer_kind = 'user';

CREATE INDEX idx_purchase_quotes_community_status
    ON purchase_quotes(community_id, status, expires_at DESC);

CREATE INDEX idx_purchase_quotes_listing_status
    ON purchase_quotes(listing_id, status, expires_at DESC);

CREATE INDEX idx_purchase_quotes_status_expires
    ON purchase_quotes(status, expires_at DESC);

CREATE INDEX idx_purchase_quotes_wallet_status
    ON purchase_quotes(buyer_chain_ref, buyer_wallet_address_normalized, status, expires_at DESC)
    WHERE buyer_kind = 'wallet';

CREATE INDEX idx_purchase_settlement_attempts_status_updated
    ON purchase_settlement_attempts(status, updated_at ASC);

CREATE UNIQUE INDEX idx_purchase_settlement_effects_funding_tx_singleuse
  ON purchase_settlement_effects(community_id, effect_key)
  WHERE effect_kind = 'buyer_funding_receipt';

CREATE UNIQUE INDEX idx_purchase_settlement_effects_idempotency
    ON purchase_settlement_effects(idempotency_key);

CREATE INDEX idx_purchase_settlement_effects_parent_recovery
  ON purchase_settlement_effects(status, failure_disposition, updated_at)
  WHERE effect_kind = 'story_parent_royalty_vault_transfer'
    AND status IN ('submitted', 'failed');

CREATE INDEX idx_purchase_settlement_effects_purchase
    ON purchase_settlement_effects(purchase_id, effect_kind, status);

CREATE UNIQUE INDEX idx_purchase_settlement_effects_quote_kind_key
    ON purchase_settlement_effects(community_id, quote_id, effect_kind, effect_key);

CREATE UNIQUE INDEX idx_purchase_settlement_transactions_coordinator_step
  ON purchase_settlement_transactions(coordinator_step_ref);

CREATE UNIQUE INDEX idx_purchase_settlement_transactions_effect_step
  ON purchase_settlement_transactions(purchase_settlement_effect_id, step_key);

CREATE UNIQUE INDEX idx_purchase_settlement_transactions_signer_nonce
  ON purchase_settlement_transactions(chain_id, signer_address, nonce)
  WHERE chain_id IS NOT NULL
    AND signer_address IS NOT NULL
    AND nonce IS NOT NULL;

CREATE INDEX idx_purchases_buyer_created
    ON purchases(buyer_user_id, created_at DESC) WHERE buyer_kind = 'user';

CREATE INDEX idx_purchases_community_created
    ON purchases(community_id, created_at DESC);

CREATE INDEX idx_purchases_wallet_created
    ON purchases(buyer_chain_ref, buyer_wallet_address_normalized, created_at DESC)
    WHERE buyer_kind = 'wallet';

CREATE INDEX idx_reward_qualification_outbox_sequence
    ON reward_qualification_outbox(sequence);

CREATE UNIQUE INDEX idx_rights_holds_active_subject
    ON rights_holds(subject_type, subject_id)
    WHERE status = 'active';

CREATE INDEX idx_rights_holds_case
    ON rights_holds(source_case_id)
    WHERE source_case_id IS NOT NULL;

CREATE INDEX idx_rights_holds_subject
    ON rights_holds(subject_type, subject_id, status);

CREATE UNIQUE INDEX idx_rights_review_cases_open_subject_trigger
    ON rights_review_cases(subject_type, subject_id, trigger_source)
    WHERE status IN ('open', 'under_review');

CREATE INDEX idx_rights_review_cases_status
    ON rights_review_cases(status, created_at DESC);

CREATE INDEX idx_rights_review_cases_subject
    ON rights_review_cases(subject_type, subject_id);

CREATE INDEX idx_song_engagement_days_user_post
    ON song_engagement_days(user_id, post_id, activity_date);

CREATE INDEX idx_song_streaks_active ON song_streaks(post_id, active_until_at);

CREATE INDEX idx_song_streaks_board
    ON song_streaks(
        post_id,
        current_streak DESC,
        best_streak DESC,
        streak_started_date,
        user_id
    );

CREATE INDEX idx_song_study_attempt_response_session
    ON song_study_attempt_response(session_id, created_at);

CREATE INDEX idx_song_study_attempt_review_unit
    ON song_study_attempt(
        user_id,
        post_id,
        line_id,
        exercise_type,
        target_language,
        created_at
    );

CREATE UNIQUE INDEX idx_song_study_attempt_session_presentation
    ON song_study_attempt(user_id, study_session_id, exercise_id, presentation_number)
    WHERE study_session_id IS NOT NULL;

CREATE INDEX idx_song_study_generation_run_status
    ON song_study_generation_run(status, updated_at ASC);

CREATE INDEX idx_song_study_review_due
    ON song_study_review_state(user_id, due_at);

CREATE UNIQUE INDEX idx_song_study_session_active
    ON song_study_session(user_id, post_id, target_language)
    WHERE status = 'active';

CREATE INDEX idx_song_study_session_exercise_queue
    ON song_study_session_exercise(session_id, mastered, presentation_count, ordinal);

CREATE INDEX idx_song_study_session_expiry
    ON song_study_session(status, expires_at);

CREATE INDEX idx_song_study_unit_cloze_status
    ON song_study_unit_cloze(status, updated_at);

CREATE INDEX idx_song_study_unit_localization_lookup
    ON song_study_unit_localization(target_language, status);

CREATE INDEX idx_song_study_unit_post
    ON song_study_unit(post_id, line_index);

CREATE UNIQUE INDEX idx_story_registration_effects_asset
  ON story_registration_effects(community_id, asset_id);

CREATE INDEX idx_story_registration_effects_reconciliation
  ON story_registration_effects(status, updated_at)
  WHERE status = 'reconciliation_required';

CREATE INDEX idx_thread_snapshots_thread_created
    ON thread_snapshots(thread_root_post_id, created_at DESC);

CREATE UNIQUE INDEX idx_thread_snapshots_thread_seq
    ON thread_snapshots(thread_root_post_id, snapshot_seq);

CREATE INDEX idx_user_account_merge_receipts_canonical
    ON user_account_merge_receipts(canonical_user_id, completed_at);

CREATE INDEX idx_user_reports_case_created
    ON user_reports(moderation_case_id, created_at DESC);

CREATE INDEX idx_user_reports_comment_created
    ON user_reports(comment_id, created_at DESC);

CREATE INDEX idx_user_reports_post_created
    ON user_reports(post_id, created_at DESC);

CREATE UNIQUE INDEX idx_user_reports_unique_reporter
    ON user_reports(community_id, COALESCE(post_id, ''), COALESCE(comment_id, ''), reporter_user_id);

CREATE TRIGGER dance_attempt_segment_fingerprints_insert
BEFORE INSERT ON dance_attempt
WHEN NEW.segment_fingerprint_hmac_json IS NOT NULL AND EXISTS (
    SELECT 1 FROM json_each(NEW.segment_fingerprint_hmac_json)
    WHERE type <> 'text' OR length(value) <> 64 OR value GLOB '*[^0-9a-f]*'
)
BEGIN
    SELECT RAISE(ABORT, 'invalid dance segment fingerprint');
END;

CREATE TRIGGER dance_attempt_segment_fingerprints_update
BEFORE UPDATE OF segment_fingerprint_hmac_json ON dance_attempt
WHEN NEW.segment_fingerprint_hmac_json IS NOT NULL AND EXISTS (
    SELECT 1 FROM json_each(NEW.segment_fingerprint_hmac_json)
    WHERE type <> 'text' OR length(value) <> 64 OR value GLOB '*[^0-9a-f]*'
)
BEGIN
    SELECT RAISE(ABORT, 'invalid dance segment fingerprint');
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

CREATE TRIGGER learning_deck_versions_published_no_delete
BEFORE DELETE ON learning_deck_versions
WHEN OLD.status = 'published'
BEGIN
    SELECT RAISE(ABORT, 'published learning deck versions cannot be deleted');
END;

CREATE TRIGGER learning_deck_versions_published_no_update
BEFORE UPDATE ON learning_deck_versions
WHEN OLD.status = 'published'
BEGIN
    SELECT RAISE(ABORT, 'published learning deck versions are immutable');
END;

CREATE TRIGGER learning_decks_published_no_delete
BEFORE DELETE ON learning_decks
WHEN OLD.status IN ('published', 'archived')
BEGIN
    SELECT RAISE(ABORT, 'published learning decks cannot be deleted');
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
