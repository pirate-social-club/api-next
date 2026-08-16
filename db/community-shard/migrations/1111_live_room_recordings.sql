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

CREATE UNIQUE INDEX idx_live_room_recordings_room
    ON live_room_recordings(live_room_id);

CREATE INDEX idx_live_room_recordings_community_status
    ON live_room_recordings(community_id, status, updated_at DESC);
