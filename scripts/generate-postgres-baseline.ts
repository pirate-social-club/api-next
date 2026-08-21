import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPostgresMigrations } from "./postgres-migrations.ts";

const root = new URL("../", import.meta.url);
const defaultOutput = new URL("db/postgres/schema.sql", root);
const postgresImage = process.env.CONTROL_PLANE_POSTGRES_IMAGE?.trim() || "postgres:17";
const localPassword = "postgres";
const migrationsDirectory = new URL("../db/postgres/migrations/", import.meta.url);

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
      const readiness = await runCommand([
        "docker",
        "exec",
        container,
        "pg_isready",
        "--username=postgres",
        "--dbname=postgres",
      ]);
      if (readiness.exitCode === 0) {
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

async function dumpLocalPostgres(container: string): Promise<string> {
  return checkedCommand(
    [
      "docker",
      "exec",
      "--env",
      `PGPASSWORD=${localPassword}`,
      container,
      "pg_dump",
      "--username=postgres",
      "--dbname=postgres",
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--no-comments",
    ],
    "dumping Postgres schema",
  );
}

async function dumpSuppliedPostgres(connectionString: string): Promise<string> {
  return checkedCommand(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "host",
      postgresImage,
      "pg_dump",
      connectionString,
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--no-comments",
    ],
    "dumping supplied Postgres schema",
  );
}

function normalizeDump(dump: string): string {
  const lines = dump.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const normalized: string[] = [];
  let dollarDelimiter: string | undefined;

  for (const line of lines) {
    const topLevel = dollarDelimiter === undefined;
    const trimmed = line.trim();
    if (
      topLevel &&
      (trimmed.startsWith("--") ||
        trimmed.startsWith("\\restrict ") ||
        trimmed.startsWith("\\unrestrict ") ||
        (trimmed.startsWith("SET ") && trimmed !== "SET check_function_bodies = false;") ||
        trimmed.startsWith("SELECT pg_catalog.set_config('search_path'") ||
        /^CREATE SCHEMA public;$/i.test(trimmed) ||
        /^ALTER SCHEMA public OWNER TO /i.test(trimmed) ||
        /^ALTER .* OWNER TO /i.test(trimmed) ||
        /^GRANT /i.test(trimmed) ||
        /^REVOKE /i.test(trimmed))
    ) {
      continue;
    }

    normalized.push(
      line
        .replaceAll(/"public"\.|\bpublic\./g, "")
        .replaceAll(
          /\(\(octet_length\(upstream_session_ref\) >= 1\) AND \(octet_length\(upstream_session_ref\) <= 16384\)\)/g,
          "(octet_length(upstream_session_ref) BETWEEN 1 AND 16384)",
        ),
    );

    const delimiter = line.match(/\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
    if (dollarDelimiter === undefined) {
      dollarDelimiter = delimiter;
    } else if (line.includes(dollarDelimiter)) {
      dollarDelimiter = undefined;
    }
  }

  const body = normalized
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
  return [
    "-- GENERATED FILE. DO NOT EDIT. Regenerate with bun run db:generate:baseline.",
    "-- Source of truth: db/postgres/migrations/*.sql",
    "",
    body,
    "",
  ].join("\n");
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

    await runPostgresMigrations({ connectionString });
    const dump =
      container === undefined
        ? await dumpSuppliedPostgres(connectionString)
        : await dumpLocalPostgres(container);
    const migrationFingerprintAfter = await migrationHistoryFingerprint();
    if (migrationFingerprintBefore !== migrationFingerprintAfter) {
      throw new Error(
        "Postgres migration history changed during baseline generation; no baseline was written. Rebase and regenerate.",
      );
    }
    await writeFile(outputPath, normalizeDump(dump));
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

export { normalizeDump };
