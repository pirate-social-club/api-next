-- Private target-observer configuration, reservation, and immutable snapshots.
-- Provider calls never occur inside these transactions. A final result may be
-- retained only while the database-time lease and observer-local fence remain
-- current.

CREATE TABLE hns_control_observer_configurations (
  provider_configuration_reference TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  provider_configuration_digest TEXT NOT NULL,
  configuration_bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_control_observer_configurations_pk PRIMARY KEY (
    provider_configuration_reference,
    provider_configuration_version
  ),
  CONSTRAINT hns_control_observer_configurations_digest_unique UNIQUE (
    provider_configuration_reference,
    provider_configuration_version,
    provider_configuration_digest
  ),
  CONSTRAINT hns_control_observer_configurations_identity_check CHECK (
    btrim(provider_configuration_reference) <> ''
    AND provider_configuration_reference = btrim(provider_configuration_reference)
    AND octet_length(provider_configuration_reference) <= 512
    AND provider_configuration_reference !~ '[[:cntrl:]]'
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND octet_length(provider_configuration_version) <= 256
    AND provider_configuration_version !~ '[[:cntrl:]]'
  ),
  CONSTRAINT hns_control_observer_configurations_digest_check CHECK (
    provider_configuration_digest ~ '^[0-9a-f]{64}$'
    AND encode(sha256(configuration_bytes), 'hex') = provider_configuration_digest
  ),
  CONSTRAINT hns_control_observer_configurations_bytes_check CHECK (
    octet_length(configuration_bytes) BETWEEN 1 AND 8192
  )
);

CREATE TABLE hns_control_observer_operations (
  observation_id TEXT PRIMARY KEY,
  provider_configuration_reference TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  provider_configuration_digest TEXT NOT NULL,
  request_bytes BYTEA NOT NULL,
  request_sha256 TEXT NOT NULL,
  configuration_bytes BYTEA NOT NULL,
  snapshot_reference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_control_observer_operations_snapshot_unique UNIQUE (snapshot_reference),
  CONSTRAINT hns_control_observer_operations_identity_snapshot_unique UNIQUE (
    observation_id,
    snapshot_reference
  ),
  CONSTRAINT hns_control_observer_operations_configuration_fk FOREIGN KEY (
    provider_configuration_reference,
    provider_configuration_version,
    provider_configuration_digest
  ) REFERENCES hns_control_observer_configurations (
    provider_configuration_reference,
    provider_configuration_version,
    provider_configuration_digest
  ),
  CONSTRAINT hns_control_observer_operations_observation_check CHECK (
    btrim(observation_id) <> ''
    AND observation_id = btrim(observation_id)
    AND octet_length(observation_id) <= 256
    AND observation_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT hns_control_observer_operations_request_check CHECK (
    octet_length(request_bytes) >= 1
    AND octet_length(request_bytes) <= 32768
    AND request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT hns_control_observer_operations_configuration_check CHECK (
    octet_length(configuration_bytes) >= 1
    AND octet_length(configuration_bytes) <= 8192
    AND provider_configuration_digest ~ '^[0-9a-f]{64}$'
    AND encode(sha256(configuration_bytes), 'hex') = provider_configuration_digest
  ),
  CONSTRAINT hns_control_observer_operations_snapshot_reference_check CHECK (
    octet_length(snapshot_reference) <= 424
    AND snapshot_reference ~ '^[a-z][a-z0-9-]{0,31}(:[a-z0-9][a-z0-9._-]{0,127}){1,3}$'
  )
);

CREATE TABLE hns_control_observer_reservations (
  observation_id TEXT PRIMARY KEY REFERENCES hns_control_observer_operations (observation_id),
  state TEXT NOT NULL DEFAULT 'reserved',
  reservation_lease_seconds INTEGER NOT NULL,
  observer_fence BIGINT NOT NULL,
  reservation_database_time TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  terminal_snapshot_reference TEXT,
  terminal_status TEXT,
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT hns_control_observer_reservations_fence_unique UNIQUE (
    observation_id,
    observer_fence
  ),
  CONSTRAINT hns_control_observer_reservations_lease_check CHECK (
    reservation_lease_seconds >= 4
    AND reservation_lease_seconds <= 60
    AND observer_fence BETWEEN 1 AND 9007199254740991
    AND lease_expires_at = reservation_database_time
      + reservation_lease_seconds * INTERVAL '1 second'
    AND updated_at >= created_at
  ),
  CONSTRAINT hns_control_observer_reservations_state_check CHECK (
    (state = 'reserved'
      AND terminal_snapshot_reference IS NULL
      AND terminal_status IS NULL
      AND terminal_at IS NULL)
    OR
    (state = 'terminal'
      AND terminal_snapshot_reference IS NOT NULL
      AND terminal_status IN ('verified', 'rejected', 'unavailable')
      AND terminal_at IS NOT NULL
      AND terminal_at = updated_at
      AND terminal_at >= reservation_database_time
      AND terminal_at < lease_expires_at)
  )
);

CREATE TABLE hns_control_observer_snapshots (
  snapshot_reference TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL,
  observer_fence BIGINT NOT NULL,
  request_bytes BYTEA NOT NULL,
  request_sha256 TEXT NOT NULL,
  configuration_bytes BYTEA NOT NULL,
  provider_configuration_digest TEXT NOT NULL,
  reservation_database_time TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  semantic_facts_bytes BYTEA NOT NULL,
  result_status TEXT NOT NULL,
  result_reference_kind TEXT NOT NULL,
  result_reference TEXT NOT NULL,
  result_bytes BYTEA NOT NULL,
  result_sha256 TEXT NOT NULL,
  transcript_entry_count SMALLINT NOT NULL,
  transcript_byte_length BIGINT NOT NULL,
  accounting_envelope_bytes BYTEA NOT NULL,
  logical_snapshot_byte_length BIGINT NOT NULL,
  retained_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT hns_control_observer_snapshots_operation_fk FOREIGN KEY (
    observation_id,
    snapshot_reference
  ) REFERENCES hns_control_observer_operations (
    observation_id,
    snapshot_reference
  ),
  CONSTRAINT hns_control_observer_snapshots_reservation_fk FOREIGN KEY (
    observation_id,
    observer_fence
  ) REFERENCES hns_control_observer_reservations (
    observation_id,
    observer_fence
  ),
  CONSTRAINT hns_control_observer_snapshots_observation_unique UNIQUE (observation_id),
  CONSTRAINT hns_control_observer_snapshots_hash_check CHECK (
    request_sha256 ~ '^[0-9a-f]{64}$'
    AND provider_configuration_digest ~ '^[0-9a-f]{64}$'
    AND encode(sha256(configuration_bytes), 'hex') = provider_configuration_digest
    AND result_sha256 ~ '^[0-9a-f]{64}$'
    AND encode(sha256(result_bytes), 'hex') = result_sha256
  ),
  CONSTRAINT hns_control_observer_snapshots_bytes_check CHECK (
    octet_length(request_bytes) >= 1
    AND octet_length(request_bytes) <= 32768
    AND octet_length(configuration_bytes) BETWEEN 1 AND 8192
    AND octet_length(semantic_facts_bytes) BETWEEN 1 AND 10485760
    AND octet_length(result_bytes) BETWEEN 1 AND 1048576
    AND octet_length(accounting_envelope_bytes) > 0
    AND transcript_entry_count BETWEEN 0 AND 16
    AND transcript_byte_length BETWEEN 0 AND 7929848
    AND logical_snapshot_byte_length BETWEEN 1 AND 10485760
  ),
  CONSTRAINT hns_control_observer_snapshots_reference_check CHECK (
    result_reference = snapshot_reference
    AND octet_length(result_reference) <= 424
    AND result_reference ~ '^[a-z][a-z0-9-]{0,31}(:[a-z0-9][a-z0-9._-]{0,127}){1,3}$'
    AND (
      (result_status IN ('verified', 'rejected')
        AND result_reference_kind = 'provider_evidence_ref')
      OR
      (result_status = 'unavailable'
        AND result_reference_kind = 'diagnostic_ref')
    )
  ),
  CONSTRAINT hns_control_observer_snapshots_time_check CHECK (
    retained_at >= reservation_database_time
    AND retained_at < lease_expires_at
  )
);

CREATE TABLE hns_control_observer_snapshot_transcript_entries (
  snapshot_reference TEXT NOT NULL REFERENCES hns_control_observer_snapshots (snapshot_reference),
  entry_ordinal SMALLINT NOT NULL,
  driver_reference TEXT NOT NULL,
  ownership_source TEXT NOT NULL,
  method_or_view_id TEXT NOT NULL,
  request_bytes BYTEA NOT NULL,
  request_sha256 TEXT NOT NULL,
  transport_outcome TEXT NOT NULL,
  transport_status INTEGER,
  response_bytes BYTEA,
  response_sha256 TEXT,
  CONSTRAINT hns_control_observer_snapshot_transcript_entries_pk PRIMARY KEY (
    snapshot_reference,
    entry_ordinal
  ),
  CONSTRAINT hns_control_observer_snapshot_transcript_entries_ordinal_check CHECK (
    entry_ordinal BETWEEN 0 AND 15
  ),
  CONSTRAINT hns_control_observer_snapshot_transcript_entries_identity_check CHECK (
    btrim(driver_reference) <> ''
    AND driver_reference = btrim(driver_reference)
    AND octet_length(driver_reference) <= 256
    AND driver_reference !~ '[[:cntrl:]]'
    AND btrim(method_or_view_id) <> ''
    AND method_or_view_id = btrim(method_or_view_id)
    AND octet_length(method_or_view_id) <= 256
    AND method_or_view_id !~ '[[:cntrl:]]'
    AND ownership_source IN ('hns_parent_chain_txt', 'owner_authoritative_dns_txt')
  ),
  CONSTRAINT hns_control_observer_snapshot_transcript_entries_request_check CHECK (
    octet_length(request_bytes) >= 1
    AND octet_length(request_bytes) <= 4096
    AND request_sha256 ~ '^[0-9a-f]{64}$'
    AND encode(sha256(request_bytes), 'hex') = request_sha256
  ),
  CONSTRAINT hns_control_observer_snapshot_transcript_entries_response_check CHECK (
    (transport_outcome = 'response'
      AND response_bytes IS NOT NULL
      AND octet_length(response_bytes) BETWEEN 1 AND 1048576
      AND response_sha256 IS NOT NULL
      AND response_sha256 ~ '^[0-9a-f]{64}$'
      AND encode(sha256(response_bytes), 'hex') = response_sha256
      AND (transport_status IS NULL OR transport_status BETWEEN 100 AND 599))
    OR
    (transport_outcome IN ('timeout', 'transport_error', 'aborted')
      AND transport_status IS NULL
      AND response_bytes IS NULL
      AND response_sha256 IS NULL)
  )
);

CREATE INDEX hns_control_observer_reservations_live_lease_idx
  ON hns_control_observer_reservations (lease_expires_at, observation_id)
  WHERE state = 'reserved';

CREATE FUNCTION reject_hns_control_observer_append_only_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HNS control observer evidence is append-only';
END;
$$;

CREATE FUNCTION prepare_hns_control_observer_operation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  configuration_record hns_control_observer_configurations%ROWTYPE;
BEGIN
  IF NEW.snapshot_reference IS NOT NULL THEN
    RAISE EXCEPTION 'HNS observer snapshot reference is database-generated';
  END IF;

  SELECT * INTO configuration_record
    FROM hns_control_observer_configurations
   WHERE provider_configuration_reference = NEW.provider_configuration_reference
     AND provider_configuration_version = NEW.provider_configuration_version;
  IF NOT FOUND
    OR configuration_record.provider_configuration_digest <> NEW.provider_configuration_digest
    OR configuration_record.configuration_bytes IS DISTINCT FROM NEW.configuration_bytes THEN
    RAISE EXCEPTION 'HNS observer operation configuration authority mismatch';
  END IF;

  NEW.snapshot_reference := 'hns-observer:postgres:' || gen_random_uuid()::text;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_hns_control_observer_reservation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot_record hns_control_observer_snapshots%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HNS observer reservations cannot be deleted';
  END IF;

  IF NEW.observation_id <> OLD.observation_id
    OR NEW.reservation_lease_seconds <> OLD.reservation_lease_seconds
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'HNS observer reservation identity is immutable';
  END IF;

  IF OLD.state = 'reserved' AND NEW.state = 'reserved' THEN
    IF OLD.lease_expires_at > NEW.reservation_database_time
      OR NEW.observer_fence <> OLD.observer_fence + 1
      OR NEW.reservation_database_time <= OLD.reservation_database_time
      OR NEW.lease_expires_at <> NEW.reservation_database_time
        + NEW.reservation_lease_seconds * INTERVAL '1 second'
      OR NEW.updated_at <> NEW.reservation_database_time THEN
      RAISE EXCEPTION 'HNS observer reservation reacquisition is not fenced';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'reserved' AND NEW.state = 'terminal' THEN
    IF NEW.observer_fence <> OLD.observer_fence
      OR NEW.reservation_database_time <> OLD.reservation_database_time
      OR NEW.lease_expires_at <> OLD.lease_expires_at
      OR OLD.lease_expires_at <= clock_timestamp()
      OR NEW.terminal_at IS NULL
      OR NEW.terminal_at > clock_timestamp()
      OR NEW.terminal_at >= OLD.lease_expires_at THEN
      RAISE EXCEPTION 'HNS observer terminal transition lost its lease or fence';
    END IF;
    SELECT * INTO snapshot_record
      FROM hns_control_observer_snapshots
     WHERE observation_id = NEW.observation_id
       AND snapshot_reference = NEW.terminal_snapshot_reference
       AND observer_fence = NEW.observer_fence;
    IF NOT FOUND OR snapshot_record.result_status <> NEW.terminal_status THEN
      RAISE EXCEPTION 'HNS observer terminal transition lacks its snapshot';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'HNS observer reservation transition is not allowed';
END;
$$;

CREATE FUNCTION validate_hns_control_observer_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  operation_record hns_control_observer_operations%ROWTYPE;
  reservation_record hns_control_observer_reservations%ROWTYPE;
BEGIN
  SELECT * INTO operation_record
    FROM hns_control_observer_operations
   WHERE observation_id = NEW.observation_id;
  SELECT * INTO reservation_record
    FROM hns_control_observer_reservations
   WHERE observation_id = NEW.observation_id;

  IF operation_record.observation_id IS NULL
    OR reservation_record.observation_id IS NULL
    OR reservation_record.state <> 'reserved'
    OR reservation_record.observer_fence <> NEW.observer_fence
    OR reservation_record.lease_expires_at <= clock_timestamp()
    OR operation_record.snapshot_reference <> NEW.snapshot_reference
    OR operation_record.request_bytes IS DISTINCT FROM NEW.request_bytes
    OR operation_record.request_sha256 <> NEW.request_sha256
    OR operation_record.configuration_bytes IS DISTINCT FROM NEW.configuration_bytes
    OR operation_record.provider_configuration_digest <> NEW.provider_configuration_digest
    OR reservation_record.reservation_database_time <> NEW.reservation_database_time
    OR reservation_record.lease_expires_at <> NEW.lease_expires_at THEN
    RAISE EXCEPTION 'HNS observer snapshot authority mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_hns_control_observer_snapshot_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actual_entry_count BIGINT;
  actual_transcript_bytes BIGINT;
  minimum_ordinal INTEGER;
  maximum_ordinal INTEGER;
  actual_logical_bytes BIGINT;
  reservation_record hns_control_observer_reservations%ROWTYPE;
BEGIN
  SELECT count(*),
         COALESCE(sum(octet_length(request_bytes) + COALESCE(octet_length(response_bytes), 0)), 0),
         min(entry_ordinal),
         max(entry_ordinal)
    INTO actual_entry_count, actual_transcript_bytes, minimum_ordinal, maximum_ordinal
    FROM hns_control_observer_snapshot_transcript_entries
   WHERE snapshot_reference = NEW.snapshot_reference;

  IF actual_entry_count <> NEW.transcript_entry_count
    OR actual_transcript_bytes <> NEW.transcript_byte_length
    OR (actual_entry_count > 0
      AND (minimum_ordinal <> 0 OR maximum_ordinal <> actual_entry_count - 1)) THEN
    RAISE EXCEPTION 'HNS observer snapshot transcript is incomplete';
  END IF;

  actual_logical_bytes :=
    octet_length(NEW.request_bytes)
    + octet_length(NEW.configuration_bytes)
    + octet_length(NEW.semantic_facts_bytes)
    + octet_length(NEW.result_bytes)
    + actual_transcript_bytes
    + octet_length(NEW.accounting_envelope_bytes);
  IF actual_logical_bytes <> NEW.logical_snapshot_byte_length
    OR actual_logical_bytes > 10485760 THEN
    RAISE EXCEPTION 'HNS observer logical snapshot byte authority mismatch';
  END IF;

  SELECT * INTO reservation_record
    FROM hns_control_observer_reservations
   WHERE observation_id = NEW.observation_id;
  IF NOT FOUND
    OR reservation_record.state <> 'terminal'
    OR reservation_record.observer_fence <> NEW.observer_fence
    OR reservation_record.terminal_snapshot_reference <> NEW.snapshot_reference
    OR reservation_record.terminal_status <> NEW.result_status THEN
    RAISE EXCEPTION 'HNS observer snapshot lacks its terminal reservation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_hns_control_observer_transcript_entry_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation_record hns_control_observer_reservations%ROWTYPE;
  configuration_bytes BYTEA;
  request_bytes BYTEA;
  configuration_document JSONB;
  request_document JSONB;
  is_hsd_entry BOOLEAN;
  is_dns_entry BOOLEAN;
BEGIN
  SELECT reservation.* INTO reservation_record
    FROM hns_control_observer_snapshots AS snapshot
    JOIN hns_control_observer_reservations AS reservation
      ON reservation.observation_id = snapshot.observation_id
     AND reservation.observer_fence = snapshot.observer_fence
   WHERE snapshot.snapshot_reference = NEW.snapshot_reference
   FOR UPDATE OF reservation;

  IF NOT FOUND
    OR reservation_record.state <> 'reserved'
    OR reservation_record.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'HNS observer transcript is not open for insertion';
  END IF;

  SELECT operation.configuration_bytes, operation.request_bytes
    INTO configuration_bytes, request_bytes
    FROM hns_control_observer_snapshots AS snapshot
    JOIN hns_control_observer_operations AS operation
      ON operation.observation_id = snapshot.observation_id
   WHERE snapshot.snapshot_reference = NEW.snapshot_reference;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HNS observer transcript operation authority is absent';
  END IF;

  configuration_document := convert_from(configuration_bytes, 'UTF8')::JSONB;
  request_document := convert_from(request_bytes, 'UTF8')::JSONB;
  is_hsd_entry :=
    NEW.driver_reference = configuration_document #>> '{chain,driver_reference}'
    AND NEW.method_or_view_id IN (
      'getblockchaininfo',
      'getblockheader',
      'getnameinfo',
      'getnameresource'
    );
  is_dns_entry :=
    request_document ->> 'ownership_source' = 'owner_authoritative_dns_txt'
    AND NEW.driver_reference = configuration_document #>> '{authoritative_dns,driver_reference}'
    AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(
              configuration_document #> '{authoritative_dns,required_view_ids}'
            ) = 'array'
              THEN configuration_document #> '{authoritative_dns,required_view_ids}'
            ELSE '[]'::JSONB
          END
        ) AS required_view(view_id)
       WHERE required_view.view_id = NEW.method_or_view_id
    );
  IF NEW.ownership_source <> request_document ->> 'ownership_source'
    OR is_hsd_entry = is_dns_entry
    OR (NEW.transport_outcome = 'response' AND is_hsd_entry
      AND NEW.transport_status IS NULL)
    OR (NEW.transport_outcome = 'response' AND is_dns_entry
      AND NEW.transport_status IS NOT NULL) THEN
    RAISE EXCEPTION 'HNS observer transcript driver authority mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hns_control_observer_configurations_append_only
BEFORE UPDATE OR DELETE ON hns_control_observer_configurations
FOR EACH ROW EXECUTE FUNCTION reject_hns_control_observer_append_only_change();

CREATE TRIGGER hns_control_observer_operation_prepare
BEFORE INSERT ON hns_control_observer_operations
FOR EACH ROW EXECUTE FUNCTION prepare_hns_control_observer_operation_insert();

CREATE TRIGGER hns_control_observer_operations_append_only
BEFORE UPDATE OR DELETE ON hns_control_observer_operations
FOR EACH ROW EXECUTE FUNCTION reject_hns_control_observer_append_only_change();

CREATE TRIGGER hns_control_observer_reservation_guard
BEFORE UPDATE OR DELETE ON hns_control_observer_reservations
FOR EACH ROW EXECUTE FUNCTION guard_hns_control_observer_reservation_change();

CREATE TRIGGER hns_control_observer_snapshot_insert_guard
BEFORE INSERT ON hns_control_observer_snapshots
FOR EACH ROW EXECUTE FUNCTION validate_hns_control_observer_snapshot_insert();

CREATE TRIGGER hns_control_observer_snapshots_append_only
BEFORE UPDATE OR DELETE ON hns_control_observer_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_hns_control_observer_append_only_change();

CREATE TRIGGER hns_control_observer_transcript_entries_append_only
BEFORE UPDATE OR DELETE ON hns_control_observer_snapshot_transcript_entries
FOR EACH ROW EXECUTE FUNCTION reject_hns_control_observer_append_only_change();

CREATE TRIGGER hns_control_observer_transcript_entry_insert_guard
BEFORE INSERT ON hns_control_observer_snapshot_transcript_entries
FOR EACH ROW EXECUTE FUNCTION validate_hns_control_observer_transcript_entry_insert();

CREATE CONSTRAINT TRIGGER hns_control_observer_snapshot_complete_guard
AFTER INSERT ON hns_control_observer_snapshots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_hns_control_observer_snapshot_complete();
