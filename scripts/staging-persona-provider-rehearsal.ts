import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { compileApprovedStagingPrivileges } from "./staging-persona-approved-privileges";
import { readResetGrantCatalog } from "./staging-persona-grant-catalog";
import { reconstructStagingInPhases } from "./staging-persona-phased-reset";
import { observeStagingProviderBackup } from "./staging-persona-provider-backup";
import { describeRehearsalFailure } from "./staging-persona-rehearsal-failure";
import { assertRehearsalHyperdriveExclusion } from "./staging-persona-rehearsal-hyperdrive";
import {
  fingerprintRehearsalData,
  withProviderRehearsalOperator,
} from "./staging-persona-rehearsal-inventory";
import { measureRehearsalReference } from "./staging-persona-rehearsal-reference";
import {
  assertRehearsalSessionHeadroom,
  observeRehearsalSessions,
} from "./staging-persona-rehearsal-sessions";
import {
  assertStagingResetLedger,
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";

const branchId = "abkmnvey02z5";
const backupId = "xvvo8r6tcaa5";
const originalData = "0b1c97ef5efa0d32eee31cf220e9d5a41f74c7cfecbe782c03f16caaf2628bf8";
const originalDefaults = "f0973701f1b93a794190b0a16ab24126ff6bda647a0d4476f6a00f9d75b2329d";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Fixed isolated branch only. No command here creates a backup, changes a
 * Worker, restores a failed run, removes a marker, or resets staging main.
 * Read-only checks and an independently measured local reference precede DROP.
 */
export async function rehearseProviderReset(execute: boolean) {
  const artifacts = loadStagingResetArtifacts();
  const plan = validateStagingResetArtifacts(artifacts);
  const reference = await measureRehearsalReference();
  const hyperdrive = await assertRehearsalHyperdriveExclusion();
  const backup = await observeStagingProviderBackup(backupId);
  // About 700 initial roots at measured 6–7 seconds per committed batch,
  // plus 119 replay batches, can exceed one hour. Never extend during a run.
  const validUntilMs = Date.now() + 2 * 3_600_000;
  if (backup.expires_at <= validUntilMs || !backup.restored_branch_ids.includes(branchId))
    throw new Error("rehearsal_backup_retention_unproven");
  return withProviderRehearsalOperator(async (admin, operator, runtime) =>
    withProviderRehearsalOperator(async (observer, observedOperator, observedRuntime) => {
      if (operator !== observedOperator || runtime !== observedRuntime)
        throw new Error("rehearsal_identity_changed");
      const target = (
        await admin.query(
          "SELECT current_database() AS database,pg_backend_pid() AS pid,'api_next'::regnamespace::oid AS oid",
        )
      ).rows[0];
      const observerPid = (await observer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await observer.query("SET statement_timeout='5s'");
      const sessions = await observeRehearsalSessions(admin, operator, observerPid);
      assertStagingResetLedger(
        plan,
        (
          await admin.query(
            "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
          )
        ).rows,
      );
      const data = await fingerprintRehearsalData(admin);
      if (data.sha256 !== originalData) throw new Error("rehearsal_capture_data_changed");
      const grants = await readResetGrantCatalog(admin);
      if (grants.defaults_sha256 !== originalDefaults)
        throw new Error("rehearsal_defaults_changed");
      const approved = await compileApprovedStagingPrivileges(admin, runtime);
      // Retain at least one settings-sized allowance per observed connection,
      // plus two additional sessions, and never exceed the reviewed 1,200 cap.
      const clusterBudget = Math.min(1_200, 64 * (25 - sessions.total_sessions - 2));
      assertRehearsalSessionHeadroom(sessions.total_sessions, clusterBudget);
      if (clusterBudget <= 1_000 || sessions.shared_locks >= clusterBudget - 1_000)
        throw new Error("rehearsal_lock_headroom_insufficient");
      const admissionEvidence = {
        mode: execute ? "execute-isolated-rehearsal" : "read-only-provider-plan",
        branch_id: branchId,
        backup_id: backupId,
        source_sha: plan.sourceSha,
        reference,
        data_sha256: data.sha256,
        sessions,
        cluster_budget: clusterBudget,
        production_target: false,
        staging_main_target: false,
      };
      console.log(JSON.stringify(admissionEvidence));
      if (!execute) return admissionEvidence;

      let stopped = false;
      let observerFailed = false;
      let observerFailure: ReturnType<typeof describeRehearsalFailure> | null = null;
      let samples = 0;
      let maximumOwn = 0;
      let maximumCluster = 0;
      let currentClusterBudget = clusterBudget;
      let batchOwn = 0;
      let batchCluster = 0;
      const sample = async () => {
        const row = (
          await observer.query(
            "SELECT count(*) FILTER(WHERE pid=$1)::int AS own,count(*)::int AS cluster FROM pg_catalog.pg_locks WHERE NOT fastpath",
            [target.pid],
          )
        ).rows[0];
        samples++;
        maximumOwn = Math.max(maximumOwn, row.own);
        maximumCluster = Math.max(maximumCluster, row.cluster);
        batchOwn = Math.max(batchOwn, row.own);
        batchCluster = Math.max(batchCluster, row.cluster);
        if (row.own > 1_000 || row.cluster > currentClusterBudget) observerFailed = true;
      };
      const polling = (async () => {
        while (!stopped) {
          try {
            await sample();
          } catch (error) {
            observerFailed = true;
            observerFailure = describeRehearsalFailure(error);
            return;
          }
          await new Promise((done) => setTimeout(done, 100));
        }
      })();
      const fresh = async () => {
        if (observerFailed) throw new Error("rehearsal_lock_observer_failed");
        const currentSessions = await observeRehearsalSessions(admin, operator, observerPid);
        assertRehearsalSessionHeadroom(currentSessions.total_sessions, 1_000);
        currentClusterBudget = Math.min(
          clusterBudget,
          64 * (25 - currentSessions.total_sessions - 2),
        );
        if (currentSessions.shared_locks > currentClusterBudget)
          throw new Error("rehearsal_session_headroom_insufficient");
      };
      const started = performance.now();
      let previous = started;
      const phaseMs = { removing: 0, replaying: 0 };
      let committedBatches = 0;
      try {
        const result = await reconstructStagingInPhases(admin, artifacts, {
          assertFenceAndRecovery: async () => {
            await fresh();
            const current = await assertRehearsalHyperdriveExclusion();
            if (hash(current) !== hash(hyperdrive)) throw new Error("rehearsal_hyperdrive_changed");
            const currentBackup = await observeStagingProviderBackup(backupId);
            if (hash(currentBackup) !== hash(backup)) throw new Error("rehearsal_backup_changed");
          },
          assertBaselineReference: async (sha, digest) => {
            if (sha !== reference.source_sha || digest !== reference.schema_sha256)
              throw new Error("rehearsal_reference_changed");
          },
          assertFreshFence: fresh,
          markerDirectory: resolve(
            import.meta.dir,
            "../../../../.state/staging-reset-rehearsal/abkmnvey02z5",
          ),
          recoveryDigest: hash({ backup, data: data.sha256 }),
          targetAndFenceDigest: hash({ branchId, hyperdrive, sessions }),
          validUntilMs,
          database: target.database,
          role: operator,
          runtimeRole: runtime,
          schemaOid: target.oid,
          defaultsDigest: originalDefaults,
          baselineDigest: reference.schema_sha256,
          reviewedGrants: approved.reviewed,
          grantPolicy: approved.policy,
          removalBudget: {
            maxOwnLockRows: 1_000,
            maxClusterLockRows: clusterBudget,
            maxClosureObjects: 800,
          },
          replayBudget: {
            maxLockRows: 1_000,
            maxClusterLockRows: clusterBudget,
            statementTimeoutMs: 120_000,
          },
          afterBatch: async (phase, count) => {
            committedBatches = count;
            const now = performance.now();
            phaseMs[phase] += now - previous;
            console.log(
              JSON.stringify({
                phase,
                batch: count,
                elapsed_ms: Math.round(now - previous),
                sampled_own_lock_rows: batchOwn,
                sampled_cluster_lock_rows: batchCluster,
                transient_peaks_may_be_missed: true,
              }),
            );
            previous = now;
            batchOwn = 0;
            batchCluster = 0;
          },
        });
        await fresh();
        if (hash(await assertRehearsalHyperdriveExclusion()) !== hash(hyperdrive))
          throw new Error("rehearsal_hyperdrive_changed_after_reset");
        const finalData = await fingerprintRehearsalData(admin);
        // Drain the sampler before declaring success. A late failure during
        // final reads must not be hidden by the unconditional cleanup below.
        stopped = true;
        await polling;
        await sample();
        await fresh();
        const receipt = {
          branch_id: branchId,
          completed_at: new Date().toISOString(),
          wall_ms: Math.round(performance.now() - started),
          phase_ms: phaseMs,
          samples,
          sampled_maximum_own: maximumOwn,
          sampled_maximum_cluster: maximumCluster,
          transient_peaks_may_be_missed: true,
          evidence: result.evidence,
          final_data_sha256: finalData.sha256,
          marker_retained: true,
          paired_release_verified: false,
          restore_after_failure_verified: false,
        };
        console.log(JSON.stringify(receipt));
        return receipt;
      } catch (error) {
        stopped = true;
        await polling;
        console.error(
          JSON.stringify({
            mode: "failed-isolated-rehearsal",
            branch_id: branchId,
            completed_batch_callbacks: committedBatches,
            failure: describeRehearsalFailure(error),
            observer_failure: observerFailure,
            samples,
            sampled_maximum_own: maximumOwn,
            sampled_maximum_cluster: maximumCluster,
            inspect_marker_required: true,
            restore_required_if_any_batch_committed: true,
            automatic_resume: false,
          }),
        );
        throw error;
      } finally {
        stopped = true;
        await polling;
      }
    }),
  );
}

if (import.meta.main) {
  try {
    if (Bun.argv.length !== 3 || !["--dry-run", "--execute"].includes(Bun.argv[2] ?? ""))
      throw new Error();
    await rehearseProviderReset(Bun.argv[2] === "--execute");
  } catch {
    console.error("provider_rehearsal_failed_keep_marker_restore_if_committed");
    process.exitCode = 1;
  }
}
