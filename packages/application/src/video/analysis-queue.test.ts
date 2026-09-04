import { describe, expect, test } from "bun:test";
import type { VideoAnalysisRuntimeServices } from "./analysis.ts";
import {
  consumeVideoAnalysisQueueMessage,
  decodeVideoAnalysisQueueMessage,
  type VideoAnalysisOutboxRecord,
  type VideoAnalysisOutboxStore,
} from "./analysis-queue.ts";

const record = (overrides: Partial<VideoAnalysisOutboxRecord> = {}): VideoAnalysisOutboxRecord => ({
  effectIdentity: "video-analysis:operation-1:v1:c1",
  submissionId: "submission-1",
  operationId: "operation-1",
  videoRevision: 1,
  creationRevision: 1,
  canonicalVideoSha256: "a".repeat(64),
  state: "pending",
  deliveryAttempts: 0,
  claimOwner: null,
  claimFence: 0,
  ...overrides,
});

describe("video analysis Queue ingress", () => {
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

  test("dead-letters a stale immutable authority after persisting failure", async () => {
    let current = record();
    const calls: string[] = [];
    const outbox: VideoAnalysisOutboxStore = {
      get: async () => current,
      claim: async (_identity, workerId) => {
        calls.push("claim");
        current = {
          ...current,
          state: "running",
          deliveryAttempts: 1,
          claimOwner: workerId,
          claimFence: 1,
        };
        return current;
      },
      complete: async () => {
        calls.push("complete");
        return true;
      },
      fail: async () => {
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
        { outbox, runtime, workerId: "video-worker-1" },
      ),
    ).toEqual({ disposition: "dlq" });
    expect(calls).toEqual(["claim", "fail"]);
  });

  test("acknowledges delivered replay and dead-letters exhausted delivery", async () => {
    let current = record({ state: "delivered", deliveryAttempts: 1 });
    const outbox = {
      get: async () => current,
    } as unknown as VideoAnalysisOutboxStore;
    const runtime = {} as VideoAnalysisRuntimeServices;
    const message = { kind: "video_analysis", outbox_id: current.effectIdentity };
    expect(
      await consumeVideoAnalysisQueueMessage(message, {
        outbox,
        runtime,
        workerId: "video-worker-1",
      }),
    ).toEqual({ disposition: "ack" });
    current = record({ state: "exhausted", deliveryAttempts: 3 });
    expect(
      await consumeVideoAnalysisQueueMessage(message, {
        outbox,
        runtime,
        workerId: "video-worker-1",
      }),
    ).toEqual({ disposition: "dlq" });
  });
});
