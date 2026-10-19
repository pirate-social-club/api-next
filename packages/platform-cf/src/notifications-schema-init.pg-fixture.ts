/** Test-only initialization boundary; no database work runs on import. */
import { expect } from "bun:test";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";

export type NotificationsInboxInitialization = "baseline" | "full_migrations";

type SchemaInspection = {
  creating_role: string;
  selected_schema: string | null;
  search_schemas: string[];
  schema_owner: string;
  relations: string[];
  functions: string[];
  types: string[];
  ledger: string | null;
};

const inspectSql = `SELECT current_user::text AS creating_role,
  current_schema() AS selected_schema, current_schemas(false)::text[] AS search_schemas,
  pg_catalog.pg_get_userbyid(n.nspowner) AS schema_owner,
  ARRAY(SELECT c.relname::text FROM pg_catalog.pg_class c
    WHERE c.relnamespace=n.oid ORDER BY c.relname) AS relations,
  ARRAY(SELECT p.oid::regprocedure::text FROM pg_catalog.pg_proc p
    WHERE p.pronamespace=n.oid ORDER BY p.oid::regprocedure::text) AS functions,
  ARRAY(SELECT t.typname::text FROM pg_catalog.pg_type t
    WHERE t.typnamespace=n.oid ORDER BY t.typname) AS types,
  pg_catalog.to_regclass(pg_catalog.format('%I.schema_migrations',$1::text))::text AS ledger
  FROM pg_catalog.pg_namespace n WHERE n.nspname=$1::text`;

type SchemaInspectionClient = {
  connect(): Promise<void>;
  query(sql: string, values: string[]): Promise<{ rows: SchemaInspection[] }>;
  end(): Promise<void>;
};

async function inspectSchema(admin: Pick<SchemaInspectionClient, "query">, schema: string) {
  const result = await admin.query(inspectSql, [schema]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row) throw new Error("Dedicated schema is missing");
  return row;
}

function requireEmptySchema(state: SchemaInspection, schema: string, creator?: string) {
  expect(state.selected_schema).toBe(schema);
  expect(state.search_schemas).toEqual([schema]);
  expect(state.schema_owner).toBe(state.creating_role);
  if (creator !== undefined) expect(state.creating_role).toBe(creator);
  // An absent/empty ledger alone cannot establish an empty application schema.
  expect(state.relations).toEqual([]);
  expect(state.functions).toEqual([]);
  expect(state.types).toEqual([]);
  expect(state.ledger).toBeNull();
}

export async function inspectScopedConnection(
  connectionString: string,
  schema: string,
  client: SchemaInspectionClient = new Client({ connectionString }),
) {
  let outcome: { kind: "inspected"; value: SchemaInspection } | { kind: "failed"; error: unknown } =
    { kind: "failed", error: undefined };
  let closeFailed = false;
  let closeFailure: unknown;
  try {
    await client.connect();
    outcome = { kind: "inspected", value: await inspectSchema(client, schema) };
  } catch (error) {
    outcome = { kind: "failed", error };
  } finally {
    try {
      await client.end();
    } catch (error) {
      closeFailed = true;
      closeFailure = error;
    }
  }
  if (outcome.kind === "failed") {
    if (closeFailed)
      throw new AggregateError([outcome.error, closeFailure], "Scoped inspection/close failed", {
        cause: outcome.error,
      });
    throw outcome.error;
  }
  if (closeFailed) throw closeFailure;
  return outcome.value;
}

const maintainedInitialization = {
  baseline: applyPostgresTestBaselineConnection,
  load: loadPostgresMigrations,
  migrate: runPostgresMigrations,
  inspectScoped: inspectScopedConnection,
};

/** Injected operations permit socket-free protocol tests. Native ACL proof uses
 * the defaults below: checksum loader, complete runner, and real connections. */
export async function initializeNotificationsInboxSchema(
  input: {
    readonly mode: NotificationsInboxInitialization;
    readonly admin: Pick<Client, "query">;
    readonly schema: string;
    readonly connectionString: string;
    readonly beforeApplicationDdl: () => Promise<void>;
  },
  operations: typeof maintainedInitialization = maintainedInitialization,
) {
  if (input.mode === "baseline") {
    await input.beforeApplicationDdl();
    await operations.baseline({ connectionString: input.connectionString });
    return;
  }
  if (
    !/^api_next_notifications_[0-9a-f]{32}$/u.test(input.schema) ||
    new URL(input.connectionString).searchParams.get("options") !== `-c search_path=${input.schema}`
  )
    throw new Error("Full ACL migrations require the dedicated schema-scoped connection");
  const migrations = await operations.load();
  if (
    migrations.length !== 278 ||
    migrations.some(
      (migration, index) => !migration.version.startsWith(`${String(index + 1).padStart(4, "0")}_`),
    )
  )
    throw new Error("Full ACL fixture requires the complete contiguous 0001..0278 plan");
  const lastMigration = migrations.at(-1);
  if (!lastMigration) throw new Error("Full ACL fixture requires its final migration");
  await input.admin.query(`SET search_path TO "${input.schema}"`);
  const initial = await inspectSchema(input.admin, input.schema);
  requireEmptySchema(initial, input.schema);
  // Roles/membership/hostile forward defaults are installed by the existing
  // callback using this creating role, before any application DDL.
  await input.beforeApplicationDdl();
  requireEmptySchema(
    await inspectSchema(input.admin, input.schema),
    input.schema,
    initial.creating_role,
  );
  requireEmptySchema(
    await operations.inspectScoped(input.connectionString, input.schema),
    input.schema,
    initial.creating_role,
  );
  const result = await operations.migrate({
    connectionString: input.connectionString,
    migrations,
    expectedLedger: [],
  });
  expect(result.dryRun).toBe(false);
  if (result.dryRun) throw new Error("ACL fixture migration execution was only a dry run");
  expect(result.result).toEqual({
    applied: migrations.map(({ version }) => version),
    currentVersion: lastMigration.version,
  });
  const ledger = await input.admin.query(
    `SELECT version,checksum FROM "${input.schema}".schema_migrations ORDER BY version`,
  );
  expect(ledger.rows).toEqual(migrations.map(({ version, checksum }) => ({ version, checksum })));
  const names = [
    "schema_migrations",
    "video_alias_audit_items_v1",
    "video_alias_audit_runs_v1",
    "video_notification_cutovers_v1",
  ];
  const owners = await input.admin.query(
    `SELECT c.relname AS relation,pg_catalog.pg_get_userbyid(c.relowner) AS owner
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname`,
    [input.schema, names],
  );
  expect(owners.rows).toEqual(
    names.map((relation) => ({ relation, owner: initial.creating_role })),
  );
}
