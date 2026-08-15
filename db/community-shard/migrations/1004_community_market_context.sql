PRAGMA foreign_keys = ON;

CREATE TABLE community_market_context_policies (
    community_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (
        mode IN ('off', 'on')
    ),
    enabled_post_types_json TEXT NOT NULL,
    max_markets_per_post INTEGER NOT NULL CHECK (
        max_markets_per_post >= 1 AND max_markets_per_post <= 3
    ),
    provider_set TEXT NOT NULL CHECK (
        provider_set IN ('platform_default', 'approved_profile')
    ),
    market_context_profile_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
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

CREATE UNIQUE INDEX idx_post_market_contexts_post
    ON post_market_contexts(post_id);

CREATE INDEX idx_post_market_contexts_community_status
    ON post_market_contexts(community_id, status, updated_at DESC);

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

CREATE UNIQUE INDEX idx_post_market_context_markets_unique_provider_market
    ON post_market_context_markets(post_market_context_id, provider_key, provider_market_id);

CREATE INDEX idx_post_market_context_markets_context_status
    ON post_market_context_markets(post_market_context_id, status, snapshot_at DESC);
