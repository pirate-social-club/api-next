import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  compileApprovedStagingPrivileges,
  verifyStagingRuntimeIdentity,
} from "./staging-persona-approved-privileges";
import {
  readResetGrantCatalog,
  revokeResetCatalogGrant,
  verifyResetForbiddenGrants,
} from "./staging-persona-grant-catalog";
import type { ResetGrant } from "./staging-persona-grant-reconciliation";
import {
  inspectResetPreparation,
  performForbiddenGrantRemoval,
} from "./staging-persona-prepare-reset";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target";
import { verifyResetRuntimeDenied } from "./staging-persona-reset-denied-grants.ts";

const raw = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!raw && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("local test URL required");
const suite = raw ? describe : describe.skip;

const routines = [
  ["append_song_owner_policy_revision_v1", "text,text,text,bigint,text,text,text"],
  ["claim_hns_authority_provision_job_v1", "text,integer"],
  [
    "finalize_hns_authority_provision_job_v1",
    "text,text,bigint,text,text,bytea,text,bytea,text,text",
  ],
  ["claim_hns_root_import_observation_job_v1", "text,integer"],
  ["finalize_hns_root_import_observation_job_v1", "text,text,bigint,text,text,bytea,text,text"],
  ["enqueue_hns_root_import_teardown_job_v1", ""],
  ["observe_song_derivative_video_policy_v1", "text,text,bigint,text,text,bigint,text"],
] as const;

type FixtureRoles = { runtime: string; operator: string; group: string };

async function fixture(use: (admin: Client, roles: FixtureRoles) => Promise<void>) {
  const source = localRecoveryTestUrl(raw ?? "");
  const database = `prepare_${crypto.randomUUID().replaceAll("-", "")}`;
  const roles: FixtureRoles = {
    runtime: `${database}_runtime`,
    operator: `${database}_operator`,
    group: `${database}_group`,
  };
  const root = new Client({ connectionString: source.toString() });
  const scoped = new URL(source);
  scoped.pathname = `/${database}`;
  const admin = new Client({ connectionString: scoped.toString() });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE "${database}"`);
    await root.query(
      `CREATE ROLE "${roles.runtime}"; CREATE ROLE "${roles.operator}"; CREATE ROLE "${roles.group}"`,
    );
    await admin.connect();
    await admin.query("CREATE SCHEMA api_next");
    await admin.query(
      "CREATE TABLE api_next.schema_migrations(version text primary key, checksum text)",
    );
    for (const [name, args] of routines)
      await admin.query(
        `CREATE FUNCTION api_next.${name}(${args}) RETURNS text LANGUAGE sql AS 'SELECT NULL::text'`,
      );
    // The migrated schema revokes PUBLIC EXECUTE on these routines; the fixture
    // keeps that fact so a PUBLIC finding comes from the case under test.
    await admin.query("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA api_next FROM PUBLIC");
    await use(admin, roles);
  } finally {
    await admin.end().catch(() => undefined);
    await root.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await root
      .query(
        `DROP ROLE IF EXISTS "${roles.runtime}"; DROP ROLE IF EXISTS "${roles.operator}"; DROP ROLE IF EXISTS "${roles.group}"`,
      )
      .catch(() => undefined);
    await root.end().catch(() => undefined);
  }
}

const removal = (admin: Client, runtime: string) =>
  performForbiddenGrantRemoval({
    prerequisites: {
      executionAuthorized: true,
      backupLinked: true,
      dataDigestMatches: true,
      operatorVisibility: true,
    },
    inspect: () => inspectResetPreparation(admin, runtime),
    revoke: (grant: ResetGrant) => revokeResetCatalogGrant(admin, grant),
    verifyDenied: () => verifyResetRuntimeDenied(admin, runtime),
  });

suite("preparation removal against PostgreSQL", () => {
  test("runtime identity returns role names as a real array, not a name[] string", async () =>
    fixture(async (admin, roles) => {
      const names = await verifyStagingRuntimeIdentity(admin, roles.runtime);
      expect(Array.isArray(names)).toBe(true);
      expect(names).toContain(roles.runtime);
    }));

  test("the restored runtime writes are detected, revoked and denied, and the operator keeps its grants", async () =>
    fixture(async (admin, roles) => {
      // This is the exact provider state that stopped r13/r14: the reviewed
      // runtime grant set legitimately carries schema USAGE before the reset
      // fence is applied. Preparation must remove it along with table access
      // before the reconstruction gate asks for complete runtime denial.
      await admin.query(`GRANT USAGE ON SCHEMA api_next TO "${roles.runtime}"`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON api_next.schema_migrations TO "${roles.runtime}"`,
      );
      await admin.query(
        `GRANT INSERT, UPDATE, DELETE ON api_next.schema_migrations TO "${roles.operator}"`,
      );
      const before = await inspectResetPreparation(admin, roles.runtime);
      expect(before.ready).toBe(false);
      expect(before.forbiddenPresent).toHaveLength(3);
      expect(new Set(before.forbiddenPresent.map((grant) => grant.privilege))).toEqual(
        new Set(["INSERT", "UPDATE", "DELETE"]),
      );
      const result = await removal(admin, roles.runtime);
      expect(result.revoked).toBe(5);
      const catalog = await readResetGrantCatalog(admin);
      const writesFor = (grantee: string) =>
        catalog.grants.filter(
          (grant) =>
            grant.objectIdentity === "api_next.schema_migrations" &&
            grant.grantee === grantee &&
            ["INSERT", "UPDATE", "DELETE"].includes(grant.privilege),
        );
      expect(writesFor(roles.runtime)).toHaveLength(0);
      expect(writesFor(roles.operator)).toHaveLength(3);
      expect(
        (
          await admin.query(
            "SELECT has_table_privilege($1,'api_next.schema_migrations','SELECT') AS allowed",
            [roles.runtime],
          )
        ).rows[0].allowed,
      ).toBe(false);
      expect(
        (
          await admin.query("SELECT has_schema_privilege($1,'api_next','USAGE') AS allowed", [
            roles.runtime,
          ])
        ).rows[0].allowed,
      ).toBe(false);
      const approved = await compileApprovedStagingPrivileges(admin, roles.runtime);
      await verifyResetForbiddenGrants(admin, approved.policy.forbidden);
    }));

  test("a forbidden grant held by PUBLIC is detected and revoked without changing the policy", async () =>
    fixture(async (admin, roles) => {
      await admin.query("GRANT INSERT ON api_next.schema_migrations TO PUBLIC");
      const before = await inspectResetPreparation(admin, roles.runtime);
      expect(before.forbiddenPresent).toHaveLength(1);
      expect(before.forbiddenPresent[0]?.grantee).toBe("PUBLIC");
      const result = await removal(admin, roles.runtime);
      expect(result.revoked).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT has_table_privilege($1,'api_next.schema_migrations','INSERT') AS allowed",
            [roles.runtime],
          )
        ).rows[0].allowed,
      ).toBe(false);
    }));

  test("forbidden authority inherited through a reachable role is removed and membership is retained", async () =>
    fixture(async (admin, roles) => {
      await admin.query(
        `GRANT "${roles.group}" TO "${roles.runtime}" WITH INHERIT FALSE, SET TRUE`,
      );
      await admin.query(`GRANT UPDATE ON api_next.schema_migrations TO "${roles.group}"`);
      const names = await verifyStagingRuntimeIdentity(admin, roles.runtime);
      expect(names).toContain(roles.group);
      const before = await inspectResetPreparation(admin, roles.runtime);
      expect(before.forbiddenPresent).toHaveLength(1);
      expect(before.forbiddenPresent[0]?.grantee).toBe(roles.group);
      const result = await removal(admin, roles.runtime);
      expect(result.revoked).toBe(1);
      expect(
        (
          await admin.query("SELECT pg_has_role($1,$2,'MEMBER') AS member", [
            roles.runtime,
            roles.group,
          ])
        ).rows[0].member,
      ).toBe(true);
      expect(
        (
          await admin.query(
            "SELECT has_table_privilege($1,'api_next.schema_migrations','UPDATE') AS allowed",
            [roles.runtime],
          )
        ).rows[0].allowed,
      ).toBe(false);
    }));
});
