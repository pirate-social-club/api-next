import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { MediaTransformAttempt } from "../media/transform.ts";
import {
  analysisState,
  frames,
  HASHES,
  providers,
  publicPersona,
  services,
  transform,
} from "./analysis.test-fixtures.ts";
import type { VideoSubmissionRecord } from "./publication.ts";
import { type VideoStageFact, validateVideoStageFact } from "./stage-facts.ts";
import {
  runVideoAnalysisWorkflow,
  VIDEO_WORKFLOW_CAPABILITY_MS,
  type VideoWorkflowServices,
  type VideoWorkflowStep,
} from "./workflow.ts";

function fixture() {
  let now = Date.parse("2026-09-05T00:00:00Z");
  let record: VideoSubmissionRecord = {
    state: analysisState(),
    eventSequence: 1,
    authorPersona: publicPersona,
    updatedAt: new Date(now).toISOString(),
  };
  const stageFacts = new Map<string, VideoStageFact>();
  const attempts = new Map<string, MediaTransformAttempt>();
  const calls = { starts: 0, allocations: 0, observations: 0, publications: 0, sourceHeads: 0 };
  let continuation = 0;
  const base = services({ providers: providers() });
  const change = (state: VideoSubmissionRecord["state"]) =>
    (record = { ...record, state, eventSequence: record.eventSequence + 1 });
  const adapter = transform();
  const runtime: VideoWorkflowServices = {
    ...base,
    nowIso: () => new Date(now).toISOString(),
    outbox: {
      get: async () => ({
        effectIdentity: identity,
        submissionId: record.state.submissionId,
        operationId: record.state.operationId,
        videoRevision: 1,
        creationRevision: 1,
        canonicalVideoSha256: HASHES[0] as string,
        state: "launched",
        launchAttempts: 1,
        continuation,
        workflowInstanceId: null,
        instanceMissing: false,
        claimOwner: null,
        claimFence: 1,
      }),
    },
    store: {
      ...base.store,
      getSubmissionByOperation: async () => record,
      commitAnalysisDecision: async ({ nextState }) => change(nextState),
      publish: async ({ state }) => {
        calls.publications++;
        return change(state);
      },
      recordProcessingFailure: async ({ submission, observedEventSequence, failureCode }) => {
        expect(observedEventSequence).toBe(record.eventSequence);
        return change({ ...submission, status: "processing_failed", phase: null, failureCode });
      },
    },
    transform: {
      ...adapter,
      allocate: (input) => {
        calls.allocations++;
        return adapter.allocate(input);
      },
      submit: (input) => {
        calls.starts++;
        expect(input.attempt.providerJobPhase).toBe("submitting");
        return adapter.submit(input);
      },
      observe: ((input) => {
        calls.observations++;
        return adapter.observe(input).pipe(
          Effect.map((result) => {
            if (result.status !== "completed") return result;
            if ("artifact" in result)
              return {
                ...result,
                artifact: { ...result.artifact, adapterRevision: result.context.adapterRevision },
              };
            if ("extraction" in result)
              return {
                ...result,
                extraction: {
                  ...result.extraction,
                  adapterRevision: result.context.adapterRevision,
                },
              };
            return result;
          }),
        );
      }) as VideoWorkflowServices["transform"]["observe"],
    },
    transformAttempts: {
      loadOrCreate: async ({ binding, initialAttempt }) => {
        const stored = attempts.get(binding.requestId) ?? initialAttempt;
        attempts.set(binding.requestId, stored);
        return stored;
      },
      advance: async ({ binding, attempt }) => {
        const previous = attempts.get(binding.requestId);
        if (previous?.providerJobPhase === "allocated" && attempt.providerJobPhase === "started")
          throw new Error("skipped phase");
        attempts.set(binding.requestId, attempt);
        return attempt;
      },
    },
    verifySource: async () => {
      calls.sourceHeads++;
    },
    artifactHead: async (ref) => {
      const frame = frames().find((value) => value.artifactRef === ref);
      return {
        canonicalSha256: frame?.sha256 ?? (HASHES[1] as string),
        sizeBytes: 100,
        contentType: frame ? "image/jpeg" : "audio/mp4",
      };
    },
    stageFacts: {
      read: async () => [...stageFacts.values()],
      write: async ({ fact, observedEventSequence }) => {
        expect(observedEventSequence).toBe(record.eventSequence);
        const valid = validateVideoStageFact(fact);
        const previous = stageFacts.get(valid.stage);
        if (previous && JSON.stringify(previous) !== JSON.stringify(valid))
          throw new Error("divergent fact");
        stageFacts.set(valid.stage, valid);
        return valid;
      },
    },
    reconciliation: {
      reconcileTerminalWorkflow: async () => {
        throw new Error("sweep only");
      },
      enterAttemptReconciliation: async ({ state }) =>
        state === "pending"
          ? record
          : change({
              ...record.state,
              status: "processing_failed",
              phase: null,
              failureCode: "probe_failed",
              reconciliationRequired: true,
            }),
      resolveAttemptReconciliation: async ({ observation }) => {
        if (observation.status === "completed")
          stageFacts.set(observation.fact.stage, observation.fact);
        return change({
          ...record.state,
          reconciliationRequired: false,
          status: observation.status === "failed" ? "processing_failed" : "processing",
          phase: observation.status === "failed" ? null : "analysis",
        });
      },
    },
  };
  const identity = `video-analysis:${record.state.operationId}:v1:c1`;
  const names: string[] = [];
  const memo = new Map<string, unknown>();
  let crashAfter: string | null = null;
  const step: VideoWorkflowStep = {
    do: async <T>(name: string, run: () => Promise<T>) => {
      names.push(name);
      if (memo.has(name)) return memo.get(name) as T;
      const result = await run();
      if (crashAfter === name) {
        crashAfter = null;
        throw new Error("worker killed");
      }
      memo.set(name, result);
      return result;
    },
    sleep: async (name, ms) => {
      if (!memo.has(name)) {
        now += ms;
        memo.set(name, true);
      }
    },
    waitForEvent: async () => {
      throw new Error("unexpected review wait");
    },
  };
  return {
    runtime,
    step,
    identity,
    calls,
    stageFacts,
    attempts,
    names,
    memo,
    record: () => record,
    setCrash: (name: string) => {
      crashAfter = name;
    },
    continue: () => {
      continuation++;
      memo.clear();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("video executor publishes from validated stage facts without a test-side publish call", async () => {
  const f = fixture();
  expect(await runVideoAnalysisWorkflow(f.identity, f.step, f.runtime)).toEqual({
    status: "published",
  });
  expect(f.stageFacts.size).toBe(5);
  expect(f.calls).toEqual({
    starts: 3,
    allocations: 3,
    observations: 3,
    publications: 1,
    sourceHeads: 1,
  });
  expect(new Set(f.names).size).toBe(f.names.length);
  expect(f.names.indexOf("frames-runtime-0-observe")).toBeLessThan(f.names.indexOf("recognition"));
});

test("video executor replays every effect boundary without duplicate starts or publication", async () => {
  const reference = fixture();
  await runVideoAnalysisWorkflow(reference.identity, reference.step, reference.runtime);
  for (const name of reference.names) {
    const f = fixture();
    f.setCrash(name);
    await expect(runVideoAnalysisWorkflow(f.identity, f.step, f.runtime)).rejects.toThrow(
      "worker killed",
    );
    expect(await runVideoAnalysisWorkflow(f.identity, f.step, f.runtime)).toEqual({
      status: "published",
    });
    expect(f.calls.starts).toBe(3);
    expect(f.calls.publications).toBe(1);
  }
});

test("drill 1: lost accepted start response observes submitting and never starts it again", async () => {
  const f = fixture();
  const submit = f.runtime.transform.submit;
  let lost = true;
  Object.assign(f.runtime.transform, {
    submit: ((input: Parameters<typeof submit>[0]) =>
      submit(input).pipe(
        Effect.map((outcome) => {
          if (lost) {
            lost = false;
            throw new Error("lost start response");
          }
          return outcome;
        }),
      )) as typeof submit,
  });
  await expect(runVideoAnalysisWorkflow(f.identity, f.step, f.runtime)).rejects.toThrow(
    "lost start response",
  );
  expect(await runVideoAnalysisWorkflow(f.identity, f.step, f.runtime)).toEqual({
    status: "published",
  });
  expect(f.calls.starts).toBe(3);
});

test("terminal continuation reuses allocated and started attempts and accepted facts", async () => {
  for (const boundary of ["probe-allocate", "probe-submit", "safety"]) {
    const f = fixture();
    f.setCrash(boundary);
    await expect(runVideoAnalysisWorkflow(f.identity, f.step, f.runtime)).rejects.toThrow(
      "worker killed",
    );
    f.continue();
    expect(await runVideoAnalysisWorkflow(`${f.identity}:k1`, f.step, f.runtime)).toEqual({
      status: "published",
    });
    expect(f.calls.starts).toBe(3);
    expect(f.calls.allocations).toBe(3);
    expect(f.calls.publications).toBe(1);
  }
});

test("unconfirmed submission exhausts two bounded windows with no second start and no provider failure", async () => {
  const f = fixture();
  Object.assign(f.runtime.transform, {
    observe: ((input: Parameters<typeof f.runtime.transform.observe>[0]) =>
      Effect.succeed({
        status: "not_found",
        attempt: input.attempt,
      })) as typeof f.runtime.transform.observe,
  });
  expect(await runVideoAnalysisWorkflow(f.identity, f.step, f.runtime)).toEqual({
    status: "reconciliation_required",
  });
  expect(f.calls.starts).toBe(1);
  expect(f.record().state.reconciliationRequired).toBe(true);
  expect(f.names.filter((name) => name.endsWith("-observe"))).toHaveLength(120);
  expect(Date.parse(f.runtime.nowIso()) - Date.parse("2026-09-05T00:00:00Z")).toBe(
    2 * VIDEO_WORKFLOW_CAPABILITY_MS,
  );
});

test("database failure after accepted start propagates and replay observes the original token", async () => {
  const f = fixture();
  const advance = f.runtime.transformAttempts.advance;
  let failed = false;
  Object.assign(f.runtime.transformAttempts, {
    advance: async (input: Parameters<typeof advance>[0]) => {
      if (!failed && input.attempt.providerJobPhase === "started") {
        failed = true;
        throw new Error("database unavailable after start");
      }
      return advance(input);
    },
  });
  await expect(runVideoAnalysisWorkflow(f.identity, f.step, f.runtime)).rejects.toThrow(
    "database unavailable after start",
  );
  expect(f.record().state.status).toBe("processing");
  expect(await runVideoAnalysisWorkflow(f.identity, f.step, f.runtime)).toEqual({
    status: "published",
  });
  expect(f.calls.starts).toBe(3);
});
