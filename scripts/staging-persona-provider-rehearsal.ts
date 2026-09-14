import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { compileApprovedStagingPrivileges } from "./staging-persona-approved-privileges";
import { captureDiagnosticFailure } from "./staging-persona-diagnostic-capture.ts";
import { resolveDiagnosticIntent } from "./staging-persona-diagnostic-mode.ts";
import { readResetGrantCatalog } from "./staging-persona-grant-catalog";
import { reconstructStagingInPhases } from "./staging-persona-phased-reset";
import {
  assertResetPreparationComplete,
  removeForbiddenResetGrants,
  withResetAdmissionReporting,
} from "./staging-persona-prepare-reset.ts";
import { observeStagingProviderBackup } from "./staging-persona-provider-backup";
import { describeRehearsalFailure } from "./staging-persona-rehearsal-failure";
import {
  type RehearsalGrantReceipt,
  reconcileRehearsalGrants,
} from "./staging-persona-rehearsal-grants.ts";
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
  assertRestoredFromApprovedBackup,
  rehearsalTarget,
} from "./staging-persona-rehearsal-target.ts";
import { REHEARSAL_VALIDITY_MS } from "./staging-persona-rehearsal-timing.ts";
import { createReleaseMarker } from "./staging-persona-reset-marker.ts";
import {
  assertStagingResetLedger,
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";
import {
  applyStagingUpgradeOnRehearsalBranch,
  STAGING_UPGRADE_RELEASE,
  type StagingUpgradeReceipt,
} from "./staging-persona-upgrade-plan.ts";

// Bound after creation from one place; see staging-persona-rehearsal-target.ts.

const originalDefaults = "f0973701f1b93a794190b0a16ab24126ff6bda647a0d4476f6a00f9d75b2329d";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Fixed isolated branch only. No command here creates a backup, changes a
 * Worker, restores a failed run, removes a marker, or resets staging main.
 * Read-only checks and an independently measured local reference precede DROP.
 */
export async function rehearseProviderReset(execute: boolean, diagnostic = false) {
  // A run that stops between observations left no trace of where it stopped.
  // On 2026-09-09 an attempt exited after roughly a minute having printed
  // nothing, and locating it needed elimination rather than evidence. Each
  // phase now announces itself before it begins, so the last line names the
  // phase that was in flight. Phase names only; no identifiers, no values.
  //
  // These are phase-start markers, not a periodic heartbeat, and the difference
  // matters when reading a stalled run. A phase containing several provider
  // calls reports one line, so the marker narrows the failure to that phase and
  // no further: it cannot say which call inside it stalled, nor distinguish a
  // slow call from a dead process. Widening this is deliberately deferred until
  // a phase's internals actually need locating.
  const startedAt = Date.now();
  const phase = (name: string) =>
    console.log(JSON.stringify({ phase: name, elapsed_ms: Date.now() - startedAt }));
  phase("bind_target");
  // Bound when a run starts, not when this module is imported.
  const boundTarget = rehearsalTarget();
  const branchId = boundTarget.branchId;
  const backupId = boundTarget.backupId;
  const originalData = boundTarget.dataDigest;
  phase("load_artifacts");
  const artifacts = loadStagingResetArtifacts();
  const plan = validateStagingResetArtifacts(artifacts);
  phase("local_reference");
  const reference = await measureRehearsalReference();
  phase("hyperdrive_exclusion");
  const hyperdrive = await assertRehearsalHyperdriveExclusion();
  phase("backup_observation");
  const backup = await observeStagingProviderBackup(backupId);
  // The bound branch must be one this backup actually restored, not merely a
  // branch that agrees about its source.
  assertRestoredFromApprovedBackup(boundTarget, backup);
  // r16 measured 808 removal batches at roughly 9–10 seconds each before the
  // replay batches, so the complete workload can exceed two hours. Never
  // extend this validity during a run.
  const validUntilMs = Date.now() + REHEARSAL_VALIDITY_MS;
  // The owner-authorized diagnostic run only: capture the raw failure chain
  // owner-only and refuse the first destructive statement so a clean window
  // stays diagnostic. Absent the flag both behaviors are exactly as before.
  const markerDirectory = resolve(
    import.meta.dir,
    `../../../../.state/staging-reset-rehearsal/${branchId}`,
  );
  if (backup.expires_at <= validUntilMs || !backup.restored_branch_ids.includes(branchId))
    throw new Error("rehearsal_backup_retention_unproven");
  phase("provider_operator_admission");
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
      // Removal is a mutation and runs only after this run has verified the
      // branch data. It re-observes its own prerequisites — backup linkage,
      // data digest and operator visibility — on the connection that carries
      // the revocations, so nothing here asserts them on its behalf.
      // Authorization is the single value passed, because a decision cannot be
      // observed.
      if (execute) {
        phase("preparation_grant_removal");
        await removeForbiddenResetGrants({ executionAuthorized: execute });
      }
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
      const targetAndFenceDigest = hash({ branchId, hyperdrive, sessions });
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
      let upgrade: StagingUpgradeReceipt | undefined;
      let grantReconciliation: RehearsalGrantReceipt | undefined;
      try {
        // The preparation gate. It does not replace admission, which still runs
        // its own verification; it fails earlier and names the check that is owed.
        phase("preparation_gate");
        await assertResetPreparationComplete(admin, runtime, undefined, {
          cancel: () => {
            (
              admin as { connection?: { stream?: { destroy?: () => void } } }
            ).connection?.stream?.destroy?.();
          },
        });
        const result = await withResetAdmissionReporting(async (observeAdmissionStage) => {
          // The reconstruction admission is its own failure surface. Without
          // this boundary an error thrown here is unallowlisted at the wrapper
          // and both the step and the category are lost; with it the refusal
          // names the step and derives the category from the original cause,
          // while the cause stays in-process and out of the message.
          return reconstructStagingInPhases(admin, artifacts, {
            onAdmissionStage: (stage) => {
              observeAdmissionStage(stage);
            },
            diagnosticStopBeforeFirstBatch: diagnostic,
            assertFenceAndRecovery: async () => {
              await fresh();
              const current = await assertRehearsalHyperdriveExclusion();
              if (hash(current) !== hash(hyperdrive))
                throw new Error("rehearsal_hyperdrive_changed");
              const currentBackup = await observeStagingProviderBackup(backupId);
              if (hash(currentBackup) !== hash(backup)) throw new Error("rehearsal_backup_changed");
            },
            assertBaselineReference: async (sha, digest) => {
              if (sha !== reference.source_sha || digest !== reference.schema_sha256)
                throw new Error("rehearsal_reference_changed");
            },
            assertFreshFence: fresh,
            markerDirectory,
            recoveryDigest: hash({ backup, data: data.sha256 }),
            targetAndFenceDigest,
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
        });
        await fresh();
        if (hash(await assertRehearsalHyperdriveExclusion()) !== hash(hyperdrive))
          throw new Error("rehearsal_hyperdrive_changed_after_reset");
        const postResetData = await fingerprintRehearsalData(admin);
        // The reset marker retires when the reset is verified, before the
        // upgrade mutates anything. This second marker is written before the
        // first upgrade statement and retired only after grant reconciliation
        // commits, so a kill in that interval leaves evidence instead of an
        // 0119 state that looks like a finished reset.
        const releaseMarker = await createReleaseMarker(markerDirectory, {
          targetAndFenceDigest,
          validUntilMs,
        });
        try {
          phase(`upgrade_0120_${STAGING_UPGRADE_RELEASE.terminalVersion.slice(0, 4)}`);
          upgrade = await applyStagingUpgradeOnRehearsalBranch();
          await releaseMarker.advance("reconciling", {
            appliedMigrations: upgrade.applied.length,
            upgradeSourceSha: upgrade.sourceSha,
            upgradeManifestSha256: upgrade.manifestSha256,
          });
          await fresh();
          phase(`grant_reconciliation_${STAGING_UPGRADE_RELEASE.terminalVersion.slice(0, 4)}`);
          grantReconciliation = await reconcileRehearsalGrants(admin, runtime);
          await fresh();
        } catch (error) {
          await releaseMarker
            .advance("failed", {
              appliedMigrations: upgrade?.applied.length ?? 0,
              upgradeSourceSha: upgrade?.sourceSha ?? null,
              upgradeManifestSha256: upgrade?.manifestSha256 ?? null,
            })
            .catch(() => undefined);
          throw error;
        }
        await releaseMarker.completeAfterReconciliation();
        const postUpgradeData = await fingerprintRehearsalData(admin);
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
          post_reset_data_sha256: postResetData.sha256,
          upgrade,
          grant_reconciliation: grantReconciliation,
          post_upgrade_data_sha256: postUpgradeData.sha256,
          release_marker_retired: true,
          marker_retained: true,
          paired_release_verified: false,
          restore_after_failure_verified: false,
        };
        console.log(JSON.stringify(receipt));
        return receipt;
      } catch (error) {
        stopped = true;
        await polling;
        if (diagnostic)
          captureDiagnosticFailure({
            trustedRoot: resolve(import.meta.dir, "../../../../.state/staging-reset-rehearsal"),
            evidenceDirectory: resolve(markerDirectory, "evidence"),
            error,
          });
        console.error(
          JSON.stringify({
            mode: "failed-isolated-rehearsal",
            branch_id: branchId,
            completed_batch_callbacks: committedBatches,
            failure: describeRehearsalFailure(error),
            observer_failure: observerFailure,
            upgrade: upgrade ?? null,
            grant_reconciliation: grantReconciliation ?? null,
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
    if (Bun.argv.length !== 4) throw new Error("rehearsal_mode_required");
    const intent = resolveDiagnosticIntent(Bun.argv[2], Bun.argv[3]);
    await rehearseProviderReset(intent.mode === "--execute", intent.diagnostic);
    console.log(
      JSON.stringify({
        event: "staging_rehearsal_completed",
        mode: intent.mode === "--execute" ? "execute" : "dry-run",
      }),
    );
  } catch (error) {
    // State the reason when it is one of ours. Reproducing a refusal by hand to
    // learn why it refused is not acceptable diagnostics.
    console.error(
      JSON.stringify({
        outcome: "provider_rehearsal_failed_keep_marker_restore_if_committed",
        ...describeRehearsalFailure(error),
      }),
    );
    process.exitCode = 1;
  }
}
