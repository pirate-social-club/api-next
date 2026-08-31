import { describe, expect, test } from "bun:test";
import { assertPostgresBaselineSeedInventory } from "./generate-postgres-baseline.ts";
import {
  normalizePostgresBaselineDump,
  normalizePostgresBaselineSeedDump,
} from "./postgres-baseline-normalization.ts";

describe("PostgreSQL baseline normalization", () => {
  test("preserves function search-path configuration without retaining the source schema", () => {
    const normalized = normalizePostgresBaselineDump(`
SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE FUNCTION public.resolve_example() RETURNS integer
    LANGUAGE sql
    SET search_path TO 'generated_schema', 'pg_temp'
    AS $function$
  SELECT 1
$function$;
`);

    expect(normalized).toContain("CREATE FUNCTION resolve_example() RETURNS integer");
    expect(normalized).toContain("SET search_path FROM CURRENT");
    expect(normalized).not.toContain("generated_schema");
    expect(normalized).not.toContain("statement_timeout");
    expect(normalized).toStartWith(
      "-- GENERATED FILE. DO NOT EDIT. Regenerate with bun run db:generate:baseline.\n" +
        "-- Source of truth: db/postgres/migrations/*.sql\n\n" +
        "SELECT pg_catalog.set_config(\n" +
        "  'search_path',\n" +
        "  pg_catalog.format('%I, pg_temp', pg_catalog.current_schema()),\n" +
        "  false\n" +
        ");\n\n" +
        "SET check_function_bodies = false;",
    );
    expect(normalized).toEndWith("SET check_function_bodies = true;\n");
  });

  test("normalizes equals-form function configuration but drops a session search path", () => {
    const normalized = normalizePostgresBaselineDump(`
SET search_path TO session_schema;
CREATE FUNCTION public.resolve_equals() RETURNS integer
    LANGUAGE sql
    SET search_path = 'generated_schema', 'pg_temp'
    AS $$ SELECT 1 $$;
SET search_path TO leaked_session_schema;
`);

    expect(normalized).toContain("SET search_path FROM CURRENT");
    expect(normalized).not.toContain("session_schema");
    expect(normalized).not.toContain("generated_schema");
    expect(normalized).not.toContain("leaked_session_schema");
  });

  test("makes migration-created seed timestamps deterministic", () => {
    expect(
      normalizePostgresBaselineSeedDump(
        "INSERT INTO example VALUES ('2026-08-31 17:07:43.49507+00', 'stable');",
      ),
    ).toBe("INSERT INTO example VALUES ('2000-01-01 00:00:00+00', 'stable');");
    expect(
      normalizePostgresBaselineSeedDump(
        "INSERT INTO example VALUES ('2026-08-31 21:07:43.49507+04', '2026-08-31 17:07:43');",
      ),
    ).toBe("INSERT INTO example VALUES ('2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00');");
  });

  test("fails closed when migration-owned seed tables drift from the manifest", () => {
    expect(() =>
      assertPostgresBaselineSeedInventory(["activity_registry", "unexpected_seed_table"]),
    ).toThrow(/missing=.*handle_account_directory_bindings.*unexpected=.*unexpected_seed_table/u);
  });
});
