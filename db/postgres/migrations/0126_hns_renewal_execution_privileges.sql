-- Renewal writers require explicit deployment grants, like the provision jobs.
-- Preserve owner and existing executor grants; a status reader must not write
-- through SECURITY DEFINER functions merely because it has schema USAGE.
REVOKE ALL ON FUNCTION schedule_hns_root_health_renewals_v1(INTEGER, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_hns_root_health_renewal_job_v1(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION prepare_hns_root_inventory_renewal_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_hns_root_health_renewal_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) FROM PUBLIC;
