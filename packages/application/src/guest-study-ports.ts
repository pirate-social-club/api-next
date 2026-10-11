import type {
  GuestParticipationResultV1,
  GuestRewardTermsV1,
  GuestStudyAnswerResultV1,
  GuestStudyPreparedContentV1,
  GuestStudySessionV1,
  GuestStudyStartOperationV1,
  StudyAnswerResultV2,
  StudyAvailabilityV2,
  StudyLearnerBandV2,
  StudySessionV2,
} from "@pirate/contracts";
import type { Effect } from "effect";
import type {
  DurableParticipationOutcome,
  GuestLearningAccess,
  GuestParticipationStoreFailure,
  LearningAccess,
  ParticipationOperationIdentity,
  ParticipationSource,
} from "./guest-participation-authority.ts";
import type {
  StudyAudioArchiveResult,
  StudyBatchTranscript,
  StudySpokenAnswerContext,
  StudyV2Store,
} from "./study-v2-service.ts";

type Result<A> = Effect.Effect<A, GuestParticipationStoreFailure>;
export type OwnerStudySession =
  | Readonly<{ source: Extract<ParticipationSource, { kind: "account" }>; session: StudySessionV2 }>
  | Readonly<{
      source: Extract<ParticipationSource, { kind: "guest" }>;
      session: GuestStudySessionV1;
    }>;
export type OwnerStudyAnswer =
  | Readonly<{
      source: Extract<ParticipationSource, { kind: "account" }>;
      answer: StudyAnswerResultV2;
      participation: GuestParticipationResultV1;
    }>
  | Readonly<{
      source: Extract<ParticipationSource, { kind: "guest" }>;
      answer: GuestStudyAnswerResultV1;
      participation: GuestParticipationResultV1;
    }>;
type ReadInput<K extends keyof StudyV2Store> = Omit<Parameters<StudyV2Store[K]>[0], "accountId"> &
  Readonly<{ access: LearningAccess }>;
type MutationInput<K extends keyof StudyV2Store> = ReadInput<K> &
  Readonly<{
    source: ParticipationSource;
    operation: ParticipationOperationIdentity;
  }>;
export type OwnerSpokenReservation =
  | Readonly<{
      state: "reserved";
      commandId: string;
      leaseToken: string;
      attemptId: string;
      artifactId: string;
      resourceReservationId: string;
      deletionFenceRevision: number;
    }>
  | Readonly<{ state: "completed"; result: OwnerStudyAnswer }>
  | Readonly<{ state: "pending_confirmation"; operation: ParticipationOperationIdentity }>;
export type OwnerSpokenSuccessfulCheckpoint = Readonly<{
  source: ParticipationSource;
  operation: ParticipationOperationIdentity;
  commandId: string;
  result: Omit<Parameters<StudyV2Store["completeSpokenAnswer"]>[0], "accountId">;
  providerResult: StudyBatchTranscript;
  resourceReservationId: string;
  deletionFenceRevision: number;
}>;
export interface PreparedGuestStudyContentStore {
  readonly get: (
    input: Readonly<{
      communityId: string;
      postId: string;
      targetLanguage: string | null;
      learnerBand: StudyLearnerBandV2 | null;
    }>,
  ) => Result<GuestStudyPreparedContentV1>;
}
/** Successor protocol. Existing account-v2 store and response schemas remain intact. */
export interface OwnerAwareStudyV2Store {
  readonly getAvailability: (input: ReadInput<"getAvailability">) => Result<StudyAvailabilityV2>;
  readonly startSession: (
    input: Omit<MutationInput<"startSession">, "personaId" | "access"> &
      Readonly<{
        access: GuestLearningAccess;
        source: Extract<ParticipationSource, { kind: "guest" }>;
        rewardMode: "practice_only" | "megapot_guest_v1";
        rewardTerms: GuestRewardTermsV1 | null;
        disclosure: Readonly<{ version: string; accepted: boolean }>;
        resourceReservationId: string;
      }>,
  ) => Result<DurableParticipationOutcome<OwnerStudySession>>;
  /** Resolve immutable source from the resource, then authorize access. No caller source/key. */
  readonly getSession: (input: ReadInput<"getSession">) => Result<OwnerStudySession | null>;
  readonly submitAnswer: (
    input: MutationInput<"submitAnswer">,
  ) => Result<DurableParticipationOutcome<OwnerStudyAnswer>>;
  readonly loadSpokenAnswerContext: (
    input: ReadInput<"loadSpokenAnswerContext">,
  ) => Result<Readonly<{ source: ParticipationSource; context: StudySpokenAnswerContext }>>;
  readonly reserveSpokenAnswer: (
    input: MutationInput<"reserveSpokenAnswer"> &
      Readonly<{ resourceReservationId: string; deletionFenceRevision: number }>,
  ) => Result<OwnerSpokenReservation>;
  readonly failSpokenAnswer: (
    input: MutationInput<"failSpokenAnswer"> &
      Readonly<{
        providerDisposition: "not_invoked" | "failed" | "unknown";
        resourceReservationId: string;
      }>,
  ) => Result<DurableParticipationOutcome<void>>;
  /** Persist before retryable reward finalization. Replay cannot regrade or rebill. */
  readonly persistSuccessfulSpokenResult: (
    input: Readonly<{ access: LearningAccess; checkpoint: OwnerSpokenSuccessfulCheckpoint }>,
  ) => Result<DurableParticipationOutcome<Readonly<{ checkpointId: string }>>>;
  readonly completeSpokenAnswer: (
    input: Readonly<{
      access: LearningAccess;
      checkpointId: string;
      source: ParticipationSource;
      operation: ParticipationOperationIdentity;
    }>,
  ) => Result<DurableParticipationOutcome<OwnerStudyAnswer>>;
  /** Read-only lookup of the original owner's start; absence is not an abort witness. */
  readonly findStartOperation: (
    input: Readonly<{
      access: LearningAccess;
      sourceOwnerId: string;
      communityId: string;
      postId: string;
      idempotencyKey: string;
    }>,
  ) => Result<GuestStudyStartOperationV1>;
}
export interface OwnerStudyAudioArchive {
  /** External storage call runs outside SQL. Finalization rechecks this fence/reservation. */
  readonly store: (
    input: Readonly<{
      source: ParticipationSource;
      operation: ParticipationOperationIdentity;
      artifactId: string;
      resourceReservationId: string;
      deletionFenceRevision: number;
      audio: Uint8Array;
      contentType: string;
      contentDigest: string;
    }>,
  ) => Effect.Effect<StudyAudioArchiveResult>;
}
export type OwnerSpokenRecoveryRecord = Readonly<{
  source: ParticipationSource;
  operation: ParticipationOperationIdentity;
  commandId: string;
  leaseToken: string;
  resourceReservationId: string;
  checkpointId: string | null;
  state:
    | "provider_not_started"
    | "provider_unknown"
    | "result_persisted"
    | "finalization_pending"
    | "completed";
}>;
export interface OwnerStudySpokenAnswerRecoveryStore {
  readonly claimExpired: (
    input: Readonly<{ leaseToken: string; leaseUntil: string; limit: number }>,
  ) => Result<readonly OwnerSpokenRecoveryRecord[]>;
  readonly loadSuccessfulCheckpoint: (
    input: Readonly<{ record: OwnerSpokenRecoveryRecord }>,
  ) => Result<OwnerSpokenSuccessfulCheckpoint | null>;
  readonly finalizePersistedResult: (
    input: Readonly<{ record: OwnerSpokenRecoveryRecord; checkpointId: string }>,
  ) => Result<DurableParticipationOutcome<OwnerStudyAnswer>>;
  readonly retainUnknownProvider: (
    input: Readonly<{ record: OwnerSpokenRecoveryRecord }>,
  ) => Result<void>;
}
