PRAGMA foreign_keys = ON;

CREATE TABLE community_gate_rules (
    gate_rule_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (
        scope IN ('membership', 'viewer', 'posting')
    ),
    gate_family TEXT NOT NULL CHECK (
        gate_family IN ('identity_proof', 'token_holding')
    ),
    gate_type TEXT NOT NULL,
    proof_requirements_json TEXT,
    chain_namespace TEXT,
    gate_config_json TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'disabled')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_gate_rules_community_scope_status
    ON community_gate_rules(community_id, scope, status, created_at);
