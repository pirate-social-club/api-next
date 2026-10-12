// Additional INTERNAL captured continuation. No frozen-port/wire edit.
import type { Effect } from "effect";
import type {
  DurableParticipationOutcome,
  GuestParticipationStoreFailure,
} from "./guest-participation-authority.ts";
import type {
  OwnerAwareStudyV2Store,
  OwnerSpokenSuccessfulCheckpoint,
  OwnerStudyAnswer,
} from "./guest-study-ports.ts";
/** Already accepted provider/checkpoint authority only. Implementations retain
 * original source/op/lease/resource/fence/call/upload correlation. No fresh
 * cookie/learning lease/current config, provider redispatch or regrading.
 * Account captured IO references never stand in for paid resource authority.
 */
export interface OwnerSpokenCapturedContinuationStore {
  readonly acknowledgeCapturedSpokenResult: (
    input: Readonly<{ checkpoint: OwnerSpokenSuccessfulCheckpoint }>,
  ) => Effect.Effect<
    DurableParticipationOutcome<Readonly<{ checkpointId: string }>>,
    GuestParticipationStoreFailure
  >;
  readonly completeCapturedSpokenAnswer: (
    input: Omit<Parameters<OwnerAwareStudyV2Store["completeSpokenAnswer"]>[0], "access">,
  ) => Effect.Effect<DurableParticipationOutcome<OwnerStudyAnswer>, GuestParticipationStoreFailure>;
}
