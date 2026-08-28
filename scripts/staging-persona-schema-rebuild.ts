import pg from "pg";
import { loadPostgresMigrations, runPostgresMigrations } from "./postgres-migrations";

const ACTIVE_SCHEMA = "api_next";
const RECOVERY_BRANCH = "recovery-20260828-moderation-e2e";
const EXPECTED_LEDGER_TIP = "0059_community_moderation_authority_policy.sql";
const EXPECTED_REBUILT_TIP = "0068_general_audience_song_covers.sql";
const identifierPattern = /^[a-z_][a-z0-9_]*$/u;

type Grant = Readonly<{ object_name: string; privilege_type: string }>;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function connectionString(): string {
  const url = new URL(required("CONTROL_PLANE_POSTGRES_ADMIN_URL"));
  if (url.searchParams.get("sslrootcert") === "system") url.searchParams.delete("sslrootcert");
  return url.toString();
}

function runtimeConnectionString(): string {
  const url = new URL(required("CONTROL_PLANE_POSTGRES_RUNTIME_URL"));
  if (url.searchParams.get("sslrootcert") === "system") url.searchParams.delete("sslrootcert");
  return url.toString();
}

function quote(value: string): string {
  if (!identifierPattern.test(value)) throw new Error("Unsafe database identifier.");
  return `"${value}"`;
}

async function client(): Promise<pg.Client> {
  const connection = new pg.Client({ connectionString: connectionString() });
  await connection.connect();
  return connection;
}

async function runtimeRole(): Promise<string> {
  const connection = new pg.Client({
    connectionString: runtimeConnectionString(),
  });
  await connection.connect();
  try {
    const result = await connection.query<{ role: string }>("SELECT current_user AS role");
    const role = result.rows[0]?.role;
    if (!role) throw new Error("Could not resolve the staging runtime role.");
    quote(role);
    return role;
  } finally {
    await connection.end();
  }
}

async function preflight(
  connection: pg.Client,
  allowEmpty: boolean,
): Promise<{
  readonly adminRole: string;
  readonly runtimeRole: string;
  readonly tableGrants: readonly Grant[];
  readonly sequenceGrants: readonly Grant[];
}> {
  const target = await connection.query<{
    database: string;
    schema: string;
    admin_role: string;
  }>(
    `SELECT current_database() AS database,
            current_schema() AS schema,
            current_user AS admin_role`,
  );
  const row = target.rows[0];
  const resolvedRuntimeRole = await runtimeRole();
  if (row?.database !== "postgres" || row.schema !== ACTIVE_SCHEMA) {
    throw new Error("Staging database identity or recovery-schema preflight failed.");
  }
  quote(row.admin_role);
  quote(resolvedRuntimeRole);

  const state = await connection.query<{
    ledger_exists: boolean;
    relation_count: string;
  }>(
    `SELECT to_regclass($1) IS NOT NULL AS ledger_exists,
            (SELECT count(*)::text FROM pg_class class
              JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
             WHERE namespace.nspname = $2
               AND class.relkind IN ('v', 'm', 'r', 'p', 'f', 'S')) AS relation_count`,
    [`${ACTIVE_SCHEMA}.schema_migrations`, ACTIVE_SCHEMA],
  );
  const emptyResume =
    allowEmpty && state.rows[0]?.ledger_exists === false && state.rows[0]?.relation_count === "0";
  const ledger = emptyResume
    ? { rows: [] }
    : await connection.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      );
  if (!emptyResume && ledger.rows[0]?.version !== EXPECTED_LEDGER_TIP) {
    throw new Error("Staging migration ledger is not at the reviewed pre-reset tip.");
  }
  const persona = emptyResume
    ? { rows: [{ total: "0", invalid: "0" }] }
    : await connection.query<{ invalid: string; total: string }>(
        `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE 1 <> (
              SELECT count(*) FROM persona_wallet_assignments assignment
               WHERE assignment.persona_id = persona.persona_id
                 AND assignment.chain_account_kind = 'evm'
                 AND assignment.status = 'active'
            ))::text AS invalid
       FROM personas persona WHERE persona.status IN ('active', 'suspended')`,
      );
  if (!emptyResume && (persona.rows[0]?.total !== "9" || persona.rows[0]?.invalid !== "8")) {
    throw new Error("Persona aggregate changed after the authorized preflight.");
  }

  const tableGrants = await connection.query<Grant>(
    `SELECT table_name AS object_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE grantee = $1 AND table_schema = $2
      ORDER BY table_name, privilege_type`,
    [resolvedRuntimeRole, ACTIVE_SCHEMA],
  );
  const sequenceGrants = await connection.query<Grant>(
    `SELECT sequence.relname AS object_name, privilege.privilege_type
       FROM pg_class sequence
       JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
       CROSS JOIN (VALUES ('SELECT'), ('UPDATE'), ('USAGE')) privilege(privilege_type)
      WHERE namespace.nspname = $1 AND sequence.relkind = 'S'
        AND has_sequence_privilege($2, sequence.oid, privilege.privilege_type)
      ORDER BY sequence.relname, privilege.privilege_type`,
    [ACTIVE_SCHEMA, resolvedRuntimeRole],
  );
  return {
    adminRole: row.admin_role,
    runtimeRole: resolvedRuntimeRole,
    tableGrants: tableGrants.rows,
    sequenceGrants: sequenceGrants.rows,
  };
}

async function clearActiveSchema(
  connection: pg.Client,
  roles: { readonly runtimeRole: string },
): Promise<void> {
  const runtime = quote(roles.runtimeRole);
  await connection.query(`REVOKE USAGE ON SCHEMA ${quote(ACTIVE_SCHEMA)} FROM ${runtime}`);
  const relations = await connection.query<{
    relkind: string;
    relname: string;
  }>(
    `SELECT class.relkind, class.relname
       FROM pg_class class JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = $1 AND class.relkind IN ('v', 'm', 'r', 'p', 'f', 'S')
      ORDER BY CASE class.relkind WHEN 'v' THEN 0 WHEN 'm' THEN 1 ELSE 2 END`,
    [ACTIVE_SCHEMA],
  );
  for (const object of relations.rows) {
    const kind =
      object.relkind === "v"
        ? "VIEW"
        : object.relkind === "m"
          ? "MATERIALIZED VIEW"
          : object.relkind === "S"
            ? "SEQUENCE"
            : "TABLE";
    await connection.query(
      `DROP ${kind} IF EXISTS ${quote(ACTIVE_SCHEMA)}.${quote(object.relname)} CASCADE`,
    );
  }
  const routines = await connection.query<{
    identity: string;
    prokind: string;
  }>(
    `SELECT routine.oid::regprocedure::text AS identity, routine.prokind
       FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = $1`,
    [ACTIVE_SCHEMA],
  );
  for (const object of routines.rows) {
    const kind = object.prokind === "p" ? "PROCEDURE" : "FUNCTION";
    await connection.query(`DROP ${kind} IF EXISTS ${object.identity} CASCADE`);
  }
  const types = await connection.query<{ typname: string }>(
    `SELECT type.typname
       FROM pg_type type JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = $1 AND type.typtype IN ('c', 'd', 'e', 'r', 'm')`,
    [ACTIVE_SCHEMA],
  );
  for (const object of types.rows) {
    await connection.query(
      `DROP TYPE IF EXISTS ${quote(ACTIVE_SCHEMA)}.${quote(object.typname)} CASCADE`,
    );
  }
}

async function restoreOverlappingPrivileges(
  connection: pg.Client,
  runtimeRole: string,
  tableGrants: readonly Grant[],
  sequenceGrants: readonly Grant[],
): Promise<void> {
  const runtime = quote(runtimeRole);
  const grouped = new Map<string, string[]>();
  for (const grant of tableGrants) {
    const privileges = grouped.get(grant.object_name) ?? [];
    privileges.push(grant.privilege_type);
    grouped.set(grant.object_name, privileges);
  }
  const existing = await connection.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
    [ACTIVE_SCHEMA],
  );
  const existingNames = new Set(existing.rows.map(({ table_name }) => table_name));
  const existingSequences = await connection.query<{ sequence_name: string }>(
    "SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = $1",
    [ACTIVE_SCHEMA],
  );
  const existingSequenceNames = new Set(
    existingSequences.rows.map(({ sequence_name }) => sequence_name),
  );
  await connection.query("BEGIN");
  try {
    for (const [name, privileges] of grouped) {
      if (!existingNames.has(name)) continue;
      const target = `${quote(ACTIVE_SCHEMA)}.${quote(name)}`;
      await connection.query(`REVOKE ALL ON TABLE ${target} FROM ${runtime}`);
      if (privileges.length > 0) {
        await connection.query(`GRANT ${privileges.join(", ")} ON TABLE ${target} TO ${runtime}`);
      }
    }
    for (const grant of sequenceGrants) {
      if (!existingSequenceNames.has(grant.object_name)) continue;
      const target = `${quote(ACTIVE_SCHEMA)}.${quote(grant.object_name)}`;
      await connection.query(`GRANT ${grant.privilege_type} ON SEQUENCE ${target} TO ${runtime}`);
    }
    await connection.query(`GRANT USAGE ON SCHEMA ${quote(ACTIVE_SCHEMA)} TO ${runtime}`);
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  }
}

async function verify(connection: pg.Client): Promise<void> {
  const result = await connection.query<{
    tip: string;
    accounts: string;
    personas: string;
    invalid: string;
  }>(`SELECT
        (SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1) AS tip,
        (SELECT count(*)::text FROM users) AS accounts,
        (SELECT count(*)::text FROM personas) AS personas,
        (SELECT count(*)::text FROM personas persona
          WHERE persona.status IN ('active', 'suspended') AND 1 <> (
            SELECT count(*) FROM persona_wallet_assignments assignment
             WHERE assignment.persona_id = persona.persona_id
               AND assignment.chain_account_kind = 'evm'
               AND assignment.status = 'active')) AS invalid`);
  const row = result.rows[0];
  if (
    row?.tip !== EXPECTED_REBUILT_TIP ||
    row.accounts !== "0" ||
    row.personas !== "0" ||
    row.invalid !== "0"
  ) {
    throw new Error("Rebuilt schema failed ledger, no-copy, or persona invariant verification.");
  }
}

export async function rebuildStagingPersonaSchema(args: readonly string[]): Promise<void> {
  if (process.env.API_NEXT_ENV !== "staging" || !args.includes("--confirm-staging-reset")) {
    throw new Error("Rebuild requires API_NEXT_ENV=staging and --confirm-staging-reset.");
  }
  const connection = await client();
  try {
    const resumeEmpty = args.includes("--resume-empty-rebuild");
    const captured = await preflight(connection, resumeEmpty);
    if (args.includes("--preflight-only")) {
      console.log(
        JSON.stringify({
          environment: "staging",
          database: "postgres",
          active_schema: ACTIVE_SCHEMA,
          reviewed_ledger_tip: EXPECTED_LEDGER_TIP,
          recovery_branch: RECOVERY_BRANCH,
          resume_empty_rebuild: resumeEmpty,
          runtime_role_resolved: true,
        }),
      );
      return;
    }
    if (!resumeEmpty) await clearActiveSchema(connection, captured);
    try {
      const migrations = await loadPostgresMigrations();
      for (const [index, expected] of migrations.entries()) {
        const migration = await runPostgresMigrations({
          connectionString: connectionString(),
          migrations: migrations.slice(0, index + 1),
        });
        if (migration.dryRun || migration.result.currentVersion !== expected.version) {
          throw new Error(`Migration runner did not reach ${expected.version}.`);
        }
      }
      if (migrations.at(-1)?.version !== EXPECTED_REBUILT_TIP) {
        throw new Error("Repository migration set does not end at the accepted tip.");
      }
    } catch (error) {
      await connection.query(
        `REVOKE USAGE ON SCHEMA ${quote(ACTIVE_SCHEMA)} FROM ${quote(captured.runtimeRole)}`,
      );
      throw error;
    }
    await restoreOverlappingPrivileges(
      connection,
      captured.runtimeRole,
      captured.tableGrants,
      captured.sequenceGrants,
    );
    await verify(connection);
    console.log(
      JSON.stringify({
        environment: "staging",
        recovery_branch: RECOVERY_BRANCH,
        migration_tip: EXPECTED_REBUILT_TIP,
        copied_identity_rows: 0,
        persona_invariant_violations: 0,
      }),
    );
  } finally {
    await connection.end().catch(() => undefined);
  }
}

if (import.meta.main) {
  await rebuildStagingPersonaSchema(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Staging schema rebuild failed.");
    process.exitCode = 1;
  });
}
