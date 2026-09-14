import { Schema } from "effect";
import {
  KaraokeReleasePlan,
  type KaraokeReleaseSurfaces,
} from "./staging-karaoke-release-operation.ts";
import { reconstructStagingInPhases } from "./staging-persona-phased-reset.ts";
import { assertReleaseMarkerAbsent, createReleaseMarker } from "./staging-persona-reset-marker.ts";
import {
  assertStagingUpgradeReceipt,
  type StagingUpgradeReceipt,
} from "./staging-persona-upgrade-plan.ts";
import {
  executeStagingResetRelease,
  type StagingResetReleaseOutcome,
} from "./staging-reset-release-executor.ts";

type ResetArguments = Parameters<typeof reconstructStagingInPhases>;
type ReleaseArguments = Parameters<typeof executeStagingResetRelease>[0];

/** An unresolved release is a failed run, including when all recovery calls
 * succeeded. Keeping its structured outcome prevents a CLI from treating a
 * returned partial result as a successful operation. When the upgrade completed
 * before the failure, its receipt travels with the error: the recovered ledger
 * alone does not tell a reviewer which reviewed span was applied. */
export class StagingResetRunUnresolved extends Error {
  constructor(
    readonly outcome: Extract<StagingResetReleaseOutcome, { disposition: "unresolved" }>,
    readonly upgrade: StagingUpgradeReceipt | undefined = undefined,
  ) {
    super("staging_reset_release_unresolved_restore_required");
    this.name = "StagingResetRunUnresolved";
  }
}

/** The upgrade is not a release surface with a confirmable provider effect to
 * reconcile. The ordinary runner commits pending migrations in one
 * transaction, so a failure leaves either the verified 0119 state or a span
 * without a trusted receipt, and either way the run is unresolved with every
 * fence untouched. This error exists so an upgrade failure is never reported
 * as a failed database surface; the original cause travels with it. */
export class StagingUpgradeFailedRestoreRequired extends Error {
  constructor(
    readonly stage: "marker" | "apply" | "receipt",
    readonly outcome: Extract<StagingResetReleaseOutcome, { disposition: "unresolved" }>,
    options: { cause: unknown },
    readonly upgrade: StagingUpgradeReceipt | undefined = undefined,
  ) {
    super("staging_upgrade_failed_restore_required", options);
    this.name = "StagingUpgradeFailedRestoreRequired";
  }
}

/** Composes the real phased reset, the pinned `0120`–`0166` upgrade and the
 * release in the same process. This accepts the existing trusted admission
 * ports, not JSON approval flags or a deserialized completion receipt. Live
 * callers must bind those ports and the release surfaces to their reviewed
 * target and retained evidence; the rehearsal binding of `upgrade` is
 * `applyStagingUpgradeOnRehearsalBranch`, and the live window needs its own
 * verified binding before it can run.
 *
 * The release configuration is checked before reconstruction can mutate the
 * database. There is one reset invocation and one release invocation, with no
 * retry or restoration inferred from an exit status. The upgrade runs inside
 * the database surface's intent: after the reset completion hook has verified
 * the serving pair, retired the marker and asserted the fence again, and
 * before the first grant is restored or any traffic can reach the pair. That
 * ordering is forced by the reset contract — completion proves the exact 0119
 * ledger — so the schema reaches 0166 while every fence is still held rather
 * than before version activation. Product acceptance here is the pre-producer
 * signup/persona check; asynchronous song acceptance runs only after producers
 * have been released.
 *
 * The release marker is written inside paired completion, before the reset
 * marker is retired, so the handoff is durable rather than a window between
 * two deletions. The isolated rehearsal never calls paired completion and
 * therefore retains its reset marker by design; this handoff exists for the
 * live composition, where completion retires that marker.
 */
export async function reconstructAndReleaseStaging(input: {
  readonly database: ResetArguments[0];
  readonly artifacts: ResetArguments[1];
  readonly admission: ResetArguments[2];
  readonly release: Omit<ReleaseArguments, "reset">;
  /** Applies the reviewed upgrade span; the rehearsal binding is
   * `applyStagingUpgradeOnRehearsalBranch` in `staging-persona-upgrade-plan.ts`. */
  readonly upgrade: {
    readonly apply: () => Promise<StagingUpgradeReceipt>;
  };
}) {
  const plan = Schema.decodeUnknownSync(KaraokeReleasePlan)(structuredClone(input.release.plan));
  if (JSON.stringify(plan.surfaceOrder) !== '["versions","database","ingress","producers"]')
    throw new Error("karaoke_release_approved_order_changed");
  if (
    new Set(plan.resumeQueues.map((queue) => queue.id)).size !== plan.resumeQueues.length ||
    new Set(plan.resumeQueues.map((queue) => queue.name)).size !== plan.resumeQueues.length ||
    new Set(plan.servingWorkers.map((worker) => worker.worker)).size !== plan.servingWorkers.length
  )
    throw new Error("karaoke_release_plan_duplicate_target");
  // A release marker left by an earlier window means the upgrade or its
  // reconciliation was interrupted. Refuse before this run can touch anything.
  await assertReleaseMarkerAbsent(input.admission.markerDirectory);
  // Copy the caller's bindings before any await so a mutable input cannot swap
  // the surfaces or plan after reconstruction has begun.
  const release = {
    ...input.release,
    plan,
    surfaces: { ...input.release.surfaces },
    refence: { ...input.release.refence },
  };
  let upgradeState: "not-started" | "running" | "completed" | "failed" = "not-started";
  let upgradeReceipt: StagingUpgradeReceipt | undefined;
  let upgradeFailure:
    | { readonly stage: "marker" | "apply" | "receipt"; readonly cause: unknown }
    | undefined;
  let releaseMarker: Awaited<ReturnType<typeof createReleaseMarker>> | undefined;
  let handoffFailure: unknown;
  const upgradeBeforeGrants: KaraokeReleaseSurfaces["database"] = async (directive, now) => {
    upgradeState = "running";
    const marker = releaseMarker;
    if (marker === undefined) {
      const error = new Error("release_marker_handoff_missing");
      upgradeState = "failed";
      upgradeFailure = { stage: "marker", cause: error };
      throw error;
    }
    let receipt: StagingUpgradeReceipt;
    try {
      receipt = await input.upgrade.apply();
    } catch (error) {
      upgradeState = "failed";
      upgradeFailure = { stage: "apply", cause: error };
      await marker
        .advance("failed", {
          appliedMigrations: 0,
          upgradeSourceSha: null,
          upgradeManifestSha256: null,
        })
        .catch(() => undefined);
      throw error;
    }
    try {
      assertStagingUpgradeReceipt(receipt);
    } catch (error) {
      upgradeState = "failed";
      upgradeFailure = { stage: "receipt", cause: error };
      await marker
        .advance("failed", {
          appliedMigrations: 0,
          upgradeSourceSha: null,
          upgradeManifestSha256: null,
        })
        .catch(() => undefined);
      throw error;
    }
    upgradeReceipt = receipt;
    upgradeState = "completed";
    try {
      await marker.advance("reconciling", {
        appliedMigrations: receipt.applied.length,
        upgradeSourceSha: receipt.sourceSha,
        upgradeManifestSha256: receipt.manifestSha256,
      });
    } catch (error) {
      upgradeState = "failed";
      upgradeFailure = { stage: "marker", cause: error };
      throw error;
    }
    let surfaceReceipt: Awaited<ReturnType<KaraokeReleaseSurfaces["database"]>>;
    try {
      surfaceReceipt = await release.surfaces.database(directive, now);
    } catch (error) {
      // The upgrade committed but reconciliation did not finish. Mark the
      // window failed and leave the marker on disk; the executor's database
      // recovery owns the fences, and the receipt travels in the outcome.
      await marker
        .advance("failed", {
          appliedMigrations: receipt.applied.length,
          upgradeSourceSha: receipt.sourceSha,
          upgradeManifestSha256: receipt.manifestSha256,
        })
        .catch(() => undefined);
      throw error;
    }
    // Retiring the marker is part of the effect: if it fails, the marker stays
    // in `reconciling` and the run stays unresolved rather than reporting a
    // success it cannot evidence.
    await marker.completeAfterReconciliation();
    return surfaceReceipt;
  };
  const upgradeProgress = (): {
    readonly state: "not-started" | "running" | "completed" | "failed";
    readonly receipt: StagingUpgradeReceipt | undefined;
    readonly failure:
      | { readonly stage: "marker" | "apply" | "receipt"; readonly cause: unknown }
      | undefined;
  } => ({ state: upgradeState, receipt: upgradeReceipt, failure: upgradeFailure });
  const reset = await reconstructStagingInPhases(input.database, input.artifacts, input.admission);
  // The reset marker is retired inside the original completion hook. Writing
  // the replacement first means an interruption between completion and the
  // database surface leaves the release marker instead of neither.
  const resetWithHandoff: typeof reset = {
    ...reset,
    async completeAfterPairedRelease(verifyServingPair) {
      try {
        releaseMarker = await createReleaseMarker(input.admission.markerDirectory, {
          targetAndFenceDigest: input.admission.targetAndFenceDigest,
          validUntilMs: input.admission.validUntilMs,
        });
      } catch (error) {
        handoffFailure = error;
        throw error;
      }
      await reset.completeAfterPairedRelease(verifyServingPair);
    },
  };
  const outcome = await executeStagingResetRelease({
    ...release,
    surfaces: { ...release.surfaces, database: upgradeBeforeGrants },
    reset: resetWithHandoff,
  });
  const progress = upgradeProgress();
  if (outcome.disposition !== "released") {
    if (handoffFailure !== undefined)
      throw new StagingUpgradeFailedRestoreRequired("marker", outcome, { cause: handoffFailure });
    if (progress.state === "failed" && progress.failure)
      throw new StagingUpgradeFailedRestoreRequired(
        progress.failure.stage,
        outcome,
        { cause: progress.failure.cause },
        progress.receipt,
      );
    throw new StagingResetRunUnresolved(outcome, progress.receipt);
  }
  if (progress.state !== "completed" || progress.receipt === undefined)
    throw new Error("staging_release_upgrade_not_composed");
  return { reset, release: outcome, upgrade: progress.receipt };
}
