import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import {
  type DanceReferenceOutcome,
  type DanceReferenceProcessingBinding,
  type DanceReferenceProcessingClaim,
  type DanceReferenceProcessingStore,
  type FrozenDanceReferenceInput,
  freezeDanceReferenceInput,
  type PreparedDanceReferenceOperation,
  runDanceReferenceProcessing,
} from "./reference-processing.ts";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const HASH_C = "33".repeat(32);
const HASH_D = "44".repeat(32);

function frozenInput(
  overrides: Partial<FrozenDanceReferenceInput> = {},
): FrozenDanceReferenceInput {
  return {
    version: "frozen-dance-reference-input-v1",
    effectIdentity: "dance-reference-choreography-1-r1",
    choreographyId: "choreography-1",
    choreographyRevision: 1,
    revisionTermsHash: HASH_A,
    canonicalAudio: {
      objectKey: "private/song/audio-1",
      sha256: HASH_B,
      durationMs: 180_000,
      audioRevision: 4,
    },
    referenceVideo: {
      postId: "video-1",
      objectKey: "private/video/reference-1",
      sha256: HASH_C,
      durationMs: 60_000,
    },
    requestedStartMs: 10_000,
    requestedEndMs: 16_000,
    segmentTermsHash: HASH_B,
    mirrorPolicy: "allowed",
    outputs: {
      segmentId: "segment-1",
      segmentObjectKey: "private/dance/segment-1",
      artifactId: "artifact-1",
      artifactObjectKey: "private/dance/artifact-1",
      evidenceObjectKey: "private/dance/evidence-1",
    },
    extraction: {
      policyVersion: "extract-v1",
      outputProfile: { sampleRateHz: 48_000, channels: 1, codec: "flac" },
    },
    alignment: {
      policyVersion: "alignment-v1",
      adapterId: "fake-alignment",
      adapterRevision: "adapter-v1",
      limits: {
        maximumAbsoluteOffsetMs: 15_000,
        maximumAbsoluteDriftMs: 50,
        maximumAbsoluteSlopeDeltaPpm: 1_000,
        minimumOverallConfidenceBps: 8_000,
        minimumCoverageBps: 9_000,
        minimumSoundtrackMatchBps: 8_000,
      },
    },
    pose: {
      modelVersion: "pose-v1",
      runtimeVersion: "runtime-v1",
      featureSchemaVersion: "features-v1",
      scorerContractVersion: "scorer-v1",
      fingerprintPolicyVersion: "fingerprint-v1",
      integrityPolicyVersion: "integrity-v1",
    },
    qualityLimits: {
      minimumUsableCoverageBps: 9_000,
      maximumMissingGapSlots: 3,
      minimumBodyCoverageBps: 9_000,
      minimumVisibilityCoverageBps: 8_500,
      minimumMotionEnergyBps: 2_000,
      minimumSpatialExtentBps: 2_000,
    },
    ownerPolicy: { revision: 7, hash: HASH_D },
    ...overrides,
  };
}

function prepared(binding: DanceReferenceProcessingBinding): PreparedDanceReferenceOperation {
  return {
    version: "prepared-dance-reference-operation-v1",
    binding,
    providerOperationId: `provider-${binding.requestId}`,
  };
}

function ready(binding: DanceReferenceProcessingBinding): DanceReferenceOutcome {
  return {
    status: "ready",
    binding,
    segment: {
      segmentId: "segment-1",
      objectKey: "private/dance/segment-1",
      sha256: HASH_D,
      sourceSha256: HASH_B,
      startMs: 10_000,
      endMs: 16_000,
      durationMs: 6_000,
      extractionPolicyVersion: "extract-v1",
      segmentTermsHash: HASH_B,
    },
    alignment: {
      videoSha256: HASH_C,
      songAudioSha256: HASH_B,
      requestedStartMs: 10_000,
      requestedEndMs: 16_000,
      referenceVideoScoredStartMs: 20_000,
      referenceVideoScoredEndMs: 26_000,
      detectedSongOffsetMs: 10_000,
      alignmentPolicyVersion: "alignment-v1",
      alignmentRevision: "adapter-v1",
      driftMetrics: {
        maximumAbsoluteDriftMs: 20,
        p95AbsoluteDriftMs: 10,
        slopeDeltaPpm: 100,
      },
      confidenceMetrics: { overallBps: 9_500, coverageBps: 9_400, soundtrackMatchBps: 9_300 },
      continuousMapping: true,
      timeStretchDetected: false,
    },
    artifact: {
      artifactId: "artifact-1",
      privateArtifactRef: "private/dance/artifact-1",
      artifactSha256: HASH_A,
      poseModelVersion: "pose-v1",
      poseRuntimeVersion: "runtime-v1",
      featureSchemaVersion: "features-v1",
      scorerContractVersion: "scorer-v1",
      integrityPolicyVersion: "integrity-v1",
      referenceDurationMs: 6_000,
      width: 1920,
      height: 1080,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      usableFrameSummary: {
        totalTimelineSlots: 180,
        usableTimelineSlots: 171,
        coverageBps: 9_500,
        maximumMissingGapSlots: 2,
        bodyCoverageBps: 9_400,
        visibilityCoverageBps: 9_200,
        stablePrincipalTrackCount: 1,
        subjectContinuityAmbiguous: false,
        motionEnergyBps: 6_000,
        spatialExtentBps: 5_000,
      },
    },
    evidence: {
      evidenceRef: "private/dance/evidence-1",
      evidenceDigest: HASH_C,
      resultDigest: HASH_D,
      bodyCoverageAccepted: true,
      timelineEvidenceAccepted: true,
      visibilityEvidenceAccepted: true,
      subjectContinuityAccepted: true,
      meaningfulMotionAccepted: true,
    },
  };
}

class FakeStore implements DanceReferenceProcessingStore {
  request: Awaited<ReturnType<typeof freezeDanceReferenceInput>> | undefined;
  saved: PreparedDanceReferenceOperation | null = null;
  committed: DanceReferenceOutcome | null = null;
  transactionOpen = false;

  async claim(input: Parameters<DanceReferenceProcessingStore["claim"]>[0]) {
    this.transactionOpen = true;
    try {
      if (input.request !== undefined) {
        if (this.request !== undefined && this.request.inputDigest !== input.request.inputDigest) {
          throw new Error("request identity conflict");
        }
        this.request = input.request;
      }
      if (this.request === undefined) throw new Error("missing frozen request");
      const binding: DanceReferenceProcessingBinding = {
        version: "dance-reference-processing-binding-v1",
        effectIdentity: this.request.frozenInput.effectIdentity,
        requestId: `${this.request.frozenInput.effectIdentity}-a1`,
        choreographyId: input.choreographyId,
        choreographyRevision: input.choreographyRevision,
        attemptNumber: 1,
        inputDigest: this.request.inputDigest,
        adapterId: input.adapterId,
        adapterRevision: input.adapterRevision,
      };
      const claim: DanceReferenceProcessingClaim = {
        ...this.request,
        binding,
        claimOwner: input.workerId,
        claimFence: 1,
        outboxClaimFence: 1,
        preparedOperation: this.saved,
      };
      return { kind: "claimed" as const, claim };
    } finally {
      this.transactionOpen = false;
    }
  }

  async recordPrepared(
    _claim: DanceReferenceProcessingClaim,
    operation: PreparedDanceReferenceOperation,
  ) {
    this.saved = operation;
    return true;
  }

  async complete(
    _claim: DanceReferenceProcessingClaim,
    outcome: Exclude<DanceReferenceOutcome, { readonly status: "pending" }>,
  ) {
    this.committed = outcome;
    return "committed" as const;
  }
}

describe("Dance reference processing interpreter", () => {
  test("freezes deterministic request bytes before invoking the processor", async () => {
    const first = await freezeDanceReferenceInput(frozenInput());
    const second = await freezeDanceReferenceInput({
      ...frozenInput(),
      canonicalAudio: { ...frozenInput().canonicalAudio },
    });
    expect(first).toEqual(second);
    expect(first.inputDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("persists preparation and commits a strictly bound ready outcome", async () => {
    const store = new FakeStore();
    let calls = 0;
    const disposition = await runDanceReferenceProcessing(
      {
        choreographyId: "choreography-1",
        choreographyRevision: 1,
        workerId: "worker-1",
        leaseSeconds: 60,
        adapterId: "fake-reference",
        adapterRevision: "fake-v1",
        frozenInput: frozenInput(),
      },
      {
        store,
        processor: {
          prepareReference: (_input, binding) =>
            Effect.sync(() => {
              expect(store.transactionOpen).toBe(false);
              calls += 1;
              return prepared(binding);
            }),
          observeReference: (operation) =>
            Effect.sync(() => {
              expect(store.transactionOpen).toBe(false);
              calls += 1;
              return ready(operation.binding);
            }),
        },
      },
    );
    expect(disposition).toEqual({ kind: "committed", status: "ready" });
    expect(calls).toBe(2);
    expect(store.saved?.providerOperationId).toContain("dance-reference-choreography-1-r1");
    expect(store.committed?.status).toBe("ready");
  });

  test("recovery omits mutable input and reuses the persisted prepared operation", async () => {
    const store = new FakeStore();
    store.request = await freezeDanceReferenceInput(frozenInput());
    const binding: DanceReferenceProcessingBinding = {
      version: "dance-reference-processing-binding-v1",
      effectIdentity: frozenInput().effectIdentity,
      requestId: `${frozenInput().effectIdentity}-a1`,
      choreographyId: "choreography-1",
      choreographyRevision: 1,
      attemptNumber: 1,
      inputDigest: store.request.inputDigest,
      adapterId: "fake-reference",
      adapterRevision: "fake-v1",
    };
    store.saved = prepared(binding);
    let prepareCalls = 0;
    const disposition = await runDanceReferenceProcessing(
      {
        choreographyId: "choreography-1",
        choreographyRevision: 1,
        workerId: "worker-2",
        leaseSeconds: 60,
        adapterId: "fake-reference",
        adapterRevision: "fake-v1",
      },
      {
        store,
        processor: {
          prepareReference: () => {
            prepareCalls += 1;
            return Effect.die("must not prepare again");
          },
          observeReference: (operation) => Effect.succeed(ready(operation.binding)),
        },
      },
    );
    expect(disposition).toEqual({ kind: "committed", status: "ready" });
    expect(prepareCalls).toBe(0);
  });

  test("does not commit pending observation", async () => {
    const store = new FakeStore();
    const disposition = await runDanceReferenceProcessing(
      {
        choreographyId: "choreography-1",
        choreographyRevision: 1,
        workerId: "worker-1",
        leaseSeconds: 60,
        adapterId: "fake-reference",
        adapterRevision: "fake-v1",
        frozenInput: frozenInput(),
      },
      {
        store,
        processor: {
          prepareReference: (_input, binding) => Effect.succeed(prepared(binding)),
          observeReference: (operation) =>
            Effect.succeed({ status: "pending", binding: operation.binding }),
        },
      },
    );
    expect(disposition).toEqual({ kind: "pending", claimFence: 1, outboxClaimFence: 1 });
    expect(store.committed).toBeNull();
  });

  test("rejects a ready result whose visibility can evade the frozen evidence binding", async () => {
    const store = new FakeStore();
    await expect(
      runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "worker-1",
          leaseSeconds: 60,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
          frozenInput: frozenInput(),
        },
        {
          store,
          processor: {
            prepareReference: (_input, binding) => Effect.succeed(prepared(binding)),
            observeReference: (operation) =>
              Effect.succeed({
                ...ready(operation.binding),
                evidence: {
                  ...(
                    ready(operation.binding) as Extract<DanceReferenceOutcome, { status: "ready" }>
                  ).evidence,
                  visibilityEvidenceAccepted: false as never,
                },
              } as DanceReferenceOutcome),
          },
        },
      ),
    ).rejects.toMatchObject({ phase: "outcome", reason: "invalid_shape" });
    expect(store.committed).toBeNull();
  });

  test("recomputes coverage and rejects provider-owned quality pass flags", async () => {
    const store = new FakeStore();
    await expect(
      runDanceReferenceProcessing(
        {
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          workerId: "worker-1",
          leaseSeconds: 60,
          adapterId: "fake-reference",
          adapterRevision: "fake-v1",
          frozenInput: frozenInput(),
        },
        {
          store,
          processor: {
            prepareReference: (_input, binding) => Effect.succeed(prepared(binding)),
            observeReference: (operation) => {
              const outcome = ready(operation.binding) as Extract<
                DanceReferenceOutcome,
                { status: "ready" }
              >;
              return Effect.succeed({
                ...outcome,
                artifact: {
                  ...outcome.artifact,
                  usableFrameSummary: {
                    ...outcome.artifact.usableFrameSummary,
                    coverageBps: 9_499,
                  },
                },
              });
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      phase: "outcome",
      reason: "terminal_evidence_mismatch",
    });
    expect(store.committed).toBeNull();
  });
});

// The baseline adapter exposes the native Promise to a parent fiber without
// changing production. Remove it when processing itself returns an Effect.
const baselineRuns: Promise<unknown>[] = [];
const processingEffect = (...args: Parameters<typeof runDanceReferenceProcessing>) =>
  Effect.tryPromise({
    try: () => {
      const run = runDanceReferenceProcessing(...args);
      baselineRuns.push(run);
      return run;
    },
    catch: (error) => error,
  });
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const processingInput = () => ({
  choreographyId: "choreography-1",
  choreographyRevision: 1,
  workerId: "worker-1",
  leaseSeconds: 60,
  adapterId: "fake-reference",
  adapterRevision: "fake-v1",
  frozenInput: frozenInput(),
});
const ordinaryProcessor = () => ({
  prepareReference: (_input: FrozenDanceReferenceInput, binding: DanceReferenceProcessingBinding) =>
    Effect.succeed(prepared(binding)),
  observeReference: (operation: PreparedDanceReferenceOperation) =>
    Effect.succeed(ready(operation.binding)),
});
const expectInterrupted = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
};

describe("Dance reference interruption contract", () => {
  for (const stage of ["prepare", "observe"] as const) {
    test(`interrupts ${stage} locally once without starting another durable write`, async () => {
      const store = new FakeStore();
      const entered = barrier();
      const finish = barrier();
      let finalized = 0;
      const controller = new AbortController();
      const processor = ordinaryProcessor();
      const wait = <A>(value: A) =>
        Effect.gen(function* () {
          entered.release();
          yield* Effect.promise(() => finish.promise);
          return value;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized += 1;
            }),
          ),
        );
      if (stage === "prepare")
        processor.prepareReference = (_input, binding) => wait(prepared(binding));
      else processor.observeReference = (operation) => wait(ready(operation.binding));
      const running = Effect.runPromiseExit(
        processingEffect(processingInput(), { store, processor }),
        { signal: controller.signal },
      );
      try {
        await entered.promise;
        controller.abort();
        expectInterrupted(await running);
        expect(finalized).toBe(1);
        expect(store.committed).toBeNull();
        expect(store.saved === null).toBe(stage === "prepare");
      } finally {
        finish.release();
        await Promise.allSettled(baselineRuns.splice(0));
      }
    });
  }

  for (const stage of ["claim", "recordPrepared", "complete"] as const) {
    test(`finishes an in-flight ${stage} before interruption, then starts no next step`, async () => {
      const store = new FakeStore();
      const entered = barrier();
      const finish = barrier();
      const events: string[] = [];
      const claim = store.claim.bind(store);
      const record = store.recordPrepared.bind(store);
      const complete = store.complete.bind(store);
      const checkpoint = async (name: string) => {
        events.push(`${name}:started`);
        if (name === stage) {
          entered.release();
          await finish.promise;
        }
        events.push(`${name}:settled`);
      };
      store.claim = async (input) => {
        await checkpoint("claim");
        return claim(input);
      };
      store.recordPrepared = async (lease, operation) => {
        await checkpoint("recordPrepared");
        return record(lease, operation);
      };
      store.complete = async (lease, outcome) => {
        await checkpoint("complete");
        return complete(lease, outcome);
      };
      const processor = ordinaryProcessor();
      processor.prepareReference = (_input, binding) =>
        Effect.sync(() => {
          events.push("prepare");
          return prepared(binding);
        });
      processor.observeReference = (operation) =>
        Effect.sync(() => {
          events.push("observe");
          return ready(operation.binding);
        });
      const controller = new AbortController();
      let settled = false;
      const running = Effect.runPromiseExit(
        processingEffect(processingInput(), { store, processor }),
        { signal: controller.signal },
      );
      void running.then(() => {
        settled = true;
      });
      try {
        await entered.promise;
        controller.abort();
        await Effect.runPromise(Effect.yieldNow);
        expect(settled).toBe(false);
        finish.release();
        expectInterrupted(await running);
        expect(events.at(-1)).toBe(`${stage}:settled`);
        expect(store.saved !== null).toBe(stage !== "claim");
        expect(store.committed !== null).toBe(stage === "complete");
      } finally {
        finish.release();
        await Promise.allSettled(baselineRuns.splice(0));
      }
    });
  }

  test("discards an unrecorded preparation when interruption precedes its write", async () => {
    const store = new FakeStore();
    const controller = new AbortController();
    let preparedCalls = 0;
    const processor = ordinaryProcessor();
    processor.prepareReference = (_input, binding) =>
      Effect.sync(() => {
        preparedCalls += 1;
        controller.abort();
        return prepared(binding);
      });
    const exit = await Effect.runPromiseExit(
      processingEffect(processingInput(), { store, processor }),
      { signal: controller.signal },
    );
    await Promise.allSettled(baselineRuns.splice(0));
    expectInterrupted(exit);
    expect(store.saved).toBeNull();
    expect(store.committed).toBeNull();
    processor.prepareReference = (_input, binding) =>
      Effect.sync(() => {
        preparedCalls += 1;
        return prepared(binding);
      });
    await Effect.runPromise(processingEffect(processingInput(), { store, processor }));
    await Promise.allSettled(baselineRuns.splice(0));
    expect(preparedCalls).toBe(2);
  });
});
