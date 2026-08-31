import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import {
  normalizePostgresBaselineDump,
  normalizePostgresBaselineSeedDump,
} from "./postgres-baseline-normalization.ts";
import { runPostgresMigrations } from "./postgres-migrations.ts";

const root = new URL("../", import.meta.url);
const defaultOutput = new URL("db/postgres/schema.sql", root);
const postgresImage = process.env.CONTROL_PLANE_POSTGRES_IMAGE?.trim() || "postgres:17";
const localPassword = "postgres";
const migrationsDirectory = new URL("../db/postgres/migrations/", import.meta.url);
const baselineSeedTables = [
  "activity_registry",
  "handle_account_directory_bindings",
  "handle_issuance_driver_revisions",
  "handle_pricing_revisions",
  "handle_qualification_policy_revisions",
  "handle_reserved_label_revisions",
  "moderation_platform_floor_category_decisions",
  "moderation_platform_floor_current",
  "moderation_platform_floor_revisions",
  "platform_pirate_label_policy_revisions",
  "qualification_policy_versions",
  "text_moderation_policy_current",
  "text_moderation_policy_revisions",
] as const;

export function assertPostgresBaselineSeedInventory(actualTables: readonly string[]): void {
  const expected = [...baselineSeedTables].sort();
  const actual = [...new Set(actualTables)].sort();
  const missing = expected.filter((table) => !actual.includes(table));
  const unexpected = actual.filter(
    (table) => !expected.includes(table as (typeof expected)[number]),
  );
  if (missing.length === 0 && unexpected.length === 0) return;
  throw new Error(
    `Postgres baseline seed inventory drifted: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
  );
}

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function commandEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...extra,
  };
}

async function runCommand(
  command: readonly string[],
  options: { readonly env?: Record<string, string> } = {},
): Promise<CommandResult> {
  const child = Bun.spawn([...command], {
    ...(options.env === undefined ? {} : { env: commandEnvironment(options.env) }),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function checkedCommand(
  command: readonly string[],
  label: string,
  options: { readonly env?: Record<string, string> } = {},
): Promise<string> {
  const result = await runCommand(command, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.stdout;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function migrationHistoryFingerprint(): Promise<string> {
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  const checksums = await readFile(new URL("checksums.json", migrationsDirectory));
  return createHash("sha256")
    .update(filenames.join("\n"))
    .update("\0")
    .update(checksums)
    .digest("hex");
}

async function removeSocketDirectory(socketDirectory: string): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : uid;
  await runCommand([
    "docker",
    "run",
    "--rm",
    "--cpus=1",
    "--memory=512m",
    "--user",
    "0:0",
    "--volume",
    `${socketDirectory}:/cleanup`,
    postgresImage,
    "chown",
    `${uid}:${gid}`,
    "/cleanup",
  ]);
  await rm(socketDirectory, { force: true, recursive: true });
}

async function startLocalPostgres(): Promise<{
  readonly container: string;
  readonly connectionString: string;
  readonly socketDirectory: string;
}> {
  const container = `api-next-postgres-baseline-${process.pid}-${Date.now()}`;
  const socketDirectory = await mkdtemp(join(tmpdir(), "api-next-postgres-baseline-socket-"));

  try {
    await checkedCommand(
      [
        "docker",
        "run",
        "--detach",
        "--rm",
        "--cpus=1",
        "--memory=512m",
        "--name",
        container,
        "--env",
        `POSTGRES_PASSWORD=${localPassword}`,
        "--env",
        "POSTGRES_DB=postgres",
        "--volume",
        `${socketDirectory}:/var/run/postgresql`,
        postgresImage,
      ],
      "starting Postgres 17 container",
    );

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const logs = await runCommand(["docker", "logs", container]);
      const readiness = await runCommand([
        "docker",
        "exec",
        container,
        "pg_isready",
        "--username=postgres",
        "--dbname=postgres",
      ]);
      if (
        readiness.exitCode === 0 &&
        `${logs.stdout}\n${logs.stderr}`.includes("PostgreSQL init process complete")
      ) {
        return {
          container,
          connectionString: `postgres://postgres:${localPassword}@localhost/postgres?host=${encodeURIComponent(socketDirectory)}`,
          socketDirectory,
        };
      }
      await sleep(500);
    }
    throw new Error("Postgres container did not become ready within 30 seconds");
  } catch (error) {
    await runCommand(["docker", "rm", "--force", container]);
    await removeSocketDirectory(socketDirectory);
    throw error;
  }
}

function connectionForBaselineGeneration(connectionString: string): string {
  const url = new URL(connectionString);
  const existingOptions = url.searchParams.get("options")?.trim();
  url.searchParams.set(
    "options",
    [existingOptions, "-c timezone=UTC", "-c search_path=public"].filter(Boolean).join(" "),
  );
  return url.toString();
}

async function withPostgresClient<A>(
  connectionString: string,
  use: (client: Client) => Promise<A>,
): Promise<A> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("SET TIME ZONE 'UTC'");
    return await use(client);
  } finally {
    await client.end();
  }
}

async function assertEmptyGeneratorDatabase(connectionString: string): Promise<void> {
  const relations = await withPostgresClient(connectionString, (client) =>
    client.query<{ readonly relation_name: string }>(
      `SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname) AS relation_name
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
          AND relation.relkind = ANY (ARRAY['r', 'p', 'v', 'm', 'S', 'f']::"char"[])
        ORDER BY relation_name`,
    ),
  );
  if (relations.rows.length === 0) return;
  const preview = relations.rows
    .slice(0, 10)
    .map((row) => row.relation_name)
    .join(", ");
  const remainder = relations.rows.length - 10;
  throw new Error(
    `Postgres baseline generation requires an empty database; found ${preview}${remainder > 0 ? ` and ${remainder} more` : ""}`,
  );
}

async function nonemptyPublicTables(connectionString: string): Promise<readonly string[]> {
  return withPostgresClient(connectionString, async (client) => {
    const tables = await client.query<{ readonly table_name: string }>(
      `SELECT relation.relname AS table_name
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind = ANY (ARRAY['r', 'p']::"char"[])
          AND relation.relname <> 'schema_migrations'
        ORDER BY table_name`,
    );
    const nonempty: string[] = [];
    for (const { table_name: tableName } of tables.rows) {
      const identifier = `"${tableName.replaceAll('"', '""')}"`;
      const result = await client.query<{ readonly nonempty: boolean }>(
        `SELECT EXISTS (SELECT FROM public.${identifier} LIMIT 1) AS nonempty`,
      );
      if (result.rows[0]?.nonempty === true) nonempty.push(tableName);
    }
    return nonempty;
  });
}

function seedDumpArguments(): readonly string[] {
  return [
    "--data-only",
    "--inserts",
    ...baselineSeedTables.map((table) => `--table=public.${table}`),
  ];
}

type DumpSection = "pre-data" | "seed" | "post-data";

function dumpArguments(section: DumpSection): readonly string[] {
  return section === "seed" ? seedDumpArguments() : ["--schema-only", `--section=${section}`];
}

async function dumpLocalPostgres(container: string, section: DumpSection): Promise<string> {
  return checkedCommand(
    [
      "docker",
      "exec",
      "--env",
      `PGPASSWORD=${localPassword}`,
      "--env",
      "PGOPTIONS=-c timezone=UTC",
      container,
      "pg_dump",
      "--username=postgres",
      "--dbname=postgres",
      ...dumpArguments(section),
      "--no-owner",
      "--no-privileges",
      "--no-comments",
    ],
    "dumping Postgres schema",
  );
}

async function dumpSuppliedPostgres(
  connectionString: string,
  section: DumpSection,
): Promise<string> {
  if (process.env.CONTROL_PLANE_POSTGRES_SERVER_DUMP === "1") {
    return dumpSuppliedPostgresFromServer(connectionString, section);
  }
  return checkedCommand(
    [
      "docker",
      "run",
      "--rm",
      "--cpus=1",
      "--memory=512m",
      "--network",
      "host",
      "--env",
      "PGOPTIONS=-c timezone=UTC",
      postgresImage,
      "pg_dump",
      connectionString,
      ...dumpArguments(section),
      "--no-owner",
      "--no-privileges",
      "--no-comments",
    ],
    "dumping supplied Postgres schema",
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function dumpSuppliedPostgresFromServer(
  connectionString: string,
  section: DumpSection,
): Promise<string> {
  return withPostgresClient(connectionString, async (client) => {
    const authority = await client.query<{
      readonly current_database: string;
      readonly current_user: string;
    }>("SELECT current_database(), current_user");
    const current = authority.rows[0];
    if (
      current === undefined ||
      current.current_user !== "postgres" ||
      current.current_database !== "postgres"
    ) {
      throw new Error(
        "server-side Postgres baseline dump requires the dedicated postgres test database and superuser",
      );
    }

    const outputPath = `/tmp/api-next-postgres-baseline-${process.pid}-${Date.now()}-${section}.sql`;
    const command = [
      "PGOPTIONS=-c\\ timezone=UTC",
      "pg_dump",
      `--username=${shellQuote(current.current_user)}`,
      `--dbname=${shellQuote(current.current_database)}`,
      ...dumpArguments(section).map((argument) => shellQuote(argument)),
      "--no-owner",
      "--no-privileges",
      "--no-comments",
      ">",
      shellQuote(outputPath),
    ].join(" ");
    const cleanup = `rm -f ${shellQuote(outputPath)}`;
    try {
      await client.query(`COPY (SELECT '') TO PROGRAM $baseline_dump$${command}$baseline_dump$`);
      const result = await client.query<{ readonly dump: string }>(
        "SELECT pg_catalog.pg_read_file($1) AS dump",
        [outputPath],
      );
      const dump = result.rows[0]?.dump;
      if (dump === undefined)
        throw new Error("server-side Postgres baseline dump returned no data");
      return dump;
    } finally {
      await client.query(
        `COPY (SELECT '') TO PROGRAM $baseline_cleanup$${cleanup}$baseline_cleanup$`,
      );
    }
  });
}

export async function generatePostgresBaseline(
  outputPath: string | URL = defaultOutput,
): Promise<void> {
  const suppliedConnectionString = process.env.CONTROL_PLANE_POSTGRES_GENERATOR_URL?.trim();
  const migrationFingerprintBefore = await migrationHistoryFingerprint();
  let container: string | undefined;
  let socketDirectory: string | undefined;
  let connectionString = suppliedConnectionString;

  try {
    if (connectionString === undefined) {
      const local = await startLocalPostgres();
      container = local.container;
      socketDirectory = local.socketDirectory;
      connectionString = local.connectionString;
    }

    connectionString = connectionForBaselineGeneration(connectionString);
    await assertEmptyGeneratorDatabase(connectionString);
    await runPostgresMigrations({ connectionString });
    assertPostgresBaselineSeedInventory(await nonemptyPublicTables(connectionString));
    const preDataDump =
      container === undefined
        ? await dumpSuppliedPostgres(connectionString, "pre-data")
        : await dumpLocalPostgres(container, "pre-data");
    const seedDump =
      container === undefined
        ? await dumpSuppliedPostgres(connectionString, "seed")
        : await dumpLocalPostgres(container, "seed");
    const postDataDump =
      container === undefined
        ? await dumpSuppliedPostgres(connectionString, "post-data")
        : await dumpLocalPostgres(container, "post-data");
    const migrationFingerprintAfter = await migrationHistoryFingerprint();
    if (migrationFingerprintBefore !== migrationFingerprintAfter) {
      throw new Error(
        "Postgres migration history changed during baseline generation; no baseline was written. Rebase and regenerate.",
      );
    }
    await writeFile(
      outputPath,
      normalizePostgresBaselineDump(
        `${preDataDump}\n${normalizePostgresBaselineSeedDump(seedDump)}\n${postDataDump}`,
      ),
    );
  } finally {
    if (container !== undefined) {
      await runCommand(["docker", "rm", "--force", container]);
    }
    if (socketDirectory !== undefined) {
      await removeSocketDirectory(socketDirectory);
    }
  }
}

async function outputPathFromArgs(args: readonly string[]): Promise<string | URL> {
  if (args.length === 0) return defaultOutput;
  if (args.length === 2 && args[0] === "--output" && args[1] !== undefined) {
    return args[1];
  }
  throw new Error("Usage: bun scripts/generate-postgres-baseline.ts [--output path]");
}

if (import.meta.main) {
  try {
    const output = await outputPathFromArgs(Bun.argv.slice(2));
    await generatePostgresBaseline(output);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "Postgres baseline generation failed");
    process.exitCode = 1;
  }
}
