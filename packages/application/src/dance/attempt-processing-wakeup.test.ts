import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type {
  DanceAttemptProcessingClaim,
  DanceAttemptProcessingOutcome,
  DanceAttemptProcessingStore,
} from "./attempt-processing.ts";
import {
  advanceDanceAttemptWorkflow,
  consumeDanceAttemptQueueMessage,
  type DanceAttemptWakeupRecord,
  type DanceAttemptWakeupStore,
} from "./attempt-processing-wakeup.ts";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const HASH_C = "33".repeat(32);

const wakeup = (overrides: Partial<DanceAttemptWakeupRecord> = {}): DanceAttemptWakeupRecord => ({
  attemptId: "attempt-1",
  effectIdentity: "dance-attempt-1",
  inputDigest: HASH_A,
  attemptState: "grading_pending",
  state: "pending",
  deliveryAttempts: 0,
  claimFence: 0,
  eligible: true,
  ...overrides,
});

const payload = {
  version: "dance-attempt-workflow-v1" as const,
  attemptId: "attempt-1",
  effectIdentity: "dance-attempt-1",
  inputDigest: HASH_A,
};

const unexpectedEffect = () => Effect.die(new Error("unexpected store call"));
const unexpectedPromise = () => Promise.reject(new Error("unexpected wakeup call"));

function store(
  processing: Partial<DanceAttemptProcessingStore> = {},
  wakeups: Partial<DanceAttemptWakeupStore> = {},
): DanceAttemptProcessingStore & DanceAttemptWakeupStore {
  return {
    claim: unexpectedEffect,
    complete: unexpectedEffect,
    fail: unexpectedEffect,
    getWakeup: unexpectedPromise,
    listEligibleWakeups: unexpectedPromise,
    ...processing,
    ...wakeups,
  };
}

describe("Dance attempt Queue and Workflow wake-up", () => {
  test("launches one closed persisted-identity payload and acknowledges duplicate launch", async () => {
    const launches: unknown[] = [];
    const dependencies = {
      store: {
        getWakeup: async () => wakeup(),
        listEligibleWakeups: async () => [],
      },
      workflow: {
        create: async (instanceId: string, workflowPayload: unknown) => {
          launches.push({ instanceId, payload: workflowPayload });
          return launches.length === 1 ? ("created" as const) : ("already_exists" as const);
        },
      },
    };
    expect(
      await consumeDanceAttemptQueueMessage(
        { attempt_id: "attempt-1" },
        "delivery-1",
        dependencies,
      ),
    ).toEqual({ disposition: "ack" });
    expect(
      await consumeDanceAttemptQueueMessage(
        { attempt_id: "attempt-1" },
        "delivery-1",
        dependencies,
      ),
    ).toEqual({ disposition: "ack" });
    expect(launches).toEqual([
      { instanceId: "dance-attempt-delivery-1", payload },
      { instanceId: "dance-attempt-delivery-1", payload },
    ]);
  });

  test("fails malformed authority closed without launching", async () => {
    let launches = 0;
    const dependencies = {
      store: {
        getWakeup: async () => wakeup({ eligible: false }),
        listEligibleWakeups: async () => [],
      },
      workflow: {
        create: async () => {
          launches += 1;
          return "created" as const;
        },
      },
    };
    expect(
      await consumeDanceAttemptQueueMessage(
        { attempt_id: "attempt-1", score_bps: 10_000 },
        "delivery-1",
        dependencies,
      ),
    ).toEqual({ disposition: "dlq" });
    expect(
      await consumeDanceAttemptQueueMessage(
        { attempt_id: "attempt-1" },
        "delivery-2",
        dependencies,
      ),
    ).toEqual({ disposition: "ack" });
    expect(launches).toBe(0);
  });

  test("returns inert with a null adapter before authority lookup or claim", async () => {
    let wakeups = 0;
    let claims = 0;
    const result = await advanceDanceAttemptWorkflow(payload, "workflow-1", {
      store: store(
        {
          claim: () => {
            claims += 1;
            return Effect.succeed({ kind: "busy" });
          },
        },
        {
          getWakeup: async () => {
            wakeups += 1;
            return wakeup();
          },
        },
      ),
      adapter: null,
      leaseSeconds: 60,
      retryAfterSeconds: 30,
    });
    expect(result).toEqual({ kind: "inert" });
    expect(wakeups).toBe(0);
    expect(claims).toBe(0);
  });

  test("runs an explicitly injected adapter through the persisted claim only", async () => {
    let claims = 0;
    let completions = 0;
    const processingClaim = {
      frozenInput: {
        version: "frozen-dance-attempt-input-v1",
        attemptId: "attempt-1",
        sessionId: "session-1",
        inputDigest: HASH_A,
        privateMediaRef: "private/attempt-1",
        sealedMediaSha256: HASH_B,
        segmentId: "segment-1",
        choreographyId: "choreography-1",
        choreographyRevision: 1,
        referenceArtifactRef: "private/reference-1",
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
          fingerprintKeyVersion: "key-v1",
          integrityPolicyVersion: "integrity-v1",
          graderAdapterVersion: "fake-v1",
        },
      },
      binding: {
        version: "dance-attempt-processing-binding-v1",
        effectIdentity: "dance-attempt-1",
        attemptId: "attempt-1",
        inputDigest: HASH_A,
        attemptNumber: 1,
        claimOwner: "workflow-1",
        claimFence: 1,
      },
    } satisfies DanceAttemptProcessingClaim;
    const rejectedOutcome: DanceAttemptProcessingOutcome = {
      version: "dance-attempt-processing-outcome-v1",
      binding: processingClaim.binding,
      gradeOutcome: "rejected",
      qualificationOutcome: "suppressed_shadow",
      scoreBps: null,
      rejectionCode: "multiple_people",
      scoredWindowStartMs: 2_000,
      scoredWindowEndMs: 8_000,
      scoredDurationMs: 6_000,
      evidenceSummary: null,
      evidenceDigest: HASH_C,
      fingerprint: null,
    };
    const result = await advanceDanceAttemptWorkflow(payload, "workflow-1", {
      store: store(
        {
          claim: () => {
            claims += 1;
            return Effect.succeed({ kind: "claimed", claim: processingClaim });
          },
          complete: () => {
            completions += 1;
            return Effect.succeed("committed");
          },
        },
        { getWakeup: async () => wakeup() },
      ),
      adapter: { grade: () => Effect.succeed(rejectedOutcome) },
      leaseSeconds: 60,
      retryAfterSeconds: 30,
    });
    expect(result).toEqual({ kind: "committed", status: "completed" });
    expect(claims).toBe(1);
    expect(completions).toBe(1);
  });
});
