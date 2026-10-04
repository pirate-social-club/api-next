import { createHash } from "node:crypto";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  normalizePostgresConnectionString,
  runPostgresMigrations,
} from "../postgres-migrations.ts";

export type IsolatedDatabaseIdentity = {
  readonly branchId: string;
  readonly branchName: string;
  readonly hostname: string;
  readonly usernameSha256: string;
};

export function validateIsolatedDatabaseIdentity(
  connectionString: string,
  identity: IsolatedDatabaseIdentity,
): URL {
  const connection = new URL(connectionString);
  if (
    !["postgres:", "postgresql:"].includes(connection.protocol) ||
    connection.hostname.length === 0 ||
    connection.username.length === 0 ||
    !/^[a-z0-9]{1,32}$/.test(identity.branchId) ||
    !/^rewards-runner-[0-9]{8}$/.test(identity.branchName) ||
    connection.hostname !== identity.hostname ||
    !/^[a-f0-9]{64}$/.test(identity.usernameSha256) ||
    createHash("sha256").update(decodeURIComponent(connection.username)).digest("hex") !==
      identity.usernameSha256
  ) {
    throw new Error("Isolated database identity mismatch");
  }
  return connection;
}

/** The caller first verifies this role belongs to the exact new provider branch. */
export async function bootstrapIsolatedRewardsDatabase(input: {
  readonly connectionString: string;
  readonly identity: IsolatedDatabaseIdentity;
}) {
  const connection = validateIsolatedDatabaseIdentity(input.connectionString, input.identity);
  const migrations = await loadPostgresMigrations();
  const markerSchema = `rewards_bootstrap_${input.identity.branchId}`;
  const archiveSchema = `rewards_inherited_${input.identity.branchName.slice(-8)}`;
  const client = new Client({
    connectionString: normalizePostgresConnectionString(connection.toString()),
    connectionTimeoutMillis: 20_000,
  });
  await client.connect();
  let archivedInheritedSchema = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `pirate.rewards.bootstrap.${input.identity.branchId}`,
    ]);
    const version = await client.query<{ server_version_num: string }>("SHOW server_version_num");
    const major = Math.floor(Number(version.rows[0]?.server_version_num) / 10_000);
    if (major !== 17) throw new Error("The isolated rebuild requires PostgreSQL 17");
    const schemas = await client.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])",
      [["api_next", archiveSchema, markerSchema]],
    );
    if (schemas.rows.some((row) => row.nspname === archiveSchema || row.nspname === markerSchema)) {
      throw new Error(
        "The isolated bootstrap was already attempted; inspect its ledger before recovery",
      );
    }
    archivedInheritedSchema = schemas.rows.some((row) => row.nspname === "api_next");
    if (archivedInheritedSchema) {
      // The archive name is generated above from a validated numeric date.
      await client.query(`ALTER SCHEMA api_next RENAME TO ${archiveSchema}`);
    }
    await client.query(`CREATE SCHEMA ${markerSchema}`);
    await client.query(
      `CREATE TABLE ${markerSchema}.receipt (branch_id text PRIMARY KEY, migration_count integer NOT NULL, finished boolean NOT NULL DEFAULT false)`,
    );
    await client.query(
      `INSERT INTO ${markerSchema}.receipt(branch_id,migration_count) VALUES ($1,$2)`,
      [input.identity.branchId, migrations.length],
    );
    await client.query("CREATE SCHEMA api_next");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  connection.searchParams.set("options", "-c search_path=api_next,pg_catalog");
  const result = await runPostgresMigrations({
    connectionString: connection.toString(),
    migrations,
    expectedLedger: [],
  });
  if (result.dryRun) throw new Error("A dry run cannot satisfy the isolated database rebuild");
  if (result.result.applied.length !== migrations.length) {
    throw new Error("The isolated rebuild did not apply every pinned migration");
  }
  const readback = new Client({
    connectionString: normalizePostgresConnectionString(connection.toString()),
    connectionTimeoutMillis: 20_000,
  });
  await readback.connect();
  try {
    const ledger = await readback.query<{ version: string; checksum: string }>(
      "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
    );
    if (
      JSON.stringify(ledger.rows) !==
      JSON.stringify(migrations.map(({ version, checksum }) => ({ version, checksum })))
    ) {
      throw new Error("The rebuilt database ledger differs from the pinned source");
    }
    await readback.query(`UPDATE ${markerSchema}.receipt SET finished=true WHERE branch_id=$1`, [
      input.identity.branchId,
    ]);
  } finally {
    await readback.end();
  }
  return {
    branchId: input.identity.branchId,
    branchName: input.identity.branchName,
    schema: "api_next",
    bootstrapReceiptSchema: markerSchema,
    archivedInheritedSchema,
    inheritedSchema: archivedInheritedSchema ? archiveSchema : null,
    migrations: migrations.length,
    currentVersion: result.result.currentVersion,
  };
}
