PRAGMA foreign_keys = ON;

CREATE TABLE community_gate_policies (
    community_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (
        scope IN ('membership', 'viewer', 'posting')
    ),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
    expression_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (community_id, scope),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_gate_policies_scope_updated
    ON community_gate_policies(scope, updated_at);

CREATE TABLE IF NOT EXISTS community_gate_rules (
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

INSERT INTO community_gate_policies (
    community_id,
    scope,
    version,
    expression_json,
    created_at,
    updated_at
)
WITH active_gate_atoms AS (
    SELECT
        community_id,
        scope,
        created_at,
        updated_at,
        CASE
            WHEN gate_type = 'unique_human' THEN json_object(
                'type', 'unique_human',
                'provider', COALESCE(json_extract(proof_requirements_json, '$[0].accepted_providers[0]'), 'very')
            )
            WHEN gate_type IN ('age_over_18', 'minimum_age') THEN json_object(
                'type', 'minimum_age',
                'provider', 'self',
                'minimum_age', COALESCE(
                    json_extract(proof_requirements_json, '$[0].config.minimum_age'),
                    json_extract(proof_requirements_json, '$[0].config.required_minimum_age'),
                    json_extract(gate_config_json, '$.minimum_age'),
                    json_extract(gate_config_json, '$.required_minimum_age'),
                    18
                )
            )
            WHEN gate_type = 'nationality' THEN json_object(
                'type', 'nationality',
                'provider', 'self',
                'allowed', json(CASE
                    WHEN json_type(proof_requirements_json, '$[0].config.required_values') = 'array' THEN json_extract(proof_requirements_json, '$[0].config.required_values')
                    WHEN json_type(gate_config_json, '$.required_values') = 'array' THEN json_extract(gate_config_json, '$.required_values')
                    ELSE json_array(COALESCE(
                        json_extract(proof_requirements_json, '$[0].config.required_value'),
                        json_extract(gate_config_json, '$.required_value')
                    ))
                END)
            )
            WHEN gate_type = 'gender' THEN json_object(
                'type', 'gender',
                'provider', 'self',
                'allowed', json(CASE
                    WHEN json_type(proof_requirements_json, '$[0].config.required_values') = 'array' THEN json_extract(proof_requirements_json, '$[0].config.required_values')
                    WHEN json_type(gate_config_json, '$.required_values') = 'array' THEN json_extract(gate_config_json, '$.required_values')
                    ELSE json_array(COALESCE(
                        json_extract(proof_requirements_json, '$[0].config.required_value'),
                        json_extract(gate_config_json, '$.required_value')
                    ))
                END)
            )
            WHEN gate_type = 'wallet_score' THEN json_object(
                'type', 'wallet_score',
                'provider', 'passport',
                'minimum_score', COALESCE(
                    json_extract(proof_requirements_json, '$[0].config.minimum_score'),
                    json_extract(gate_config_json, '$.minimum_score'),
                    0
                )
            )
            WHEN gate_type = 'erc721_holding' THEN json_object(
                'type', 'erc721_holding',
                'chain_namespace', COALESCE(chain_namespace, json_extract(gate_config_json, '$.chain_namespace'), 'eip155:1'),
                'contract_address', json_extract(gate_config_json, '$.contract_address')
            )
            WHEN gate_type = 'erc721_inventory_match' THEN json_object(
                'type', 'erc721_inventory_match',
                'provider', 'courtyard',
                'chain_namespace', COALESCE(chain_namespace, json_extract(gate_config_json, '$.chain_namespace'), 'eip155:1'),
                'contract_address', json_extract(gate_config_json, '$.contract_address'),
                'min_quantity', COALESCE(json_extract(gate_config_json, '$.min_quantity'), 1),
                'match', json(COALESCE(json_extract(gate_config_json, '$.match'), '{}'))
            )
            ELSE NULL
        END AS gate_atom_json
    FROM community_gate_rules
    WHERE status = 'active'
),
active_gate_expressions AS (
    SELECT
        community_id,
        scope,
        created_at,
        updated_at,
        json_object(
            'op', 'gate',
            'gate', json(gate_atom_json)
        ) AS expression_node_json
    FROM active_gate_atoms
    WHERE gate_atom_json IS NOT NULL
),
scope_gate_expressions AS (
    SELECT
        community_id,
        scope,
        MIN(created_at) AS created_at,
        MAX(updated_at) AS updated_at,
        COUNT(*) AS gate_count,
        MIN(expression_node_json) AS single_expression_json,
        json_group_array(json(expression_node_json)) AS expression_children_json
    FROM active_gate_expressions
    GROUP BY community_id, scope
)
SELECT
    community_id,
    scope,
    1,
    json_object(
        'version', 1,
        'expression', json(CASE
            WHEN gate_count = 1 THEN single_expression_json
            ELSE json_object(
                'op', 'and',
                'children', json(expression_children_json)
            )
        END)
    ),
    created_at,
    updated_at
FROM scope_gate_expressions;

DROP TABLE IF EXISTS community_gate_rules;
