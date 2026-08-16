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

CREATE UNIQUE INDEX idx_live_room_viewer_sessions_uid
    ON live_room_viewer_sessions(community_id, live_room_id, agora_uid);

CREATE INDEX idx_live_room_viewer_sessions_viewer
    ON live_room_viewer_sessions(community_id, viewer_user_id, updated_at DESC);
