import type { Effect } from "effect";
import type { LearnerAudioUploadCapture } from "./learner-audio-capture.ts";
import type { StudyV2Failure, StudyV2Store } from "./study-v2-service.ts";
export type AccountSpokenSuccess = Omit<
  Parameters<StudyV2Store["completeSpokenAnswer"]>[0],
  "archive"
>;
/** Ordinary account-private protocol, not a fabricated OwnerAware resource reservation. */
export interface AccountStudyCaptureProtocol {
  readonly beginProvider: (
    capture: LearnerAudioUploadCapture,
  ) => Effect.Effect<void, StudyV2Failure>;
  readonly providerUnknown: (
    capture: LearnerAudioUploadCapture,
  ) => Effect.Effect<void, StudyV2Failure>;
  readonly persistSuccess: (
    capture: LearnerAudioUploadCapture,
    result: AccountSpokenSuccess,
  ) => Effect.Effect<AccountSpokenSuccess, StudyV2Failure>;
}
