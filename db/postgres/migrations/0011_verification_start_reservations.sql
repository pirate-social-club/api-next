-- Durable pre-provider start reservations.
--
-- The reservation is intentionally separate from proof_sessions: a provider
-- launch is an external side effect and must be fenced before its result can
-- become a pending proof session.

CREATE TABLE verification_start_reservations (
    reservation_id text NOT NULL,
    actor_id text NOT NULL,
    intent_id text NOT NULL,
    request_hash text NOT NULL,
    request jsonb NOT NULL,
    state text NOT NULL,
    fence_token bigint NOT NULL DEFAULT 1,
    lease_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT verification_start_reservations_pkey PRIMARY KEY (reservation_id),
    CONSTRAINT verification_start_reservations_actor_intent_unique UNIQUE (actor_id, intent_id),
    CONSTRAINT verification_start_reservations_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT verification_start_reservations_request_object_check CHECK (jsonb_typeof(request) = 'object'),
    CONSTRAINT verification_start_reservations_state_check CHECK (state IN ('acquired', 'released', 'finalized')),
    CONSTRAINT verification_start_reservations_fence_check CHECK (fence_token > 0),
    CONSTRAINT verification_start_reservations_actor_fk FOREIGN KEY (actor_id) REFERENCES users(user_id)
);

CREATE INDEX verification_start_reservations_lease_idx
    ON verification_start_reservations (state, lease_expires_at);
