-- V1 uses one retained Filebase pin plus a byte-verified retrieval through the
-- independent ipfs.io gateway. Migration 0057 was never activated with live
-- DATA attempts, so fail closed rather than inventing missing signing intent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM data_registration_signing_attempts) THEN
    RAISE EXCEPTION '0058 requires reconciliation of pre-existing DATA signing attempts';
  END IF;
END;
$$;

ALTER TABLE data_registration_signing_attempts
  ADD COLUMN target_address TEXT NOT NULL
    CHECK (target_address ~ '^0x[0-9a-fA-F]{40}$'),
  ADD COLUMN method_selector TEXT NOT NULL
    CHECK (method_selector ~ '^0x[0-9a-f]{8}$'),
  ADD COLUMN signing_deadline TIMESTAMPTZ NOT NULL,
  ADD COLUMN value_wei NUMERIC(78, 0) NOT NULL CHECK (value_wei >= 0),
  ADD COLUMN gas_limit NUMERIC(78, 0) NOT NULL CHECK (gas_limit > 0),
  ADD COLUMN max_fee_per_gas NUMERIC(78, 0) NOT NULL CHECK (max_fee_per_gas > 0),
  ADD COLUMN max_priority_fee_per_gas NUMERIC(78, 0) NOT NULL
    CHECK (max_priority_fee_per_gas >= 0),
  ADD CONSTRAINT data_registration_attempt_fee_shape
    CHECK (max_priority_fee_per_gas <= max_fee_per_gas);

CREATE OR REPLACE FUNCTION data_registration_pins_are_ready(operation_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
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
        JOIN data_registration_pin_verifications gateway
          ON gateway.registration_operation_id = primary_pin.registration_operation_id
         AND gateway.artifact_id = primary_pin.artifact_id
         AND gateway.role = 'independent_gateway'
         AND gateway.outcome = 'verified'
         AND gateway.cid = primary_pin.cid
         AND gateway.canonical_sha256 = primary_pin.canonical_sha256
         AND gateway.byte_length = primary_pin.byte_length
         AND gateway.provider_id <> primary_pin.provider_id
        WHERE primary_pin.registration_operation_id = operation_id
          AND primary_pin.artifact_id = artifact.artifact_id
          AND primary_pin.role = 'primary'
          AND primary_pin.provider_id = 'filebase'
          AND primary_pin.outcome = 'verified'
          AND primary_pin.canonical_sha256 = artifact.canonical_sha256
          AND primary_pin.byte_length = artifact.byte_length
      )
  );
$$;

CREATE OR REPLACE FUNCTION guard_data_registration_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prior data_registration_signing_attempts%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DATA registration attempt cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'signing_intent'
       OR NOT data_registration_pins_are_ready(NEW.registration_operation_id) THEN
      RAISE EXCEPTION 'DATA registration attempt requires a verified Filebase pin and independent retrieval';
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
    NEW.signing_intent_id, NEW.target_address, NEW.method_selector,
    NEW.calldata_hash, NEW.signing_deadline, NEW.value_wei, NEW.gas_limit,
    NEW.max_fee_per_gas, NEW.max_priority_fee_per_gas,
    NEW.supersedes_submission_attempt_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.submission_attempt_id, OLD.registration_operation_id, OLD.chain_id,
    OLD.attempt_number, OLD.signer_namespace, OLD.signer_address,
    OLD.signing_intent_id, OLD.target_address, OLD.method_selector,
    OLD.calldata_hash, OLD.signing_deadline, OLD.value_wei, OLD.gas_limit,
    OLD.max_fee_per_gas, OLD.max_priority_fee_per_gas,
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
