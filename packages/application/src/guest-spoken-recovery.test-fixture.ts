import type { OwnerSpokenPreArchiveSuccess } from "./owner-spoken-success-protocol.ts";
import { gradeStudySpokenTranscript } from "./study-shared-lesson-engine.ts";

// Finite typed accepted-result fixture. No provider or native SQL authority claim.
const operation = {
  sourceOwnerId: "owner-original",
  kind: "study_answer" as const,
  idempotencyKey: "answer-original",
  requestHash: "a".repeat(64),
};
const transcript = {
  transcript: "I can love you",
  detectedLanguage: "en",
  detectedLanguageConfidence: 0.99,
};
const grading = gradeStudySpokenTranscript({
  referenceText: transcript.transcript,
  transcript: transcript.transcript,
  dominantLanguage: null,
  policy: "script_aware_token_phonetic_v2",
  languageProvenance: { kind: "no_authoritative_evidence" },
  detectedLanguage: "en",
  detectedLanguageConfidence: 0.99,
});
export const success: OwnerSpokenPreArchiveSuccess = {
  source: { kind: "guest", ownerId: "owner-original" },
  operation,
  commandId: "command-original",
  resourceReservationId: "resource-original",
  deletionFenceRevision: 0,
  providerResult: transcript,
  result: {
    acceptedAt: "2026-10-12T12:00:00.000Z",
    artifactId: "artifact-original",
    attemptId: "attempt-original",
    attemptNumber: 1,
    audioByteSize: 3,
    audioContentType: "audio/webm",
    audioDigest: "b".repeat(64),
    audioDurationMs: 1000,
    commandId: "command-original",
    leaseToken: "original-private-dispatch-lease",
    communityId: "community-original",
    ...grading,
    languageProvenance: { kind: "no_authoritative_evidence" },
    rerecordEnabled: true,
    providerDetectedLanguage: "en",
    providerDetectedLanguageConfidence: 0.99,
    qualificationId: "unused-guest-candidate",
    requestHash: operation.requestHash,
    sessionId: "session-original",
    sessionItemId: "item-original",
  },
};
