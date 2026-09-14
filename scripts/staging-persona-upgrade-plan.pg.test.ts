import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { runPostgresMigrations } from "./postgres-migrations.ts";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target.ts";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan.ts";
import {
  applyStagingUpgradeInPhases,
  STAGING_UPGRADE_CHECKPOINT_COUNT,
  STAGING_UPGRADE_RELEASE,
  StagingUpgradeApplyFailed,
} from "./staging-persona-upgrade-plan.ts";

const raw = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!raw && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("local test URL required");
const suite = raw ? describe : describe.skip;
const reset = validateStagingResetArtifacts(loadStagingResetArtifacts());

async function withResetDatabase(use: (connectionString: string, admin: Client) => Promise<void>) {
  const source = localRecoveryTestUrl(raw ?? "");
  const database = `staging_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  const scoped = new URL(source);
  scoped.pathname = `/${database}`;
  scoped.searchParams.set("options", "-c search_path=api_next,pg_catalog");
  const root = new Client({ connectionString: source.toString() });
  const admin = new Client({ connectionString: scoped.toString() });
  let adminConnected = false;
  await root.connect();
  try {
    await root.query(`CREATE DATABASE "${database}"`);
    await admin.connect();
    adminConnected = true;
    await admin.query("CREATE SCHEMA api_next");
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: reset.migrations,
    });
    await use(scoped.toString(), admin);
  } finally {
    if (adminConnected) await admin.end().catch(() => undefined);
    for (let attempt = 0; attempt < 500; attempt++) {
      const active = (
        await root.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1", [
          database,
        ])
      ).rows[0]?.count;
      if (active === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await root.query(`DROP DATABASE IF EXISTS "${database}"`);
    await root.end();
  }
}

suite("staging upgrade exact checkpoint", () => {
  test(
    "the real two-transaction helper produces the complete reviewed receipt",
    () =>
      withResetDatabase(async (connectionString, admin) => {
        const receipt = await applyStagingUpgradeInPhases(connectionString);
        expect(receipt.applied).toHaveLength(STAGING_UPGRADE_RELEASE.upgradeCount);
        expect(receipt.applied[0]).toBe(STAGING_UPGRADE_RELEASE.firstUpgradeVersion);
        expect(receipt.applied.at(-1)).toBe(STAGING_UPGRADE_RELEASE.terminalVersion);

        const ledger = (
          await admin.query(
            "SELECT count(*)::int AS count,max(version) AS terminal FROM api_next.schema_migrations",
          )
        ).rows[0];
        expect(ledger).toEqual({
          count: STAGING_UPGRADE_RELEASE.migrationCount,
          terminal: STAGING_UPGRADE_RELEASE.terminalVersion,
        });
      }),
    120_000,
  );

  test(
    "the second transaction refuses a ledger other than the exact 0153 checkpoint",
    () =>
      withResetDatabase(async (connectionString, admin) => {
        let calls = 0;
        try {
          await applyStagingUpgradeInPhases(connectionString, async (input) => {
            const result = await runPostgresMigrations(input);
            calls++;
            if (calls === 1) {
              await admin.query(
                "INSERT INTO api_next.schema_migrations(version,checksum) VALUES($1,$2)",
                ["9999_unreviewed.sql", "0".repeat(64)],
              );
            }
            return result;
          });
          throw new Error("expected exact-ledger refusal");
        } catch (error) {
          expect(error).toBeInstanceOf(StagingUpgradeApplyFailed);
          if (!(error instanceof StagingUpgradeApplyFailed)) throw error;
          expect(error.appliedMigrations).toBe(STAGING_UPGRADE_CHECKPOINT_COUNT);
          expect(error.cause).toMatchObject({ _tag: "MigrationLedgerMismatch" });
        }
        expect(calls).toBe(1);

        const ledger = (
          await admin.query(`SELECT count(*)::int AS count,
            count(*) FILTER (WHERE version='0153_hns_activation_policy.sql')::int AS checkpoint,
            count(*) FILTER (WHERE version='0154_hns_expiry_consumers.sql')::int AS after_checkpoint
            FROM api_next.schema_migrations`)
        ).rows[0];
        expect(ledger).toEqual({ count: 154, checkpoint: 1, after_checkpoint: 0 });
      }),
    120_000,
  );
});
