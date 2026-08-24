-- Version-closed owner-authority inventory and observer snapshot successor.
-- Historical v1 rows remain byte-exact. Configuration-v2 observations retain
-- their inventory and manifest authority under the existing lease/fence.

CREATE TABLE hns_authority_inventories (
  registry_reference TEXT NOT NULL,
  authority_inventory_reference TEXT NOT NULL,
  authority_inventory_version TEXT NOT NULL,
  authority_inventory_digest TEXT NOT NULL,
  environment TEXT NOT NULL,
  runtime_capability_set_digest TEXT NOT NULL,
  inventory_bytes BYTEA NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_authority_inventories_pk PRIMARY KEY (
    registry_reference,
    authority_inventory_version
  ),
  CONSTRAINT hns_authority_inventories_identity_unique UNIQUE (
    authority_inventory_reference,
    authority_inventory_version,
    authority_inventory_digest
  ),
  CONSTRAINT hns_authority_inventories_identity_check CHECK (
    registry_reference ~ '^[a-z][a-z0-9-]{0,63}:[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'
    AND authority_inventory_reference ~ '^[a-z][a-z0-9-]{0,63}:[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'
    AND btrim(authority_inventory_version) <> ''
    AND authority_inventory_version = btrim(authority_inventory_version)
    AND octet_length(authority_inventory_version) <= 256
    AND authority_inventory_version !~ '[[:cntrl:]]'
    AND btrim(environment) <> ''
    AND environment = btrim(environment)
    AND octet_length(environment) <= 256
    AND environment !~ '[[:cntrl:]]'
  ),
  CONSTRAINT hns_authority_inventories_digest_check CHECK (
    authority_inventory_digest ~ '^[0-9a-f]{64}$'
    AND runtime_capability_set_digest ~ '^[0-9a-f]{64}$'
    AND encode(sha256(inventory_bytes), 'hex') = authority_inventory_digest
  ),
  CONSTRAINT hns_authority_inventories_bytes_check CHECK (
    octet_length(inventory_bytes) BETWEEN 1 AND 65536
  ),
  CONSTRAINT hns_authority_inventories_time_check CHECK (
    expires_at > published_at
  )
);

CREATE INDEX hns_authority_inventories_current_idx
  ON hns_authority_inventories (registry_reference, published_at DESC, expires_at);

CREATE TRIGGER hns_authority_inventories_append_only
BEFORE UPDATE OR DELETE ON hns_authority_inventories
FOR EACH ROW EXECUTE FUNCTION reject_hns_control_observer_append_only_change();

ALTER TABLE hns_control_observer_reservations
  DROP CONSTRAINT hns_control_observer_reservations_state_check;

ALTER TABLE hns_control_observer_reservations
  ADD CONSTRAINT hns_control_observer_reservations_state_check CHECK (
    (state = 'reserved'
      AND terminal_snapshot_reference IS NULL
      AND terminal_status IS NULL
      AND terminal_at IS NULL)
    OR
    (state = 'terminal'
      AND terminal_snapshot_reference IS NOT NULL
      AND terminal_status IN ('verified', 'rejected', 'unavailable', 'ineligible')
      AND terminal_at IS NOT NULL
      AND terminal_at = updated_at
      AND terminal_at >= reservation_database_time
      AND terminal_at < lease_expires_at)
  );

ALTER TABLE hns_control_observer_snapshots
  ADD COLUMN authority_inventory_bytes BYTEA,
  ADD COLUMN authority_inventory_reference TEXT,
  ADD COLUMN authority_inventory_version TEXT,
  ADD COLUMN authority_inventory_digest TEXT,
  ADD COLUMN semantic_facts_sha256 TEXT,
  ADD COLUMN transcript_manifest_sha256 TEXT,
  ADD COLUMN observer_snapshot_sha256 TEXT;

ALTER TABLE hns_control_observer_snapshots
  DROP CONSTRAINT hns_control_observer_snapshots_hash_check,
  DROP CONSTRAINT hns_control_observer_snapshots_bytes_check,
  DROP CONSTRAINT hns_control_observer_snapshots_reference_check;

ALTER TABLE hns_control_observer_snapshots
  ADD CONSTRAINT hns_control_observer_snapshots_hash_check CHECK (
    request_sha256 ~ '^[0-9a-f]{64}$'
    AND provider_configuration_digest ~ '^[0-9a-f]{64}$'
    AND encode(sha256(configuration_bytes), 'hex') = provider_configuration_digest
    AND result_sha256 ~ '^[0-9a-f]{64}$'
    AND encode(sha256(result_bytes), 'hex') = result_sha256
    AND (authority_inventory_digest IS NULL OR (
      authority_inventory_digest ~ '^[0-9a-f]{64}$'
      AND authority_inventory_bytes IS NOT NULL
      AND encode(sha256(authority_inventory_bytes), 'hex') = authority_inventory_digest
    ))
    AND (semantic_facts_sha256 IS NULL OR (
      semantic_facts_sha256 ~ '^[0-9a-f]{64}$'
      AND encode(sha256(semantic_facts_bytes), 'hex') = semantic_facts_sha256
    ))
    AND (transcript_manifest_sha256 IS NULL
      OR transcript_manifest_sha256 ~ '^[0-9a-f]{64}$')
    AND (observer_snapshot_sha256 IS NULL
      OR observer_snapshot_sha256 ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT hns_control_observer_snapshots_bytes_check CHECK (
    (octet_length(request_bytes) >= 1 AND octet_length(request_bytes) <= 32768)
    AND (octet_length(configuration_bytes) >= 1
      AND octet_length(configuration_bytes) <= 8192)
    AND (authority_inventory_bytes IS NULL
      OR (octet_length(authority_inventory_bytes) >= 1
        AND octet_length(authority_inventory_bytes) <= 65536))
    AND (octet_length(semantic_facts_bytes) >= 1
      AND octet_length(semantic_facts_bytes) <= 10485760)
    AND (octet_length(result_bytes) >= 1 AND octet_length(result_bytes) <= 1048576)
    AND octet_length(accounting_envelope_bytes) > 0
    AND (transcript_entry_count >= 0 AND transcript_entry_count <= 16)
    AND (transcript_byte_length >= 0 AND transcript_byte_length <= 7929848)
    AND (logical_snapshot_byte_length >= 1 AND logical_snapshot_byte_length <= 10485760)
  ),
  ADD CONSTRAINT hns_control_observer_snapshots_reference_check CHECK (
    result_reference = snapshot_reference
    AND octet_length(result_reference) <= 424
    AND result_reference ~ '^[a-z][a-z0-9-]{0,31}(:[a-z0-9][a-z0-9._-]{0,127}){1,3}$'
    AND (
      (result_status IN ('verified', 'rejected')
        AND result_reference_kind = 'provider_evidence_ref')
      OR
      (result_status IN ('unavailable', 'ineligible')
        AND result_reference_kind = 'diagnostic_ref')
    )
  );

CREATE OR REPLACE FUNCTION validate_hns_control_observer_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  operation_record hns_control_observer_operations%ROWTYPE;
  reservation_record hns_control_observer_reservations%ROWTYPE;
  configuration_version TEXT;
  request_source TEXT;
  result_document JSONB;
  result_version TEXT;
  inventory_member_count INTEGER;
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

  configuration_version := convert_from(NEW.configuration_bytes, 'UTF8')::JSONB ->> 'version';
  request_source := convert_from(NEW.request_bytes, 'UTF8')::JSONB ->> 'ownership_source';
  result_document := convert_from(NEW.result_bytes, 'UTF8')::JSONB;
  result_version := result_document ->> 'version';
  inventory_member_count :=
      (NEW.authority_inventory_bytes IS NOT NULL)::INTEGER
    + (NEW.authority_inventory_reference IS NOT NULL)::INTEGER
    + (NEW.authority_inventory_version IS NOT NULL)::INTEGER
    + (NEW.authority_inventory_digest IS NOT NULL)::INTEGER;

  IF configuration_version = 'pirate-hns-control-observer-configuration-v1' THEN
    IF result_version <> 'pirate-hns-control-observation-result-v1'
      OR inventory_member_count <> 0
      OR NEW.semantic_facts_sha256 IS NOT NULL
      OR NEW.transcript_manifest_sha256 IS NOT NULL
      OR NEW.observer_snapshot_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'HNS observer v1 snapshot contains successor authority';
    END IF;
  ELSIF configuration_version = 'pirate-hns-control-observer-configuration-v2' THEN
    IF result_version <> 'pirate-hns-control-observation-result-v2'
      OR inventory_member_count NOT IN (0, 4)
      OR NEW.semantic_facts_sha256 IS NULL
      OR NEW.transcript_manifest_sha256 IS NULL
      OR NEW.observer_snapshot_sha256 IS NULL
      OR result_document ->> 'observer_snapshot_sha256' <> NEW.observer_snapshot_sha256 THEN
      RAISE EXCEPTION 'HNS observer v2 snapshot authority is incomplete';
    END IF;
    IF request_source = 'owner_authoritative_dns_txt'
      AND NEW.result_status IN ('verified', 'rejected', 'ineligible')
      AND inventory_member_count <> 4 THEN
      RAISE EXCEPTION 'HNS observer owner-authoritative terminal lacks inventory';
    END IF;
    IF NEW.result_status = 'ineligible'
      AND (result_document ->> 'reason_code' <> 'owner_authoritative_source_ineligible'
        OR inventory_member_count <> 4) THEN
      RAISE EXCEPTION 'HNS observer source-ineligible snapshot is invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'HNS observer snapshot configuration version is unsupported';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_hns_control_observer_snapshot_complete()
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
    + COALESCE(octet_length(NEW.authority_inventory_bytes), 0)
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
