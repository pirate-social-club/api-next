-- Migrate the route-v1 creation guard from the retired Very OAuth receipt kind
-- to the server-verified web receipt kind. Migration 0031 is immutable; use
-- the installed function definition so this delta stays narrow and preserves
-- every other guard clause exactly.

DO $$
DECLARE
  function_definition TEXT;
  old_evidence_kind CONSTANT TEXT := 'very.oauth.id-token-userinfo.v1';
  new_evidence_kind CONSTANT TEXT := 'very.web.server-verified.v1';
  old_evidence_kind_bytes INTEGER;
BEGIN
  SELECT pg_get_functiondef(procedure.oid)
    INTO function_definition
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = current_schema()
     AND procedure.proname = 'validate_route_v1_committed_community'
     AND pg_get_function_identity_arguments(procedure.oid) = '';

  IF function_definition IS NULL THEN
    RAISE EXCEPTION
      'migration 0038 requires validate_route_v1_committed_community()';
  END IF;

  old_evidence_kind_bytes :=
    length(function_definition) -
    length(replace(function_definition, old_evidence_kind, ''));
  IF old_evidence_kind_bytes <> length(old_evidence_kind) THEN
    RAISE EXCEPTION
      'migration 0038 expected exactly one retired Very evidence-kind predicate';
  END IF;
  IF position(new_evidence_kind IN function_definition) <> 0 THEN
    RAISE EXCEPTION
      'migration 0038 found the new Very evidence-kind predicate already installed';
  END IF;

  EXECUTE replace(function_definition, old_evidence_kind, new_evidence_kind);
END;
$$;
