-- Spec 012 §5.3.13.3.1. Preparation is not an active assignment. An operator
-- may attest to its own wallet and address, but only the owner can confirm it.
CREATE TABLE spaces_operator_service_credentials (
  credential_id TEXT PRIMARY KEY CHECK (credential_id ~ '^sopscred_[0-9a-f]{32}$'),
  operator_instance_id TEXT NOT NULL REFERENCES spaces_operator_instances(operator_instance_id),
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  network TEXT NOT NULL CHECK (network='mainnet'),
  canonical_root TEXT NOT NULL CHECK (is_community_route_root_label('spaces',canonical_root)),
  capability TEXT NOT NULL CHECK (capability IN (
    'assignment_prepare','capability_report','funding_report'
  )),
  verifier_sha256_hex TEXT NOT NULL CHECK (verifier_sha256_hex ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  authorization_reference TEXT NOT NULL CHECK (is_handle_sales_identifier_v1(authorization_reference,128)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  CHECK ((status='active' AND revoked_at IS NULL) OR
         (status='revoked' AND revoked_at >= created_at))
);

CREATE UNIQUE INDEX spaces_operator_service_active_uidx
  ON spaces_operator_service_credentials(operator_instance_id,environment,network,canonical_root,capability)
  WHERE status='active';

CREATE FUNCTION guard_spaces_operator_service_credential_change_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Spaces operator credential cannot be deleted';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'revoked'
    OR (to_jsonb(NEW) - 'status' - 'revoked_at')
      <> (to_jsonb(OLD) - 'status' - 'revoked_at') THEN
    RAISE EXCEPTION 'Spaces operator credential may only be revoked';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_operator_service_credentials_change_guard
BEFORE UPDATE OR DELETE ON spaces_operator_service_credentials
FOR EACH ROW EXECUTE FUNCTION guard_spaces_operator_service_credential_change_v1();

-- A unique idempotency key is bound to one authenticated host capability.
-- The address and wallet reference cannot be proposed for another root, even
-- if the proposal is later superseded or the host credential is revoked.
CREATE TABLE spaces_operator_prepared_assignments (
  operator_assignment_id TEXT PRIMARY KEY CHECK (operator_assignment_id ~ '^sassign_[0-9a-f]{32}$'),
  operator_assignment_generation BIGINT NOT NULL DEFAULT 1 CHECK (operator_assignment_generation=1),
  credential_id TEXT NOT NULL REFERENCES spaces_operator_service_credentials(credential_id),
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  network TEXT NOT NULL CHECK (network='mainnet'),
  canonical_root TEXT NOT NULL CHECK (is_community_route_root_label('spaces',canonical_root)),
  operator_instance_id TEXT NOT NULL REFERENCES spaces_operator_instances(operator_instance_id),
  operator_wallet_reference TEXT NOT NULL UNIQUE CHECK (is_handle_sales_identifier_v1(operator_wallet_reference,256)),
  delegation_address TEXT NOT NULL UNIQUE CHECK (delegation_address ~ '^bcs1p[a-z0-9]{8,120}$'),
  idempotency_key TEXT NOT NULL CHECK (is_handle_sales_identifier_v1(idempotency_key,128)),
  request_bytes BYTEA NOT NULL CHECK (octet_length(request_bytes) BETWEEN 1 AND 4096),
  request_sha256_hex TEXT NOT NULL CHECK (request_sha256_hex ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('prepared','confirmed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  confirmed_at TIMESTAMPTZ,
  confirmed_by_account_id TEXT REFERENCES users(user_id),
  namespace_authority_reference TEXT,
  namespace_authority_generation BIGINT,
  confirm_idempotency_key TEXT,
  confirm_request_bytes BYTEA,
  CHECK (
    (status='prepared' AND confirmed_at IS NULL AND confirmed_by_account_id IS NULL
      AND namespace_authority_reference IS NULL AND namespace_authority_generation IS NULL
      AND confirm_idempotency_key IS NULL AND confirm_request_bytes IS NULL)
    OR
    (status='confirmed' AND confirmed_at >= created_at AND confirmed_by_account_id IS NOT NULL
      AND namespace_authority_reference IS NOT NULL AND namespace_authority_generation > 0
      AND confirm_idempotency_key IS NOT NULL
      AND octet_length(confirm_request_bytes) BETWEEN 1 AND 4096)
  ),
  FOREIGN KEY (namespace_authority_reference,namespace_authority_generation)
    REFERENCES spaces_namespace_authority_evidence(namespace_authority_reference,namespace_authority_generation),
  UNIQUE(credential_id,idempotency_key)
);

CREATE UNIQUE INDEX spaces_operator_prepared_root_uidx
  ON spaces_operator_prepared_assignments(environment,network,canonical_root)
  WHERE status='prepared';

CREATE FUNCTION guard_spaces_operator_prepared_assignment_change_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Spaces prepared assignment cannot be deleted';
  END IF;
  IF OLD.status <> 'prepared' OR NEW.status <> 'confirmed'
    OR (to_jsonb(NEW) - 'status' - 'confirmed_at' - 'confirmed_by_account_id'
        - 'namespace_authority_reference' - 'namespace_authority_generation'
        - 'confirm_idempotency_key' - 'confirm_request_bytes')
      <> (to_jsonb(OLD) - 'status' - 'confirmed_at' - 'confirmed_by_account_id'
        - 'namespace_authority_reference' - 'namespace_authority_generation'
        - 'confirm_idempotency_key' - 'confirm_request_bytes') THEN
    RAISE EXCEPTION 'Spaces prepared assignment may only be confirmed once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_operator_prepared_assignments_change_guard
BEFORE UPDATE OR DELETE ON spaces_operator_prepared_assignments
FOR EACH ROW EXECUTE FUNCTION guard_spaces_operator_prepared_assignment_change_v1();

-- Each host report has one exact replay key. A report records what the scoped
-- host observed; it does not stand in for the independent verifier's view.
CREATE TABLE spaces_operator_service_reports (
  report_id TEXT PRIMARY KEY CHECK (report_id ~ '^sopsreport_[0-9a-f]{32}$'),
  credential_id TEXT NOT NULL REFERENCES spaces_operator_service_credentials(credential_id),
  capability TEXT NOT NULL CHECK (capability IN ('capability_report','funding_report')),
  operator_assignment_id TEXT NOT NULL,
  operator_assignment_generation BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (is_handle_sales_identifier_v1(idempotency_key,128)),
  request_bytes BYTEA NOT NULL CHECK (octet_length(request_bytes) BETWEEN 1 AND 4096),
  request_sha256_hex TEXT NOT NULL CHECK (request_sha256_hex ~ '^[0-9a-f]{64}$'),
  observation_generation BIGINT NOT NULL CHECK (observation_generation BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('observed','absent','funded_v1','commits_paused_insufficient_funds_v1')),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (operator_assignment_id,operator_assignment_generation)
    REFERENCES spaces_operator_assignment_revisions(operator_assignment_id,operator_assignment_generation),
  UNIQUE(credential_id,idempotency_key),
  CHECK (observed_at <= created_at)
);

CREATE TRIGGER spaces_operator_service_reports_append_only
BEFORE UPDATE OR DELETE ON spaces_operator_service_reports
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();
