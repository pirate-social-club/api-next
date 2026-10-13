// Internal reviewed composition, no activation/flags/runtime role grants.
import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { makeOwnerGuestSpokenClosedRecovery } from "@pirate/application/owner-guest-spoken-closed-recovery";
import { makeControlledAccountStudyV2Store } from "@pirate/platform-cf/controlled-account-study-store";
import { makeControlledAccountSpokenRecovery } from "@pirate/platform-cf/controlled-account-spoken-recovery";
import { makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores } from "@pirate/platform-cf/owner-guest-spoken-checkpoint-recovery-store";
import { makeControlPlaneOwnerSpokenCapturedContinuationStore } from "@pirate/platform-cf/owner-study-mutations";
import { makeControlPlaneGuestStudyResourceExpiry } from "@pirate/platform-cf/guest-study-resource-expiry";
import type { Layer } from "effect";
import type { StudySourceRecoveryStages } from "./study-source-recovery-cycle.ts";
type Runtime = Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
export type GuestStudyRecoveryComposition = () => NonNullable<StudySourceRecoveryStages["guest"]>;
/** Explicit reviewed source composition; callers do not infer this from an R2
 * binding, cookie/proof, current provider key, today's lease or a generic flag.
 * The scheduled production entrypoint currently supplies no such composition.
 */
export function makeGuestStudyRecoveryComposition(runtime: Runtime): GuestStudyRecoveryComposition {
  return () => {
    const retained = makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores(runtime).closed;
    const continuation = makeControlPlaneOwnerSpokenCapturedContinuationStore(runtime);
    const expiry = makeControlPlaneGuestStudyResourceExpiry(runtime);
    return {
      closed: makeOwnerGuestSpokenClosedRecovery(retained, continuation).run(8),
      releaseNext: expiry.releaseNext,
      maximumReleases: 4,
    };
  };
}
export function makeStudySourceRecoveryStages(
  runtime: Runtime,
  guest?: GuestStudyRecoveryComposition,
): StudySourceRecoveryStages {
  const accountStore = makeControlledAccountStudyV2Store(runtime);
  const account = makeControlledAccountSpokenRecovery(runtime, accountStore.finalize);
  return { account: account.recover(), ...(guest === undefined ? {} : { guest: guest() }) };
}
