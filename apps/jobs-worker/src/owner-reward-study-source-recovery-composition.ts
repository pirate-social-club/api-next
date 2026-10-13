// Internal reviewed composition, no activation/flags/runtime role grants.
import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { makeOwnerGuestSpokenClosedRecovery } from "@pirate/application/owner-guest-spoken-closed-recovery";
import { makeGuestEphemeralCleanupStage } from "@pirate/platform-cf/guest-ephemeral-cleanup";
import { makeControlPlaneGuestStudyResourceExpiry } from "@pirate/platform-cf/guest-study-resource-expiry";
import { makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores } from "@pirate/platform-cf/owner-guest-spoken-checkpoint-recovery-store";
import {
  composeGuestRewardCapturedContinuation,
  makeControlPlaneGuestRewardStudyContinuations,
} from "@pirate/platform-cf/owner-reward-study-continuation";
import { makeControlPlaneOwnerSpokenCapturedContinuationStore } from "@pirate/platform-cf/owner-study-mutations";
import type { Layer } from "effect";
import type { StudySourceRecoveryStages } from "./study-source-recovery-cycle.ts";

type Runtime = Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
export type GuestStudyRecoveryComposition = () => NonNullable<StudySourceRecoveryStages["guest"]>;
/** Explicit reviewed source composition; callers do not infer this from an R2
 * binding, cookie/proof, current provider key, today's lease or a generic flag.
 * Both the Guest cron principal and its exact DELETE bucket are explicit; the
 * Account job session/registration bucket is never used as a fallback.
 * The scheduled production entrypoint currently supplies no such composition.
 */
export function makeOwnerRewardGuestStudyRecoveryComposition(
  runtime: Runtime,
  bucket: Readonly<{ delete: (key: string) => Promise<void> }>,
): GuestStudyRecoveryComposition {
  return () => {
    const retained = makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores(runtime).closed;
    const accepted = makeControlPlaneOwnerSpokenCapturedContinuationStore(runtime);
    const reward = makeControlPlaneGuestRewardStudyContinuations(runtime, accepted);
    const continuation = composeGuestRewardCapturedContinuation(accepted, reward);
    const expiry = makeControlPlaneGuestStudyResourceExpiry(runtime);
    return {
      closed: makeOwnerGuestSpokenClosedRecovery(retained, continuation).run(8),
      capturedChoices: reward.recoverCapturedChoices(8),
      releaseNext: expiry.releaseNext,
      maximumReleases: 4,
      // One bounded exact-original-key stage after closed recovery and expiry.
      // Its SDK owns short SQL transactions around DELETE, never across it.
      ephemeralCleanup: makeGuestEphemeralCleanupStage({ runtime, bucket, maximumDeletes: 4 })(),
    };
  };
}
