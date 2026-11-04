// Additional INTERNAL application seam; no frozen contract/client modification.
import type { Effect } from "effect";
import type {
  GuestParticipationStoreFailure,
  GuestRecoveryAccess,
} from "./guest-participation-authority.ts";
import type { OwnerSpokenPreArchiveSuccess } from "./owner-spoken-success-protocol.ts";
import type { StudyAudioArchiveResult } from "./study-v2-service.ts";
export interface OwnerGuestSpokenCheckpointRecoveryStore {
  readonly findForAudio: (
    input: Readonly<{
      access: GuestRecoveryAccess;
      communityId: string;
      sessionId: string;
      sessionItemId: string;
      idempotencyKey: string;
      attemptNumber: number;
      audioDigest: string;
      audioContentType: string;
      audioByteSize: number;
      audioDurationMs: number;
    }>,
  ) => Effect.Effect<
    Readonly<{ checkpointId: string; success: OwnerSpokenPreArchiveSuccess }> | null,
    GuestParticipationStoreFailure
  >;
}
export interface OwnerGuestSpokenClosedRecoveryStore {
  readonly list: (
    maximum: number,
  ) => Effect.Effect<readonly Readonly<{ checkpointId: string }>[], GuestParticipationStoreFailure>;
  readonly read: (checkpointId: string) => Effect.Effect<
    Readonly<{
      checkpointId: string;
      success: OwnerSpokenPreArchiveSuccess;
      archive: StudyAudioArchiveResult;
    }> | null,
    GuestParticipationStoreFailure
  >;
}
