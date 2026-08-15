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
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_rules_order
    ON community_rules(community_id, status, position);
