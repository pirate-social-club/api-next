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
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id),
    FOREIGN KEY (handle_claim_quote_id) REFERENCES community_handle_claim_quotes(handle_claim_quote_id)
);

CREATE UNIQUE INDEX idx_community_handle_label_reservations_active_label
    ON community_handle_label_reservations(namespace_id, label_normalized)
    WHERE status = 'active';

CREATE INDEX idx_community_handle_label_reservations_active_expiry
    ON community_handle_label_reservations(expires_at)
    WHERE status = 'active';
