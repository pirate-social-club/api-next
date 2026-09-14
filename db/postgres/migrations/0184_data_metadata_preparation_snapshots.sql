-- Pin the complete public metadata pair before either artifact is recorded.
-- Retained v1 documents remain byte-identical; new rated songs use v2.
CREATE TABLE data_registration_metadata_snapshots (
  registration_operation_id text PRIMARY KEY REFERENCES data_registration_operations(registration_operation_id),
  schema_revision text NOT NULL CHECK (schema_revision IN ('pirate-data-metadata-v1','pirate-data-metadata-v2')),
  ip_metadata_bytes bytea NOT NULL CHECK (octet_length(ip_metadata_bytes)>0),
  nft_metadata_bytes bytea NOT NULL CHECK (octet_length(nft_metadata_bytes)>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(convert_from(ip_metadata_bytes,'UTF8')::jsonb)='object'),
  CHECK (jsonb_typeof(convert_from(nft_metadata_bytes,'UTF8')::jsonb)='object'),
  CHECK (convert_from(ip_metadata_bytes,'UTF8')::jsonb->>'schema_version' IS NOT DISTINCT FROM schema_revision),
  CHECK (convert_from(nft_metadata_bytes,'UTF8')::jsonb->>'schema_version' IS NOT DISTINCT FROM schema_revision)
);

CREATE FUNCTION guard_data_metadata_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'DATA metadata preparation is immutable' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('data-metadata:' || NEW.registration_operation_id,0));
  IF EXISTS (
    SELECT 1 FROM data_registration_artifacts a
    WHERE a.registration_operation_id=NEW.registration_operation_id
      AND a.artifact_kind IN ('ip_metadata','nft_metadata')
      AND (a.canonical_sha256<>encode(sha256(CASE a.artifact_kind
           WHEN 'ip_metadata' THEN NEW.ip_metadata_bytes ELSE NEW.nft_metadata_bytes END),'hex')
        OR a.byte_length<>octet_length(CASE a.artifact_kind
           WHEN 'ip_metadata' THEN NEW.ip_metadata_bytes ELSE NEW.nft_metadata_bytes END))
  ) THEN
    RAISE EXCEPTION 'DATA metadata preparation conflicts with retained artifact' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_metadata_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE
  ON data_registration_metadata_snapshots FOR EACH ROW EXECUTE FUNCTION guard_data_metadata_snapshot();

CREATE FUNCTION guard_data_metadata_artifact_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pinned bytea;
BEGIN
  IF NEW.artifact_kind NOT IN ('ip_metadata','nft_metadata') THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('data-metadata:' || NEW.registration_operation_id,0));
  SELECT CASE NEW.artifact_kind WHEN 'ip_metadata' THEN ip_metadata_bytes ELSE nft_metadata_bytes END
    INTO pinned FROM data_registration_metadata_snapshots
    WHERE registration_operation_id=NEW.registration_operation_id;
  IF pinned IS NOT NULL AND (NEW.canonical_sha256<>encode(sha256(pinned),'hex') OR NEW.byte_length<>octet_length(pinned)) THEN
    RAISE EXCEPTION 'DATA metadata artifact conflicts with pinned preparation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_metadata_artifact_snapshot_guard BEFORE INSERT OR UPDATE
  ON data_registration_artifacts FOR EACH ROW EXECUTE FUNCTION guard_data_metadata_artifact_snapshot();
