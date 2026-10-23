-- CREATE OR REPLACE resets a function's configuration when SET is omitted.
-- Restore the owner-only purpose-grant routine's trusted resolution path after
-- its 0302 closure extension. No role, table, history or admission is changed.
DO $path$
DECLARE trusted TEXT:=current_schema();
BEGIN
 IF trusted IS NULL THEN RAISE EXCEPTION 'Dance grant path requires a schema'; END IF;
 EXECUTE format('ALTER FUNCTION %I.grant_moderated_dance_runtime_v1(TEXT,TEXT) SET search_path TO %I,pg_catalog,pg_temp',trusted,trusted);
END $path$;
