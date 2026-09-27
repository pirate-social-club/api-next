-- TXT-only completion reads the import publication window to distinguish an
-- ordinary challenge from an exposed root import. Migration 0208 granted this
-- function to api_next_app when that role exists. The production runtime uses
-- the branch-scoped role below instead, so its completion check was denied
-- before it could reserve an observation attempt.
--
-- This grant exposes only the actor/community/session-scoped read function.
-- It does not grant the import authorization or any mutation function.
DO $hns_txt_attachment_runtime_window_grant$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'pscale_api_gfbytfmpuetx'
  ) THEN
    GRANT EXECUTE ON FUNCTION hns_root_import_publication_window_v1(text,text,text)
      TO pscale_api_gfbytfmpuetx;
  END IF;
END;
$hns_txt_attachment_runtime_window_grant$;
