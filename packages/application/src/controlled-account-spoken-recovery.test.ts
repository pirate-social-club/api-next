import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { AccountSpokenSuccess } from "./account-study-capture-protocol.ts";
import {
  type ControlledAccountSpokenProtocol,
  makeControlledAccountSpokenService,
} from "./controlled-account-spoken.ts";
import { Clock, IdGen } from "./ports.ts";
import { gradeStudySpokenTranscript } from "./study-shared-lesson-engine.ts";
import { type StudyV2Store, StudyV2StoreFailed } from "./study-v2-service.ts";

// Recovery ordering witness, independent of the live PG finalization tests.
// The old retained short checkpoint must reach its original continuation before
// today's duration floor or missing provider configuration can reject it.
test("historical short successful checkpoint resumes without reserving or transcribing", async () => {
  const audio = new TextEncoder().encode("Hold on");
  const digest = createHash("sha256").update(audio).digest("hex");
  const input = {
    accountId: "account",
    communityId: "community",
    sessionId: "session",
    sessionItemId: "item",
    attemptNumber: 1,
    idempotencyKey: "original",
    audio,
    audioContentType: "audio/webm",
    audioDurationMs: 353,
  };
  const success: AccountSpokenSuccess = {
    ...input,
    audioByteSize: audio.length,
    audioDigest: digest,
    acceptedAt: "2026-10-14T00:00:00.000Z",
    artifactId: "artifact",
    attemptId: "attempt",
    commandId: "command",
    leaseToken: "original-generation",
    requestHash: "a".repeat(64),
    qualificationId: "qualification",
    rerecordEnabled: false,
    languageProvenance: { kind: "no_authoritative_evidence" },
    providerDetectedLanguage: "en",
    providerDetectedLanguageConfidence: 0.99,
    ...gradeStudySpokenTranscript({
      referenceText: "Hold on",
      transcript: "Hold on",
      dominantLanguage: null,
      policy: "script_aware_token_phonetic_v2",
      languageProvenance: { kind: "no_authoritative_evidence" },
      detectedLanguage: "en",
      detectedLanguageConfidence: 0.99,
    }),
  };
  const capture = {
    uploadAttemptId: "upload",
    sourceOwnerId: "owner",
    artifactId: "artifact",
    sourceKind: "study" as const,
    attemptRef: "attempt",
    commandRef: "command",
    reservationRef: JSON.stringify([
      "account_study_audio_generation_v1",
      "command",
      "original-generation",
    ]),
    capturedRevision: 0,
    objectRef: `learner-audio/study/attempt/${digest}`,
    contentDigest: digest,
    contentType: "audio/webm",
    byteSize: audio.length,
    durationMs: 353,
  };
  const unexpected = () => Effect.die("unexpected new work");
  const store: StudyV2Store = {
    getAvailability: unexpected,
    startSession: unexpected,
    getSession: unexpected,
    submitAnswer: unexpected,
    loadSpokenAnswerContext: unexpected,
    reserveSpokenAnswer: unexpected,
    failSpokenAnswer: unexpected,
    completeSpokenAnswer: unexpected,
  };
  const calls: string[] = [];
  const protocol: ControlledAccountSpokenProtocol = {
    reserve: unexpected,
    beginProvider: unexpected,
    providerUnknown: unexpected,
    providerFailed: unexpected,
    persistSuccess: unexpected,
    findSuccess: () => Effect.succeed({ capture, success, matchedIdempotencyKey: "original" }),
    archive: () =>
      Effect.sync(() => {
        calls.push("archive-original");
        return { state: "stored" as const, objectRef: capture.objectRef };
      }),
    finalize: () => {
      calls.push("finalize-original");
      return Effect.fail(new StudyV2StoreFailed({ reason: "outcome-unknown" }));
    },
  };
  const result = await Effect.runPromise(
    Effect.flip(
      makeControlledAccountSpokenService(store, protocol, null, false)
        .submitSpokenAnswer(input)
        .pipe(
          Effect.provideService(Clock, { now: unexpected() }),
          Effect.provideService(IdGen, { next: unexpected() }),
        ),
    ),
  );
  expect(result).toMatchObject({ reason: "outcome-unknown" });
  expect(calls).toEqual(["archive-original", "finalize-original"]);
});
