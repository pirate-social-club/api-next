// Additional private application composition. No frozen interface/wire edit.

import { StartGuestStudySessionV1, StudyAnswerSubmissionV2 } from "@pirate/contracts";
import {
  STUDY_TRANSCRIPT_GRADER_POLICY_V1,
  STUDY_TRANSCRIPT_GRADER_POLICY_V2,
  STUDY_TRANSCRIPT_GRADER_POLICY_V3,
  STUDY_TRANSCRIPT_GRADER_POLICY_V4,
  type StudyTranscriptGraderPolicyRevision,
} from "@pirate/domain";
import { Data, Effect, Schema } from "effect";
import type { GuestResourceAdmissionPolicy } from "./guest-learning-resource-admission.ts";
import {
  type DurableParticipationOutcome,
  type GuestLearningAccess,
  type GuestParticipationStoreFailure,
  GuestParticipationStoreRejected,
  type LearningAccess,
  type ParticipationOperationIdentity,
  type ParticipationSource,
} from "./guest-participation-authority.ts";
import type {
  OwnerAwareStudyV2Store,
  OwnerStudyAnswer,
  OwnerStudySession,
  PreparedGuestStudyContentStore,
} from "./guest-study-ports.ts";
import type {
  OwnerSpokenPreArchiveSuccess,
  OwnerSpokenSuccessFailure,
} from "./owner-spoken-success-protocol.ts";
import { Clock, IdGen } from "./ports.ts";
import { gradeStudySpokenTranscript } from "./study-shared-lesson-engine.ts";
import type {
  StudyBatchTranscriber,
  StudyBatchTranscript,
  StudyBatchTranscriptionFailed,
  StudySpokenAnswerContext,
} from "./study-v2-service.ts";
import { canonicalBodyHash } from "./use-cases/content/common.ts";

type GuestSource = Extract<ParticipationSource, { kind: "guest" }>;
type AnswerPath = Readonly<{
  communityId: string;
  sessionId: string;
  sessionItemId: string;
}>;
type AnswerCommand = AnswerPath &
  Readonly<{
    access: LearningAccess;
    idempotencyKey: string;
    attemptNumber: number;
  }>;

import type { OwnerGuestAtomicStarter } from "./owner-guest-atomic-start.ts";

export type {
  OwnerGuestAtomicStarter,
  OwnerGuestAtomicStartInput,
  OwnerGuestAtomicStartOutcome,
} from "./owner-guest-atomic-start.ts";

export interface OwnerGuestSpokenDispatchContextStore {
  /** Immutable source locator under current proved learning access only; no
   * publication/session-expiry precheck that could block an accepted JSON replay.
   * NEW-answer checks stay inside the actual locked mutation transaction.
   */
  readonly resolveAnswerSource: (
    input: AnswerCommand,
  ) => Effect.Effect<GuestSource, GuestParticipationStoreFailure>;
  /** Private fields never enter a public session/context response. This is a
   * candidate read: the NEW reserve function rechecks both under its locks.
   */
  readonly load: (
    input: Parameters<OwnerAwareStudyV2Store["loadSpokenAnswerContext"]>[0],
  ) => Effect.Effect<
    Readonly<{
      source: GuestSource;
      context: StudySpokenAnswerContext;
      resourceReservationId: string;
      deletionFenceRevision: number;
    }>,
    GuestParticipationStoreFailure
  >;
  /** Read an actual original operation ID for a completed reservation replay.
   * Frozen reservation deliberately has no durable operation ID. Absence must
   * remain pending; a session/item/new candidate is never a fabricated witness.
   */
  readonly findAnswerOutcome: (
    input: AnswerCommand &
      Readonly<{
        source: GuestSource;
        operation: ParticipationOperationIdentity;
      }>,
  ) => Effect.Effect<DurableParticipationOutcome<OwnerStudyAnswer>, GuestParticipationStoreFailure>;
}
export type OwnerStudyProviderInvocation =
  | Readonly<{ state: "completed"; result: StudyBatchTranscript }>
  | Readonly<{
      state: "failed";
      reason: StudyBatchTranscriptionFailed["reason"];
      providerDisposition: "not_invoked" | "failed" | "unknown";
    }>;
/** Additional internal metadata; the frozen transcriber is unchanged. The
 * platform must derive certainty from actual invocation facts, never timeout
 * or error-name inference. Available is trusted configuration, not a paid probe.
 */
export interface OwnerStudyInvokingTranscriber {
  readonly providerRetention: StudyBatchTranscriber["providerRetention"];
  readonly available: boolean;
  readonly invoke: (
    input: Parameters<StudyBatchTranscriber["transcribe"]>[0],
  ) => Effect.Effect<OwnerStudyProviderInvocation>;
}
export interface OwnerGuestSpokenSuccessProtocol {
  readonly finish: (
    input: Readonly<{
      access: LearningAccess;
      success: OwnerSpokenPreArchiveSuccess;
      audio: Uint8Array;
    }>,
  ) => Effect.Effect<DurableParticipationOutcome<OwnerStudyAnswer>, OwnerSpokenSuccessFailure>;
}
export interface OwnerGuestStudyPublicVisibilityStore {
  readonly isPublic: (
    input: Readonly<{ communityId: string; postId: string }>,
  ) => Effect.Effect<boolean, GuestParticipationStoreFailure>;
}

import type { OwnerGuestSpokenCheckpointRecoveryStore } from "./owner-guest-spoken-checkpoint-recovery.ts";

export type { OwnerGuestSpokenCheckpointRecoveryStore } from "./owner-guest-spoken-checkpoint-recovery.ts";

type OwnerGuestSpokenAcceptedCheckpoint = NonNullable<
  Effect.Success<ReturnType<OwnerGuestSpokenCheckpointRecoveryStore["findForAudio"]>>
>;
export class OwnerGuestStudyCommandRejected extends Data.TaggedError(
  "OwnerGuestStudyCommandRejected",
)<{
  readonly reason: "invalid-input" | "provider-unavailable";
}> {}
type Failure = OwnerSpokenSuccessFailure | OwnerGuestStudyCommandRejected;
const reject = (reason: GuestParticipationStoreRejected["reason"]) =>
  new GuestParticipationStoreRejected({ reason });
const invalid = () => new OwnerGuestStudyCommandRejected({ reason: "invalid-input" });
const providerUnavailable = () =>
  new OwnerGuestStudyCommandRejected({ reason: "provider-unavailable" });
const instant = (ms: number) => new Date(ms).toISOString();
const hash = (value: unknown) => canonicalBodyHash(value).pipe(Effect.mapError(invalid));
const pending = <A>(operation: ParticipationOperationIdentity): DurableParticipationOutcome<A> => ({
  state: "pending_confirmation",
  operation,
  outcomeId: null,
});
const sameOperation = (a: ParticipationOperationIdentity, b: ParticipationOperationIdentity) =>
  a.sourceOwnerId === b.sourceOwnerId &&
  a.kind === b.kind &&
  a.idempotencyKey === b.idempotencyKey &&
  a.requestHash === b.requestHash;
const assertOutcome = <A>(
  outcome: DurableParticipationOutcome<A>,
  operation: ParticipationOperationIdentity,
) =>
  sameOperation(outcome.operation, operation)
    ? Effect.succeed(outcome)
    : Effect.fail(reject("idempotency-conflict"));
const originalOwner = (
  source: ParticipationSource,
  access: LearningAccess,
): source is GuestSource =>
  source.kind === "guest" && access.kind === "guest" && source.ownerId === access.ownerId;
const graderPolicy = (
  revision: string,
): Effect.Effect<StudyTranscriptGraderPolicyRevision, GuestParticipationStoreRejected> => {
  switch (revision) {
    case STUDY_TRANSCRIPT_GRADER_POLICY_V1:
      return Effect.succeed(STUDY_TRANSCRIPT_GRADER_POLICY_V1);
    case STUDY_TRANSCRIPT_GRADER_POLICY_V2:
      return Effect.succeed(STUDY_TRANSCRIPT_GRADER_POLICY_V2);
    case STUDY_TRANSCRIPT_GRADER_POLICY_V3:
      return Effect.succeed(STUDY_TRANSCRIPT_GRADER_POLICY_V3);
    case STUDY_TRANSCRIPT_GRADER_POLICY_V4:
      return Effect.succeed(STUDY_TRANSCRIPT_GRADER_POLICY_V4);
    default:
      return Effect.fail(reject("resource-policy-unavailable"));
  }
};
const AudioInput = Schema.Struct({
  byteSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 524288 })),
  contentType: Schema.Literals(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"]),
  durationMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 })),
  attemptNumber: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
});
const digest = (audio: Uint8Array) =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new Uint8Array(audio)),
    catch: invalid,
  }).pipe(
    Effect.map((buffer) =>
      [...new Uint8Array(buffer)].map((n) => n.toString(16).padStart(2, "0")).join(""),
    ),
  );
const StartBody = StartGuestStudySessionV1.request.body;
type StartBody = Schema.Schema.Type<typeof StartBody>;

/** Server-only factory. Transport verifies cookie/proof, origin and CSRF and
 * provides access/trusted edge. Body fields and headers supply locators only.
 * The genuine SQL layer repeats original source/lease/operation validation.
 * No Account principal, guest persona, membership or qualification is created.
 */
export function makeOwnerGuestStudyService(
  deps: Readonly<{
    store: OwnerAwareStudyV2Store;
    prepared: PreparedGuestStudyContentStore;
    atomicStarter: OwnerGuestAtomicStarter;
    dispatchContext: OwnerGuestSpokenDispatchContextStore;
    resourcePolicy: GuestResourceAdmissionPolicy | null;
    transcriber: OwnerStudyInvokingTranscriber;
    success: OwnerGuestSpokenSuccessProtocol;
    recovery: OwnerGuestSpokenCheckpointRecoveryStore;
    visibility: OwnerGuestStudyPublicVisibilityStore;
    rerecordEnabled: boolean;
  }>,
) {
  const publicAnswer = Effect.fn("OwnerGuestStudyService.publicAnswer")(function* (
    outcome: DurableParticipationOutcome<OwnerStudyAnswer>,
    input: AnswerCommand,
  ) {
    if (outcome.state !== "completed") return outcome;
    const owned = outcome.result;
    const answer = owned.answer;
    const session = answer.session;
    if (
      owned.source.kind !== "guest" ||
      session.object !== "guest_study_session_v1" ||
      owned.source.ownerId !== outcome.operation.sourceOwnerId ||
      session.owner_id !== owned.source.ownerId ||
      session.community_id !== input.communityId ||
      session.session_id !== input.sessionId ||
      answer.session_item_id !== input.sessionItemId ||
      answer.attempt_number !== input.attemptNumber
    )
      return yield* reject("owner-mismatch");
    // Egress only, AFTER accepted continuation/COMMIT. Never roll back retained
    // success, infer absence/abort or require renewed learning authority.
    if (
      !(yield* deps.visibility.isPublic({
        communityId: session.community_id,
        postId: session.post_id,
      }))
    )
      return yield* reject("not-found");
    return outcome;
  });
  const sourceForAnswer = Effect.fn("OwnerGuestStudyService.sourceForAnswer")(function* (
    input: AnswerCommand,
  ) {
    const source = yield* deps.dispatchContext.resolveAnswerSource(input);
    if (!originalOwner(source, input.access)) return yield* reject("owner-mismatch");
    return source;
  });
  return {
    getPreparedContent: deps.prepared.get,
    getSession: Effect.fn("OwnerGuestStudyService.getSession")(function* (
      input: Parameters<OwnerAwareStudyV2Store["getSession"]>[0],
    ) {
      const owned = yield* deps.store.getSession(input);
      if (owned === null) return yield* reject("not-found");
      if (owned.source.kind !== "guest" || owned.session.object !== "guest_study_session_v1")
        return yield* reject("owner-mismatch");
      if (
        !(yield* deps.visibility.isPublic({
          communityId: owned.session.community_id,
          postId: owned.session.post_id,
        }))
      )
        return yield* reject("not-found");
      return owned.session;
    }),
    findStartOperation: Effect.fn("OwnerGuestStudyService.findStartOperation")(function* (
      input: Parameters<OwnerAwareStudyV2Store["findStartOperation"]>[0],
    ) {
      const found = yield* deps.store.findStartOperation(input);
      if (
        found.state === "completed" &&
        !(yield* deps.visibility.isPublic({
          communityId: found.session.community_id,
          postId: found.session.post_id,
        }))
      )
        return yield* reject("not-found");
      return found;
    }),
    startSession: Effect.fn("OwnerGuestStudyService.startSession")(function* (
      input: Readonly<{
        access: GuestLearningAccess;
        communityId: string;
        postId: string;
        body: StartBody;
        trustedEdge: Readonly<{ kind: "trusted_edge"; fingerprint: string }>;
      }>,
    ) {
      const body = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(StartBody, { onExcessProperty: "error" })(input.body),
        catch: invalid,
      });
      if (body.expected_owner_id !== input.access.ownerId) return yield* reject("owner-mismatch");
      // This packet implements practice only. It never invents a reward offer,
      // policy version, economics or an unpaid alternative for spoken practice.
      if (body.reward_mode !== "practice_only" || body.reward_preview_terms_hash !== null)
        return yield* reject("resource-policy-unavailable");
      const requestHash = yield* hash({
        community_id: input.communityId,
        post_id: input.postId,
        body,
      });
      const source: GuestSource = {
        kind: "guest",
        ownerId: input.access.ownerId,
      };
      const operation: ParticipationOperationIdentity = {
        sourceOwnerId: source.ownerId,
        kind: "study_start",
        idempotencyKey: body.idempotency_key,
        requestHash,
      };
      const ids = yield* IdGen;
      const clock = yield* Clock;
      const result = yield* deps.atomicStarter
        .startPreparedSession({
          access: input.access,
          source,
          operation,
          communityId: input.communityId,
          postId: input.postId,
          createdAt: instant(yield* clock.now),
          targetLanguage: body.target_language,
          learnerBand: body.learner_band,
          idempotencyKey: body.idempotency_key,
          requestHash,
          sessionId: `study_v2_${yield* ids.next}`,
          timezone: body.timezone,
          rewardMode: "practice_only",
          rewardTerms: null,
          disclosure: body.disclosure,
          trustedEdge: input.trustedEdge,
          policy: deps.resourcePolicy,
          freshRefusalOperationId: `guest_start_${yield* ids.next}`,
        })
        .pipe(
          Effect.catchTag("ControlPlaneTransactionOutcomeUnknown", () =>
            Effect.succeed({
              kind: "start" as const,
              outcome: pending<OwnerStudySession>(operation),
            }),
          ),
        );
      yield* assertOutcome(result.outcome, operation);
      if (result.kind === "start" && result.outcome.state === "completed") {
        const owned = result.outcome.result;
        if (
          owned.source.kind !== "guest" ||
          owned.session.object !== "guest_study_session_v1" ||
          owned.source.ownerId !== operation.sourceOwnerId
        )
          return yield* reject("owner-mismatch");
        if (
          !(yield* deps.visibility.isPublic({
            communityId: owned.session.community_id,
            postId: owned.session.post_id,
          }))
        )
          return yield* reject("not-found");
      }
      // Preserve the explicit internal tag. HTTP error mapping occurs outside
      // the already committed refusal, using its actual rate/budget disposition.
      return result;
    }),
    submitAnswer: Effect.fn("OwnerGuestStudyService.submitAnswer")(function* (
      input: AnswerCommand &
        Readonly<{
          answer: Schema.Schema.Type<typeof StudyAnswerSubmissionV2>;
        }>,
    ): Effect.fn.Return<DurableParticipationOutcome<OwnerStudyAnswer>, Failure, Clock | IdGen> {
      const answer = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(StudyAnswerSubmissionV2, {
            onExcessProperty: "error",
          })(input.answer),
        catch: invalid,
      });
      const source = yield* sourceForAnswer(input);
      const requestHash = yield* hash({
        community_id: input.communityId,
        session_id: input.sessionId,
        session_item_id: input.sessionItemId,
        attempt_number: input.attemptNumber,
        answer,
      });
      const operation: ParticipationOperationIdentity = {
        sourceOwnerId: source.ownerId,
        kind: "study_answer",
        idempotencyKey: input.idempotencyKey,
        requestHash,
      };
      const ids = yield* IdGen;
      const clock = yield* Clock;
      const outcome = yield* deps.store
        .submitAnswer({
          ...input,
          answer,
          source,
          operation,
          requestHash,
          acceptedAt: instant(yield* clock.now),
          attemptId: `study_attempt_v2_${yield* ids.next}`,
          // Retained frozen store field; guest SQL never creates this qualification.
          qualificationId: `qualification_${yield* ids.next}`,
        })
        .pipe(
          Effect.catchTag("ControlPlaneTransactionOutcomeUnknown", () =>
            Effect.succeed(pending<OwnerStudyAnswer>(operation)),
          ),
        );
      yield* assertOutcome(outcome, operation);
      return yield* publicAnswer(outcome, input);
    }),
    submitSpokenAnswer: Effect.fn("OwnerGuestStudyService.submitSpokenAnswer")(function* (
      input: AnswerCommand &
        Readonly<{
          audio: Uint8Array;
          audioContentType: string;
          audioDurationMs: number;
        }>,
    ): Effect.fn.Return<DurableParticipationOutcome<OwnerStudyAnswer>, Failure, Clock | IdGen> {
      const access = input.access;
      if (access.kind !== "guest") return yield* reject("owner-mismatch");
      const audio = new Uint8Array(input.audio); // Retain exact request bytes across asynchronous I/O.
      yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(AudioInput, { onExcessProperty: "error" })({
            byteSize: audio.byteLength,
            contentType: input.audioContentType,
            durationMs: input.audioDurationMs,
            attemptNumber: input.attemptNumber,
          }),
        catch: invalid,
      });
      const audioDigest = yield* digest(audio);
      const recoveryInput = {
        access,
        communityId: input.communityId,
        sessionId: input.sessionId,
        sessionItemId: input.sessionItemId,
        idempotencyKey: input.idempotencyKey,
        attemptNumber: input.attemptNumber,
        audioDigest,
        audioByteSize: audio.byteLength,
        audioContentType: input.audioContentType,
        audioDurationMs: input.audioDurationMs,
      };
      const resumeSaved = Effect.fn("OwnerGuestStudyService.resumeSaved")(function* (
        saved: OwnerGuestSpokenAcceptedCheckpoint,
      ) {
        const accepted = saved.success;
        const result = accepted.result;
        if (
          !originalOwner(accepted.source, input.access) ||
          accepted.operation.kind !== "study_answer" ||
          accepted.operation.sourceOwnerId !== accepted.source.ownerId ||
          accepted.operation.idempotencyKey !== input.idempotencyKey ||
          result.requestHash !== accepted.operation.requestHash ||
          result.communityId !== input.communityId ||
          result.sessionId !== input.sessionId ||
          result.sessionItemId !== input.sessionItemId ||
          result.attemptNumber !== input.attemptNumber ||
          result.audioDigest !== audioDigest ||
          result.audioContentType !== input.audioContentType ||
          result.audioByteSize !== audio.byteLength ||
          result.audioDurationMs !== input.audioDurationMs ||
          accepted.commandId !== result.commandId
        )
          return yield* reject("idempotency-conflict");
        const finished = yield* deps.success
          .finish({ access: input.access, success: accepted, audio })
          .pipe(
            Effect.catchTag("ControlPlaneTransactionOutcomeUnknown", () =>
              Effect.succeed(pending<OwnerStudyAnswer>(accepted.operation)),
            ),
          );
        yield* assertOutcome(finished, accepted.operation);
        return yield* publicAnswer(finished, input);
      });
      const saved = yield* deps.recovery.findForAudio(recoveryInput);
      if (saved !== null) return yield* resumeSaved(saved);
      const dispatch = yield* deps.dispatchContext.load(input);
      if (
        !originalOwner(dispatch.source, input.access) ||
        dispatch.context.item.session_item_id !== input.sessionItemId ||
        dispatch.context.item.exercise_type !== "say_it_back"
      )
        return yield* reject("owner-mismatch");
      const source = dispatch.source;
      const context = dispatch.context;
      const policy = yield* graderPolicy(context.item.grader_policy_revision);
      const referenceGrade = gradeStudySpokenTranscript({
        referenceText: context.referenceText,
        transcript: "",
        dominantLanguage: context.dominantLanguage,
        policy,
        languageProvenance: context.languageProvenance,
        detectedLanguage: null,
        detectedLanguageConfidence: null,
      }).grade;
      if (referenceGrade.missing.length > 256) return yield* reject("resource-policy-unavailable");
      const requestHash = yield* hash({
        audio_digest: audioDigest,
        audio_byte_size: audio.byteLength,
        audio_content_type: input.audioContentType,
        audio_duration_ms: input.audioDurationMs,
        attempt_number: input.attemptNumber,
        session_id: input.sessionId,
        session_item_id: input.sessionItemId,
        study_unit_id: context.item.line.study_unit_id,
        source_line_revision: context.item.line.line_version,
        language_profile_revision: context.item.language_profile_revision,
        grading_revision: context.item.grader_policy_revision,
        provider_retention: deps.transcriber.providerRetention,
      });
      const operation: ParticipationOperationIdentity = {
        sourceOwnerId: source.ownerId,
        kind: "study_answer",
        idempotencyKey: input.idempotencyKey,
        requestHash,
      };
      const ids = yield* IdGen;
      const clock = yield* Clock;
      const reserved = yield* deps.store
        .reserveSpokenAnswer({
          access: input.access,
          source,
          operation,
          attemptNumber: input.attemptNumber,
          audioByteSize: audio.byteLength,
          audioContentType: input.audioContentType,
          audioDigest,
          audioDurationMs: input.audioDurationMs,
          commandId: `study_spoken_${yield* ids.next}`,
          attemptId: `study_attempt_v2_${yield* ids.next}`,
          artifactId: `learner_audio_${yield* ids.next}`,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          leaseToken: `study_spoken_lease_${yield* ids.next}`,
          providerRetention: deps.transcriber.providerRetention,
          sessionId: input.sessionId,
          sessionItemId: input.sessionItemId,
          resourceReservationId: dispatch.resourceReservationId,
          deletionFenceRevision: dispatch.deletionFenceRevision,
        })
        .pipe(
          Effect.catchTag("ControlPlaneTransactionOutcomeUnknown", () =>
            Effect.succeed({
              state: "pending_confirmation" as const,
              operation,
            }),
          ),
        );
      if (reserved.state === "completed") {
        const original = yield* deps.dispatchContext.findAnswerOutcome({
          ...input,
          source,
          operation,
        });
        yield* assertOutcome(original, operation);
        if (original.state === "completed") {
          const retainedHash = yield* hash(original.result);
          const reservedHash = yield* hash(reserved.result);
          if (retainedHash !== reservedHash) return yield* reject("idempotency-conflict");
        }
        return yield* publicAnswer(original, input);
      }
      if (reserved.state === "pending_confirmation") {
        if (!sameOperation(reserved.operation, operation))
          return yield* reject("idempotency-conflict");
        const accepted = yield* deps.recovery.findForAudio(recoveryInput);
        if (accepted !== null) return yield* resumeSaved(accepted);
        return pending(operation);
      }
      // Existing keys return above before invoking. Even misconfigured actual
      // provider config may observe an original completed/pending command.
      const invocation = deps.transcriber.available
        ? yield* deps.transcriber.invoke({
            audio,
            contentType: input.audioContentType,
            languageHint:
              context.dominantLanguage === null || context.item.language_profile_revision === null
                ? null
                : context.dominantLanguage,
          })
        : {
            state: "failed" as const,
            reason: "misconfigured" as const,
            providerDisposition: "not_invoked" as const,
          };
      if (invocation.state === "failed") {
        const failed = yield* deps.store
          .failSpokenAnswer({
            access: input.access,
            source,
            operation,
            commandId: reserved.commandId,
            leaseToken: reserved.leaseToken,
            failedAt: instant(yield* clock.now),
            providerFailureKind: invocation.reason,
            providerDisposition: invocation.providerDisposition,
            resourceReservationId: reserved.resourceReservationId,
          })
          .pipe(
            Effect.catchTag("ControlPlaneTransactionOutcomeUnknown", () =>
              Effect.succeed(pending<void>(operation)),
            ),
          );
        yield* assertOutcome(failed, operation);
        if (invocation.providerDisposition === "unknown" || failed.state === "pending_confirmation")
          return pending(operation);
        return yield* providerUnavailable();
      }
      const transcript = invocation.result;
      const { grade, rerecordAssessment } = gradeStudySpokenTranscript({
        referenceText: context.referenceText,
        transcript: transcript.transcript,
        dominantLanguage: context.dominantLanguage,
        policy,
        languageProvenance: context.languageProvenance,
        detectedLanguage: transcript.detectedLanguage,
        detectedLanguageConfidence: transcript.detectedLanguageConfidence,
      });
      // A valid provider response can still exceed the private retained grade
      // cardinality cap. Never truncate it, release the paid allowance or call
      // it a known failure. Retain the original unknown operation for recovery.
      if (
        grade.matched.length > 256 ||
        grade.missing.length > 256 ||
        grade.extra.length > 256 ||
        grade.substituted.length > 256
      ) {
        yield* deps.store
          .failSpokenAnswer({
            access: input.access,
            source,
            operation,
            commandId: reserved.commandId,
            leaseToken: reserved.leaseToken,
            failedAt: instant(yield* clock.now),
            providerFailureKind: "invalid-response",
            providerDisposition: "unknown",
            resourceReservationId: reserved.resourceReservationId,
          })
          .pipe(
            Effect.catchTag("ControlPlaneTransactionOutcomeUnknown", () =>
              Effect.succeed(pending<void>(operation)),
            ),
          );
        return pending(operation);
      }
      const success: OwnerSpokenPreArchiveSuccess = {
        source,
        operation,
        commandId: reserved.commandId,
        resourceReservationId: reserved.resourceReservationId,
        deletionFenceRevision: reserved.deletionFenceRevision,
        providerResult: transcript,
        result: {
          acceptedAt: instant(yield* clock.now),
          artifactId: reserved.artifactId,
          attemptId: reserved.attemptId,
          attemptNumber: input.attemptNumber,
          audioByteSize: audio.byteLength,
          audioContentType: input.audioContentType,
          audioDigest,
          audioDurationMs: input.audioDurationMs,
          commandId: reserved.commandId,
          leaseToken: reserved.leaseToken,
          communityId: input.communityId,
          grade,
          languageProvenance: context.languageProvenance,
          rerecordAssessment,
          rerecordEnabled: deps.rerecordEnabled,
          providerDetectedLanguage: transcript.detectedLanguage,
          providerDetectedLanguageConfidence: transcript.detectedLanguageConfidence,
          qualificationId: `qualification_${yield* ids.next}`,
          requestHash,
          sessionId: input.sessionId,
          sessionItemId: input.sessionItemId,
        },
      };
      // Protocol strictly validates checkpoint caps without truncation, persists
      // first, then uses actual fenced archive and ACK-before-finalize. Unknown
      // storage remains its distinct typed error; no invented archive state.
      const finished = yield* deps.success
        .finish({ access: input.access, success, audio })
        .pipe(
          Effect.catchTag("ControlPlaneTransactionOutcomeUnknown", () =>
            Effect.succeed(pending<OwnerStudyAnswer>(operation)),
          ),
        );
      yield* assertOutcome(finished, operation);
      return yield* publicAnswer(finished, input);
    }),
  };
}
