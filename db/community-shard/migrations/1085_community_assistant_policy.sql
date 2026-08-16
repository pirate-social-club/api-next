PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS community_assistant_policy (
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
        voice_mode IN ('off', 'transcription_only', 'voice_replies')
    ),
    stt_provider TEXT NOT NULL DEFAULT 'mistral' CHECK (
        stt_provider IN ('mistral', 'openai', 'none')
    ),
    stt_model TEXT NOT NULL DEFAULT '',
    tts_voice TEXT NOT NULL DEFAULT '',
    include_in_sovereign_export INTEGER NOT NULL DEFAULT 1 CHECK (
        include_in_sovereign_export IN (0, 1)
    ),
    policy_origin TEXT NOT NULL DEFAULT 'default' CHECK (
        policy_origin IN ('default', 'explicit')
    ),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (community_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE TABLE IF NOT EXISTS community_assistant_prompt_revisions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    community_id TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    default_prompt TEXT NOT NULL,
    starter_prompts TEXT NOT NULL DEFAULT '[]',
    actor_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX IF NOT EXISTS idx_assistant_prompt_revisions_community
    ON community_assistant_prompt_revisions(community_id, created_at DESC);
