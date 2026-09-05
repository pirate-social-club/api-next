import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { runPostgresMigrations } from "./postgres-migrations";
import { readResetGrantCatalog } from "./staging-persona-grant-catalog";
import { localResetRecoveryTool } from "./staging-persona-local-recovery-tool";
import { reconstructStagingInPhases } from "./staging-persona-phased-reset";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";
import { readResetSchemaShape } from "./staging-persona-schema-shape";

const raw = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!raw && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("local test URL required");
const suite = raw ? describe : describe.skip;
const artifacts = loadStagingResetArtifacts();
const plan = validateStagingResetArtifacts(artifacts);

async function seed(url: URL) {
  // Local fixture setup uses ordinary prefix commits so it also fits 64/25/0.
  for (let count = 1; count <= 109; count++) {
    await runPostgresMigrations({
      connectionString: url.toString(),
      migrations: plan.migrations.slice(0, count),
    });
  }
}

async function fixture(use: (admin: Client, url: URL, markerDirectory: string) => Promise<void>) {
  const source = localRecoveryTestUrl(raw ?? "");
  const database = `phased_reset_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = new Client({ connectionString: source.toString() });
  const url = new URL(source);
  url.pathname = `/${database}`;
  url.searchParams.set("options", "-c search_path=api_next,pg_catalog");
  const admin = new Client({ connectionString: url.toString() });
  const directory = await mkdtemp(join(tmpdir(), "phased-reset-marker-"));
  await root.connect();
  try {
    await root.query(`CREATE DATABASE "${database}"`);
    await admin.connect();
    expect(
      Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num),
    ).toBeGreaterThanOrEqual(170000);
    await admin.query(
      "CREATE SCHEMA api_next; CREATE SCHEMA outside_sentinel; CREATE TABLE outside_sentinel.retained(id int); INSERT INTO outside_sentinel.retained VALUES(7)",
    );
    await use(admin, url, directory);
    expect((await admin.query("SELECT id FROM outside_sentinel.retained")).rows).toEqual([
      { id: 7 },
    ]);
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.end();
    await root.query(`DROP DATABASE IF EXISTS "${database}"`);
    await root.end();
    await rm(directory, { recursive: true });
  }
}

async function expected(admin: Client, markerDirectory: string, baselineDigest: string) {
  const row = (
    await admin.query(
      "SELECT current_database() AS database,session_user AS role,'api_next'::regnamespace::oid AS oid",
    )
  ).rows[0];
  return {
    assertFenceAndRecovery: async () => {},
    assertBaselineReference: async (sourceSha: string, digest: string) => {
      if (sourceSha !== plan.sourceSha || digest !== baselineDigest)
        throw new Error("test_baseline_reference_mismatch");
    },
    assertFreshFence: async () => {},
    markerDirectory,
    recoveryDigest: "a".repeat(64),
    targetAndFenceDigest: "b".repeat(64),
    validUntilMs: Date.now() + 900_000,
    database: row.database,
    role: row.role,
    schemaOid: row.oid,
    defaultsDigest: (await readResetGrantCatalog(admin)).defaults_sha256,
    baselineDigest,
    reviewedGrants: [],
    // LOCAL limits derived from 778 observed locks and 603 closure objects.
    // Fresh provider rehearsal must independently validate its own budget.
    removalBudget: {
      maxOwnLockRows: 1_000,
      maxClusterLockRows: 1_200,
      maxClosureObjects: 800,
    },
    replayBudget: { maxLockRows: 1_000, maxClusterLockRows: 1_200, statementTimeoutMs: 120_000 },
  };
}

suite("phased reset in disposable PostgreSQL 17", () => {
  test("refuses caller transactions, unverified baseline and oversized closure before the first drop", async () => {
    await fixture(async (admin, url, directory) => {
      await seed(url);
      const admission = await expected(admin, directory, "0".repeat(64));
      await admin.query("BEGIN");
      await expect(reconstructStagingInPhases(admin, artifacts, admission)).rejects.toThrow(
        "fresh_idle_connection_required",
      );
      await admin.query("ROLLBACK");
      await expect(
        reconstructStagingInPhases(admin, artifacts, {
          ...admission,
          assertBaselineReference: async () => {
            throw new Error("unverified_baseline");
          },
        }),
      ).rejects.toThrow("unverified_baseline");
      await expect(
        reconstructStagingInPhases(admin, artifacts, {
          ...admission,
          replayBudget: { ...admission.replayBudget, maxClusterLockRows: 1_100 },
        }),
      ).rejects.toThrow("common_cluster_budget_required");
      await admin.query("CREATE PUBLICATION reset_refusal FOR TABLE api_next.users");
      await expect(reconstructStagingInPhases(admin, artifacts, admission)).rejects.toThrow(
        "replication_membership_requires_disposition",
      );
      await admin.query("DROP PUBLICATION reset_refusal");
      await expect(
        reconstructStagingInPhases(admin, artifacts, {
          ...admission,
          removalBudget: { ...admission.removalBudget, maxClosureObjects: 1 },
        }),
      ).rejects.toThrow("closure_budget_exceeded");
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM api_next.schema_migrations")).rows[0].n,
      ).toBe(109);
      expect(
        (await admin.query("SELECT to_regclass('api_next.users') IS NOT NULL AS present")).rows[0]
          .present,
      ).toBe(true);
    });
  }, 60_000);
  test("commits roots and migration prefixes, retains marker until paired verification", async () => {
    let baseline = "";
    await fixture(async (admin, url) => {
      // psql parses the independent baseline as individual commands, not one
      // multi-statement protocol transaction that exhausts the low-capacity test.
      await localResetRecoveryTool(
        url,
        "psql",
        ["--set", "ON_ERROR_STOP=1"],
        new TextEncoder().encode(artifacts.baseline),
      );
      await admin.query("SET search_path=pg_catalog");
      baseline = (await readResetSchemaShape(admin)).sha256;
    });
    await fixture(async (admin, url, directory) => {
      await seed(url);
      await admin.query("INSERT INTO api_next.users(user_id) VALUES('phased-account')");
      const admission = await expected(admin, directory, baseline);
      let removals = 0;
      let replays = 0;
      const result = await reconstructStagingInPhases(admin, artifacts, {
        ...admission,
        afterBatch: async (phase) => {
          if (phase === "removing") removals++;
          else replays++;
        },
      });
      expect(removals).toBeGreaterThan(0);
      expect(replays).toBe(119);
      expect(result.evidence.ledgerCount).toBe(119);
      console.log(
        JSON.stringify({
          localOnly: true,
          batches: result.batches,
          ...result.observedCommitBoundaryLocks,
        }),
      );
      await expect(reconstructStagingInPhases(admin, artifacts, admission)).rejects.toThrow(
        "restore_required",
      );
      let served = false;
      await result.completeAfterPairedRelease(async () => {
        served = true;
      });
      expect(served).toBe(true);
      await expect(
        readFile(join(directory, "pirate-staging-api-next.reset-in-progress.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }, 600_000);

  test("failure after a committed removal retains marker and refuses a fresh invocation", async () => {
    await fixture(async (admin, url, directory) => {
      await seed(url);
      await admin.query("INSERT INTO api_next.users(user_id) VALUES('retained-in-capture')");
      const admission = await expected(admin, directory, "0".repeat(64));
      await expect(
        reconstructStagingInPhases(admin, artifacts, {
          ...admission,
          afterBatch: async () => {
            throw new Error("injected_between_batches");
          },
        }),
      ).rejects.toThrow("injected_between_batches");
      const marker = JSON.parse(
        await readFile(join(directory, "pirate-staging-api-next.reset-in-progress.json"), "utf8"),
      );
      expect(marker.phase).toBe("failed");
      expect(marker.completedBatches).toBe(1);
      await expect(reconstructStagingInPhases(admin, artifacts, admission)).rejects.toThrow(
        "restore_required",
      );
      // Whole-dataset restore is a separate required rehearsal, not asserted here.
    });
  }, 60_000);

  test("restores a data-bearing recovery copy after a committed partial reset", async () => {
    await fixture(async (admin, url, directory) => {
      await seed(url);
      await admin.query(
        "INSERT INTO api_next.users(user_id) VALUES('captured-account'); GRANT SELECT ON api_next.users TO PUBLIC",
      );
      const recoveryName = `phased_reset_${crypto.randomUUID().replaceAll("-", "")}`;
      const replacementName = `phased_reset_${crypto.randomUUID().replaceAll("-", "")}`;
      const recoveryUrl = new URL(url);
      recoveryUrl.pathname = `/${recoveryName}`;
      const replacementUrl = new URL(url);
      replacementUrl.pathname = `/${replacementName}`;
      const recovery = new Client({ connectionString: recoveryUrl.toString() });
      const replacement = new Client({ connectionString: replacementUrl.toString() });
      try {
        const captured = await localResetRecoveryTool(url, "pg_dump", ["--format=custom"]);
        await admin.query(`CREATE DATABASE "${recoveryName}";`);
        await admin.query(`CREATE DATABASE "${replacementName}";`);
        await localResetRecoveryTool(
          recoveryUrl,
          "pg_restore",
          ["--dbname", recoveryName, "--exit-on-error"],
          captured,
        );
        await recovery.connect();
        const admission = await expected(admin, directory, "0".repeat(64));
        await expect(
          reconstructStagingInPhases(admin, artifacts, {
            ...admission,
            afterBatch: async () => {
              throw new Error("injected_committed_failure");
            },
          }),
        ).rejects.toThrow("injected_committed_failure");
        // Recovery comes from the retained copy, not an undo transaction on the damaged target.
        const retainedCapture = await localResetRecoveryTool(recoveryUrl, "pg_dump", [
          "--format=custom",
        ]);
        await localResetRecoveryTool(
          replacementUrl,
          "pg_restore",
          ["--dbname", replacementName, "--exit-on-error"],
          retainedCapture,
        );
        await replacement.connect();
        const tables = (
          await recovery.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='api_next' ORDER BY tablename",
          )
        ).rows;
        for (const { tablename } of tables) {
          const sql = `SELECT to_jsonb(r)::text AS row FROM api_next."${tablename.replaceAll('"', '""')}" r ORDER BY to_jsonb(r)::text COLLATE "C"`;
          expect((await replacement.query(sql)).rows).toEqual((await recovery.query(sql)).rows);
        }
        const schemaArgs = ["--schema-only", "--restrict-key=PhasedRecoveryTest"];
        expect(await localResetRecoveryTool(replacementUrl, "pg_dump", schemaArgs)).toEqual(
          await localResetRecoveryTool(recoveryUrl, "pg_dump", schemaArgs),
        );
        expect(
          (await replacement.query("SELECT count(*)::int AS n FROM api_next.schema_migrations"))
            .rows[0].n,
        ).toBe(109);
        await expect(reconstructStagingInPhases(admin, artifacts, admission)).rejects.toThrow(
          "restore_required",
        );
      } finally {
        await recovery.end();
        await replacement.end();
        await admin.query(`DROP DATABASE IF EXISTS "${replacementName}"`);
        await admin.query(`DROP DATABASE IF EXISTS "${recoveryName}"`);
      }
    });
  }, 180_000);
});
