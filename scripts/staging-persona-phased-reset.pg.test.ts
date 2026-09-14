import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { runPostgresMigrations } from "./postgres-migrations";
import { compileApprovedStagingPrivileges } from "./staging-persona-approved-privileges";
import { readResetGrantCatalog } from "./staging-persona-grant-catalog";
import { localResetRecoveryTool } from "./staging-persona-local-recovery-tool";
import {
  readCompletedStagingReset,
  reconstructStagingInPhases,
} from "./staging-persona-phased-reset";
import { withResetAdmissionReporting } from "./staging-persona-prepare-reset.ts";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target";
import { reconcileRehearsalGrants } from "./staging-persona-rehearsal-grants.ts";
import {
  denyReplayedRuntimeGrants,
  verifyResetRuntimeDenied,
} from "./staging-persona-reset-denied-grants";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";
import { readResetSchemaShape } from "./staging-persona-schema-shape";
import {
  loadStagingUpgradeArtifacts,
  STAGING_UPGRADE_RELEASE,
  stagingUpgradeBaseLedger,
  stagingUpgradeReceipt,
} from "./staging-persona-upgrade-plan.ts";
import { reconstructAndReleaseStaging } from "./staging-reset-release-runtime.ts";

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

async function fixture(
  use: (admin: Client, url: URL, markerDirectory: string, runtime: string) => Promise<void>,
) {
  const source = localRecoveryTestUrl(raw ?? "");
  const database = `phased_reset_${crypto.randomUUID().replaceAll("-", "")}`;
  const runtime = `runtime_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = new Client({ connectionString: source.toString() });
  const url = new URL(source);
  url.pathname = `/${database}`;
  url.searchParams.set("options", "-c search_path=api_next,pg_catalog");
  const admin = new Client({ connectionString: url.toString() });
  const directory = await mkdtemp(join(tmpdir(), "phased-reset-marker-"));
  await root.connect();
  try {
    await root.query(`CREATE ROLE "${runtime}" NOLOGIN`);
    await root.query(`CREATE DATABASE "${database}"`);
    await admin.connect();
    expect(
      Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num),
    ).toBeGreaterThanOrEqual(170000);
    await admin.query(
      "CREATE SCHEMA api_next; CREATE SCHEMA outside_sentinel; CREATE TABLE outside_sentinel.retained(id int); INSERT INTO outside_sentinel.retained VALUES(7)",
    );
    await admin.query(`GRANT USAGE ON SCHEMA api_next TO "${runtime}"`);
    await admin.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA api_next GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO "${runtime}"`,
    );
    await admin.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA api_next GRANT SELECT,UPDATE,USAGE ON SEQUENCES TO "${runtime}"`,
    );
    await use(admin, url, directory, runtime);
    expect((await admin.query("SELECT id FROM outside_sentinel.retained")).rows).toEqual([
      { id: 7 },
    ]);
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.end();
    await root.query(`DROP DATABASE IF EXISTS "${database}"`);
    await root.query(`DROP ROLE IF EXISTS "${runtime}"`);
    await root.end();
    await rm(directory, { recursive: true });
  }
}

async function expected(
  admin: Client,
  markerDirectory: string,
  baselineDigest: string,
  runtime: string,
) {
  const approved = await compileApprovedStagingPrivileges(admin, runtime);
  // Model the admitted ACL fence, retaining defaults so every replay tests
  // removal of newly materialized grants before its commit boundary.
  await admin.query("BEGIN");
  await admin.query(`REVOKE ALL ON SCHEMA api_next FROM "${runtime}"`);
  await denyReplayedRuntimeGrants(admin, runtime);
  await admin.query("COMMIT");
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
    runtimeRole: runtime,
    schemaOid: row.oid,
    defaultsDigest: (await readResetGrantCatalog(admin)).defaults_sha256,
    baselineDigest,
    reviewedGrants: approved.reviewed,
    // LOCAL limits derived from 778 observed locks and 603 closure objects.
    // Fresh provider rehearsal must independently validate its own budget.
    grantPolicy: approved.policy,
    removalBudget: {
      maxOwnLockRows: 1_000,
      maxClusterLockRows: 1_200,
      maxClosureObjects: 800,
    },
    replayBudget: { maxLockRows: 1_000, maxClusterLockRows: 1_200, statementTimeoutMs: 120_000 },
  };
}

suite("phased reset in disposable PostgreSQL 17", () => {
  test("composes committed reconstruction, the pinned upgrade and release in one process", async () => {
    let baseline = "";
    await fixture(async (admin, url) => {
      await localResetRecoveryTool(
        url,
        "psql",
        ["--set", "ON_ERROR_STOP=1"],
        new TextEncoder().encode(artifacts.baseline),
      );
      await admin.query("SET search_path=pg_catalog");
      baseline = (await readResetSchemaShape(admin)).sha256;
    });
    await fixture(async (admin, url, directory, runtime) => {
      await seed(url);
      const admission = await expected(admin, directory, baseline, runtime);
      const calls: string[] = [];
      let reconciliation: Awaited<ReturnType<typeof reconcileRehearsalGrants>> | undefined;
      const marker = join(directory, "pirate-staging-api-next.reset-in-progress.json");
      const surface =
        (name: "versions" | "database" | "ingress" | "producers") =>
        async (_directive: unknown, now: () => string) => {
          calls.push(name);
          if (name === "versions") {
            await readFile(marker);
            await verifyResetRuntimeDenied(admin, runtime);
            expect(
              (await admin.query("SELECT count(*)::int AS n FROM api_next.schema_migrations"))
                .rows[0].n,
            ).toBe(119);
          }
          if (name === "database") {
            await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
            const ledger = await admin.query(
              "SELECT count(*)::int AS n FROM api_next.schema_migrations",
            );
            expect(ledger.rows[0].n).toBe(STAGING_UPGRADE_RELEASE.migrationCount);
            const terminal = await admin.query(
              "SELECT version FROM api_next.schema_migrations ORDER BY version DESC LIMIT 1",
            );
            expect(terminal.rows[0].version).toBe(STAGING_UPGRADE_RELEASE.terminalVersion);
            // The release surface's own work: restore the reviewed vocabulary
            // against the upgraded schema and derive the digest the window
            // must pin.
            reconciliation = await reconcileRehearsalGrants(admin, runtime);
          }
          return { surface: name, releasedAt: now(), receipt: `${name}-local-fixture` };
        };
      const result = await reconstructAndReleaseStaging({
        database: admin,
        artifacts,
        admission,
        release: {
          plan: {
            version: "staging-karaoke-release-plan-v2",
            ingressApplicationId: "a".repeat(32),
            resumeQueues: [{ name: "local-fixture", id: "b".repeat(32) }],
            servingWorkers: [{ worker: "local-fixture", versionId: "c".repeat(32) }],
            reviewedGrantDigest: "d".repeat(64),
            surfaceOrder: ["versions", "database", "ingress", "producers"],
          },
          surfaces: {
            versions: surface("versions"),
            database: surface("database"),
            ingress: surface("ingress"),
            producers: surface("producers"),
          },
          acceptance: async () => {
            calls.push("acceptance");
          },
          refence: {
            database: async () => {
              throw new Error("unexpected local re-fence");
            },
            ingress: async () => {
              throw new Error("unexpected local re-fence");
            },
            producers: async () => {
              throw new Error("unexpected local re-fence");
            },
          },
        },
        upgrade: {
          apply: async () => {
            calls.push("upgrade");
            const upgradeArtifacts = loadStagingUpgradeArtifacts();
            const exact = stagingUpgradeBaseLedger(validateStagingResetArtifacts(artifacts));
            const ledgerCount = async () =>
              (await admin.query("SELECT count(*)::int AS n FROM api_next.schema_migrations"))
                .rows[0].n;
            const refusalOf = async (
              expectedLedger: readonly { version: string; checksum: string }[],
            ) =>
              runPostgresMigrations({
                connectionString: url.toString(),
                migrations: upgradeArtifacts.migrations,
                expectedLedger,
              }).then(
                () => null,
                (cause: unknown) => cause,
              );
            // Every refused starting state must leave the ledger untouched: the
            // 0109 source prefix, a checksum drift, and a later prefix the
            // reconstructed state does not have.
            const sourcePrefix = await refusalOf(exact.slice(0, 109));
            expect((sourcePrefix as { reason?: string }).reason).toBe("exact-ledger");
            const checksumDrift = await refusalOf(
              exact.map((entry, index) =>
                index === 5 ? { ...entry, checksum: "0".repeat(64) } : entry,
              ),
            );
            expect((checksumDrift as { reason?: string }).reason).toBe("exact-ledger");
            const laterPrefix = await refusalOf(upgradeArtifacts.migrations);
            expect((laterPrefix as { reason?: string }).reason).toBe("exact-ledger");
            expect(await ledgerCount()).toBe(119);
            const output = await runPostgresMigrations({
              connectionString: url.toString(),
              migrations: upgradeArtifacts.migrations,
              expectedLedger: exact,
            });
            if (output.dryRun) throw new Error("unexpected_local_upgrade_dry_run");
            return stagingUpgradeReceipt(upgradeArtifacts, output.result.applied);
          },
        },
      });
      expect(result.release.disposition).toBe("released");
      expect(calls).toEqual([
        "versions",
        "upgrade",
        "database",
        "ingress",
        "acceptance",
        "producers",
      ]);
      expect(reconciliation?.reviewed_grants).toBeGreaterThan(0);
      expect(reconciliation?.derived_reviewed_grant_digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(reconciliation?.runtime_connect).toBe(true);
      await expect(result.reset.completeAfterPairedRelease(async () => {})).rejects.toThrow(
        "reset_release_retry_forbidden_restore_required",
      );
    });
  }, 600_000);

  test("the upgrade refuses an unreset 0109 ledger with zero writes", async () => {
    await fixture(async (admin, url) => {
      await seed(url);
      const upgradeArtifacts = loadStagingUpgradeArtifacts();
      const exact = stagingUpgradeBaseLedger(validateStagingResetArtifacts(artifacts));
      const error = await runPostgresMigrations({
        connectionString: url.toString(),
        migrations: upgradeArtifacts.migrations,
        expectedLedger: exact,
      }).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect((error as { reason?: string }).reason).toBe("exact-ledger");
      const count = (await admin.query("SELECT count(*)::int AS n FROM api_next.schema_migrations"))
        .rows[0].n;
      expect(count).toBe(109);
    });
  }, 600_000);

  test("refuses caller transactions, unverified baseline and oversized closure before the first drop", async () => {
    await fixture(async (admin, url, directory, runtime) => {
      await seed(url);
      const admission = await expected(admin, directory, "0".repeat(64), runtime);
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
    await fixture(async (admin, url, directory, runtime) => {
      await seed(url);
      await admin.query("INSERT INTO api_next.users(user_id) VALUES('phased-account')");
      const admission = await expected(admin, directory, baseline, runtime);
      let removals = 0;
      let replays = 0;
      let deniedFenceObservations = 0;
      const result = await reconstructStagingInPhases(admin, artifacts, {
        ...admission,
        assertFreshFence: async ({ transactionId, privilegeMode }) => {
          // Actual ACL denial, including in-transaction replay grants. The
          // separate drain suite still owns live session admission coverage.
          expect(
            (await admin.query("SELECT pg_current_xact_id_if_assigned()::text AS xid")).rows[0].xid,
          ).toBe(transactionId);
          expect(privilegeMode).toBe("revoked");
          await verifyResetRuntimeDenied(admin, runtime);
          deniedFenceObservations++;
        },
        afterBatch: async (phase) => {
          if (phase === "removing") removals++;
          else replays++;
        },
      });
      expect(removals).toBeGreaterThan(0);
      expect(replays).toBe(119);
      expect(result.evidence.ledgerCount).toBe(119);
      const completion = await result.verifyResetCompletion();
      expect(completion.version).toBe("staging-karaoke-reset-completion-v1");
      expect(completion.serverVersion).toBe(
        (await admin.query("SHOW server_version")).rows[0].server_version,
      );
      expect<string | undefined>(completion.terminalMigration).toBe(
        plan.migrations.at(-1)?.version,
      );
      expect(completion.personaCounts).toEqual({
        unbound: 0,
        singleCommunity: 0,
        multiCommunity: 0,
      });
      expect(result.executionEvidence.ledger).toEqual(
        plan.migrations.map(({ version, checksum }) => ({ version, checksum })),
      );
      expect<string>(result.executionEvidence.sourceSha).toBe(plan.sourceSha);
      expect(result.executionEvidence.schemaOid).toBe(admission.schemaOid);
      expect(deniedFenceObservations).toBeGreaterThan(2 * result.batches);
      await verifyResetRuntimeDenied(admin, runtime);
      expect((await readResetGrantCatalog(admin)).defaults_sha256).toBe(admission.defaultsDigest);
      await expect(readCompletedStagingReset({ ...result })).rejects.toThrow(
        "reset_executor_completion_not_owned",
      );
      const readback = readCompletedStagingReset(result);
      await expect(result.verifyResetCompletion()).rejects.toThrow("reset_completion_read_pending");
      await expect(result.completeAfterPairedRelease(async () => {})).rejects.toThrow(
        "reset_completion_read_pending",
      );
      expect((await readback).proof.ledger).toEqual(result.executionEvidence.ledger);
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
      await expect(readCompletedStagingReset(result)).rejects.toThrow(
        "reset_completion_release_already_attempted",
      );
      await expect(
        readFile(join(directory, "pirate-staging-api-next.reset-in-progress.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }, 600_000);

  test("failure after a committed removal retains marker and refuses a fresh invocation", async () => {
    await fixture(async (admin, url, directory, runtime) => {
      await seed(url);
      await admin.query("INSERT INTO api_next.users(user_id) VALUES('retained-in-capture')");
      const admission = await expected(admin, directory, "0".repeat(64), runtime);
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

  test("owned completion refuses grant drift and retains the failed marker without restoring grants", async () => {
    let baseline = "";
    await fixture(async (admin, url) => {
      await localResetRecoveryTool(
        url,
        "psql",
        ["--set", "ON_ERROR_STOP=1"],
        new TextEncoder().encode(artifacts.baseline),
      );
      await admin.query("SET search_path=pg_catalog");
      baseline = (await readResetSchemaShape(admin)).sha256;
    });
    await fixture(async (admin, url, directory, runtime) => {
      await seed(url);
      const admission = await expected(admin, directory, baseline, runtime);
      const result = await reconstructStagingInPhases(admin, artifacts, admission);
      await verifyResetRuntimeDenied(admin, runtime);
      await admin.query(`GRANT SELECT ON api_next.users TO "${runtime}"`);
      await expect(readCompletedStagingReset(result)).rejects.toThrow();
      expect(
        JSON.parse(
          await readFile(join(directory, "pirate-staging-api-next.reset-in-progress.json"), "utf8"),
        ).phase,
      ).toBe("failed");
      // Refusal neither hides the drift nor restores the rest of the grants.
      expect(
        (
          await admin.query(
            "SELECT has_table_privilege($1,'api_next.users','SELECT') AS selected, has_table_privilege($1,'api_next.users','INSERT') AS inserted",
            [runtime],
          )
        ).rows[0],
      ).toEqual({ selected: true, inserted: false });
      await expect(readCompletedStagingReset(result)).rejects.toThrow(
        "reset_completion_release_already_attempted",
      );
    });
  }, 600_000);

  test("failure between replay batches keeps its partial ledger and refuses rerun", async () => {
    await fixture(async (admin, url, directory, runtime) => {
      await seed(url);
      const admission = await expected(admin, directory, "0".repeat(64), runtime);
      let replayBatches = 0;
      await expect(
        reconstructStagingInPhases(admin, artifacts, {
          ...admission,
          afterBatch: async (phase) => {
            if (phase === "replaying" && ++replayBatches === 1)
              throw new Error("injected_between_replay_batches");
          },
        }),
      ).rejects.toThrow("injected_between_replay_batches");
      const marker = JSON.parse(
        await readFile(join(directory, "pirate-staging-api-next.reset-in-progress.json"), "utf8"),
      );
      expect(marker.phase).toBe("failed");
      expect(marker.completedBatches).toBeGreaterThan(1);
      expect(replayBatches).toBe(1);
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM api_next.schema_migrations")).rows[0].n,
      ).toBe(1);
      await expect(reconstructStagingInPhases(admin, artifacts, admission)).rejects.toThrow(
        "restore_required",
      );
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM api_next.schema_migrations")).rows[0].n,
      ).toBe(1);
    });
  }, 600_000);

  test("restores a data-bearing recovery copy after a committed partial reset", async () => {
    await fixture(async (admin, url, directory, runtime) => {
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
        const admission = await expected(admin, directory, "0".repeat(64), runtime);
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

  test("the diagnostic stop preserves schema, data and ledger, rolls back and retains a failed marker", async () => {
    let baseline = "";
    await fixture(async (admin, url) => {
      await localResetRecoveryTool(
        url,
        "psql",
        ["--set", "ON_ERROR_STOP=1"],
        new TextEncoder().encode(artifacts.baseline),
      );
      await admin.query("SET search_path=pg_catalog");
      baseline = (await readResetSchemaShape(admin)).sha256;
    });
    await fixture(async (admin, url, directory, runtime) => {
      await seed(url);
      await admin.query(
        "CREATE TABLE api_next.diagnostic_sentinel(id int primary key); INSERT INTO api_next.diagnostic_sentinel VALUES (1)",
      );
      await admin.query("SET search_path=pg_catalog");
      const beforeShape = (await readResetSchemaShape(admin)).sha256;
      const beforeLedger = (
        await admin.query(
          "SELECT version, checksum FROM api_next.schema_migrations ORDER BY version",
        )
      ).rows;
      const admission = await expected(admin, directory, baseline, runtime);
      let callbacks = 0;
      await expect(
        reconstructStagingInPhases(admin, artifacts, {
          ...admission,
          diagnosticStopBeforeFirstBatch: true,
          afterBatch: async () => {
            callbacks += 1;
          },
        }),
      ).rejects.toThrow("diagnostic_stop_before_first_apply");
      expect(callbacks).toBe(0);
      expect((await readResetSchemaShape(admin)).sha256).toBe(beforeShape);
      expect(
        (
          await admin.query(
            "SELECT version, checksum FROM api_next.schema_migrations ORDER BY version",
          )
        ).rows,
      ).toEqual(beforeLedger);
      expect((await admin.query("SELECT id FROM api_next.diagnostic_sentinel")).rows).toEqual([
        { id: 1 },
      ]);
      const marker = JSON.parse(
        await readFile(join(directory, "pirate-staging-api-next.reset-in-progress.json"), "utf8"),
      ) as { phase: string; completedBatches: number };
      expect(marker.phase).toBe("failed");
      expect(marker.completedBatches).toBe(0);
      expect(
        (await admin.query("SELECT pg_current_xact_id_if_assigned()::text AS xid")).rows[0]?.xid,
      ).toBeNull();
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM pg_locks WHERE pid=pg_backend_pid() AND NOT fastpath",
          )
        ).rows[0].n,
      ).toBe(0);
    });
  }, 120_000);

  test("a marker-created pre-batch failure keeps a finite redacted stage", async () => {
    await fixture(async (admin, url, directory, runtime) => {
      await seed(url);
      const admission = await expected(admin, directory, "0".repeat(64), runtime);
      const error = await withResetAdmissionReporting((observe) =>
        reconstructStagingInPhases(admin, artifacts, {
          ...admission,
          onAdmissionStage: observe,
          diagnosticStopBeforeFirstBatch: true,
        }),
      ).catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        message: "reset_admission_unproven:first_batch",
        cause: expect.any(Error),
      });
      expect((error as Error).message).not.toContain("diagnostic_stop_before_first_apply");
      const marker = JSON.parse(
        await readFile(join(directory, "pirate-staging-api-next.reset-in-progress.json"), "utf8"),
      ) as { phase: string; completedBatches: number };
      expect(marker).toMatchObject({ phase: "failed", completedBatches: 0 });
    });
  }, 120_000);

  test("an earlier first-batch precheck failure keeps its identity and failed marker", async () => {
    let baseline = "";
    await fixture(async (admin, url) => {
      await localResetRecoveryTool(
        url,
        "psql",
        ["--set", "ON_ERROR_STOP=1"],
        new TextEncoder().encode(artifacts.baseline),
      );
      await admin.query("SET search_path=pg_catalog");
      baseline = (await readResetSchemaShape(admin)).sha256;
    });
    await fixture(async (admin, url, directory, runtime) => {
      await seed(url);
      await admin.query("SET search_path=pg_catalog");
      const admission = await expected(admin, directory, baseline, runtime);
      await expect(
        reconstructStagingInPhases(admin, artifacts, {
          ...admission,
          removalBudget: { ...admission.removalBudget, maxClosureObjects: 1 },
          diagnosticStopBeforeFirstBatch: true,
        }),
      ).rejects.toThrow("reset_batch_closure_budget_exceeded_restore_required");
      const marker = JSON.parse(
        await readFile(join(directory, "pirate-staging-api-next.reset-in-progress.json"), "utf8"),
      ) as { phase: string; completedBatches: number };
      expect(marker.phase).toBe("failed");
      expect(marker.completedBatches).toBe(0);
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM api_next.schema_migrations")).rows[0].n,
      ).toBe(109);
    });
  }, 120_000);
});
