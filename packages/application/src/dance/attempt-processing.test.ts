import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type DanceAttemptProcessingBinding,
  type DanceAttemptProcessingClaim,
  DanceAttemptProcessingInvalid,
  type DanceAttemptProcessingOutcome,
  type DanceAttemptProcessingStore,
  type FrozenDanceAttemptInput,
  runDanceAttemptProcessing,
} from "./attempt-processing.ts";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const HASH_C = "33".repeat(32);

const frozenInput: FrozenDanceAttemptInput = {
  version: "frozen-dance-attempt-input-v1",
  attemptId: "attempt-1",
  sessionId: "session-1",
  inputDigest: HASH_A,
  privateMediaRef: "private/random/session-1",
  sealedMediaSha256: HASH_B,
  segmentId: "segment-1",
  choreographyId: "choreography-1",
  choreographyRevision: 1,
  referenceArtifactRef: "private/reference/artifact-1",
  referenceArtifactSha256: HASH_C,
  scoredWindowStartMs: 2_000,
  scoredWindowEndMs: 8_000,
  expectedScoredDurationMs: 6_000,
  policy: {
    capturedAdmissionState: "shadow",
    poseModelVersion: "pose-v1",
    featureSchemaVersion: "features-v1",
    scorerContractVersion: "scorer-v1",
    mirrorPolicyVersion: "mirror-v1",
    fingerprintPolicyVersion: "fingerprint-v1",
    fingerprintKeyVersion: "fingerprint-key-v1",
    integrityPolicyVersion: "integrity-v1",
    graderAdapterVersion: "grader-fake-v1",
  },
};

const binding: DanceAttemptProcessingBinding = {
  version: "dance-attempt-processing-binding-v1",
  effectIdentity: "dance-attempt:attempt-1",
  attemptId: "attempt-1",
  inputDigest: HASH_A,
  attemptNumber: 1,
  claimOwner: "worker-1",
  claimFence: 1,
};

const claim: DanceAttemptProcessingClaim = { frozenInput, binding };

const outcome: DanceAttemptProcessingOutcome = {
  version: "dance-attempt-processing-outcome-v1",
  binding,
  gradeOutcome: "scored",
  qualificationOutcome: "suppressed_shadow",
  scoreBps: 7_250,
  rejectionCode: null,
  scoredWindowStartMs: 2_000,
  scoredWindowEndMs: 8_000,
  scoredDurationMs: 6_000,
  evidenceSummary: {
    schema_version: 1,
    usable_coverage_bps: 9_500,
    selected_mirror: "original",
    meaningful_motion_accepted: true,
    replay_outcome: "unique",
    subject_continuity: "stable",
  },
  evidenceDigest: HASH_C,
  fingerprint: {
    claimId: "fingerprint-claim-1",
    policyVersion: "fingerprint-v1",
    keyVersion: "fingerprint-key-v1",
    matchScope: "platform_wide",
    accountScopeId: null,
    wholeSequenceFingerprint: HASH_A,
    segmentFingerprints: [HASH_B],
  },
};

const preFingerprintRejection: DanceAttemptProcessingOutcome = {
  ...outcome,
  gradeOutcome: "rejected",
  scoreBps: null,
  rejectionCode: "multiple_people",
  evidenceSummary: null,
  fingerprint: null,
};

const unexpected = () => Effect.die(new Error("unexpected processing store call"));

function store(overrides: Partial<DanceAttemptProcessingStore>): DanceAttemptProcessingStore {
  return {
    claim: unexpected,
    complete: unexpected,
    fail: unexpected,
    ...overrides,
  };
}

const runInput = {
  attemptId: "attempt-1",
  workerId: "worker-1",
  leaseSeconds: 60,
  retryAfterSeconds: 30,
};

describe("Dance attempt processing interpreter", () => {
  test("is inert before an explicit grader adapter is installed", async () => {
    let claims = 0;
    const result = await Effect.runPromise(
      runDanceAttemptProcessing(runInput, {
        store: store({
          claim: () => {
            claims += 1;
            return Effect.succeed({ kind: "claimed", claim });
          },
        }),
        adapter: null,
      }),
    );
    expect(result).toEqual({ kind: "inert" });
    expect(claims).toBe(0);
  });

  test("commits only an exactly bound suppressed-shadow outcome", async () => {
    const events: string[] = [];
    const result = await Effect.runPromise(
      runDanceAttemptProcessing(runInput, {
        store: store({
          claim: () => {
            events.push("claim");
            return Effect.succeed({ kind: "claimed", claim });
          },
          complete: (completedClaim, completedOutcome) => {
            events.push(`complete:${completedClaim.binding.claimFence}`);
            expect(completedOutcome.qualificationOutcome).toBe("suppressed_shadow");
            return Effect.succeed("committed");
          },
        }),
        adapter: {
          grade: () => {
            events.push("grade");
            return Effect.succeed(outcome);
          },
        },
      }),
    );
    expect(events).toEqual(["claim", "grade", "complete:1"]);
    expect(result).toEqual({ kind: "committed", status: "completed" });
  });

  test("commits an integrity rejection without manufacturing fingerprint evidence", async () => {
    const result = await Effect.runPromise(
      runDanceAttemptProcessing(runInput, {
        store: store({
          claim: () => Effect.succeed({ kind: "claimed", claim }),
          complete: (_completedClaim, completedOutcome) => {
            expect(completedOutcome).toMatchObject({
              gradeOutcome: "rejected",
              rejectionCode: "multiple_people",
              evidenceSummary: null,
              fingerprint: null,
            });
            return Effect.succeed("committed");
          },
        }),
        adapter: { grade: () => Effect.succeed(preFingerprintRejection) },
      }),
    );
    expect(result).toEqual({ kind: "committed", status: "completed" });
  });

  test("rejects a scored outcome that omits fingerprint evidence", async () => {
    let completed = false;
    const result = await Effect.runPromise(
      runDanceAttemptProcessing(runInput, {
        store: store({
          claim: () => Effect.succeed({ kind: "claimed", claim }),
          complete: () => {
            completed = true;
            return Effect.succeed("committed");
          },
          fail: ({ failureCode }) => {
            expect(failureCode).toBe("grader_adapter_failure");
            return Effect.succeed("retryable");
          },
        }),
        adapter: {
          grade: () =>
            Effect.succeed({
              ...outcome,
              fingerprint: null,
            } as unknown as DanceAttemptProcessingOutcome),
        },
      }),
    );
    expect(completed).toBe(false);
    expect(result).toEqual({ kind: "retryable", status: "failed" });
  });

  test("turns a binding-mismatched adapter result into bounded failure", async () => {
    let completed = false;
    const result = await Effect.runPromise(
      runDanceAttemptProcessing(runInput, {
        store: store({
          claim: () => Effect.succeed({ kind: "claimed", claim }),
          complete: () => {
            completed = true;
            return Effect.succeed("committed");
          },
          fail: ({ failureCode }) => {
            expect(failureCode).toBe("grader_adapter_failure");
            return Effect.succeed("retryable");
          },
        }),
        adapter: {
          grade: () =>
            Effect.succeed({
              ...outcome,
              binding: { ...binding, claimFence: 2 },
            }),
        },
      }),
    );
    expect(completed).toBe(false);
    expect(result).toEqual({ kind: "retryable", status: "failed" });
  });

  test("records adapter failure without manufacturing terminal evidence", async () => {
    const result = await Effect.runPromise(
      runDanceAttemptProcessing(runInput, {
        store: store({
          claim: () => Effect.succeed({ kind: "claimed", claim }),
          fail: () => Effect.succeed("exhausted"),
        }),
        adapter: {
          grade: () => Effect.fail(new DanceAttemptProcessingInvalid({ phase: "adapter" })),
        },
      }),
    );
    expect(result).toEqual({ kind: "exhausted", status: "failed" });
  });
});
