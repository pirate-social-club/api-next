ALTER TABLE live_rooms ADD COLUMN replay_asset_id TEXT;
ALTER TABLE live_rooms ADD COLUMN replay_listing_id TEXT;

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
    updated_at TEXT NOT NULL,
    FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id),
    FOREIGN KEY (source_recording_id) REFERENCES live_room_recordings(recording_id)
);

CREATE UNIQUE INDEX idx_live_room_replay_assets_room
    ON live_room_replay_assets(live_room_id);

CREATE INDEX idx_live_room_replay_assets_community_status
    ON live_room_replay_assets(community_id, publication_status, updated_at DESC);

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

CREATE INDEX idx_live_room_replay_allocations_asset
    ON live_room_replay_allocations(replay_asset_id);
