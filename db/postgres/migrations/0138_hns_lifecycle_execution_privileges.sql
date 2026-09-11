-- HNS root-import lifecycle execution privileges. Like the renewal
-- writers (0126), the lifecycle commit/claim/finalize functions are
-- executable only through explicit deployment grants to the provisioner
-- runtime roles; a status reader must not write through SECURITY DEFINER
-- functions merely because it has schema USAGE. Required EXECUTE grants:
-- the hns authority provisioner executor role (claim, finalize, commit)
-- and the control-plane transition writer role (commit). Serving releases
-- consuming this step: the root-import lifecycle repair release train.

REVOKE ALL ON FUNCTION guard_hns_root_import_lifecycle_anchor_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION hns_root_import_lifecycle_transition_allowed_v1(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION commit_hns_root_import_lifecycle_decision_v1(
  TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_hns_root_import_lifecycle_job_v1(
  BIGINT, TEXT, BIGINT, TEXT, TEXT
) FROM PUBLIC;

-- The lifecycle commit/claim/finalize functions execute table mutations as
-- the schema owner (SECURITY DEFINER with a pinned search path, matching
-- the provision/observation envelope pattern), so the runtime roles need
-- only explicit EXECUTE grants, never table writes.
ALTER FUNCTION commit_hns_root_import_lifecycle_decision_v1(
  TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB
) SECURITY DEFINER;
ALTER FUNCTION claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER) SECURITY DEFINER;
ALTER FUNCTION finalize_hns_root_import_lifecycle_job_v1(
  BIGINT, TEXT, BIGINT, TEXT, TEXT
) SECURITY DEFINER;
DO $pin_lifecycle_privileges$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION commit_hns_root_import_lifecycle_decision_v1(text,bigint,text,text,text,text,text,jsonb,jsonb) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION claim_hns_root_import_lifecycle_job_v1(text,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION finalize_hns_root_import_lifecycle_job_v1(bigint,text,bigint,text,text) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_lifecycle_privileges$;
