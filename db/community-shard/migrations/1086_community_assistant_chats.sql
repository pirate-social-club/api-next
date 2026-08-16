PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS community_assistant_chats (
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

CREATE TABLE IF NOT EXISTS community_assistant_messages (
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

CREATE INDEX IF NOT EXISTS idx_assistant_chats_user
    ON community_assistant_chats(community_id, user_id, updated_at DESC, chat_id DESC);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_chat
    ON community_assistant_messages(chat_id, created_at ASC, message_id ASC);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_user_daily
    ON community_assistant_messages(community_id, user_id, role, created_at DESC);
