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

CREATE INDEX idx_post_events_community_start
    ON post_events(community_id, event_start_at, post_id);
