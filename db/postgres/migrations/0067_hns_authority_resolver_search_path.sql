-- Bind the community-host authority resolver graph to the schema in which the
-- migration is installed. Production captures api_next; isolated PostgreSQL
-- tests capture their per-suite schema. pg_temp is placed last so temporary
-- objects cannot shadow retained authority relations.
DO $$
DECLARE
  installed_schema TEXT := current_schema();
BEGIN
  IF installed_schema IS NULL THEN
    RAISE EXCEPTION 'HNS authority resolver migration requires a current schema';
  END IF;

  EXECUTE format(
    'ALTER FUNCTION %I.effective_active_route(TEXT, TIMESTAMPTZ) SET search_path TO %I, pg_temp',
    installed_schema,
    installed_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.effective_route_authority_v2(TEXT, TIMESTAMPTZ) SET search_path TO %I, pg_temp',
    installed_schema,
    installed_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.resolve_hns_community_app_host_authority_v1(TEXT, TIMESTAMPTZ) SET search_path TO %I, pg_temp',
    installed_schema,
    installed_schema
  );
END;
$$;

COMMENT ON FUNCTION resolve_hns_community_app_host_authority_v1(TEXT, TIMESTAMPTZ) IS
  'Source-closed current app-host authority. Its resolver graph captures the installation schema and remains independent of caller search_path.';
