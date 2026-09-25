-- Spec 012 §5.3.13.3.1. Owner challenges and poll outcomes are durable and
-- private. A completed authority row is accompanied by exact proof provenance.
CREATE TABLE spaces_owner_proof_ceremonies (
  ceremony_id TEXT PRIMARY KEY CHECK (ceremony_id ~ '^sowner_[0-9a-f]{32}$'),
  generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  network TEXT NOT NULL DEFAULT 'mainnet' CHECK (network='mainnet'),
  canonical_root TEXT NOT NULL CHECK (is_community_route_root_label('spaces',canonical_root)),
  community_id TEXT NOT NULL REFERENCES communities(community_id),
  account_id TEXT NOT NULL REFERENCES users(user_id),
  start_idempotency_key TEXT NOT NULL CHECK (is_handle_sales_identifier_v1(start_idempotency_key,128)),
  start_request_bytes BYTEA NOT NULL CHECK (octet_length(start_request_bytes) BETWEEN 1 AND 2048),
  start_request_hash TEXT NOT NULL CHECK (start_request_hash ~ '^[0-9a-f]{64}$'),
  nonce_hex TEXT NOT NULL CHECK (nonce_hex ~ '^[0-9a-f]{64}$'),
  root_outpoint TEXT NOT NULL CHECK (root_outpoint ~ '^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$'),
  root_key_hex TEXT NOT NULL CHECK (root_key_hex ~ '^[0-9a-f]{64}$'),
  challenge_message TEXT NOT NULL,
  challenge_digest_hex TEXT NOT NULL CHECK (challenge_digest_hex ~ '^[0-9a-f]{64}$'),
  start_verifier_bytes BYTEA NOT NULL CHECK (octet_length(start_verifier_bytes) BETWEEN 1 AND 65536),
  start_verifier_sha256_hex TEXT NOT NULL CHECK (start_verifier_sha256_hex ~ '^[0-9a-f]{64}$'),
  key_last_changed_at TIMESTAMPTZ NOT NULL,
  anchored_at TIMESTAMPTZ NOT NULL,
  publication_verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','verified','expired','root_changed','signature_rejected')),
  terminal_response JSONB,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT spaces_owner_proof_ceremony_times CHECK (
    key_last_changed_at <= anchored_at AND anchored_at <= publication_verified_at
    AND publication_verified_at <= created_at AND expires_at > created_at
    AND updated_at >= created_at
  ),
  CONSTRAINT spaces_owner_proof_ceremony_terminal CHECK (
    (status='pending' AND terminal_response IS NULL)
    OR (status <> 'pending' AND terminal_response IS NOT NULL)
  ),
  UNIQUE (environment,canonical_root,generation),
  UNIQUE (account_id,community_id,canonical_root,start_idempotency_key)
);

CREATE INDEX spaces_owner_proof_current_idx ON spaces_owner_proof_ceremonies
  (environment,canonical_root,generation DESC);

CREATE TABLE spaces_owner_proof_polls (
  poll_id TEXT PRIMARY KEY CHECK (poll_id ~ '^sopoll_[0-9a-f]{32}$'),
  ceremony_id TEXT NOT NULL REFERENCES spaces_owner_proof_ceremonies(ceremony_id),
  account_id TEXT NOT NULL REFERENCES users(user_id),
  idempotency_key TEXT NOT NULL CHECK (is_handle_sales_identifier_v1(idempotency_key,128)),
  request_bytes BYTEA NOT NULL CHECK (octet_length(request_bytes) BETWEEN 1 AND 4096),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  signature_hex TEXT NOT NULL CHECK (signature_hex ~ '^[0-9a-f]{128}$'),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  terminal_response JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (ceremony_id,idempotency_key),
  CHECK (updated_at >= created_at)
);

CREATE TABLE spaces_owner_proof_evidence (
  namespace_authority_reference TEXT NOT NULL,
  namespace_authority_generation BIGINT NOT NULL,
  ceremony_id TEXT NOT NULL UNIQUE REFERENCES spaces_owner_proof_ceremonies(ceremony_id),
  proof_anchor_height BIGINT NOT NULL CHECK (proof_anchor_height >= 0),
  proof_anchor_block_hash TEXT NOT NULL CHECK (proof_anchor_block_hash ~ '^[0-9a-f]{64}$'),
  proof_root_anchor_id_hex TEXT NOT NULL CHECK (proof_root_anchor_id_hex ~ '^[0-9a-f]{64}$'),
  certificate_anchor_height BIGINT NOT NULL CHECK (certificate_anchor_height >= 0),
  certificate_anchor_block_hash TEXT NOT NULL CHECK (certificate_anchor_block_hash ~ '^[0-9a-f]{64}$'),
  certificate_root_anchor_id_hex TEXT NOT NULL CHECK (certificate_root_anchor_id_hex ~ '^[0-9a-f]{64}$'),
  observation_sha256_hex TEXT NOT NULL CHECK (observation_sha256_hex ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  fresh_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (namespace_authority_reference,namespace_authority_generation),
  FOREIGN KEY (namespace_authority_reference,namespace_authority_generation)
    REFERENCES spaces_namespace_authority_evidence(namespace_authority_reference,namespace_authority_generation),
  CHECK (proof_anchor_height >= certificate_anchor_height AND fresh_until > observed_at)
);
