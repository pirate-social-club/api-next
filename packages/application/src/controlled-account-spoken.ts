// INTERNAL controlled ordinary-account producer. No OwnerAware financial IDs.

import { StudyAnswerResultV2, StudySessionV2 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type { AccountSpokenSuccess } from "./account-study-capture-protocol.ts";
import type { LearnerAudioUploadCapture } from "./learner-audio-capture.ts";
import { Clock, IdGen } from "./ports.ts";
import { gradeStudySpokenTranscript } from "./study-shared-lesson-engine.ts";
import {
  type makeStudyV2Service,
  STUDY_MIN_RECORDING_DURATION_MS,
  type StudyAudioArchiveResult,
  type StudyBatchTranscriber,
  type StudyProviderRefusalStatus,
  type StudySpokenAnswerContext,
  type StudySpokenAnswerReservation,
  StudyV2CommandRejected,
  type StudyV2Failure,
  type StudyV2Store,
  StudyV2StoreFailed,
} from "./study-v2-service.ts";
import { canonicalBodyHash } from "./use-cases/content/common.ts";
export type AccountSpokenInput = Parameters<
  ReturnType<typeof makeStudyV2Service>["submitSpokenAnswer"]
>[0];
export type AccountSpokenSavedSuccess = Readonly<{
  capture: LearnerAudioUploadCapture;
  success: AccountSpokenSuccess;
  /** Native find predicates matched the actual stored request key before returning.
   * This is its verified match witness, not a newly synthesized persisted key. */
  matchedIdempotencyKey: string;
}>;
export interface ControlledAccountSpokenProtocol {
  reserve: (input: Parameters<StudyV2Store["reserveSpokenAnswer"]>[0]) => Effect.Effect<
    | Exclude<StudySpokenAnswerReservation, { state: "reserved" }>
    | Readonly<{
        state: "reserved";
        commandId: string;
        leaseToken: string;
        attemptId: string;
        artifactId: string;
        capture: LearnerAudioUploadCapture;
      }>,
    StudyV2Failure
  >;
  findSuccess: (
    input: AccountSpokenInput,
  ) => Effect.Effect<AccountSpokenSavedSuccess | null, StudyV2Failure>;
  beginProvider: (capture: LearnerAudioUploadCapture) => Effect.Effect<void, StudyV2Failure>;
  providerFailed: (
    capture: LearnerAudioUploadCapture,
    httpStatus: StudyProviderRefusalStatus,
  ) => Effect.Effect<void, StudyV2Failure>;
  providerUnknown: (capture: LearnerAudioUploadCapture) => Effect.Effect<void, StudyV2Failure>;
  persistSuccess: (
    capture: LearnerAudioUploadCapture,
    result: AccountSpokenSuccess,
  ) => Effect.Effect<AccountSpokenSuccess, StudyV2Failure>;
  archive: (
    input: Readonly<{ capture: LearnerAudioUploadCapture; audio: Uint8Array }>,
  ) => Effect.Effect<StudyAudioArchiveResult, StudyV2Failure>;
  finalize: (
    capture: LearnerAudioUploadCapture,
    result: AccountSpokenSuccess,
    archive: StudyAudioArchiveResult,
  ) => ReturnType<StudyV2Store["completeSpokenAnswer"]>;
}
const reject = (reason: StudyV2CommandRejected["reason"]) => new StudyV2CommandRejected({ reason });
const invalid = () => new StudyV2StoreFailed({ reason: "invalid-row" });
const Generation = Schema.Tuple([
  Schema.Literal("account_study_audio_generation_v1"),
  Schema.NonEmptyString,
  Schema.NonEmptyString,
]);
/** Correlate the original native capture, successful facts and submitted route
 * before any archive/finalizer I/O. sourceOwnerId is the genuine original owner,
 * not an account ID or a Guest paid reservation. */
export const assertAccountSpokenSavedSuccess = Effect.fn(
  "controlledAccountSpoken.assertSavedSuccess",
)(function* (input: AccountSpokenInput, saved: AccountSpokenSavedSuccess, audioDigest: string) {
  const generation = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(Generation, { onExcessProperty: "error" })(
        JSON.parse(saved.capture.reservationRef),
      ),
    catch: invalid,
  });
  const { success, capture } = saved;
  if (
    saved.matchedIdempotencyKey !== input.idempotencyKey ||
    success.accountId !== input.accountId ||
    success.communityId !== input.communityId ||
    success.sessionId !== input.sessionId ||
    success.sessionItemId !== input.sessionItemId ||
    success.attemptNumber !== input.attemptNumber ||
    success.audioDigest !== audioDigest ||
    success.audioByteSize !== input.audio.byteLength ||
    success.audioContentType !== input.audioContentType ||
    success.audioDurationMs !== input.audioDurationMs ||
    capture.sourceKind !== "study" ||
    capture.commandRef !== success.commandId ||
    capture.attemptRef !== success.attemptId ||
    capture.artifactId !== success.artifactId ||
    capture.contentDigest !== audioDigest ||
    capture.byteSize !== input.audio.byteLength ||
    capture.contentType !== input.audioContentType ||
    capture.durationMs !== input.audioDurationMs ||
    generation[1] !== success.commandId ||
    generation[2] !== success.leaseToken ||
    capture.objectRef !== `learner-audio/study/${success.attemptId}/${audioDigest}`
  )
    return yield* invalid();
});
const Policy = Schema.Literals([
  "script_aware_token_diff_v1",
  "script_aware_token_phonetic_v2",
  "script_aware_token_phonetic_v3",
  "script_aware_token_phonetic_v4",
]);
const digest = Effect.fn("controlledAccountSpoken.digest")(function* (audio: Uint8Array) {
  const bytes = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new Uint8Array(audio)),
    catch: () => reject("invalid-input"),
  });
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
});
/** The old nonspoken service remains the ordinary delegate. This private method
 * is selected only with a complete controlled protocol; it has no unsafe fallback.
 * Source-bound CP is recovered BEFORE today's context/lease can deny it.
 */
export const makeControlledAccountSpokenService = (
  store: StudyV2Store,
  protocol: ControlledAccountSpokenProtocol,
  transcriber: StudyBatchTranscriber | null,
  rerecordEnabled: boolean,
) => {
  // This read runs AFTER durable private continuation. Its original ordinary
  // authorization also applies Telegram admission when this store carries it.
  const publicResult = Effect.fn("controlledAccountSpoken.publicResult")(function* (
    input: AccountSpokenInput,
    raw: StudyAnswerResultV2,
  ) {
    const result = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(StudyAnswerResultV2, { onExcessProperty: "error" })(raw),
      catch: invalid,
    });
    const currentRaw = yield* store.getSession({
      accountId: input.accountId,
      communityId: input.communityId,
      sessionId: input.sessionId,
    });
    if (currentRaw === null) return yield* reject("not-found");
    const current = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(StudySessionV2, { onExcessProperty: "error" })(currentRaw),
      catch: invalid,
    });
    if (
      current.session_id !== input.sessionId ||
      current.community_id !== input.communityId ||
      result.session.session_id !== input.sessionId ||
      result.session.community_id !== input.communityId ||
      current.persona_id !== result.session.persona_id ||
      current.post_id !== result.session.post_id ||
      result.session_item_id !== input.sessionItemId ||
      result.attempt_number !== input.attemptNumber ||
      !current.items.some((item) => item.session_item_id === input.sessionItemId) ||
      !result.session.items.some((item) => item.session_item_id === input.sessionItemId)
    )
      return yield* invalid();
    return result;
  });
  return {
    submitSpokenAnswer: Effect.fn("controlledAccountSpoken.submitSpokenAnswer")(function* (
      raw: AccountSpokenInput,
    ) {
      const input = { ...raw, audio: new Uint8Array(raw.audio) };
      const audioDigest = yield* digest(input.audio);
      const recovered = yield* protocol.findSuccess(input);
      if (recovered !== null) {
        yield* assertAccountSpokenSavedSuccess(input, recovered, audioDigest);
        const archive = yield* protocol.archive({ capture: recovered.capture, audio: input.audio });
        const result = yield* protocol.finalize(recovered.capture, recovered.success, archive);
        return yield* publicResult(input, result);
      }
      // Preserve previously accepted short recordings above. This is a product
      // floor on reported duration, not a decoded-duration or provider guarantee.
      if (!Number.isSafeInteger(input.audioDurationMs)) return yield* reject("invalid-input");
      if (input.audioDurationMs < STUDY_MIN_RECORDING_DURATION_MS)
        return yield* reject("recording-too-short");
      // Missing current provider configuration refuses NEW work before reservation
      // or provider admission, without blocking an already accepted checkpoint.
      if (transcriber === null) return yield* reject("provider-unavailable");
      const context: StudySpokenAnswerContext = yield* store.loadSpokenAnswerContext(input);
      const requestHash = yield* canonicalBodyHash({
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
        provider_retention: transcriber.providerRetention,
      }).pipe(Effect.mapError(() => reject("invalid-input")));
      const ids = yield* IdGen;
      const clock = yield* Clock;
      const reservation = yield* protocol.reserve({
        ...input,
        audioByteSize: input.audio.byteLength,
        audioDigest,
        requestHash,
        commandId: `study_spoken_${yield* ids.next}`,
        attemptId: `study_attempt_v2_${yield* ids.next}`,
        artifactId: `learner_audio_${yield* ids.next}`,
        leaseToken: `study_spoken_lease_${yield* ids.next}`,
        providerRetention: transcriber.providerRetention,
      });
      if (reservation.state === "completed") return yield* publicResult(input, reservation.result);
      yield* protocol.beginProvider(reservation.capture);
      const transcript = yield* transcriber
        .transcribe({
          audio: input.audio,
          contentType: input.audioContentType,
          languageHint:
            context.dominantLanguage === null || context.item.language_profile_revision === null
              ? null
              : context.dominantLanguage,
        })
        .pipe(
          Effect.catch(
            Effect.fn("controlledAccountSpoken.providerFailure")(function* (failure) {
              if (
                failure.outcome === "known_failed" &&
                failure.httpStatus !== undefined &&
                [400, 401, 403, 413, 415, 422, 429].includes(failure.httpStatus)
              ) {
                yield* protocol.providerFailed(
                  reservation.capture,
                  failure.httpStatus as StudyProviderRefusalStatus,
                );
                return yield* reject("provider-refused");
              }
              yield* protocol.providerUnknown(reservation.capture);
              return yield* reject("provider-outcome-unknown");
            }),
          ),
        );
      const policy = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Policy)(context.item.grader_policy_revision),
        catch: () => reject("submission-kind-mismatch"),
      });
      const { grade, rerecordAssessment } = gradeStudySpokenTranscript({
        referenceText: context.referenceText,
        transcript: transcript.transcript,
        dominantLanguage: context.dominantLanguage,
        policy,
        languageProvenance: context.languageProvenance,
        detectedLanguage: transcript.detectedLanguage,
        detectedLanguageConfidence: transcript.detectedLanguageConfidence,
      });
      const successful: AccountSpokenSuccess = {
        accountId: input.accountId,
        attemptNumber: input.attemptNumber,
        communityId: input.communityId,
        sessionId: input.sessionId,
        sessionItemId: input.sessionItemId,
        audioContentType: input.audioContentType,
        audioDurationMs: input.audioDurationMs,
        acceptedAt: new Date(yield* clock.now).toISOString(),
        artifactId: reservation.artifactId,
        attemptId: reservation.attemptId,
        audioByteSize: input.audio.byteLength,
        audioDigest,
        commandId: reservation.commandId,
        leaseToken: reservation.leaseToken,
        grade,
        languageProvenance: context.languageProvenance,
        rerecordAssessment,
        rerecordEnabled,
        providerDetectedLanguage: transcript.detectedLanguage,
        providerDetectedLanguageConfidence: transcript.detectedLanguageConfidence,
        qualificationId: `qualification_${yield* ids.next}`,
        requestHash,
      };
      // The accepted record commits before any archive call. Never manufacture a
      // failed result for unknown storage; archive/finalize errors leave it retained.
      const original = yield* protocol.persistSuccess(reservation.capture, successful);
      yield* assertAccountSpokenSavedSuccess(
        input,
        {
          capture: reservation.capture,
          success: original,
          matchedIdempotencyKey: input.idempotencyKey,
        },
        audioDigest,
      );
      const archive = yield* protocol.archive({ capture: reservation.capture, audio: input.audio });
      const result = yield* protocol.finalize(reservation.capture, original, archive);
      return yield* publicResult(input, result);
    }),
  };
};
