-- Consume each reconciliation claim exactly once and retain operator reset evidence.
-- Migration 0019 is checksummed and remains byte-for-byte immutable.

ALTER TABLE community_purchase_funding_reconciliation_attempts
  ADD COLUMN finalized_generation bigint;

ALTER TABLE community_purchase_funding_reconciliation_attempts
  ADD CONSTRAINT cpf_attempts_finalized_generation_check
  CHECK (
    finalized_generation IS NULL
    OR (finalized_generation >= 0 AND finalized_generation <= generation)
  );

CREATE TABLE community_purchase_funding_reconciliation_operator_actions (
    action_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_id text NOT NULL
      REFERENCES community_purchase_funding_reconciliation_attempts (operation_id),
    actor_id text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    generation bigint NOT NULL,
    recorded_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT cpf_attempt_operator_action_check
      CHECK (action = 'unpark_escalated'),
    CONSTRAINT cpf_attempt_operator_actor_check CHECK (length(trim(actor_id)) > 0),
    CONSTRAINT cpf_attempt_operator_reason_check CHECK (length(trim(reason)) > 0),
    CONSTRAINT cpf_attempt_operator_generation_check CHECK (generation >= 0)
);

CREATE INDEX cpf_attempt_operator_actions_operation_idx
  ON community_purchase_funding_reconciliation_operator_actions (operation_id, action_id);
