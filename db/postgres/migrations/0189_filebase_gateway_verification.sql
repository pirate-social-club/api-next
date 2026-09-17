-- Registration retrieval is verified through the Filebase dedicated gateway.
-- The single-provider contract verifies availability and integrity within one
-- provider; it is not independent replication and no longer requires a
-- distinct gateway provider. Historical independent_gateway rows remain valid
-- and readable; new gateway rows use the filebase_gateway role.

ALTER TABLE data_registration_pin_verifications
  DROP CONSTRAINT data_registration_pin_verifications_role_check,
  ADD CONSTRAINT data_registration_pin_verifications_role_check CHECK (
    role = ANY (ARRAY['primary'::text, 'redundant'::text, 'independent_gateway'::text, 'filebase_gateway'::text])
  );

CREATE OR REPLACE FUNCTION data_registration_pins_are_ready(operation_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE operation.media_kind
    WHEN 'song' THEN
      EXISTS (SELECT 1 FROM data_registration_artifacts artifact
        WHERE artifact.registration_operation_id=operation_id
          AND artifact.artifact_kind='canonical_audio')
    WHEN 'video' THEN
      EXISTS (SELECT 1 FROM data_registration_artifacts artifact
        WHERE artifact.registration_operation_id=operation_id
          AND artifact.artifact_kind='canonical_video')
      AND EXISTS (SELECT 1 FROM data_registration_artifacts artifact
        WHERE artifact.registration_operation_id=operation_id
          AND artifact.artifact_kind='poster')
    ELSE FALSE
  END
  AND EXISTS (SELECT 1 FROM data_registration_artifacts artifact
    WHERE artifact.registration_operation_id=operation_id
      AND artifact.artifact_kind='ip_metadata')
  AND EXISTS (SELECT 1 FROM data_registration_artifacts artifact
    WHERE artifact.registration_operation_id=operation_id
      AND artifact.artifact_kind='nft_metadata')
  AND NOT EXISTS (
    SELECT 1 FROM data_registration_artifacts artifact
    WHERE artifact.registration_operation_id=operation_id
      AND NOT EXISTS (
        SELECT 1
        FROM data_registration_pin_verifications primary_pin
        JOIN data_registration_pin_verifications gateway
          ON gateway.registration_operation_id=primary_pin.registration_operation_id
         AND gateway.artifact_id=primary_pin.artifact_id
         AND gateway.role IN ('independent_gateway','filebase_gateway')
         AND gateway.provider_id IN ('filebase-gateway','ipfs.io')
         AND gateway.outcome='verified'
         AND gateway.cid=primary_pin.cid
         AND gateway.canonical_sha256=primary_pin.canonical_sha256
         AND gateway.byte_length=primary_pin.byte_length
        WHERE primary_pin.registration_operation_id=operation_id
          AND primary_pin.artifact_id=artifact.artifact_id
          AND primary_pin.role='primary' AND primary_pin.provider_id='filebase'
          AND primary_pin.outcome='verified'
          AND primary_pin.canonical_sha256=artifact.canonical_sha256
          AND primary_pin.byte_length=artifact.byte_length
      )
  )
  FROM data_registration_operations operation
  WHERE operation.registration_operation_id=operation_id;
$$;
