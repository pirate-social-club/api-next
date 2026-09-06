import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { runPostgresMigrations } from "./postgres-migrations";
import {
  readResetGrantCatalog,
  restoreReviewedResetGrants,
  verifyResetForbiddenGrants,
} from "./staging-persona-grant-catalog";
import type { ResetGrant } from "./staging-persona-grant-reconciliation";
import { snapshotOutsideResetCatalog } from "./staging-persona-outside-catalog";
import { reconstructStagingInTransaction } from "./staging-persona-reconstruct";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";
import { assertInplaceSchemaAuthority } from "./staging-persona-schema-authority";
import { readResetSchemaShape } from "./staging-persona-schema-shape";

const raw = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!raw && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("local test URL required");
const suite = raw ? describe : describe.skip;
const artifacts = loadStagingResetArtifacts();
const plan = validateStagingResetArtifacts(artifacts);

async function fixture(use: (admin: Client, url: string, runtime: string) => Promise<void>) {
  if (!raw) throw new Error("local test URL required");
  const source = localRecoveryTestUrl(raw);
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const database = `reconstruct_${suffix}`;
  const operator = `operator_${suffix}`;
  const runtime = `runtime_${suffix}`;
  const root = new Client({ connectionString: source.toString() });
  await root.connect();
  const version = Number((await root.query("SHOW server_version_num")).rows[0].server_version_num);
  expect(version).toBeGreaterThanOrEqual(170000);
  expect(version).toBeLessThan(180000);
  const url = new URL(source);
  url.pathname = `/${database}`;
  url.username = operator;
  url.searchParams.set("options", "-c search_path=api_next,pg_catalog");
  const admin = new Client({ connectionString: url.toString() });
  try {
    for (const role of [operator, runtime]) {
      const statement = (
        await root.query(
          "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql",
          [role, decodeURIComponent(source.password) || crypto.randomUUID()],
        )
      ).rows[0].sql;
      await root.query(statement);
    }
    await root.query(`CREATE DATABASE "${database}" OWNER "${operator}"`);
    await admin.connect();
    await admin.query("CREATE SCHEMA api_next");
    await admin.query("CREATE SCHEMA reset_outside");
    await admin.query("CREATE TABLE reset_outside.sentinel (id int PRIMARY KEY)");
    await admin.query("INSERT INTO reset_outside.sentinel VALUES (7)");
    await use(admin, url.toString(), runtime);
    expect((await admin.query("SELECT id FROM reset_outside.sentinel")).rows).toEqual([{ id: 7 }]);
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.end();
    // Only this fixture's generated database and roles, without FORCE/CASCADE.
    await root.query(`DROP DATABASE IF EXISTS "${database}"`);
    await root.query(`DROP ROLE IF EXISTS "${runtime}"`);
    await root.query(`DROP ROLE IF EXISTS "${operator}"`);
    await root.end();
  }
}

async function referenceShape() {
  let digest = "";
  await fixture(async (admin) => {
    await admin.query(artifacts.baseline);
    await admin.query("SET search_path = pg_catalog");
    digest = (await readResetSchemaShape(admin)).sha256;
  });
  return digest;
}

async function input(admin: Client, runtime: string, baseline: string) {
  await admin.query("SET search_path = pg_catalog");
  const row = (
    await admin.query(`SELECT current_database() AS database,
    session_user AS role,'api_next'::regnamespace::oid AS oid`)
  ).rows[0];
  const reviewed: ResetGrant[] = [
    {
      schema: "api_next",
      objectKind: "table",
      objectIdentity: "api_next.users",
      grantee: runtime,
      privilege: "SELECT",
      grantOption: false,
    },
  ];
  return {
    database: row.database,
    sessionRole: row.role,
    schemaOid: row.oid,
    defaultsSha256: (await readResetGrantCatalog(admin)).defaults_sha256,
    baselineShapeSha256: baseline,
    reviewedGrants: reviewed,
    replayStatementTimeoutMs: 120_000,
    minimumLockTableEntries: 51_200,
  };
}

suite("composed reset transaction on disposable PostgreSQL 17", () => {
  test("in-place authority requires schema CREATE, not database CREATE", async () => {
    await fixture(async (admin, url) => {
      const identity = (
        await admin.query(
          "SELECT current_user AS role,'api_next'::regnamespace::oid AS oid,current_database() AS database",
        )
      ).rows[0];
      const statement = (
        await admin.query(
          "SELECT format('REVOKE CREATE ON DATABASE %I FROM %I',current_database(),current_user) AS statement",
        )
      ).rows[0].statement;
      await admin.query(statement);
      expect(
        (
          await admin.query(
            "SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed",
          )
        ).rows[0].allowed,
      ).toBe(false);
      await assertInplaceSchemaAuthority(admin, identity.role, identity.oid);
      await admin.query(
        `REVOKE CREATE ON SCHEMA api_next FROM "${decodeURIComponent(new URL(url).username)}"`,
      );
      await expect(
        assertInplaceSchemaAuthority(admin, identity.role, identity.oid),
      ).rejects.toThrow("inplace_authority_unproven");
      expect((await admin.query("SELECT id FROM reset_outside.sentinel")).rows).toEqual([
        { id: 7 },
      ]);
    });
  }, 30_000);
  test("approved new routine grant and ledger denial land as the non-superuser operator", async () => {
    await fixture(async (admin, url, runtime) => {
      await admin.query(`GRANT USAGE ON SCHEMA api_next TO "${runtime}"`);
      await admin.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA api_next GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO "${runtime}"`,
      );
      await admin.query("CREATE TABLE api_next.schema_migrations(version text)");
      await admin.query(
        "CREATE FUNCTION api_next.policy_probe() RETURNS int LANGUAGE sql AS 'SELECT 7'",
      );
      await admin.query("REVOKE ALL ON FUNCTION api_next.policy_probe() FROM PUBLIC");
      await admin.query("SET search_path=pg_catalog");
      const before = await readResetGrantCatalog(admin);
      const routine: ResetGrant = {
        schema: "api_next",
        objectKind: "routine",
        objectIdentity: "api_next.policy_probe()",
        grantee: runtime,
        privilege: "EXECUTE",
        grantOption: false,
      };
      const ledger: ResetGrant = {
        ...routine,
        objectKind: "table",
        objectIdentity: "api_next.schema_migrations",
        privilege: "SELECT",
      };
      const forbidden = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"].map((privilege) => ({
        ...ledger,
        privilege,
      }));
      await admin.query("BEGIN");
      const result = await restoreReviewedResetGrants(admin, before.grants, [routine, ledger], {
        explicitNew: [routine],
        forbidden,
      });
      expect(result.added).toBe(1);
      expect(result.revoked).toBe(3);
      expect((await readResetGrantCatalog(admin)).defaults_sha256).toBe(before.defaults_sha256);
      await admin.query("COMMIT");
      const runtimeUrl = new URL(url);
      runtimeUrl.username = runtime;
      const reader = new Client({ connectionString: runtimeUrl.toString() });
      await reader.connect();
      try {
        expect((await reader.query("SELECT api_next.policy_probe() AS value")).rows).toEqual([
          { value: 7 },
        ]);
        expect((await reader.query("SELECT * FROM api_next.schema_migrations")).rows).toEqual([]);
        await expect(
          reader.query("INSERT INTO api_next.schema_migrations VALUES ('forbidden')"),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await reader.end();
      }
      await admin.query("BEGIN");
      await admin.query("GRANT INSERT ON api_next.schema_migrations TO PUBLIC");
      await expect(verifyResetForbiddenGrants(admin, forbidden)).rejects.toThrow(
        "forbidden_privilege_effective",
      );
      await admin.query("ROLLBACK");
      await verifyResetForbiddenGrants(admin, forbidden);
    });
  }, 30_000);
  test("replays the pinned baseline, restores a reviewed grant as operator, then commits only in the caller", async () => {
    const baseline = await referenceShape();
    await fixture(async (admin, url, runtime) => {
      await runPostgresMigrations({
        connectionString: url,
        migrations: plan.migrations.slice(0, 109),
      });
      await admin.query("INSERT INTO api_next.users(user_id) VALUES ('reset-fixture-account')");
      await admin.query(`GRANT USAGE ON SCHEMA api_next TO "${runtime}"`);
      await admin.query(`GRANT SELECT ON api_next.users TO "${runtime}"`);
      const expected = await input(admin, runtime, baseline);
      await admin.query("BEGIN");
      try {
        const result = await reconstructStagingInTransaction(admin, artifacts, expected);
        expect(result.committed).toBe(false);
        expect(result.ledger_count).toBe(119);
        expect(result.grants.reapplied).toBe(1);
        expect(result.identity_counts).toEqual({
          users: 0,
          personas: 0,
          bindings: 0,
          communities: 0,
          memberships: 0,
        });
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      const runtimeUrl = new URL(url);
      runtimeUrl.username = runtime;
      const reader = new Client({ connectionString: runtimeUrl.toString() });
      await reader.connect();
      try {
        expect((await reader.query("SELECT user_id FROM api_next.users")).rows).toEqual([]);
        await expect(
          reader.query("INSERT INTO api_next.users(user_id) VALUES ('denied')"),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await reader.end();
      }
    });
  }, 120_000);

  test("a post-replay verification failure restores populated rows, ACLs and 0109 ledger", async () => {
    await fixture(async (admin, url, runtime) => {
      await runPostgresMigrations({
        connectionString: url,
        migrations: plan.migrations.slice(0, 109),
      });
      await admin.query("INSERT INTO api_next.users(user_id) VALUES ('retained-account')");
      await admin.query(`GRANT SELECT ON api_next.users TO "${runtime}"`);
      const expected = await input(admin, runtime, "0".repeat(64));
      const acl = (await readResetGrantCatalog(admin)).grants;
      await admin.query("BEGIN");
      await expect(reconstructStagingInTransaction(admin, artifacts, expected)).rejects.toThrow(
        "reset_baseline_shape_mismatch",
      );
      await admin.query("ROLLBACK");
      expect((await admin.query("SELECT user_id FROM api_next.users")).rows).toEqual([
        { user_id: "retained-account" },
      ]);
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM api_next.schema_migrations")).rows,
      ).toEqual([{ n: 109 }]);
      expect((await readResetGrantCatalog(admin)).grants).toEqual(acl);
    });
  }, 120_000);

  test("outside digest detects routine and relation ACL changes without reading data", async () => {
    await fixture(async (admin) => {
      const before = await snapshotOutsideResetCatalog(admin);
      await admin.query("BEGIN");
      await admin.query("GRANT SELECT ON reset_outside.sentinel TO PUBLIC");
      expect((await snapshotOutsideResetCatalog(admin)).sha256).not.toBe(before.sha256);
      await admin.query("ROLLBACK");
      expect((await snapshotOutsideResetCatalog(admin)).sha256).toBe(before.sha256);
      await admin.query(
        "CREATE FUNCTION reset_outside.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      );
      expect((await snapshotOutsideResetCatalog(admin)).sha256).not.toBe(before.sha256);
    });
  }, 30_000);

  test("refuses wrong target, unreviewed defaults and a stale ledger before removal", async () => {
    await fixture(async (admin, url, runtime) => {
      await runPostgresMigrations({
        connectionString: url,
        migrations: plan.migrations.slice(0, 109),
      });
      const expected = await input(admin, runtime, "0".repeat(64));
      for (const [changed, error] of [
        [{ ...expected, database: "wrong-target" }, "reset_target_identity_mismatch"],
        [
          { ...expected, minimumLockTableEntries: Number.MAX_SAFE_INTEGER },
          "reset_lock_capacity_below_rehearsal",
        ],
        [{ ...expected, defaultsSha256: "0".repeat(64) }, "reset_default_acl_unreviewed"],
      ] as const) {
        await admin.query("BEGIN");
        await expect(reconstructStagingInTransaction(admin, artifacts, changed)).rejects.toThrow(
          error,
        );
        expect(
          (await admin.query("SELECT count(*)::int AS n FROM api_next.schema_migrations")).rows,
        ).toEqual([{ n: 109 }]);
        await admin.query("ROLLBACK");
      }
      await admin.query("BEGIN");
      await admin.query("DELETE FROM api_next.schema_migrations WHERE version LIKE '0109%'");
      await expect(reconstructStagingInTransaction(admin, artifacts, expected)).rejects.toThrow(
        "Reset source ledger differs",
      );
      expect(
        (await admin.query("SELECT to_regclass('api_next.users') IS NOT NULL AS retained")).rows,
      ).toEqual([{ retained: true }]);
      await admin.query("ROLLBACK");
    });
  }, 60_000);
});
