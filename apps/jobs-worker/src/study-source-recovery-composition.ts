// Internal reviewed composition, no activation/flags/runtime role grants.
import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { makeOwnerGuestSpokenClosedRecovery } from "@pirate/application/owner-guest-spoken-closed-recovery";
import { makeControlPlaneAccountOriginalAdmissionReconciliation } from "@pirate/platform-cf/account-original-admission-reconciliation";
import { makeControlPlaneAccountOwnerRewardHooks } from "@pirate/platform-cf/account-owner-reward-hooks";
import { makeControlledAccountSpokenRecovery } from "@pirate/platform-cf/controlled-account-spoken-recovery";
import { makeControlledAccountStudyV2Store } from "@pirate/platform-cf/controlled-account-study-store";
import { makeGuestEphemeralCleanupStage } from "@pirate/platform-cf/guest-ephemeral-cleanup";
import { makeControlPlaneGuestStudyResourceExpiry } from "@pirate/platform-cf/guest-study-resource-expiry";
import { makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores } from "@pirate/platform-cf/owner-guest-spoken-checkpoint-recovery-store";
import { makeControlPlaneOwnerSpokenCapturedContinuationStore } from "@pirate/platform-cf/owner-study-mutations";
import type { Layer } from "effect";
import type { StudySourceRecoveryStages } from "./study-source-recovery-cycle.ts";

type Runtime = Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
export type GuestStudyRecoveryComposition = (() => NonNullable<
  StudySourceRecoveryStages["guest"]
>) & {
  /** Only the verified financial factory attaches this actual Account layer. */
  readonly accountOriginalAdmissionRuntime?: Runtime;
};
/** Explicit reviewed source composition; callers do not infer this from an R2
 * binding, cookie/proof, current provider key, today's lease or a generic flag.
 * Both the Guest cron principal and its exact DELETE bucket are explicit; the
 * Account job session/registration bucket is never used as a fallback.
 * The scheduled production entrypoint currently supplies no such composition.
 */
export function makeGuestStudyRecoveryComposition(
  runtime: Runtime,
  bucket: Readonly<{ delete: (key: string) => Promise<void> }>,
): GuestStudyRecoveryComposition {
  return () => {
    const retained = makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores(runtime).closed;
    const continuation = makeControlPlaneOwnerSpokenCapturedContinuationStore(runtime);
    const expiry = makeControlPlaneGuestStudyResourceExpiry(runtime);
    return {
      closed: makeOwnerGuestSpokenClosedRecovery(retained, continuation).run(8),
      releaseNext: expiry.releaseNext,
      maximumReleases: 4,
      // One bounded exact-original-key stage after closed recovery and expiry.
      // Its SDK owns short SQL transactions around DELETE, never across it.
      ephemeralCleanup: makeGuestEphemeralCleanupStage({ runtime, bucket, maximumDeletes: 4 })(),
    };
  };
}
export function makeStudySourceRecoveryStages(
  runtime: Runtime,
  guest?: GuestStudyRecoveryComposition,
  accountOriginalAdmissionReconciliation?: Runtime,
): StudySourceRecoveryStages {
  const originalRewards = makeControlPlaneAccountOwnerRewardHooks(runtime, null);
  const accountStore = makeControlledAccountStudyV2Store(runtime, undefined, originalRewards);
  const account = makeControlledAccountSpokenRecovery(runtime, accountStore.finalize);
  return {
    account: account.recover(),
    ...(accountOriginalAdmissionReconciliation === undefined
      ? {}
      : {
          accountOriginalAdmissionReconciliation:
            makeControlPlaneAccountOriginalAdmissionReconciliation(
              accountOriginalAdmissionReconciliation,
            ).recover(8),
        }),
    ...(guest === undefined ? {} : { guest: guest() }),
  };
}
