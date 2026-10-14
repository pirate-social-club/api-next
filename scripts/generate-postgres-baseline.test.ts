import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPostgresBaselineSeedInventory,
  connectionForBaselineGeneration,
} from "./generate-postgres-baseline.ts";
import {
  normalizePostgresBaselineDump,
  normalizePostgresBaselineResetDump,
  normalizePostgresBaselineSeedDump,
} from "./postgres-baseline-normalization.ts";
import {
  assertPostgresFoundationTableCatalogFresh,
  tableNamesFromFoundationCatalog,
  tableNamesFromPostgresBaseline,
} from "./postgres-foundation-table-catalog.ts";

describe("PostgreSQL baseline fixture lifecycle", () => {
  for (const startupFailure of [true, false]) {
    test(`removes owned anonymous storage after ${startupFailure ? "partial startup" : "database connection"} failure`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "baseline-lifecycle-test-"));
      const statePath = join(directory, "state.json");
      try {
        await writeFile(
          statePath,
          JSON.stringify({ containers: ["unrelated"], volumes: ["unrelated"] }),
        );
        const dockerPath = join(directory, "docker");
        // Model Docker's anonymous-volume lifetime independently of --rm:
        // explicit forced removal requires --volumes, even with AutoRemove.
        await writeFile(
          dockerPath,
          `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const path = process.env.BASELINE_LIFECYCLE_STATE;
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "run" && args.includes("--detach")) {
  const name = args[args.indexOf("--name") + 1];
  state.containers.push(name);
  state.volumes.push(name);
  writeFileSync(path, JSON.stringify(state));
  if (process.env.BASELINE_LIFECYCLE_STARTUP_FAILURE === "1") {
    console.error("injected startup failure after volume allocation");
    process.exit(1);
  }
  console.log(name);
} else if (args[0] === "logs") {
  console.log("PostgreSQL init process complete");
} else if (args[0] === "rm") {
  const name = args.at(-1);
  state.containers = state.containers.filter((item) => item !== name);
  if (args.includes("--volumes") || args.includes("-v")) {
    state.volumes = state.volumes.filter((item) => item !== name);
  }
  writeFileSync(path, JSON.stringify(state));
}
`,
        );
        await chmod(dockerPath, 0o700);
        const environment = { ...process.env };
        delete environment.CONTROL_PLANE_POSTGRES_GENERATOR_URL;
        const child = Bun.spawn([process.execPath, "scripts/generate-postgres-baseline.ts"], {
          cwd: new URL("../", import.meta.url).pathname,
          env: {
            ...environment,
            PATH: `${directory}:${process.env.PATH}`,
            TMPDIR: directory,
            BASELINE_LIFECYCLE_STATE: statePath,
            BASELINE_LIFECYCLE_STARTUP_FAILURE: startupFailure ? "1" : "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, , stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain(startupFailure ? "injected startup failure" : "ENOENT");
        expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
          containers: ["unrelated"],
          volumes: ["unrelated"],
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

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

  test("alters an exact catalog-first overload after creation without changing its ambient namespace", () => {
    const normalized = normalizePostgresBaselineDump(`
CREATE FUNCTION public.private_example(input_value integer DEFAULT 7) RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $private$ SELECT input_value + 1 $private$;
CREATE FUNCTION public.legacy_example() RETURNS integer
    LANGUAGE sql
    SET search_path = 'public', 'pg_temp'
    AS $$ SELECT 2 $$;
`);
    const create = normalized.indexOf("CREATE FUNCTION private_example(");
    const end = normalized.indexOf("$private$;");
    const alter = normalized.indexOf("DO $baseline_function_path$");
    const legacy = normalized.indexOf("CREATE FUNCTION legacy_example()");
    expect(create).toBeGreaterThan(0);
    expect(end).toBeLessThan(alter);
    expect(alter).toBeLessThan(legacy);
    expect(normalized).toContain("p.proname='private_example'");
    expect(normalized).toContain(
      "pg_catalog.pg_get_function_arguments(p.oid)='input_value integer DEFAULT 7'",
    );
    expect(normalized).toContain("INTO STRICT target_function");
    expect(normalized).toContain(
      "ALTER FUNCTION %I.%I(%s) SET search_path TO pg_catalog, %I, pg_temp",
    );
    expect(normalized.match(/SET search_path FROM CURRENT/gu)).toHaveLength(2);
    expect(normalized.match(/SELECT pg_catalog.set_config\(/gu)).toHaveLength(1);
    expect(normalized).not.toContain("pg_catalog.format('pg_catalog, %I");
  });

  test("restores private owner-financial ACLs without widening ordinary function normalization", () => {
    const source = `
CREATE FUNCTION public.require_disabled_owner_financial_inventory_private_v1() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$ BEGIN RETURN; END $$;
CREATE FUNCTION public.ordinary_example() RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$ SELECT 2 $$;
`;
    const normalized = normalizePostgresBaselineDump(source);
    const ordinary = normalized.indexOf("CREATE FUNCTION ordinary_example()");
    const privateOutput = normalized.slice(0, ordinary);
    expect(privateOutput).toContain("REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC");
    expect(privateOutput).toContain("a.grantee<>0 AND a.grantee<>p.proowner");
    expect(privateOutput).toContain("p.oid=target_function.oid");
    expect(privateOutput).toContain("REVOKE ALL ON FUNCTION %I.%I(%s) FROM %I CASCADE");
    expect(normalized.slice(ordinary)).not.toContain("REVOKE");
    expect(normalized).not.toContain("GRANT");
  });

  test("restores exact source privileges after protected metadata and post-data", () => {
    const normalized = normalizePostgresBaselineDump(`
CREATE TABLE public.owner_accounting_native_source_inventory_v1 (
    singleton boolean NOT NULL,
    source_version text NOT NULL,
    manifest jsonb NOT NULL
);
INSERT INTO public.owner_accounting_native_source_inventory_v1 VALUES (true, 'owner_accounting_native_source_v1', '{}');
CREATE TRIGGER original_accounting_source_inventory_immutable BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.owner_accounting_native_source_inventory_v1 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_owner_accounting_source_inventory_mutation_v1();
`);
    const protectedRow = normalized.indexOf(
      "INSERT INTO owner_accounting_native_source_inventory_v1",
    );
    const immutableGuard = normalized.indexOf(
      "CREATE TRIGGER original_accounting_source_inventory_immutable",
    );
    const sourceBinder = normalized.indexOf("DO $baseline_owner_source_privileges$");
    expect(protectedRow).toBeGreaterThan(0);
    expect(immutableGuard).toBeGreaterThan(protectedRow);
    expect(sourceBinder).toBeGreaterThan(immutableGuard);
    expect(normalized.lastIndexOf("SET check_function_bodies = true;")).toBeGreaterThan(
      sourceBinder,
    );
    expect(normalized).toContain(
      "pg_catalog.to_regprocedure(pg_catalog.format('%I.%s',target_schema,expected.signature))",
    );
    expect(normalized).toContain("baseline raw function source differs");
    expect(normalized).toContain("actual_acl IS DISTINCT FROM expected.source_acl");
    expect(normalized).toContain("private baseline relation custody differs");
    expect(normalized).toContain("SELECT %I.require_owner_accounting_ready_private_v1()");
    expect(normalized).not.toContain("GRANT ");
    expect(normalized).not.toContain("ALTER DEFAULT PRIVILEGES");
  });

  test("does not select full-source privileges from a metadata name inside an ordinary body", () => {
    const normalized = normalizePostgresBaselineDump(`
CREATE FUNCTION public.ordinary_example() RETURNS void LANGUAGE plpgsql AS $body$
BEGIN
CREATE TABLE owner_accounting_native_source_inventory_v1 (singleton boolean);
END
$body$;
`);
    expect(normalized).not.toContain("DO $baseline_owner_source_privileges$");
  });

  test("preserves raw function-body blank lines for source attestation", () => {
    const originalBody = "\nBEGIN\n  PERFORM 1;\n\n\n  PERFORM 2;\nEND\n";
    const normalized = normalizePostgresBaselineDump(`
CREATE FUNCTION public.preserved_body() RETURNS void
    LANGUAGE plpgsql
    AS $body$${originalBody}$body$;
`);
    expect(normalized).toContain(`AS $body$${originalBody}$body$;`);
  });

  test("refuses unsupported catalog-first declarations and incomplete bodies", () => {
    expect(() =>
      normalizePostgresBaselineDump(`
CREATE FUNCTION public.unsupported() RETURNS integer
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'public', 'unreviewed_schema', 'pg_temp'
    AS $$ SELECT 1 $$;
`),
    ).toThrow("Unsupported catalog-first portable function declaration");
    expect(() =>
      normalizePostgresBaselineDump(`
CREATE FUNCTION public.incomplete() RETURNS integer
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $body$ SELECT 1
`),
    ).toThrow("Unclosed catalog-first portable function body");
  });

  test("restores the original bounded Guest call-plan BETWEEN and preserves maximum paid calls", () => {
    const range =
      "(((guest_spoken_call_plan ->> 'graded_presentation_cap'::text))::integer >= 0) AND (((guest_spoken_call_plan ->> 'graded_presentation_cap'::text))::integer <= 20)";
    const maximum =
      "((guest_spoken_call_plan ->> 'maximum_paid_calls'::text))::integer = (2 * ((guest_spoken_call_plan ->> 'graded_presentation_cap'::text))::integer)";
    const normalized = normalizePostgresBaselineDump(`CHECK ((${range}) AND (${maximum}));`);
    expect(normalized).toContain("::integer BETWEEN 0 AND 20");
    expect(normalized).toContain(maximum);
    expect(normalized).not.toContain("::integer >= 0");
    expect(normalized).not.toContain("::integer <= 20");
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

  test("preserves opaque source metadata while normalizing schema and ordinary seed dates", () => {
    const metadata = `INSERT INTO public.owner_accounting_native_source_inventory_v1 VALUES (true, 'owner_accounting_native_source_v1', '{"constraints":["((octet_length(upstream_session_ref) >= 1) AND (octet_length(upstream_session_ref) <= 16384))"],"default_expression":"public.example(''2026-08-31 17:07:43.49507+00'')"}');`;
    const ordinary = "INSERT INTO public.example VALUES ('2026-08-31 17:07:43.49507+00');";
    const seeds = normalizePostgresBaselineSeedDump(`${metadata}\n${ordinary}`);
    expect(seeds).toContain(metadata);
    expect(seeds).toContain("INSERT INTO public.example VALUES ('2000-01-01 00:00:00+00');");
    const normalized = normalizePostgresBaselineDump(seeds);
    expect(normalized).toContain(metadata.replace("INSERT INTO public.", "INSERT INTO "));
    expect(normalized).toContain("INSERT INTO example VALUES ('2000-01-01 00:00:00+00');");
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

  test("generates a portable reset with every root table and deterministic seeds", () => {
    const normalized = normalizePostgresBaselineResetDump(
      `SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
INSERT INTO public.seed_table VALUES ('2026-08-31 17:07:43.49507+00');`,
      ["z_table", "seed_table"],
    );

    expect(normalized).toContain('TRUNCATE TABLE\n  "seed_table",\n  "z_table"');
    expect(normalized).toContain("RESTART IDENTITY CASCADE;");
    expect(normalized).toContain("SET LOCAL session_replication_role = replica;");
    expect(normalized).toContain("SET LOCAL session_replication_role = origin;");
    expect(normalized).toContain("INSERT INTO seed_table VALUES ('2000-01-01 00:00:00+00');");
    expect(normalized).not.toContain("public.seed_table");
    expect(normalized).not.toContain("statement_timeout");
  });

  test("retains immutable source metadata outside destructive reset and seed replay", () => {
    const metadata = `INSERT INTO public.owner_accounting_native_source_inventory_v1 VALUES (true, 'owner_accounting_native_source_v1', '{}');`;
    const normalized = normalizePostgresBaselineResetDump(
      `${metadata}\nINSERT INTO public.seed_table VALUES ('original');`,
      ["seed_table", "owner_accounting_native_source_inventory_v1"],
    );
    expect(normalized).toContain('TRUNCATE TABLE\n  "seed_table"');
    expect(normalized).not.toContain("owner_accounting_native_source_inventory_v1");
    expect(normalized).toContain("INSERT INTO seed_table VALUES ('original');");
  });

  test("fails closed when migration-owned seed tables drift from the manifest", () => {
    expect(() =>
      assertPostgresBaselineSeedInventory(["activity_registry", "unexpected_seed_table"]),
    ).toThrow(/missing=.*handle_account_directory_bindings.*unexpected=.*unexpected_seed_table/u);
  });

  test("percent-encodes libpq option spaces in supplied connection URLs", () => {
    const connectionString = connectionForBaselineGeneration(
      "postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable&options=-c%20statement_timeout%3D0",
    );

    expect(connectionString).toContain("sslmode=disable");
    expect(connectionString).toContain(
      "options=-c%20statement_timeout%3D0%20-c%20timezone%3DUTC%20-c%20search_path%3Dpublic",
    );
    expect(connectionString).not.toContain("+");
  });

  test("keeps the explicit foundation table catalog equal to the normalized baseline", () => {
    const baselineSource =
      "CREATE TABLE alpha_table (\n);\n" +
      "CREATE TABLE beta_table (\n);\n" +
      "CREATE VIEW current_items AS\nSELECT 1;\n";
    const foundationTestSource = `
      // POSTGRES_FOUNDATION_TABLE_CATALOG_START
      "alpha_table",
      "beta_table",
      "current_items",
      // POSTGRES_FOUNDATION_TABLE_CATALOG_END
    `;
    expect(tableNamesFromPostgresBaseline(baselineSource)).toEqual([
      "alpha_table",
      "beta_table",
      "current_items",
    ]);
    expect(tableNamesFromFoundationCatalog(foundationTestSource)).toEqual([
      "alpha_table",
      "beta_table",
      "current_items",
    ]);
    expect(() =>
      assertPostgresFoundationTableCatalogFresh({ baselineSource, foundationTestSource }),
    ).not.toThrow();
    expect(() =>
      assertPostgresFoundationTableCatalogFresh({
        baselineSource: `${baselineSource}CREATE TABLE gamma_table (\n);\n`,
        foundationTestSource,
      }),
    ).toThrow("missing=gamma_table");
  });
});
