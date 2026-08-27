-- Align the author-inclusive royalty-allocation guard with persona authorship.
-- The accepted function is intentionally patched in place so every unrelated
-- snapshot invariant remains byte-for-byte owned by its original migration.

DO $migration$
DECLARE
  function_definition TEXT;
  patched_definition TEXT;
  stale_predicate CONSTANT TEXT := 'value->>''recipientId'' = NEW.actor_user_id';
  persona_predicate CONSTANT TEXT := 'value->>''recipientId'' = NEW.author_persona_id';
  stale_predicate_bytes INTEGER;
BEGIN
  SELECT pg_get_functiondef(procedure.oid)
    INTO function_definition
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = current_schema()
     AND procedure.proname = 'validate_media_snapshot_insert'
     AND pg_get_function_identity_arguments(procedure.oid) = '';

  IF function_definition IS NULL THEN
    RAISE EXCEPTION
      'migration 0064 requires validate_media_snapshot_insert()';
  END IF;

  stale_predicate_bytes :=
    length(function_definition) -
    length(replace(function_definition, stale_predicate, ''));
  IF stale_predicate_bytes <> length(stale_predicate) THEN
    RAISE EXCEPTION
      'migration 0064 expected exactly one account-scoped royalty recipient predicate';
  END IF;
  IF position(persona_predicate IN function_definition) <> 0 THEN
    RAISE EXCEPTION
      'migration 0064 found the persona-scoped royalty recipient predicate already installed';
  END IF;

  patched_definition := replace(function_definition, stale_predicate, persona_predicate);
  EXECUTE patched_definition;
END;
$migration$;
