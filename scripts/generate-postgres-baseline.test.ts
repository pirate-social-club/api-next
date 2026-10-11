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
