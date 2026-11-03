import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadPostgresMigrations, runPostgresMigrations } from "../../postgres-migrations.ts";
import { APP_REPO, PREFIX_LEDGER, sha256 } from "../source-inputs.ts";
import { type fixtureTarget, OWNER } from "./fixture-target.ts";

export type Target = Awaited<ReturnType<typeof fixtureTarget>>;

/** Reuses the accepted source-v5 25-migration bootstrap shape; no suffix migration is passed. */
export async function bootstrap275(target: Target) {
  const { admin, checkpoint } = target;
  checkpoint();
  target.lastQuery = "bootstrap_admin_connect";
  await admin.connect();
  target.lastQuery = "bootstrap_admin_identity";
  const identity = (
    await admin.query(
      "SELECT current_user AS role,current_database() AS database,current_setting('server_version_num') AS version,current_setting('max_locks_per_transaction') AS locks,current_setting('listen_addresses') AS listen,current_setting('cluster_name') AS cluster,inet_server_addr() AS address",
    )
  ).rows[0];
  assert.deepEqual(identity, {
    role: "postgres",
    database: "postgres",
    version: "180006",
    locks: "64",
    listen: "",
    cluster: target.clusterName,
    address: null,
  });
  target.lastQuery = "bootstrap_api_schema_absent";
  assert.deepEqual((await admin.query("SELECT to_regnamespace('api_next')::text AS schema")).rows, [
    { schema: null },
  ]);
  target.lastQuery = "bootstrap_owner_role_absent";
  assert.deepEqual(
    (await admin.query("SELECT rolname FROM pg_catalog.pg_roles WHERE rolname=$1", [OWNER])).rows,
    [],
  );
  // Fixed synthetic role only, matching the accepted ordinary-owner bootstrap flags.
  target.lastQuery = "bootstrap_create_synthetic_owner_and_schema";
  await admin.query(
    `CREATE ROLE "${OWNER}" LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION BYPASSRLS PASSWORD '${target.password}'; CREATE SCHEMA api_next AUTHORIZATION "${OWNER}"`,
  );
  const owner = new pg.Client({
    connectionString: target.ownerUrl,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 7_000,
    query_timeout: 10_000,
  });
  target.lastQuery = "bootstrap_owner_connect";
  await owner.connect();
  try {
    // Verify the exact URL parser/transport before passing that URL to the maintained writer.
    target.lastQuery = "bootstrap_owner_uds_identity";
    const current = (
      await owner.query(
        "SELECT current_user AS role,session_user AS session,inet_server_addr() AS address,current_schemas(false)::text[] AS schemas,current_setting('cluster_name') AS cluster",
      )
    ).rows[0];
    assert.deepEqual(current, {
      role: OWNER,
      session: OWNER,
      address: null,
      schemas: ["api_next", "pg_catalog"],
      cluster: target.clusterName,
    });
    target.lastQuery = "bootstrap_owner_not_superuser";
    assert.equal(
      (await owner.query("SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user"))
        .rows[0].rolsuper,
      false,
    );
    target.lastQuery = "bootstrap_load_333_migrations_verify_275_prefix";
    const all = await loadPostgresMigrations(pathToFileURL(APP_REPO + "/db/postgres/migrations/"));
    assert.equal(all.length, 333);
    const prefix = all.slice(0, 275);
    assert.equal(
      sha256(prefix.map((row) => row.version + ":" + row.checksum).join("\n")),
      PREFIX_LEDGER,
    );
    for (let end = 25; end < 275; end += 25) {
      checkpoint();
      target.lastQuery = "bootstrap_migrations_prefix_" + end;
      await runPostgresMigrations({
        connectionString: target.ownerUrl,
        migrations: prefix.slice(0, end),
      });
    }
    checkpoint();
    target.lastQuery = "bootstrap_migrations_prefix_275";
    await runPostgresMigrations({ connectionString: target.ownerUrl, migrations: prefix });
    target.lastQuery = "bootstrap_verify_exact_275_ledger";
    assert.deepEqual(
      (
        await owner.query(
          "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
        )
      ).rows,
      target.inputs.prefix,
    );
    return owner;
  } catch (error) {
    await owner.end().catch(() => undefined);
    throw error;
  }
}
