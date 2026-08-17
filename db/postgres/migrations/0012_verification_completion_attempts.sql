-- Fenced, short-lived reservations for public verification callbacks.
--
-- A reservation is held only around the provider invocation. The database
-- transaction that acquires it commits before provider work starts; the
-- completion transaction later checks the fence generation before writing the
-- evidence ledger. Released attempts can be retried, while consumed attempts
-- count against the per-session budget.

CREATE TABLE verification_completion_attempts (
    attempt_id text NOT NULL,
    proof_session_id text NOT NULL,
    idempotency_key text NOT NULL,
    state text NOT NULL,
    fence_token bigint NOT NULL DEFAULT 1,
    lease_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT verification_completion_attempts_pkey PRIMARY KEY (attempt_id),
    CONSTRAINT verification_completion_attempts_idempotency_unique
      UNIQUE (proof_session_id, idempotency_key),
    CONSTRAINT verification_completion_attempts_session_fk
      FOREIGN KEY (proof_session_id) REFERENCES proof_sessions(proof_session_id),
    CONSTRAINT verification_completion_attempts_idempotency_not_blank
      CHECK (btrim(idempotency_key) <> ''),
    CONSTRAINT verification_completion_attempts_state_check
      CHECK (state IN ('leased', 'released', 'consumed')),
    CONSTRAINT verification_completion_attempts_fence_check
      CHECK (fence_token > 0)
);

CREATE INDEX verification_completion_attempts_lease_idx
    ON verification_completion_attempts (state, lease_expires_at);

CREATE INDEX verification_completion_attempts_session_state_idx
    ON verification_completion_attempts (proof_session_id, state);
