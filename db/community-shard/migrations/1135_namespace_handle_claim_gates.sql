ALTER TABLE namespace_handle_policies
    ADD COLUMN claim_gate_mode TEXT NOT NULL DEFAULT 'none' CHECK (
        claim_gate_mode IN ('none', 'inherit_community', 'explicit')
    );

ALTER TABLE namespace_handle_policies
    ADD COLUMN claim_gate_expression_ref TEXT;

ALTER TABLE namespace_handle_policies
    ADD COLUMN eligibility_timing TEXT NOT NULL DEFAULT 'claim_time' CHECK (
        eligibility_timing IN ('claim_time', 'continuous')
    );

CREATE TABLE namespace_handle_claim_gate_policies (
    claim_gate_expression_ref TEXT PRIMARY KEY,
    namespace_handle_policy_id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
    expression_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (namespace_handle_policy_id)
        REFERENCES namespace_handle_policies(namespace_handle_policy_id)
);

CREATE INDEX idx_namespace_handle_claim_gate_policies_updated
    ON namespace_handle_claim_gate_policies(updated_at);
