import { describe, expect, test } from "bun:test";
import {
  type CreateDanceAttemptSession,
  createDanceAttemptSession,
  type DanceAttemptDecision,
  type DanceAttemptSession,
  type DanceSealedUpload,
  type DanceSessionConsent,
  type DanceShadowTerminalResult,
  type DanceUploadReservation,
  danceAttemptSessionInvariant,
  finalizeDanceShadowAttempt,
  recordDanceSessionConsent,
  reserveDanceSessionUpload,
  sealDanceSessionUpload,
  submitDanceSessionForGrading,
} from "./attempt.ts";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const T0 = "2026-09-01T08:00:00.000Z";
const T1 = "2026-09-01T08:01:00.000Z";
const T2 = "2026-09-01T08:02:00.000Z";
const T3 = "2026-09-01T08:03:00.000Z";
const T4 = "2026-09-01T08:04:00.000Z";
const EXPIRES = "2026-09-01T08:15:00.000Z";

function value<T>(decision: DanceAttemptDecision<T>): T {
  if (decision.kind === "rejected") throw new Error(decision.reason);
  return decision.value;
}

function createInput(
  overrides: Partial<CreateDanceAttemptSession> = {},
): CreateDanceAttemptSession {
  return {
    sessionId: "dance-session-1",
    accountId: "account-1",
    personaId: "persona-1",
    communityId: "community-1",
    songPostId: "song-1",
    audioRevision: 4,
    segmentId: "segment-1",
    choreographyId: "choreography-1",
    choreographyRevision: 2,
    rewardMode: "practice",
    objectiveSnapshot: [],
    expectedScoredDurationMs: 6_000,
    cue: {
      kind: "hands_on_head",
      holdMs: 1_000,
      observationStartMs: 0,
      observationEndMs: 2_000,
    },
    policy: {
      qualificationPolicyVersionId: "dance-shadow-policy-v1",
      calibrationVersionId: "dance-shadow-calibration-v1",
      calibrationChecksum: HASH_A,
      capturedAdmissionState: "shadow",
      platformFloorBps: 4_321,
      poseModelVersion: "pose-v1",
      featureSchemaVersion: "features-v1",
      scorerContractVersion: "scorer-v1",
      mirrorPolicyVersion: "mirror-v1",
      cuePolicyVersion: "cue-v1",
      fingerprintPolicyVersion: "fingerprint-v1",
      integrityPolicyVersion: "integrity-v1",
      graderAdapterVersion: "adapter-v1",
    },
    sessionTermsHash: HASH_B,
    createdAt: T0,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

const consent: DanceSessionConsent = {
  personaId: "persona-1",
  sessionTermsHash: HASH_B,
  consentPolicyVersionId: "consent-v1",
  retentionDisclosureVersion: "retention-v1",
  source: "camera",
  consentedAt: T1,
};

const reservation: DanceUploadReservation = {
  reservationId: "reservation-1",
  privateObjectKey: "private/random/session-1/video",
  expectedContentType: "video/mp4",
  expectedSizeBytes: 1_000,
  expectedDurationMs: 8_000,
  expectedSha256: null,
  expiresAt: T3,
};

const sealed: DanceSealedUpload = {
  reservationId: "reservation-1",
  privateObjectKey: "private/random/session-1/video",
  contentType: "video/mp4",
  sizeBytes: 1_000,
  durationMs: 8_000,
  serverSha256: HASH_A,
  sealedAt: T2,
};

function uploadedSession(): DanceAttemptSession {
  const created = value(createDanceAttemptSession(createInput()));
  const consented = value(recordDanceSessionConsent(created, 1, consent));
  const awaiting = value(reserveDanceSessionUpload(consented, 2, reservation));
  return value(sealDanceSessionUpload(awaiting, 3, sealed));
}

function pendingSession(): DanceAttemptSession {
  return value(submitDanceSessionForGrading(uploadedSession(), 4, "attempt-1"));
}

function terminal(overrides: Partial<DanceShadowTerminalResult> = {}): DanceShadowTerminalResult {
  return {
    attemptId: "attempt-1",
    gradeOutcome: "scored",
    qualificationOutcome: "suppressed_shadow",
    scoreBps: 7_250,
    rejectionCode: null,
    scoredWindowStartMs: 2_000,
    scoredWindowEndMs: 8_000,
    scoredDurationMs: 6_000,
    evidenceDigest: HASH_B,
    completedAt: T4,
    ...overrides,
  };
}

describe("Dance private attempt session reducer", () => {
  test("creates only a rewardless shadow session with immutable cue and policy terms", () => {
    const created = value(createDanceAttemptSession(createInput()));
    expect(created).toMatchObject({
      state: "created",
      rewardMode: "practice",
      objectiveSnapshot: [],
      consent: null,
      sealedUpload: null,
      attemptId: null,
      terminalResult: null,
      version: 1,
    });
    expect(danceAttemptSessionInvariant(created)).toBeNull();
    expect(
      createDanceAttemptSession(
        createInput({
          policy: { ...createInput().policy, capturedAdmissionState: "money_admitted" as "shadow" },
        }),
      ),
    ).toEqual({ kind: "rejected", reason: "shadow_boundary_violation" });
    expect(
      createDanceAttemptSession(createInput({ rewardMode: "reward_eligible" as "practice" })),
    ).toEqual({ kind: "rejected", reason: "shadow_boundary_violation" });
  });

  test("requires consent bound to the exact persona and frozen terms before reservation", () => {
    const created = value(createDanceAttemptSession(createInput()));
    expect(reserveDanceSessionUpload(created, 1, reservation)).toEqual({
      kind: "rejected",
      reason: "transition_not_allowed",
    });
    expect(recordDanceSessionConsent(created, 1, { ...consent, personaId: "persona-2" })).toEqual({
      kind: "rejected",
      reason: "consent_binding_conflict",
    });
    const consented = value(recordDanceSessionConsent(created, 1, consent));
    expect(recordDanceSessionConsent(consented, 1, consent)).toMatchObject({
      kind: "accepted",
      replayed: true,
      value: consented,
    });
    expect(recordDanceSessionConsent(consented, 2, { ...consent, source: "file_upload" })).toEqual({
      kind: "rejected",
      reason: "consent_binding_conflict",
    });
  });

  test("reserves and seals exactly one server-bound private object", () => {
    const created = value(createDanceAttemptSession(createInput()));
    const consented = value(recordDanceSessionConsent(created, 1, consent));
    const awaiting = value(reserveDanceSessionUpload(consented, 2, reservation));
    expect(awaiting).toMatchObject({ state: "awaiting_upload", version: 3 });
    expect(reserveDanceSessionUpload(awaiting, 2, reservation)).toMatchObject({
      kind: "accepted",
      replayed: true,
    });
    expect(
      sealDanceSessionUpload(awaiting, 3, { ...sealed, privateObjectKey: "other-key" }),
    ).toEqual({ kind: "rejected", reason: "sealed_digest_conflict" });
    const uploaded = value(sealDanceSessionUpload(awaiting, 3, sealed));
    expect(uploaded).toMatchObject({ state: "uploaded", version: 4, sealedUpload: sealed });
    expect(sealDanceSessionUpload(uploaded, 4, { ...sealed, serverSha256: HASH_B })).toEqual({
      kind: "rejected",
      reason: "sealed_digest_conflict",
    });
  });

  test("creates one logical attempt and treats exact submission replay as harmless", () => {
    const uploaded = uploadedSession();
    const pending = value(submitDanceSessionForGrading(uploaded, 4, "attempt-1"));
    expect(pending).toMatchObject({ state: "grading_pending", attemptId: "attempt-1", version: 5 });
    expect(submitDanceSessionForGrading(pending, 4, "attempt-1")).toMatchObject({
      kind: "accepted",
      replayed: true,
    });
    expect(submitDanceSessionForGrading(pending, 5, "attempt-2")).toEqual({
      kind: "rejected",
      reason: "attempt_identity_conflict",
    });
  });

  test("records numeric grading separately and cannot emit a qualification", () => {
    const pending = pendingSession();
    const completed = value(finalizeDanceShadowAttempt(pending, 5, terminal()));
    expect(completed).toMatchObject({
      state: "completed",
      cleanupState: "pending",
      terminalResult: {
        gradeOutcome: "scored",
        qualificationOutcome: "suppressed_shadow",
        scoreBps: 7_250,
      },
      version: 6,
    });
    expect(finalizeDanceShadowAttempt(completed, 5, terminal())).toMatchObject({
      kind: "accepted",
      replayed: true,
    });
    expect(
      finalizeDanceShadowAttempt(pending, 5, {
        ...terminal(),
        qualificationOutcome: "emitted" as "suppressed_shadow",
      }),
    ).toEqual({ kind: "rejected", reason: "shadow_boundary_violation" });
  });

  test("preserves the first terminal result and maps rejected and failed outcomes distinctly", () => {
    const completed = value(finalizeDanceShadowAttempt(pendingSession(), 5, terminal()));
    expect(
      finalizeDanceShadowAttempt(completed, 6, { ...terminal(), evidenceDigest: HASH_A }),
    ).toEqual({ kind: "rejected", reason: "terminal_result_conflict" });
    const rejected = value(
      finalizeDanceShadowAttempt(
        pendingSession(),
        5,
        terminal({
          gradeOutcome: "rejected",
          scoreBps: null,
          rejectionCode: "replay_detected",
        }),
      ),
    );
    expect(rejected.state).toBe("rejected");
    const failed = value(
      finalizeDanceShadowAttempt(
        pendingSession(),
        5,
        terminal({
          gradeOutcome: "failed",
          scoreBps: null,
          rejectionCode: "provider_failed",
        }),
      ),
    );
    expect(failed.state).toBe("processing_failed");
  });
});
