import type {
  StudyAnswerResultV2,
  StudyAnswerSubmissionV2,
  StudyAvailabilityV2,
  StudyLearnerBandV2,
  StudySessionItemV2,
  StudySessionV2,
} from "@pirate/contracts";
import { gradeTranscriptV2, type StudyTranscriptGradeV2 } from "@pirate/domain";
import { Data, Effect } from "effect";
import { Clock, IdGen } from "./ports.ts";
import { canonicalBodyHash } from "./use-cases/content/common.ts";

export class StudyV2StoreFailed extends Data.TaggedError("StudyV2StoreFailed")<{
  readonly reason: "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class StudyV2CommandRejected extends Data.TaggedError("StudyV2CommandRejected")<{
  readonly reason:
    | "attempt-conflict"
    | "command-in-flight"
    | "idempotency-conflict"
    | "insufficient-exercises"
    | "invalid-input"
    | "not-found"
    | "provider-unavailable"
    | "submission-kind-mismatch"
    | "transcript-evidence-expired"
    | "transcript-evidence-mismatch"
    | "transcript-evidence-not-found";
}> {}

export type StudyV2Failure = StudyV2StoreFailed | StudyV2CommandRejected;

export type StudySpokenAnswerContext = Readonly<{
  item: StudySessionItemV2;
  referenceText: string;
  dominantLanguage: string | null;
}>;

export type StudySpokenAnswerReservation =
  | Readonly<{
      state: "reserved";
      commandId: string;
      leaseToken: string;
      attemptId: string;
      artifactId: string;
    }>
  | Readonly<{ state: "completed"; result: StudyAnswerResultV2 }>;

export type StudyBatchTranscript = Readonly<{
  transcript: string;
  detectedLanguage: string | null;
  detectedLanguageConfidence: number | null;
}>;

export class StudyBatchTranscriptionFailed extends Data.TaggedError(
  "StudyBatchTranscriptionFailed",
)<{
  readonly reason:
    | "invalid-response"
    | "misconfigured"
    | "rate-limited"
    | "timeout"
    | "unavailable";
}> {}

export interface StudyBatchTranscriber {
  readonly transcribe: (input: {
    readonly audio: Uint8Array;
    readonly contentType: string;
    readonly languageHint: string | null;
  }) => Effect.Effect<StudyBatchTranscript, StudyBatchTranscriptionFailed>;
}

export type StudyAudioArchiveResult =
  | Readonly<{ state: "stored"; objectRef: string }>
  | Readonly<{ state: "failed"; objectRef: null }>;

export interface StudyAudioArchive {
  readonly store: (input: {
    readonly accountId: string;
    readonly attemptRef: string;
    readonly audio: Uint8Array;
    readonly contentType: string;
    readonly contentDigest: string;
  }) => Effect.Effect<StudyAudioArchiveResult>;
}

export interface StudyV2Store {
  readonly getAvailability: (input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly postId: string;
  }) => Effect.Effect<StudyAvailabilityV2, StudyV2Failure>;
  readonly startSession: (input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly createdAt: string;
    readonly targetLanguage: string | null;
    readonly idempotencyKey: string;
    readonly learnerBand: StudyLearnerBandV2 | null;
    readonly personaId: string;
    readonly postId: string;
    readonly requestHash: string;
    readonly sessionId: string;
    readonly timezone: string;
  }) => Effect.Effect<StudySessionV2, StudyV2Failure>;
  readonly getSession: (input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly sessionId: string;
  }) => Effect.Effect<StudySessionV2 | null, StudyV2Failure>;
  readonly submitAnswer: (input: {
    readonly accountId: string;
    readonly acceptedAt: string;
    readonly answer: StudyAnswerSubmissionV2;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly communityId: string;
    readonly idempotencyKey: string;
    readonly qualificationId: string;
    readonly requestHash: string;
    readonly sessionId: string;
    readonly sessionItemId: string;
  }) => Effect.Effect<StudyAnswerResultV2, StudyV2Failure>;
  readonly loadSpokenAnswerContext: (input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly sessionId: string;
    readonly sessionItemId: string;
  }) => Effect.Effect<StudySpokenAnswerContext, StudyV2Failure>;
  readonly reserveSpokenAnswer: (input: {
    readonly accountId: string;
    readonly attemptNumber: number;
    readonly audioByteSize: number;
    readonly audioContentType: string;
    readonly audioDigest: string;
    readonly audioDurationMs: number;
    readonly commandId: string;
    readonly attemptId: string;
    readonly artifactId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly leaseToken: string;
    readonly sessionId: string;
    readonly sessionItemId: string;
  }) => Effect.Effect<StudySpokenAnswerReservation, StudyV2Failure>;
  readonly failSpokenAnswer: (input: {
    readonly accountId: string;
    readonly commandId: string;
    readonly leaseToken: string;
    readonly failedAt: string;
    readonly providerFailureKind: string;
  }) => Effect.Effect<void, StudyV2Failure>;
  readonly completeSpokenAnswer: (input: {
    readonly accountId: string;
    readonly acceptedAt: string;
    readonly archive: StudyAudioArchiveResult;
    readonly artifactId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly audioByteSize: number;
    readonly audioContentType: string;
    readonly audioDigest: string;
    readonly audioDurationMs: number;
    readonly commandId: string;
    readonly leaseToken: string;
    readonly communityId: string;
    readonly grade: StudyTranscriptGradeV2;
    readonly providerDetectedLanguage: string | null;
    readonly providerDetectedLanguageConfidence: number | null;
    readonly qualificationId: string;
    readonly requestHash: string;
    readonly sessionId: string;
    readonly sessionItemId: string;
  }) => Effect.Effect<StudyAnswerResultV2, StudyV2Failure>;
}

const rejected = (reason: StudyV2CommandRejected["reason"]) =>
  new StudyV2CommandRejected({ reason });

const hash = (value: unknown) =>
  canonicalBodyHash(value).pipe(Effect.mapError(() => rejected("invalid-input")));

const instant = (milliseconds: number): string => new Date(milliseconds).toISOString();

const sha256Hex = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", bytes),
    catch: () => rejected("invalid-input"),
  }).pipe(
    Effect.map((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

export const makeStudyV2Service = (
  store: StudyV2Store,
  spoken?: Readonly<{ transcriber: StudyBatchTranscriber; archive: StudyAudioArchive }>,
) => ({
  getAvailability: store.getAvailability,
  getSession: (input: Parameters<StudyV2Store["getSession"]>[0]) =>
    store
      .getSession(input)
      .pipe(
        Effect.flatMap((session) =>
          session === null ? Effect.fail(rejected("not-found")) : Effect.succeed(session),
        ),
      ),
  startSession: (
    input: Omit<
      Parameters<StudyV2Store["startSession"]>[0],
      "createdAt" | "requestHash" | "sessionId"
    >,
  ) =>
    Effect.gen(function* () {
      const requestHash = yield* hash(input);
      const ids = yield* IdGen;
      const clock = yield* Clock;
      return yield* store.startSession({
        ...input,
        requestHash,
        sessionId: `study_v2_${yield* ids.next}`,
        createdAt: instant(yield* clock.now),
      });
    }),
  submitAnswer: (
    input: Omit<
      Parameters<StudyV2Store["submitAnswer"]>[0],
      "acceptedAt" | "attemptId" | "qualificationId" | "requestHash"
    >,
  ) =>
    Effect.gen(function* () {
      const requestHash = yield* hash(input);
      const ids = yield* IdGen;
      const clock = yield* Clock;
      return yield* store.submitAnswer({
        ...input,
        requestHash,
        attemptId: `study_attempt_v2_${yield* ids.next}`,
        qualificationId: `qualification_${yield* ids.next}`,
        acceptedAt: instant(yield* clock.now),
      });
    }),
  submitSpokenAnswer: (input: {
    readonly accountId: string;
    readonly attemptNumber: number;
    readonly audio: Uint8Array;
    readonly audioContentType: string;
    readonly audioDurationMs: number;
    readonly communityId: string;
    readonly idempotencyKey: string;
    readonly sessionId: string;
    readonly sessionItemId: string;
  }) =>
    Effect.gen(function* () {
      if (spoken === undefined) return yield* rejected("provider-unavailable");
      const context = yield* store.loadSpokenAnswerContext(input);
      const audioDigest = yield* sha256Hex(input.audio);
      const requestHash = yield* hash({
        audio_digest: audioDigest,
        audio_byte_size: input.audio.byteLength,
        audio_content_type: input.audioContentType,
        audio_duration_ms: input.audioDurationMs,
        attempt_number: input.attemptNumber,
        session_id: input.sessionId,
        session_item_id: input.sessionItemId,
        study_unit_id: context.item.line.study_unit_id,
        source_line_revision: context.item.line.line_version,
        language_profile_revision: context.item.language_profile_revision,
        grading_revision: context.item.grader_policy_revision,
      });
      const ids = yield* IdGen;
      const clock = yield* Clock;
      const commandId = `study_spoken_${yield* ids.next}`;
      const attemptId = `study_attempt_v2_${yield* ids.next}`;
      const artifactId = `learner_audio_${yield* ids.next}`;
      const leaseToken = `study_spoken_lease_${yield* ids.next}`;
      const reservation = yield* store.reserveSpokenAnswer({
        ...input,
        audioByteSize: input.audio.byteLength,
        commandId,
        attemptId,
        artifactId,
        leaseToken,
        requestHash,
        audioDigest,
      });
      if (reservation.state === "completed") return reservation.result;
      const reservedCommandId = reservation.commandId;
      const reservedLeaseToken = reservation.leaseToken;

      const transcript = yield* spoken.transcriber
        .transcribe({
          audio: input.audio,
          contentType: input.audioContentType,
          languageHint:
            context.dominantLanguage === null || context.item.language_profile_revision === null
              ? null
              : context.dominantLanguage,
        })
        .pipe(
          Effect.catch((failure) =>
            Effect.gen(function* () {
              yield* store.failSpokenAnswer({
                accountId: input.accountId,
                commandId: reservedCommandId,
                leaseToken: reservedLeaseToken,
                failedAt: instant(yield* clock.now),
                providerFailureKind: failure.reason,
              });
              return yield* rejected("provider-unavailable");
            }),
          ),
        );
      const archive = yield* spoken.archive.store({
        accountId: input.accountId,
        attemptRef: reservation.attemptId,
        audio: input.audio,
        contentType: input.audioContentType,
        contentDigest: audioDigest,
      });
      const acceptedAt = instant(yield* clock.now);
      return yield* store.completeSpokenAnswer({
        ...input,
        acceptedAt,
        archive,
        artifactId: reservation.artifactId,
        attemptId: reservation.attemptId,
        audioByteSize: input.audio.byteLength,
        audioDigest,
        commandId: reservedCommandId,
        leaseToken: reservedLeaseToken,
        grade: gradeTranscriptV2(
          context.referenceText,
          transcript.transcript,
          context.dominantLanguage,
        ),
        providerDetectedLanguage: transcript.detectedLanguage,
        providerDetectedLanguageConfidence: transcript.detectedLanguageConfidence,
        qualificationId: `qualification_${yield* ids.next}`,
        requestHash,
      });
    }),
});
