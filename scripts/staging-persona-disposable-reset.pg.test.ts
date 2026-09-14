import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresMigrationsInTransaction } from "../packages/platform-cf/src/postgres-migrations.ts";
import { compileApprovedStagingPrivileges } from "./staging-persona-approved-privileges.ts";
import {
  type DisposableResetAdmission,
  reconstructDisposableStaging,
} from "./staging-persona-disposable-reset.ts";
import {
  readResetGrantCatalog,
  restoreReviewedResetGrants,
} from "./staging-persona-grant-catalog.ts";
import { migrationTransaction } from "./staging-persona-reconstruct.ts";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan.ts";
import { loadStagingUpgradeArtifacts } from "./staging-persona-upgrade-plan.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES18_DISPOSABLE_RESET_TEST_URL;
const suite = connectionString ? describe : describe.skip;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

type Fixture = Readonly<{
  owner: Client;
  databaseRoot: Client;
  markerDirectory: string;
  artifacts: ReturnType<typeof loadStagingResetArtifacts>;
  admission: DisposableResetAdmission;
}>;

async function withFixture(use: (fixture: Fixture) => Promise<void>) {
  if (!connectionString) throw new Error("PostgreSQL 18 test URL required");
  const rootUrl = new URL(connectionString);
  if (rootUrl.hostname !== "127.0.0.1" || rootUrl.pathname !== "/postgres")
    throw new Error("loopback fixture required");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const database = `disposable_reset_${suffix}`;
  const ownerRole = `reset_owner_${suffix}`;
  const runtimeRole = `reset_runtime_${suffix}`;
  const password = `fixture_${suffix}`;
  const markerDirectory = await mkdtemp(join(tmpdir(), "disposable-reset-marker-"));
  const root = new Client({ connectionString: rootUrl.toString() });
  const ownerUrl = new URL(rootUrl);
  ownerUrl.pathname = `/${database}`;
  ownerUrl.username = ownerRole;
  ownerUrl.password = password;
  ownerUrl.searchParams.set("options", "-c search_path=api_next,pg_catalog");
  const owner = new Client({ connectionString: ownerUrl.toString() });
  await root.connect();
  try {
    await root.query(`CREATE ROLE "${ownerRole}" LOGIN PASSWORD '${password}'`);
    await root.query(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
    await root.query(`CREATE DATABASE "${database}"`);
    const databaseRootUrl = new URL(rootUrl);
    databaseRootUrl.pathname = `/${database}`;
    const databaseRoot = new Client({ connectionString: databaseRootUrl.toString() });
    await databaseRoot.connect();
    try {
      await databaseRoot.query(`CREATE SCHEMA api_next AUTHORIZATION "${ownerRole}"`);
      await owner.connect();
      const artifacts = loadStagingResetArtifacts(repositoryRoot);
      const plan = validateStagingResetArtifacts(artifacts);
      await owner.query("BEGIN");
      await owner.query("SET LOCAL search_path=api_next,pg_catalog");
      await Effect.runPromise(
        applyPostgresMigrationsInTransaction(
          migrationTransaction(owner),
          plan.migrations.slice(0, 109),
        ),
      );
      await owner.query("COMMIT");
      await owner.query("CREATE TABLE api_next.unreviewed_drift (value text)");
      // Live staging carries the reviewed runtime grants as explicit default
      // ACLs on the schema rather than per-object grants. Reproduce that shape
      // so the reset must survive the drop that removes its materialization.
      await owner.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA api_next GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${runtimeRole}"`,
      );
      await owner.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA api_next GRANT SELECT, UPDATE, USAGE ON SEQUENCES TO "${runtimeRole}"`,
      );
      const schemaOid = (await owner.query("SELECT 'api_next'::regnamespace::oid AS oid")).rows[0]
        .oid as number;
      const grants = await readResetGrantCatalog(owner);
      const approved = await compileApprovedStagingPrivileges(owner, runtimeRole, repositoryRoot);
      const admission: DisposableResetAdmission = {
        markerDirectory,
        recoveryDigest: "1".repeat(64),
        targetAndFenceDigest: "2".repeat(64),
        validUntilMs: Date.now() + 10 * 60_000,
        database,
        role: ownerRole,
        runtimeRole,
        schemaOid,
        defaultsDigest: grants.defaults_sha256,
        baselineDigest: "2e295e58b965fd73e73167c1b6628efe28115fd01386d3fd155b104ba0d432fd",
        reviewedGrants: approved.reviewed,
        grantPolicy: approved.policy,
        replayBudget: { statementTimeoutMs: 120_000 },
        assertFenceAndRecovery: async () => {},
        assertBaselineReference: async () => {},
        assertFreshFence: async () => {},
        async withDatabaseCreate({ execute }) {
          await databaseRoot.query(`GRANT CREATE ON DATABASE "${database}" TO "${ownerRole}"`);
          try {
            return await execute();
          } finally {
            await databaseRoot.query(`REVOKE CREATE ON DATABASE "${database}" FROM "${ownerRole}"`);
          }
        },
      };
      await use({ owner, databaseRoot, markerDirectory, artifacts, admission });
    } finally {
      await owner.end().catch(() => undefined);
      await databaseRoot.end();
    }
  } finally {
    await root.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await root.query(`DROP ROLE IF EXISTS "${runtimeRole}"`).catch(() => undefined);
    await root.query(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(() => undefined);
    await root.end();
    await rm(markerDirectory, { recursive: true, force: true });
  }
}

suite("disposable staging schema reset", () => {
  test("replaces drifted 0109 with exact empty 0119 and retires database CREATE", async () => {
    await withFixture(async ({ owner, databaseRoot, artifacts, admission }) => {
      const result = await reconstructDisposableStaging(owner, artifacts, admission);
      expect(result.batches).toBe(2);
      expect(result.evidence.ledgerCount).toBe(119);
      expect(
        (
          await databaseRoot.query(
            "SELECT has_database_privilege($1,current_database(),'CREATE') AS allowed",
            [admission.role],
          )
        ).rows[0].allowed,
      ).toBeFalse();
      expect(
        (await owner.query("SELECT count(*)::int AS count FROM api_next.schema_migrations")).rows[0]
          .count,
      ).toBe(119);
      expect(
        (await owner.query("SELECT to_regclass('api_next.unreviewed_drift') AS value")).rows[0]
          .value,
      ).toBeNull();
      // The reset must not restore runtime access: the held database fence
      // declares `database: restored` only at the release's database surface,
      // which runs after the upgrade.
      const denied = await readResetGrantCatalog(owner);
      expect(
        denied.grants.some(
          (grant) =>
            grant.grantee === admission.runtimeRole &&
            ["table", "sequence", "schema"].includes(grant.objectKind),
        ),
      ).toBeFalse();
      await result.completeAfterPairedRelease(async () => {});
      // Default ACLs survived the schema replacement, so objects created by
      // the upgrade carry the runtime grants without per-object restoration.
      await owner.query("CREATE TABLE api_next.default_acl_probe (value int)");
      expect(
        (
          await owner.query(
            "SELECT has_table_privilege($1,'api_next.default_acl_probe','SELECT') AS ok",
            [admission.runtimeRole],
          )
        ).rows[0].ok,
      ).toBeTrue();
      await owner.query("DROP TABLE api_next.default_acl_probe");
      const upgrade = loadStagingUpgradeArtifacts(repositoryRoot);
      await owner.query("BEGIN");
      await owner.query("SET LOCAL search_path=api_next,pg_catalog");
      await Effect.runPromise(
        applyPostgresMigrationsInTransaction(migrationTransaction(owner), upgrade.migrations),
      );
      await owner.query("COMMIT");
      const finalLedger = (
        await owner.query("SELECT version FROM api_next.schema_migrations ORDER BY version")
      ).rows;
      expect(finalLedger).toHaveLength(176);
      expect(finalLedger.at(-1)?.version).toBe("0179_data_registration_confirmed_recovery.sql");
      // The release's database surface is the component that restores the
      // reviewed grants after the upgrade; prove that composition here.
      await restoreReviewedResetGrants(
        owner,
        admission.reviewedGrants,
        admission.reviewedGrants,
        admission.grantPolicy,
      );
      const restored = await readResetGrantCatalog(owner);
      const restoredKeys = new Set(restored.grants.map((grant) => JSON.stringify(grant)));
      expect(
        admission.reviewedGrants.every((grant) => restoredKeys.has(JSON.stringify(grant))),
      ).toBeTrue();
    });
  }, 120_000);

  test("refuses an outside dependency before creating the reset marker", async () => {
    await withFixture(async ({ owner, databaseRoot, markerDirectory, artifacts, admission }) => {
      await databaseRoot.query(
        "CREATE VIEW public.reset_outside_probe AS SELECT user_id FROM api_next.users",
      );
      await expect(reconstructDisposableStaging(owner, artifacts, admission)).rejects.toThrow(
        "reset_dependency_closure_unproven",
      );
      expect(await readdir(markerDirectory)).toEqual([]);
      expect(
        (await owner.query("SELECT to_regclass('api_next.unreviewed_drift') AS value")).rows[0]
          .value,
      ).not.toBeNull();
    });
  }, 120_000);

  test("retains the marker and refuses retry after a replay failure", async () => {
    await withFixture(async ({ owner, markerDirectory, artifacts, admission }) => {
      const failing = {
        query: async (text: string, values?: readonly unknown[]) => {
          if (text.includes("Community-persona binding authority"))
            throw new Error("fixture replay failure");
          return owner.query(text, values as never);
        },
      };
      await expect(
        reconstructDisposableStaging(failing as never, artifacts, admission),
      ).rejects.toThrow();
      const markerFiles = await readdir(markerDirectory);
      expect(markerFiles).toHaveLength(1);
      const marker = JSON.parse(
        await readFile(join(markerDirectory, markerFiles[0] as string), "utf8"),
      ) as { phase: string; completedBatches: number };
      expect(marker.phase).toBe("failed");
      expect(marker.completedBatches).toBe(1);
      expect(
        (await owner.query("SELECT to_regclass('api_next.schema_migrations') AS value")).rows[0]
          .value,
      ).toBeNull();
      await expect(reconstructDisposableStaging(owner, artifacts, admission)).rejects.toThrow();
    });
  }, 120_000);
});
