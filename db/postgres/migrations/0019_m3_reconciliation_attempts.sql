-- Durable reconciliation scheduling for the M3 community-purchase funding
-- journal (spec 004; retry metadata is liveness state, never economic
-- identity). Rows exist only for operations with transaction identity;
-- hashless legacy-ambiguous entries never receive attempt metadata.

CREATE TABLE community_purchase_funding_reconciliation_attempts (
    operation_id text PRIMARY KEY REFERENCES community_purchase_funding_journal (operation_id),
    generation bigint NOT NULL DEFAULT 0,
    last_attempt_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    last_failure_class text,
    consecutive_failures integer NOT NULL DEFAULT 0,
    escalated_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT cpf_attempts_generation_check CHECK (generation >= 0),
    CONSTRAINT cpf_attempts_consecutive_failures_check CHECK (consecutive_failures >= 0),
    CONSTRAINT cpf_attempts_failure_class_check CHECK (
      last_failure_class IS NULL
      OR last_failure_class IN (
        'lease_contention', 'chain_unavailable', 'chain_timeout',
        'transaction_not_found', 'invalid_evidence', 'reorg', 'identity_conflict'
      )
    ),
    CONSTRAINT cpf_attempts_shape_check CHECK (
      (last_attempt_at IS NULL AND next_attempt_at IS NULL AND last_failure_class IS NULL
        AND consecutive_failures = 0 AND escalated_at IS NULL)
      OR (last_attempt_at IS NOT NULL)
    ),
    CONSTRAINT cpf_attempts_escalation_check CHECK (
      escalated_at IS NULL OR last_failure_class IS NOT NULL
    )
);

CREATE INDEX cpf_attempts_selection_idx
    ON community_purchase_funding_reconciliation_attempts (next_attempt_at, operation_id)
    WHERE escalated_at IS NULL;
