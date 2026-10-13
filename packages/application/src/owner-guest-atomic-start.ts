// Additional INTERNAL atomic application protocol. Frozen ports stay unchanged.
import type { Effect } from "effect";
import type {
  GuestResourceAdmissionPolicy,
  GuestResourceReservation,
} from "./guest-learning-resource-admission.ts";
import type {
  DurableParticipationOutcome,
  GuestParticipationStoreFailure,
} from "./guest-participation-authority.ts";
import type { OwnerAwareStudyV2Store, OwnerStudySession } from "./guest-study-ports.ts";

export type OwnerGuestAtomicStartInput = Omit<
  Parameters<OwnerAwareStudyV2Store["startSession"]>[0],
  "resourceReservationId"
> &
  Readonly<{
    trustedEdge: Readonly<{ kind: "trusted_edge"; fingerprint: string }>;
    policy: GuestResourceAdmissionPolicy | null;
    freshRefusalOperationId: string;
    /** NEW rewarded start only. Actual trusted terms are selected after original
     * SQL replay and the atomic prepared-source plan, then frozen under locks. */
    acceptedRewardPreviewTermsHash?: string;
  }>;
/** Adapter returns only after owning COMMIT acknowledges. Authoritative
 * refusal's resource operation and main known-aborted witness commit together.
 * App maps refusal OUTSIDE that transaction. Absence is never an abort.
 */
export type OwnerGuestAtomicStartOutcome =
  | Readonly<{
      kind: "start";
      outcome: DurableParticipationOutcome<OwnerStudySession>;
    }>
  | Readonly<{
      kind: "resource_refused";
      outcome: DurableParticipationOutcome<GuestResourceReservation>;
    }>;
export interface OwnerGuestAtomicStarter {
  readonly startPreparedSession: (
    input: OwnerGuestAtomicStartInput,
  ) => Effect.Effect<OwnerGuestAtomicStartOutcome, GuestParticipationStoreFailure>;
}
