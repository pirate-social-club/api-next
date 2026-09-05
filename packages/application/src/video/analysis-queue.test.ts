import { describe, expect, test } from "bun:test";
import type { VideoAnalysisRuntimeServices } from "./analysis.ts";
import {
  consumeVideoAnalysisQueueMessage,
  decodeVideoAnalysisQueueMessage,
  type VideoAnalysisOutboxRecord,
  type VideoAnalysisOutboxStore,
} from "./analysis-queue.ts";

const launcher = {
  get: async () => "missing" as const,
  instanceId: async () => `vaw-${"a".repeat(64)}`,
  create: async () => "created" as const,
};

const record = (overrides: Partial<VideoAnalysisOutboxRecord> = {}): VideoAnalysisOutboxRecord => ({
  effectIdentity: "video-analysis:operation-1:v1:c1",
  submissionId: "submission-1",
  operationId: "operation-1",
  videoRevision: 1,
  creationRevision: 1,
  canonicalVideoSha256: "a".repeat(64),
  state: "pending",
  launchAttempts: 0,
  continuation: 0,
  claimOwner: null,
  claimFence: 0,
  workflowInstanceId: null,
  instanceMissing: false,
  ...overrides,
});

describe("video analysis Queue ingress", () => {
  test("a database failure after accepted create does not enter the create retry budget", async () => {
    const claimed = record({
      state: "launching",
      claimOwner: "worker",
      claimFence: 1,
      launchAttempts: 1,
    });
    let retryWrites = 0;
    const runtime = {
      store: {
        getSubmissionByOperation: async () => ({
          state: {
            videoRevision: 1,
            creationRevision: 1,
            status: "processing",
            decision: null,
            video: { canonicalSha256: "a".repeat(64) },
          },
        }),
      },
    } as unknown as VideoAnalysisRuntimeServices;
    const outbox = {
      get: async () => record(),
      claim: async () => claimed,
      markLaunched: async () => {
        throw new Error("database unavailable");
      },
      markRetryWait: async () => {
        retryWrites += 1;
        return true;
      },
    } as unknown as VideoAnalysisOutboxStore;
    await expect(
      consumeVideoAnalysisQueueMessage(
        { kind: "video_analysis", outbox_id: claimed.effectIdentity },
        { outbox, runtime, launcher, workerId: "worker" },
      ),
    ).rejects.toThrow("database unavailable");
    expect(retryWrites).toBe(0);
  });

  test("third failed create persists author failure before acknowledging exhaustion", async () => {
    const claimed = record({
      state: "launching",
      claimOwner: "worker",
      claimFence: 3,
      launchAttempts: 3,
    });
    const events: string[] = [];
    const runtime = {
      store: {
        getSubmissionByOperation: async () => ({
          state: {
            videoRevision: 1,
            creationRevision: 1,
            status: "processing",
            decision: null,
            video: { canonicalSha256: "a".repeat(64) },
          },
        }),
        recordProcessingFailure: async () => {
          events.push("author-failure");
        },
      },
    } as unknown as VideoAnalysisRuntimeServices;
    const outbox = {
      get: async () => record({ state: "retry_wait", launchAttempts: 2 }),
      claim: async () => claimed,
      markExhausted: async () => {
        events.push("exhausted");
        return true;
      },
    } as unknown as VideoAnalysisOutboxStore;
    expect(
      await consumeVideoAnalysisQueueMessage(
        { kind: "video_analysis", outbox_id: claimed.effectIdentity },
        {
          outbox,
          runtime,
          launcher: {
            ...launcher,
            create: async () => {
              throw new Error("create failed");
            },
          },
          workerId: "worker",
        },
      ),
    ).toEqual({ disposition: "ack" });
    expect(events).toEqual(["author-failure", "exhausted"]);
  });

  test("accepts only the closed discriminator and durable identity", () => {
    expect(
      decodeVideoAnalysisQueueMessage({
        kind: "video_analysis",
        outbox_id: "video-analysis:operation-1:v1:c1",
      }),
    ).toEqual({ kind: "video_analysis", outbox_id: "video-analysis:operation-1:v1:c1" });
    expect(() =>
      decodeVideoAnalysisQueueMessage({
        kind: "video_analysis",
        outbox_id: "video-analysis:operation-1:v1:c1",
        source_url: "https://user.invalid/video",
      }),
    ).toThrow();
    expect(() =>
      decodeVideoAnalysisQueueMessage({ kind: "video_analysis", outbox_id: "" }),
    ).toThrow();
  });

  test("acknowledges superseded authority without launching or changing the newer submission", async () => {
    let current = record();
    const calls: string[] = [];
    const outbox: VideoAnalysisOutboxStore = {
      markExhausted: async () => true,
      get: async () => current,
      claim: async (_identity, workerId) => {
        calls.push("claim");
        current = {
          ...current,
          state: "launching",
          launchAttempts: 1,
          claimOwner: workerId,
          claimFence: 1,
        };
        return current;
      },
      markLaunched: async () => {
        calls.push("complete");
        return true;
      },
      markInstanceMissing: async () => {
        calls.push("defer");
        return true;
      },
      markRetryWait: async () => {
        calls.push("fail");
        return true;
      },
    };
    const runtime = {
      store: {
        getSubmissionByOperation: async () => ({
          state: {
            submissionId: "submission-1",
            operationId: "operation-1",
            videoRevision: 2,
            creationRevision: 1,
            video: { canonicalSha256: "b".repeat(64) },
          },
        }),
      },
    } as unknown as VideoAnalysisRuntimeServices;
    expect(
      await consumeVideoAnalysisQueueMessage(
        { kind: "video_analysis", outbox_id: current.effectIdentity },
        { outbox, runtime, launcher, workerId: "video-worker-1" },
      ),
    ).toEqual({ disposition: "ack" });
    expect(calls).toEqual([]);
  });

  test("acknowledges launched replay and durably exhausted delivery", async () => {
    let current = record({ state: "launched", launchAttempts: 1 });
    const outbox = {
      get: async () => current,
    } as unknown as VideoAnalysisOutboxStore;
    const runtime = {} as VideoAnalysisRuntimeServices;
    const message = { kind: "video_analysis", outbox_id: current.effectIdentity };
    expect(
      await consumeVideoAnalysisQueueMessage(message, {
        outbox,
        launcher,
        runtime,
        workerId: "video-worker-1",
      }),
    ).toEqual({ disposition: "ack" });
    current = record({ state: "exhausted", launchAttempts: 3 });
    expect(
      await consumeVideoAnalysisQueueMessage(message, {
        outbox,
        launcher,
        runtime,
        workerId: "video-worker-1",
      }),
    ).toEqual({ disposition: "ack" });
  });
});
