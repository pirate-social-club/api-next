-- The accepted observation, persisted as server evidence — spec 012,
-- "Activation and the public contract" and "Persisted state, evidence, and
-- jobs".
--
-- The public lifecycle projection carries an observation summary: which view
-- was read, the resource digest it carried, the tip height, the UPDATE
-- inclusion height and the commitment height. Until now none of that survived
-- the decision that consumed it. The lifecycle row kept counts and deadlines,
-- and history kept an evidence *reference* encoded inside an event identity —
-- enough to recognise a replay, not enough to answer what the server actually
-- observed. A projection built from anything else would be the client's
-- inference rather than the server's evidence, which is the failure mode this
-- lane exists to remove.
--
-- Only an accepted observation is recorded, in the same transaction as the
-- decision that accepted it, under the same row lock and lease fence. The
-- three heights are deliberately separate columns: conflating tip height,
-- inclusion height and commitment height has already produced one defect on
-- this lane, and a projection that reports the wrong one tells an owner their
-- name is included when it is not.

ALTER TABLE hns_root_import_lifecycle
  ADD COLUMN last_observation_view TEXT,
  ADD COLUMN last_observation_resource_sha256 TEXT,
  ADD COLUMN last_observation_tip_height BIGINT,
  ADD COLUMN last_observation_update_inclusion_height BIGINT,
  ADD COLUMN last_observation_commitment_height BIGINT,
  ADD COLUMN last_observation_at TIMESTAMPTZ;

ALTER TABLE hns_root_import_lifecycle
  ADD CONSTRAINT hns_root_import_lifecycle_observation_shape CHECK (
    -- Every conjunct is written to be TRUE or FALSE and never NULL. A CHECK
    -- passes on NULL, so the obvious "all set OR all null" phrasing is
    -- permissive for exactly the half-written rows it is meant to reject: with
    -- a view set and a height null, one branch is FALSE and the other NULL, and
    -- FALSE OR NULL is NULL. `num_nulls` gives the all-or-none rule a
    -- three-valued-safe form, and each per-column rule guards its own null.
    num_nulls(
      last_observation_view,
      last_observation_resource_sha256,
      last_observation_tip_height,
      last_observation_at
    ) IN (0, 4)
    AND (last_observation_view IS NULL OR last_observation_view IN ('current', 'safe'))
    AND (
      last_observation_resource_sha256 IS NULL
      OR last_observation_resource_sha256 ~ '^[0-9a-f]{64}$'
    )
    AND (
      last_observation_tip_height IS NULL
      OR (last_observation_tip_height > 0 AND last_observation_tip_height <= 9007199254740991)
    )
    -- A height with no tip to measure it against is meaningless, and a height
    -- above the tip is impossible.
    AND (
      last_observation_update_inclusion_height IS NULL
      OR (
        last_observation_tip_height IS NOT NULL
        AND last_observation_update_inclusion_height > 0
        AND last_observation_update_inclusion_height <= last_observation_tip_height
      )
    )
    AND (
      last_observation_commitment_height IS NULL
      OR (
        last_observation_tip_height IS NOT NULL
        AND last_observation_commitment_height > 0
        AND last_observation_commitment_height <= last_observation_tip_height
      )
    )
  );

-- Records the observation a decision accepted. Called inside the runner's
-- transaction, after the decision commits, while the job's lease fence and the
-- operation row lock are both still held by that transaction — so this adds no
-- fence of its own and must never be reachable outside one.
--
-- Unlike the finality anchor and the plan digest, this is deliberately not
-- write-once: it is the *last* accepted observation, refreshed by every
-- accepted one. It is evidence about a moment, not an anchor.
CREATE OR REPLACE FUNCTION record_hns_root_import_lifecycle_observation_v1(
  input_session_id TEXT,
  input_view TEXT,
  input_resource_sha256 TEXT,
  input_tip_height BIGINT,
  input_update_inclusion_height BIGINT,
  input_commitment_height BIGINT,
  input_observed_at TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  IF input_view NOT IN ('current', 'safe')
    OR input_resource_sha256 !~ '^[0-9a-f]{64}$'
    OR input_tip_height IS NULL
    OR input_tip_height <= 0
    OR input_observed_at IS NULL
  THEN
    RAISE EXCEPTION 'invalid HNS lifecycle observation evidence';
  END IF;
  UPDATE hns_root_import_lifecycle
     SET last_observation_view = input_view,
         last_observation_resource_sha256 = input_resource_sha256,
         last_observation_tip_height = input_tip_height,
         last_observation_update_inclusion_height = input_update_inclusion_height,
         last_observation_commitment_height = input_commitment_height,
         last_observation_at = input_observed_at,
         updated_at = clock_timestamp()
   WHERE root_import_session_id = input_session_id;
  IF NOT FOUND THEN RETURN 'lifecycle_absent'; END IF;
  RETURN 'recorded';
END;
$$;

REVOKE ALL ON FUNCTION record_hns_root_import_lifecycle_observation_v1(
  TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ
) FROM PUBLIC;
ALTER FUNCTION record_hns_root_import_lifecycle_observation_v1(
  TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ
) SECURITY DEFINER;
DO $pin_observation_privileges$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION record_hns_root_import_lifecycle_observation_v1(text,text,text,bigint,bigint,bigint,timestamptz) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_observation_privileges$;
