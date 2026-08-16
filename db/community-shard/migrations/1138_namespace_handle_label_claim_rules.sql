CREATE TABLE namespace_handle_label_claim_rules (
    label_claim_rule_id TEXT PRIMARY KEY,
    namespace_handle_policy_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    selector_type TEXT NOT NULL CHECK (selector_type IN ('exact', 'any')),
    selector_labels_json TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
    expression_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (namespace_handle_policy_id)
        REFERENCES namespace_handle_policies(namespace_handle_policy_id)
);

CREATE UNIQUE INDEX idx_namespace_handle_label_claim_rules_position
    ON namespace_handle_label_claim_rules(namespace_handle_policy_id, position);

CREATE INDEX idx_namespace_handle_label_claim_rules_updated
    ON namespace_handle_label_claim_rules(updated_at);
