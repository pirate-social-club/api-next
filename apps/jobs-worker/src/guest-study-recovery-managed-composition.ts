import {
  type GuestStudyManagedControlPlaneBindings,
  makeGuestStudyManagedControlPlanes,
} from "@pirate/platform-cf/guest-study-managed-control-planes";
import { makeGuestStudyManagedReadiness } from "@pirate/platform-cf/guest-study-managed-readiness";
import {
  type HyperdriveConnection,
  makeHyperdriveControlPlaneLayer,
} from "@pirate/platform-cf/postgres";
import { Schema } from "effect";
import { makeOwnerRewardGuestStudyRecoveryComposition } from "./owner-reward-study-source-recovery-composition.ts";
import {
  type GuestStudyRecoveryComposition,
  makeGuestStudyRecoveryComposition,
} from "./study-source-recovery-composition.ts";

export interface GuestStudyRecoveryManagedBindings extends GuestStudyManagedControlPlaneBindings {
  readonly GUEST_STUDY_SERVING_ENABLED?: string;
  readonly CONTROL_PLANE?: HyperdriveConnection;
  readonly GUEST_STUDY_REWARDS_ENABLED?: string;
  readonly LEARNER_AUDIO?: Pick<R2Bucket, "put" | "delete">;
}
/** Called once per scheduled event before registry selection. The actual Guest
 * runtime always comes from GUEST_STUDY_CRON, never ordinary CONTROL_PLANE.
 * Complete native/read-only inspection occurs before any source reconciliation,
 * expiry, cleanup, provider or storage request is queued. */
export async function makeDefaultGuestStudyRecoveryComposition(
  bindings: GuestStudyRecoveryManagedBindings,
  environment: string,
): Promise<GuestStudyRecoveryComposition | undefined> {
  const learning = bindings.GUEST_STUDY_SERVING_ENABLED,
    financial = bindings.GUEST_STUDY_REWARDS_ENABLED;
  if (financial !== undefined && financial !== "false" && financial !== "true")
    throw new Error("Guest financial recovery selector invalid");
  if (learning === undefined || learning === "false") {
    if (financial === "true") throw new Error("Financial recovery requires learning admission");
    return undefined;
  }
  if (learning !== "true" || !["development", "staging", "test"].includes(environment))
    throw new Error("Guest recovery requires explicit nonproduction admission");
  const bucket = bindings.LEARNER_AUDIO;
  if (
    bucket === undefined ||
    typeof bucket.put !== "function" ||
    typeof bucket.delete !== "function"
  )
    throw new Error("Guest recovery learner-audio binding unavailable");
  const actual = makeGuestStudyManagedControlPlanes(bindings);
  let ordinaryAccount: ReturnType<typeof makeHyperdriveControlPlaneLayer> | undefined;
  if (financial === "true") {
    const core = Schema.decodeUnknownSync(
      Schema.Struct({ connectionString: Schema.NonEmptyString }),
    )(bindings.CONTROL_PLANE);
    if (core.connectionString.trim() !== core.connectionString)
      throw new Error("Ordinary Account database binding unavailable");
    ordinaryAccount = makeHyperdriveControlPlaneLayer(core, {
      connectTimeoutMs: 3000,
      statementTimeoutMs: 2000,
      closeTimeoutMs: 2000,
    });
  }
  const readiness = makeGuestStudyManagedReadiness(
    {
      ...actual,
      ...(ordinaryAccount === undefined ? {} : { ordinaryAccount }),
      workerLearnerAudioBinding: bucket,
      selectedLearnerAudioBinding: bucket,
    },
    { roleProfile: financial === "true" ? "owner_financial" : "practice" },
  );
  await readiness.verify();
  if (financial === "true") {
    if (ordinaryAccount === undefined)
      throw new Error("Verified ordinary Account recovery binding unavailable");
    // This exact layer participated in the five-principal native inspection.
    // Practice callback presence supplies no Account financial authority.
    return Object.freeze(
      Object.assign(makeOwnerRewardGuestStudyRecoveryComposition(actual.cron, bucket), {
        accountOriginalAdmissionRuntime: ordinaryAccount,
      }),
    );
  }
  return makeGuestStudyRecoveryComposition(actual.cron, bucket);
}
