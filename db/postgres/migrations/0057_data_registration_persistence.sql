-- Durable DATA registration authority. Provider and signer effects remain in
-- later lanes; this ledger makes every effect replay-safe before they exist.

CREATE TABLE data_registration_operations (
  registration_operation_id TEXT PRIMARY KEY CHECK (
    btrim(registration_operation_id) <> ''
    AND registration_operation_id = btrim(registration_operation_id)
    AND octet_length(registration_operation_id) <= 512
  ),
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  media_operation_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  asset_id TEXT NOT NULL CHECK (
    btrim(asset_id) <> '' AND asset_id = btrim(asset_id)
    AND octet_length(asset_id) <= 256
  ),
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  registration_revision BIGINT NOT NULL CHECK (registration_revision > 0),
  publication_creation_revision BIGINT NOT NULL CHECK (publication_creation_revision > 0),
  publication_audio_revision BIGINT NOT NULL CHECK (publication_audio_revision > 0),
  publication_analysis_revision BIGINT NOT NULL CHECK (publication_analysis_revision > 0),
  publication_decision_revision BIGINT NOT NULL CHECK (publication_decision_revision > 0),
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'signing', 'broadcast', 'confirming', 'registered', 'failed',
    'reconciliation_required'
  )),
  workflow_revision BIGINT NOT NULL DEFAULT 1 CHECK (workflow_revision > 0),
  workflow_instance_id TEXT NOT NULL CHECK (
    btrim(workflow_instance_id) <> '' AND workflow_instance_id = btrim(workflow_instance_id)
  ),
  current_attempt_id TEXT,
  registered_ip_id TEXT,
  confirmed_transaction_hash TEXT CHECK (
    confirmed_transaction_hash IS NULL OR confirmed_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  confirmed_block_number BIGINT CHECK (
    confirmed_block_number IS NULL OR confirmed_block_number >= 0
  ),
  confirmed_block_hash TEXT CHECK (
    confirmed_block_hash IS NULL OR confirmed_block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  confirmed_log_index INTEGER CHECK (confirmed_log_index IS NULL OR confirmed_log_index >= 0),
  confirmed_at TIMESTAMPTZ,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'pin_verification_failed', 'signing_failed', 'broadcast_failed',
    'receipt_reverted', 'confirmation_timeout', 'chain_reorganization',
    'invalid_receipt', 'configuration_invalid'
  )),
  failure_evidence_ref TEXT CHECK (
    failure_evidence_ref IS NULL OR
      (btrim(failure_evidence_ref) <> '' AND failure_evidence_ref = btrim(failure_evidence_ref))
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, media_operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (community_id, actor_user_id, post_id)
    REFERENCES media_publication_projections (community_id, actor_user_id, post_id),
  UNIQUE (chain_id, asset_id, registration_revision),
  UNIQUE (registration_operation_id, chain_id),
  UNIQUE (registration_operation_id, post_id),
  CONSTRAINT data_registration_operation_identity CHECK (
    registration_operation_id =
      'data-registration:' || chain_id::text || ':' || asset_id || ':' || registration_revision::text
    AND asset_id = post_id
    AND workflow_instance_id =
      'data-registration-workflow:' || registration_operation_id || ':r' || workflow_revision::text
  ),
  CONSTRAINT data_registration_operation_outcome_shape CHECK (
    (state = 'registered'
      AND current_attempt_id IS NOT NULL
      AND registered_ip_id IS NOT NULL AND btrim(registered_ip_id) <> ''
      AND confirmed_transaction_hash IS NOT NULL
      AND confirmed_block_number IS NOT NULL
      AND confirmed_block_hash IS NOT NULL
      AND confirmed_log_index IS NOT NULL
      AND confirmed_at IS NOT NULL
      AND failure_code IS NULL AND failure_evidence_ref IS NULL)
    OR (state = 'failed'
      AND failure_code IS NOT NULL AND failure_evidence_ref IS NOT NULL
      AND confirmed_at IS NULL)
    OR (state NOT IN ('registered', 'failed')
      AND registered_ip_id IS NULL
      AND confirmed_transaction_hash IS NULL
      AND confirmed_block_number IS NULL
      AND confirmed_block_hash IS NULL
      AND confirmed_log_index IS NULL
      AND confirmed_at IS NULL
      AND failure_code IS NULL AND failure_evidence_ref IS NULL)
  )
);

CREATE TABLE data_registration_artifacts (
  artifact_id TEXT PRIMARY KEY CHECK (
    btrim(artifact_id) <> '' AND artifact_id = btrim(artifact_id)
    AND octet_length(artifact_id) <= 512
  ),
  registration_operation_id TEXT NOT NULL
    REFERENCES data_registration_operations (registration_operation_id),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
    'canonical_audio', 'normalized_artwork', 'ip_metadata', 'nft_metadata'
  )),
  source_ref TEXT NOT NULL CHECK (btrim(source_ref) <> '' AND source_ref = btrim(source_ref)),
  media_type TEXT NOT NULL CHECK (
    media_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'
  ),
  byte_length BIGINT NOT NULL CHECK (byte_length > 0),
  canonical_sha256 TEXT NOT NULL CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  canonicalization_revision TEXT CHECK (
    canonicalization_revision IS NULL OR
      (btrim(canonicalization_revision) <> '' AND canonicalization_revision = btrim(canonicalization_revision))
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (registration_operation_id, artifact_kind),
  UNIQUE (registration_operation_id, artifact_id),
  UNIQUE (registration_operation_id, artifact_id, canonical_sha256, byte_length),
  CONSTRAINT data_registration_artifact_identity CHECK (
    artifact_id = registration_operation_id || ':artifact:' || artifact_kind
  ),
  CONSTRAINT data_registration_artifact_canonicalization_shape CHECK (
    (artifact_kind IN ('ip_metadata', 'nft_metadata')
      AND media_type = 'application/json'
      AND canonicalization_revision = 'rfc8785-jcs-v1')
    OR (artifact_kind IN ('canonical_audio', 'normalized_artwork')
      AND canonicalization_revision IS NULL)
  )
);

CREATE TABLE data_registration_pin_verifications (
  pin_verification_id TEXT PRIMARY KEY CHECK (
    btrim(pin_verification_id) <> '' AND pin_verification_id = btrim(pin_verification_id)
    AND octet_length(pin_verification_id) <= 512
  ),
  registration_operation_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'redundant', 'independent_gateway')),
  provider_id TEXT NOT NULL CHECK (
    btrim(provider_id) <> '' AND provider_id = btrim(provider_id)
    AND octet_length(provider_id) <= 128
  ),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 10),
  outcome TEXT NOT NULL CHECK (outcome IN ('verified', 'failed')),
  cid TEXT,
  canonical_sha256 TEXT,
  byte_length BIGINT,
  evidence_ref TEXT NOT NULL CHECK (btrim(evidence_ref) <> '' AND evidence_ref = btrim(evidence_ref)),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (registration_operation_id, artifact_id, canonical_sha256, byte_length)
    REFERENCES data_registration_artifacts (
      registration_operation_id, artifact_id, canonical_sha256, byte_length
    ),
  FOREIGN KEY (registration_operation_id, artifact_id)
    REFERENCES data_registration_artifacts (registration_operation_id, artifact_id),
  FOREIGN KEY (registration_operation_id, artifact_kind)
    REFERENCES data_registration_artifacts (registration_operation_id, artifact_kind),
  UNIQUE (registration_operation_id, artifact_id, role, provider_id, attempt_number),
  CONSTRAINT data_registration_pin_outcome_shape CHECK (
    (outcome = 'verified'
      AND cid IS NOT NULL AND btrim(cid) <> '' AND cid = btrim(cid)
      AND canonical_sha256 ~ '^[0-9a-f]{64}$'
      AND byte_length > 0 AND verified_at IS NOT NULL)
    OR (outcome = 'failed'
      AND cid IS NULL AND canonical_sha256 IS NULL
      AND byte_length IS NULL AND verified_at IS NULL)
  )
);
CREATE INDEX data_registration_pin_verified_idx
  ON data_registration_pin_verifications (
    registration_operation_id, artifact_id, role, provider_id
  ) WHERE outcome = 'verified';

CREATE FUNCTION data_registration_pins_are_ready(operation_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM data_registration_artifacts artifact
    WHERE artifact.registration_operation_id = operation_id
      AND artifact.artifact_kind = 'canonical_audio'
  )
  AND EXISTS (
    SELECT 1 FROM data_registration_artifacts artifact
    WHERE artifact.registration_operation_id = operation_id
      AND artifact.artifact_kind = 'ip_metadata'
  )
  AND EXISTS (
    SELECT 1 FROM data_registration_artifacts artifact
    WHERE artifact.registration_operation_id = operation_id
      AND artifact.artifact_kind = 'nft_metadata'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM data_registration_artifacts artifact
    WHERE artifact.registration_operation_id = operation_id
      AND NOT EXISTS (
        SELECT 1
        FROM data_registration_pin_verifications primary_pin
        JOIN data_registration_pin_verifications redundant_pin
          ON redundant_pin.registration_operation_id = primary_pin.registration_operation_id
         AND redundant_pin.artifact_id = primary_pin.artifact_id
         AND redundant_pin.role = 'redundant'
         AND redundant_pin.outcome = 'verified'
         AND redundant_pin.cid = primary_pin.cid
         AND redundant_pin.canonical_sha256 = primary_pin.canonical_sha256
         AND redundant_pin.byte_length = primary_pin.byte_length
         AND redundant_pin.provider_id <> primary_pin.provider_id
        JOIN data_registration_pin_verifications gateway
          ON gateway.registration_operation_id = primary_pin.registration_operation_id
         AND gateway.artifact_id = primary_pin.artifact_id
         AND gateway.role = 'independent_gateway'
         AND gateway.outcome = 'verified'
         AND gateway.cid = primary_pin.cid
         AND gateway.canonical_sha256 = primary_pin.canonical_sha256
         AND gateway.byte_length = primary_pin.byte_length
         AND gateway.provider_id NOT IN (primary_pin.provider_id, redundant_pin.provider_id)
        WHERE primary_pin.registration_operation_id = operation_id
          AND primary_pin.artifact_id = artifact.artifact_id
          AND primary_pin.role = 'primary'
          AND primary_pin.outcome = 'verified'
          AND primary_pin.canonical_sha256 = artifact.canonical_sha256
          AND primary_pin.byte_length = artifact.byte_length
      )
  );
$$;

CREATE TABLE data_registration_signing_attempts (
  submission_attempt_id TEXT PRIMARY KEY CHECK (
    btrim(submission_attempt_id) <> '' AND submission_attempt_id = btrim(submission_attempt_id)
    AND octet_length(submission_attempt_id) <= 512
  ),
  registration_operation_id TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 20),
  signer_namespace TEXT NOT NULL CHECK (
    btrim(signer_namespace) <> '' AND signer_namespace = btrim(signer_namespace)
  ),
  signer_address TEXT NOT NULL CHECK (signer_address ~ '^0x[0-9a-fA-F]{40}$'),
  signing_intent_id TEXT NOT NULL UNIQUE CHECK (
    btrim(signing_intent_id) <> '' AND signing_intent_id = btrim(signing_intent_id)
  ),
  calldata_hash TEXT NOT NULL CHECK (calldata_hash ~ '^[0-9a-f]{64}$'),
  nonce NUMERIC(78, 0),
  signed_transaction BYTEA,
  signed_transaction_hash TEXT CHECK (
    signed_transaction_hash IS NULL OR signed_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  transaction_hash TEXT CHECK (
    transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  supersedes_submission_attempt_id TEXT
    REFERENCES data_registration_signing_attempts (submission_attempt_id),
  state TEXT NOT NULL CHECK (state IN (
    'signing_intent', 'nonce_reserved', 'prepared', 'broadcast', 'mined',
    'confirmed', 'replaced', 'reverted', 'failed', 'reconciliation_required'
  )),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'signing_failed', 'broadcast_failed', 'receipt_reverted',
    'confirmation_timeout', 'chain_reorganization', 'invalid_receipt'
  )),
  failure_evidence_ref TEXT CHECK (
    failure_evidence_ref IS NULL OR
      (btrim(failure_evidence_ref) <> '' AND failure_evidence_ref = btrim(failure_evidence_ref))
  ),
  prepared_at TIMESTAMPTZ,
  broadcast_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (registration_operation_id, chain_id)
    REFERENCES data_registration_operations (registration_operation_id, chain_id),
  UNIQUE (registration_operation_id, attempt_number),
  UNIQUE (registration_operation_id, calldata_hash, attempt_number),
  UNIQUE (registration_operation_id, submission_attempt_id),
  CONSTRAINT data_registration_attempt_identity CHECK (
    submission_attempt_id = registration_operation_id || ':attempt:' || attempt_number::text
    AND signing_intent_id = submission_attempt_id || ':signing-intent'
  ),
  CONSTRAINT data_registration_attempt_shape CHECK (
    (state = 'signing_intent'
      AND nonce IS NULL AND signed_transaction IS NULL
      AND signed_transaction_hash IS NULL AND transaction_hash IS NULL
      AND prepared_at IS NULL AND broadcast_at IS NULL AND terminal_at IS NULL
      AND failure_code IS NULL AND failure_evidence_ref IS NULL)
    OR (state = 'nonce_reserved'
      AND nonce IS NOT NULL AND signed_transaction IS NULL
      AND signed_transaction_hash IS NULL AND transaction_hash IS NULL
      AND prepared_at IS NULL AND broadcast_at IS NULL AND terminal_at IS NULL
      AND failure_code IS NULL AND failure_evidence_ref IS NULL)
    OR (state = 'prepared'
      AND nonce IS NOT NULL AND octet_length(signed_transaction) > 0
      AND signed_transaction_hash IS NOT NULL AND transaction_hash IS NULL
      AND prepared_at IS NOT NULL AND broadcast_at IS NULL AND terminal_at IS NULL
      AND failure_code IS NULL AND failure_evidence_ref IS NULL)
    OR (state IN ('broadcast', 'mined')
      AND nonce IS NOT NULL AND octet_length(signed_transaction) > 0
      AND signed_transaction_hash IS NOT NULL
      AND transaction_hash = signed_transaction_hash
      AND prepared_at IS NOT NULL AND broadcast_at IS NOT NULL AND terminal_at IS NULL
      AND failure_code IS NULL AND failure_evidence_ref IS NULL)
    OR (state IN ('confirmed', 'replaced')
      AND nonce IS NOT NULL AND octet_length(signed_transaction) > 0
      AND signed_transaction_hash IS NOT NULL
      AND transaction_hash = signed_transaction_hash
      AND prepared_at IS NOT NULL AND broadcast_at IS NOT NULL AND terminal_at IS NOT NULL
      AND failure_code IS NULL AND failure_evidence_ref IS NULL)
    OR (state IN ('reverted', 'failed', 'reconciliation_required')
      AND failure_code IS NOT NULL AND failure_evidence_ref IS NOT NULL
      AND terminal_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX data_registration_signer_nonce_unique
  ON data_registration_signing_attempts (chain_id, lower(signer_address), nonce)
  WHERE nonce IS NOT NULL;
CREATE UNIQUE INDEX data_registration_transaction_hash_unique
  ON data_registration_signing_attempts (transaction_hash)
  WHERE transaction_hash IS NOT NULL;
ALTER TABLE data_registration_operations
  ADD CONSTRAINT data_registration_operations_current_attempt_fk
  FOREIGN KEY (current_attempt_id)
    REFERENCES data_registration_signing_attempts (submission_attempt_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE data_registration_attempt_transitions (
  transition_id TEXT PRIMARY KEY CHECK (btrim(transition_id) <> ''),
  registration_operation_id TEXT NOT NULL,
  submission_attempt_id TEXT NOT NULL,
  transition_sequence BIGINT NOT NULL CHECK (transition_sequence > 0),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN (
    'signing_intent', 'nonce_reserved', 'prepared', 'broadcast', 'mined',
    'confirmed', 'replaced', 'reverted', 'failed', 'reconciliation_required'
  )),
  to_state TEXT NOT NULL CHECK (to_state IN (
    'signing_intent', 'nonce_reserved', 'prepared', 'broadcast', 'mined',
    'confirmed', 'replaced', 'reverted', 'failed', 'reconciliation_required'
  )),
  evidence_ref TEXT NOT NULL CHECK (btrim(evidence_ref) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (submission_attempt_id)
    REFERENCES data_registration_signing_attempts (submission_attempt_id),
  FOREIGN KEY (registration_operation_id, submission_attempt_id)
    REFERENCES data_registration_signing_attempts (
      registration_operation_id, submission_attempt_id
    ),
  UNIQUE (submission_attempt_id, transition_sequence),
  CONSTRAINT data_registration_transition_identity CHECK (
    transition_id = submission_attempt_id || ':transition:' || transition_sequence::text
  )
);
CREATE TABLE data_registration_receipt_observations (
  receipt_observation_id TEXT PRIMARY KEY CHECK (btrim(receipt_observation_id) <> ''),
  registration_operation_id TEXT NOT NULL,
  submission_attempt_id TEXT NOT NULL,
  observation_sequence BIGINT NOT NULL CHECK (observation_sequence > 0),
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'pending', 'mined', 'confirmed', 'reverted', 'orphaned'
  )),
  block_number BIGINT CHECK (block_number IS NULL OR block_number >= 0),
  block_hash TEXT CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
  log_index INTEGER CHECK (log_index IS NULL OR log_index >= 0),
  confirmations INTEGER NOT NULL CHECK (confirmations >= 0),
  registered_ip_id TEXT,
  ip_metadata_uri TEXT,
  ip_metadata_hash TEXT CHECK (
    ip_metadata_hash IS NULL OR ip_metadata_hash ~ '^0x[0-9a-f]{64}$'
  ),
  nft_metadata_uri TEXT,
  nft_metadata_hash TEXT CHECK (
    nft_metadata_hash IS NULL OR nft_metadata_hash ~ '^0x[0-9a-f]{64}$'
  ),
  evidence_ref TEXT NOT NULL CHECK (btrim(evidence_ref) <> ''),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (registration_operation_id, submission_attempt_id)
    REFERENCES data_registration_signing_attempts (
      registration_operation_id, submission_attempt_id
    ),
  UNIQUE (submission_attempt_id, observation_sequence),
  CONSTRAINT data_registration_receipt_identity CHECK (
    receipt_observation_id = submission_attempt_id || ':receipt:' || observation_sequence::text
  ),
  CONSTRAINT data_registration_receipt_shape CHECK (
    (outcome = 'pending'
      AND block_number IS NULL AND block_hash IS NULL AND log_index IS NULL
      AND confirmations = 0 AND registered_ip_id IS NULL
      AND ip_metadata_uri IS NULL AND ip_metadata_hash IS NULL
      AND nft_metadata_uri IS NULL AND nft_metadata_hash IS NULL)
    OR (outcome IN ('mined', 'reverted', 'orphaned')
      AND block_number IS NOT NULL AND block_hash IS NOT NULL
      AND registered_ip_id IS NULL
      AND ip_metadata_uri IS NULL AND ip_metadata_hash IS NULL
      AND nft_metadata_uri IS NULL AND nft_metadata_hash IS NULL)
    OR (outcome = 'confirmed'
      AND block_number IS NOT NULL AND block_hash IS NOT NULL AND log_index IS NOT NULL
      AND confirmations > 0
      AND registered_ip_id IS NOT NULL AND btrim(registered_ip_id) <> ''
      AND ip_metadata_uri IS NOT NULL AND btrim(ip_metadata_uri) <> ''
      AND ip_metadata_hash IS NOT NULL
      AND nft_metadata_uri IS NOT NULL AND btrim(nft_metadata_uri) <> ''
      AND nft_metadata_hash IS NOT NULL)
  )
);

CREATE TABLE data_registration_outbox (
  outbox_id TEXT PRIMARY KEY CHECK (btrim(outbox_id) <> ''),
  registration_operation_id TEXT NOT NULL
    REFERENCES data_registration_operations (registration_operation_id),
  workflow_revision BIGINT NOT NULL CHECK (workflow_revision > 0),
  workflow_instance_id TEXT NOT NULL CHECK (btrim(workflow_instance_id) <> ''),
  event_type TEXT NOT NULL CHECK (event_type IN ('registration_launch', 'workflow_replacement')),
  effect_identity TEXT NOT NULL UNIQUE CHECK (btrim(effect_identity) <> ''),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'running', 'delivered', 'failed', 'exhausted'
  )),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 5),
  claim_owner TEXT,
  claim_fence BIGINT NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  lease_expires_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'queue_unavailable', 'workflow_unavailable', 'invalid_binding'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (registration_operation_id, workflow_revision, event_type),
  CONSTRAINT data_registration_outbox_identity CHECK (
    outbox_id = registration_operation_id || ':outbox:r' || workflow_revision::text
    AND workflow_instance_id =
      'data-registration-workflow:' || registration_operation_id || ':r' || workflow_revision::text
    AND payload = jsonb_build_object(
      'operation_id', registration_operation_id,
      'outbox_id', outbox_id
    )
  ),
  CONSTRAINT data_registration_outbox_state_shape CHECK (
    (state = 'pending' AND delivery_attempts = 0 AND claim_owner IS NULL
      AND claim_fence = 0 AND lease_expires_at IS NULL AND next_eligible_at IS NULL
      AND failure_code IS NULL)
    OR (state = 'running' AND delivery_attempts > 0 AND claim_owner IS NOT NULL
      AND claim_fence > 0 AND lease_expires_at IS NOT NULL
      AND next_eligible_at IS NULL AND failure_code IS NULL)
    OR (state = 'delivered' AND delivery_attempts > 0 AND claim_owner IS NULL
      AND claim_fence > 0 AND lease_expires_at IS NULL
      AND next_eligible_at IS NULL AND failure_code IS NULL)
    OR (state = 'failed' AND delivery_attempts BETWEEN 1 AND 4 AND claim_owner IS NULL
      AND claim_fence > 0 AND lease_expires_at IS NULL
      AND next_eligible_at IS NOT NULL AND failure_code IS NOT NULL)
    OR (state = 'exhausted' AND delivery_attempts = 5 AND claim_owner IS NULL
      AND claim_fence > 0 AND lease_expires_at IS NULL
      AND next_eligible_at IS NULL AND failure_code IS NOT NULL)
  )
);
CREATE INDEX data_registration_outbox_eligible_idx
  ON data_registration_outbox (state, next_eligible_at, lease_expires_at, outbox_id)
  WHERE state IN ('pending', 'running', 'failed');

CREATE TABLE data_registration_command_replays (
  endpoint_template TEXT NOT NULL CHECK (btrim(endpoint_template) <> ''),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  registration_operation_id TEXT NOT NULL
    REFERENCES data_registration_operations (registration_operation_id),
  response_snapshot_bytes BYTEA NOT NULL CHECK (octet_length(response_snapshot_bytes) > 0),
  response_snapshot_sha256 TEXT NOT NULL CHECK (response_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (endpoint_template, idempotency_key),
  CONSTRAINT data_registration_replay_response_hash CHECK (
    encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256
  )
);

CREATE FUNCTION guard_data_registration_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_registration_artifacts_append_only
  BEFORE UPDATE OR DELETE ON data_registration_artifacts
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_append_only();
CREATE TRIGGER data_registration_pins_append_only
  BEFORE UPDATE OR DELETE ON data_registration_pin_verifications
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_append_only();
CREATE TRIGGER data_registration_transitions_append_only
  BEFORE UPDATE OR DELETE ON data_registration_attempt_transitions
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_append_only();
CREATE TRIGGER data_registration_receipts_append_only
  BEFORE UPDATE OR DELETE ON data_registration_receipt_observations
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_append_only();
CREATE TRIGGER data_registration_replays_append_only
  BEFORE UPDATE OR DELETE ON data_registration_command_replays
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_append_only();

CREATE FUNCTION guard_data_registration_operation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DATA registration operation cannot be deleted';
  END IF;
  IF ROW(
    NEW.registration_operation_id, NEW.community_id, NEW.actor_user_id,
    NEW.submission_id, NEW.media_operation_id, NEW.post_id, NEW.asset_id,
    NEW.chain_id, NEW.registration_revision, NEW.publication_creation_revision,
    NEW.publication_audio_revision, NEW.publication_analysis_revision,
    NEW.publication_decision_revision, NEW.canonical_audio_sha256,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.registration_operation_id, OLD.community_id, OLD.actor_user_id,
    OLD.submission_id, OLD.media_operation_id, OLD.post_id, OLD.asset_id,
    OLD.chain_id, OLD.registration_revision, OLD.publication_creation_revision,
    OLD.publication_audio_revision, OLD.publication_analysis_revision,
    OLD.publication_decision_revision, OLD.canonical_audio_sha256,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'DATA registration operation identity is immutable';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'DATA registration operation timestamp must advance';
  END IF;
  IF NEW.workflow_revision IS DISTINCT FROM OLD.workflow_revision
     OR NEW.workflow_instance_id IS DISTINCT FROM OLD.workflow_instance_id THEN
    IF OLD.state = 'registered'
       OR NEW.workflow_revision IS DISTINCT FROM OLD.workflow_revision + 1
       OR NEW.workflow_instance_id IS DISTINCT FROM
          'data-registration-workflow:' || NEW.registration_operation_id || ':r' || NEW.workflow_revision::text
       OR ROW(
         NEW.state, NEW.current_attempt_id, NEW.registered_ip_id,
         NEW.confirmed_transaction_hash, NEW.confirmed_block_number,
         NEW.confirmed_block_hash, NEW.confirmed_log_index, NEW.confirmed_at,
         NEW.failure_code, NEW.failure_evidence_ref
       ) IS DISTINCT FROM ROW(
         OLD.state, OLD.current_attempt_id, OLD.registered_ip_id,
         OLD.confirmed_transaction_hash, OLD.confirmed_block_number,
         OLD.confirmed_block_hash, OLD.confirmed_log_index, OLD.confirmed_at,
         OLD.failure_code, OLD.failure_evidence_ref
       ) THEN
      RAISE EXCEPTION 'DATA registration workflow replacement is invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.state = 'pending' AND NEW.state IN ('signing', 'failed'))
    OR (OLD.state = 'signing' AND NEW.state IN (
      'broadcast', 'failed', 'reconciliation_required'
    ))
    OR (OLD.state = 'broadcast' AND NEW.state IN (
      'signing', 'confirming', 'failed', 'reconciliation_required'
    ))
    OR (OLD.state = 'confirming' AND NEW.state IN (
      'signing', 'broadcast', 'registered', 'failed', 'reconciliation_required'
    ))
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN (
      'signing', 'broadcast', 'confirming', 'registered', 'failed'
    ))
    OR (OLD.state = 'failed' AND NEW.state = 'registered')
    OR (OLD.state = 'registered' AND NEW.state IN ('failed', 'reconciliation_required'))
  ) THEN
    RAISE EXCEPTION 'invalid DATA registration operation transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_registration_operation_update_guard
  BEFORE UPDATE OR DELETE ON data_registration_operations
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_operation_update();

CREATE FUNCTION guard_data_registration_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prior data_registration_signing_attempts%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DATA registration attempt cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'signing_intent'
       OR NOT data_registration_pins_are_ready(NEW.registration_operation_id) THEN
      RAISE EXCEPTION 'DATA registration attempt requires verified redundant pins';
    END IF;
    IF NEW.supersedes_submission_attempt_id IS NOT NULL THEN
      SELECT * INTO prior FROM data_registration_signing_attempts
        WHERE submission_attempt_id=NEW.supersedes_submission_attempt_id FOR SHARE;
      IF prior.registration_operation_id IS DISTINCT FROM NEW.registration_operation_id
         OR prior.attempt_number >= NEW.attempt_number
         OR prior.state NOT IN ('broadcast', 'mined', 'replaced', 'reconciliation_required') THEN
        RAISE EXCEPTION 'DATA registration replacement lineage is invalid';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.submission_attempt_id, NEW.registration_operation_id, NEW.chain_id,
    NEW.attempt_number, NEW.signer_namespace, NEW.signer_address,
    NEW.signing_intent_id, NEW.calldata_hash,
    NEW.supersedes_submission_attempt_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.submission_attempt_id, OLD.registration_operation_id, OLD.chain_id,
    OLD.attempt_number, OLD.signer_namespace, OLD.signer_address,
    OLD.signing_intent_id, OLD.calldata_hash,
    OLD.supersedes_submission_attempt_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'DATA registration attempt identity is immutable';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'DATA registration attempt timestamp must advance';
  END IF;
  IF NOT (
    (OLD.state = 'signing_intent' AND NEW.state IN ('nonce_reserved', 'failed'))
    OR (OLD.state = 'nonce_reserved' AND NEW.state IN (
      'prepared', 'failed', 'reconciliation_required'
    ))
    OR (OLD.state = 'prepared' AND NEW.state IN ('broadcast', 'reconciliation_required'))
    OR (OLD.state = 'broadcast' AND NEW.state IN (
      'mined', 'replaced', 'reverted', 'reconciliation_required'
    ))
    OR (OLD.state = 'mined' AND NEW.state IN (
      'broadcast', 'confirmed', 'reverted', 'reconciliation_required'
    ))
    OR (OLD.state = 'confirmed' AND NEW.state = 'reconciliation_required')
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN (
      'broadcast', 'mined', 'confirmed', 'replaced', 'reverted', 'failed'
    ))
  ) THEN
    RAISE EXCEPTION 'invalid DATA registration attempt transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_registration_attempt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON data_registration_signing_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_attempt();

CREATE FUNCTION guard_data_registration_receipt_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE attempt data_registration_signing_attempts%ROWTYPE;
BEGIN
  SELECT * INTO attempt FROM data_registration_signing_attempts
    WHERE registration_operation_id=NEW.registration_operation_id
      AND submission_attempt_id=NEW.submission_attempt_id FOR SHARE;
  IF attempt.submission_attempt_id IS NULL
     OR attempt.transaction_hash IS DISTINCT FROM NEW.transaction_hash
     OR attempt.state NOT IN (
       'broadcast', 'mined', 'confirmed', 'replaced', 'reconciliation_required'
     ) THEN
    RAISE EXCEPTION 'DATA receipt observation is not owned by a broadcast attempt';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_registration_receipt_insert_guard
  BEFORE INSERT ON data_registration_receipt_observations
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_receipt_insert();

CREATE FUNCTION guard_data_registration_outbox_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DATA registration outbox cannot be deleted';
  END IF;
  IF ROW(
    NEW.outbox_id, NEW.registration_operation_id, NEW.workflow_revision,
    NEW.workflow_instance_id, NEW.event_type, NEW.effect_identity,
    NEW.payload, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.outbox_id, OLD.registration_operation_id, OLD.workflow_revision,
    OLD.workflow_instance_id, OLD.event_type, OLD.effect_identity,
    OLD.payload, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'DATA registration outbox identity is immutable';
  END IF;
  IF NEW.updated_at <= OLD.updated_at OR NEW.claim_fence < OLD.claim_fence
     OR NEW.delivery_attempts < OLD.delivery_attempts THEN
    RAISE EXCEPTION 'DATA registration outbox fence must advance';
  END IF;
  IF OLD.state IN ('pending', 'failed') AND (
      NEW.state <> 'running'
      OR NEW.delivery_attempts <> OLD.delivery_attempts + 1
      OR NEW.claim_fence <> OLD.claim_fence + 1
      OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()
      OR (OLD.state = 'failed' AND (
        OLD.next_eligible_at IS NULL OR OLD.next_eligible_at > clock_timestamp()
      ))
    ) THEN
    RAISE EXCEPTION 'DATA registration outbox claim is not allowed';
  END IF;
  IF OLD.state = 'running' AND NEW.state IN ('delivered', 'failed', 'exhausted') AND (
      NEW.delivery_attempts <> OLD.delivery_attempts
      OR NEW.claim_fence <> OLD.claim_fence
      OR NEW.claim_owner IS NOT NULL OR OLD.lease_expires_at <= clock_timestamp()
      OR (NEW.state = 'failed' AND NEW.next_eligible_at IS NULL)
      OR (NEW.state = 'exhausted' AND (
        NEW.delivery_attempts <> 5 OR NEW.next_eligible_at IS NOT NULL
      ))
    ) THEN
    RAISE EXCEPTION 'DATA registration outbox completion is not allowed';
  END IF;
  IF OLD.state = 'running' AND NEW.state = 'running' AND (
      OLD.lease_expires_at > clock_timestamp()
      OR NEW.delivery_attempts <> OLD.delivery_attempts + 1
      OR NEW.claim_fence <> OLD.claim_fence + 1
      OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()
    ) THEN
    RAISE EXCEPTION 'DATA registration outbox reclaim is not allowed';
  END IF;
  IF OLD.state NOT IN ('pending', 'failed', 'running') THEN
    RAISE EXCEPTION 'DATA registration outbox is terminal';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_registration_outbox_update_guard
  BEFORE UPDATE OR DELETE ON data_registration_outbox
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_outbox_update();

-- The publication row remains immutable except for exact alignment and DATA
-- projections backed by their own authoritative ledgers.
CREATE OR REPLACE FUNCTION guard_media_publication_projection_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE alignment_record media_alignment_projections%ROWTYPE;
        registration_record data_registration_operations%ROWTYPE;
BEGIN
  IF ROW(
    NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id,
    NEW.post_id, NEW.creation_revision, NEW.audio_revision, NEW.analysis_revision,
    NEW.decision_revision, NEW.canonical_audio_sha256, NEW.title,
    NEW.audio_asset_ref, NEW.cover_artifact_ref, NEW.language_status,
    NEW.primary_language_bcp47, NEW.secondary_language_bcp47,
    NEW.lyrics_explicitness, NEW.analysis_badges, NEW.locked_delivery,
    NEW.author_persona_id, NEW.lyrics_status, NEW.lyrics_revision,
    NEW.lyrics_text, NEW.projected_at
  ) IS DISTINCT FROM ROW(
    OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id,
    OLD.post_id, OLD.creation_revision, OLD.audio_revision, OLD.analysis_revision,
    OLD.decision_revision, OLD.canonical_audio_sha256, OLD.title,
    OLD.audio_asset_ref, OLD.cover_artifact_ref, OLD.language_status,
    OLD.primary_language_bcp47, OLD.secondary_language_bcp47,
    OLD.lyrics_explicitness, OLD.analysis_badges, OLD.locked_delivery,
    OLD.author_persona_id, OLD.lyrics_status, OLD.lyrics_revision,
    OLD.lyrics_text, OLD.projected_at
  ) THEN
    RAISE EXCEPTION 'media publication accepted evidence is immutable';
  END IF;
  IF NEW.alignment IS DISTINCT FROM OLD.alignment THEN
    SELECT * INTO alignment_record FROM media_alignment_projections
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
        AND post_id=NEW.post_id FOR SHARE;
    IF alignment_record.submission_id IS NULL
       OR alignment_record.status IS DISTINCT FROM NEW.alignment
       OR alignment_record.audio_revision IS DISTINCT FROM NEW.audio_revision
       OR alignment_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision
       OR alignment_record.canonical_audio_sha256 IS DISTINCT FROM NEW.canonical_audio_sha256 THEN
      RAISE EXCEPTION 'publication alignment is not owned by the exact alignment projection';
    END IF;
  END IF;
  IF NEW.data_registration IS DISTINCT FROM OLD.data_registration THEN
    SELECT * INTO registration_record FROM data_registration_operations
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND post_id=NEW.post_id
      ORDER BY registration_revision DESC LIMIT 1 FOR SHARE;
    IF registration_record.registration_operation_id IS NULL
       OR registration_record.community_id IS DISTINCT FROM NEW.community_id
       OR registration_record.actor_user_id IS DISTINCT FROM NEW.actor_user_id
       OR registration_record.submission_id IS DISTINCT FROM NEW.submission_id
       OR registration_record.media_operation_id IS DISTINCT FROM NEW.operation_id
       OR registration_record.publication_creation_revision IS DISTINCT FROM NEW.creation_revision
       OR registration_record.publication_audio_revision IS DISTINCT FROM NEW.audio_revision
       OR registration_record.publication_analysis_revision IS DISTINCT FROM NEW.analysis_revision
       OR registration_record.publication_decision_revision IS DISTINCT FROM NEW.decision_revision
       OR registration_record.canonical_audio_sha256 IS DISTINCT FROM NEW.canonical_audio_sha256
       OR NEW.data_registration IS DISTINCT FROM (CASE registration_record.state
         WHEN 'registered' THEN 'registered'
         WHEN 'failed' THEN 'failed'
         ELSE 'pending'
       END) THEN
      RAISE EXCEPTION 'publication DATA state is not owned by the exact registration operation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
