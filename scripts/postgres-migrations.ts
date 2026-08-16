import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import {
  applyPostgresMigrations,
  type MigrationApplyResult,
  type PostgresMigration,
} from "../packages/platform-cf/src/postgres-migrations.ts";

type ChecksumsManifest = {
  readonly algorithm: "sha256";
  readonly migrations: Readonly<Record<string, string>>;
};

export type MigrationPlan = {
  readonly version: string;
  readonly checksum: string;
};

export type MigrationRunResult =
  | { readonly dryRun: true; readonly plan: readonly MigrationPlan[] }
  | { readonly dryRun: false; readonly result: MigrationApplyResult };

const migrationDirectory = new URL("../db/postgres/migrations/", import.meta.url);

async function readManifest(directory: URL): Promise<ChecksumsManifest> {
  const parsed: unknown = JSON.parse(await readFile(new URL("checksums.json", directory), "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { algorithm?: unknown }).algorithm !== "sha256" ||
    typeof (parsed as { migrations?: unknown }).migrations !== "object" ||
    (parsed as { migrations?: unknown }).migrations === null
  ) {
    throw new Error("Invalid Postgres migration checksum manifest");
  }
  return parsed as ChecksumsManifest;
}

/** Reads and verifies the exact repository migration set before opening a DB. */
export async function loadPostgresMigrations(
  directory: URL = migrationDirectory,
): Promise<readonly PostgresMigration[]> {
  const manifest = await readManifest(directory);
  const names = (await readdir(fileURLToPath(directory)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const manifestNames = Object.keys(manifest.migrations).sort();
  if (names.length === 0 || names.join("\n") !== manifestNames.join("\n")) {
    throw new Error("Postgres migration files do not match their checksum manifest");
  }

  const migrations: PostgresMigration[] = [];
  for (const version of names) {
    const sql = await readFile(new URL(version, directory), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    if (checksum !== manifest.migrations[version]) {
      throw new Error(`Postgres migration checksum mismatch: ${version}`);
    }
    migrations.push({ version, checksum, sql });
  }
  return migrations;
}

export function migrationPlan(migrations: readonly PostgresMigration[]): readonly MigrationPlan[] {
  return migrations.map(({ version, checksum }) => ({ version, checksum }));
}

export function formatMigrationPlan(migrations: readonly PostgresMigration[]): string {
  const plan = migrationPlan(migrations);
  return [
    "Postgres migration plan",
    ...plan.map(({ version, checksum }) => `- ${version} sha256=${checksum}`),
  ].join("\n");
}

export async function runPostgresMigrations(
  input: {
    readonly connectionString?: string;
    readonly dryRun?: boolean;
    readonly migrations?: readonly PostgresMigration[];
  } = {},
): Promise<MigrationRunResult> {
  const migrations = input.migrations ?? (await loadPostgresMigrations());
  if (input.dryRun === true) {
    return { dryRun: true, plan: migrationPlan(migrations) };
  }
  const connectionString = input.connectionString?.trim();
  if (!connectionString) {
    throw new Error("CONTROL_PLANE_POSTGRES_ADMIN_URL is required for migrations");
  }

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* ControlPlaneDb;
        return yield* applyPostgresMigrations(migrations);
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connectionString))),
    ),
  );
  return { dryRun: false, result };
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    throw new Error(`Unknown migration option: ${unknown[0]}`);
  }
  const migrations = await loadPostgresMigrations();
  if (args.includes("--dry-run")) {
    console.log(formatMigrationPlan(migrations));
    console.log("Dry run: no database connection opened.");
    return;
  }

  const output = await runPostgresMigrations({
    ...(process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL === undefined
      ? {}
      : { connectionString: process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL }),
    migrations,
  });
  if (output.dryRun) return;
  console.log(`Applied migrations: ${output.result.applied.join(", ") || "none"}`);
  console.log(`Current version: ${output.result.currentVersion ?? "none"}`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Postgres migration failed");
    process.exitCode = 1;
  });
}
