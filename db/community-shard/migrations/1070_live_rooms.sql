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
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (anchor_post_id) REFERENCES posts(post_id)
);

CREATE INDEX idx_live_rooms_community_status
    ON live_rooms(community_id, status, created_at DESC);

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

CREATE UNIQUE INDEX idx_live_room_allocations_role
    ON live_room_performer_allocations(live_room_id, role);

CREATE TABLE live_room_setlists (
    setlist_id TEXT PRIMARY KEY,
    live_room_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'locked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
);

CREATE UNIQUE INDEX idx_live_room_setlists_room
    ON live_room_setlists(live_room_id);

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
    updated_at TEXT NOT NULL,
    FOREIGN KEY (setlist_id) REFERENCES live_room_setlists(setlist_id),
    FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
);

CREATE UNIQUE INDEX idx_live_room_setlist_items_position
    ON live_room_setlist_items(setlist_id, position);

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

CREATE UNIQUE INDEX idx_live_room_guest_invites_active
    ON live_room_guest_invites(live_room_id, guest_user_id)
    WHERE status IN ('pending', 'accepted');
