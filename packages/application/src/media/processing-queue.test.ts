import { describe, expect, test } from "bun:test";
import type {
  MediaProcessingOutboxRecord,
  MediaProcessingStore,
  MediaProcessingWorkflowLauncher,
} from "./processing-contracts.ts";
import { decodeMediaProcessingQueueMessage } from "./processing-contracts.ts";
import { consumeMediaProcessingQueueMessage } from "./processing-queue.ts";

const record = (
  overrides: Partial<MediaProcessingOutboxRecord> = {},
): MediaProcessingOutboxRecord => ({
  outboxId: "outbox-1",
  eventType: "analysis_launch",
  submissionId: "submission-1",
  operationId: "operation-1",
  workflowRevision: 1,
  workflowInstanceId: "media-operation-1-r1",
  deliveryAttempts: 0,
  state: "pending",
  claimFence: 0,
  claimOwner: null,
  ...overrides,
});

function queueHarness(options: { create?: "created" | "already_exists" | "throw" } = {}) {
  let current = record();
  let present = false;
  const calls: string[] = [];
  const store = {
    getOutbox: async () => current,
    claimOutbox: async (_outboxId: string, workerId: string) => {
      current = {
        ...current,
        state: "running",
        deliveryAttempts: current.deliveryAttempts + 1,
        claimFence: current.claimFence + 1,
        claimOwner: workerId,
      };
      calls.push("claim");
      return current;
    },
    completeOutbox: async () => {
      calls.push("complete");
      current = { ...current, state: "delivered", claimOwner: null };
      return true;
    },
    failOutbox: async () => {
      calls.push("fail");
      current = {
        ...current,
        state: current.deliveryAttempts >= 3 ? "exhausted" : "failed",
        claimOwner: null,
      };
      return true;
    },
    loadAuthority: async () => ({
      communityId: "community-1",
      actorAccountId: "account-1",
      authorPersonaId: "persona-1",
      submissionId: "submission-1",
      operationId: "operation-1",
      songType: "original",
      creationRevision: 2,
      audioRevision: 1,
      analysisRevision: 1,
      decisionRevision: 0,
      workflowRevision: 1,
      retryCount: 0,
      status: "processing",
      phase: "analysis",
      audio: {
        immutableRef: "private/audio",
        canonicalSha256: "a".repeat(64),
        contentType: "audio/mpeg",
        sizeBytes: 1,
      },
      termsRevision: null,
      lyrics: null,
      analysis: null,
      decision: null,
      boundReferenceAssetId: null,
      postId: null,
      publishedLyricsRevision: null,
    }),
  } as Pick<
    MediaProcessingStore,
    "getOutbox" | "claimOutbox" | "completeOutbox" | "failOutbox" | "loadAuthority"
  >;
  const workflow: MediaProcessingWorkflowLauncher = {
    get: async () => {
      calls.push("get");
      return present ? "present" : "missing";
    },
    create: async () => {
      calls.push("create");
      if (options.create === "throw") throw new Error("transport unavailable");
      if (options.create === "already_exists") {
        present = true;
        return "already_exists";
      }
      present = true;
      return "created";
    },
    notify: async () => {
      calls.push("notify");
    },
  };
  return {
    calls,
    store: store as MediaProcessingStore,
    workflow,
    setCurrent(next: MediaProcessingOutboxRecord) {
      current = next;
    },
    current: () => current,
  };
}

describe("media processing Queue ingress", () => {
  test("accepts only an outbox id", () => {
    expect(decodeMediaProcessingQueueMessage({ outbox_id: "outbox-1" })).toEqual({
      outbox_id: "outbox-1",
    });
    expect(() =>
      decodeMediaProcessingQueueMessage({ outbox_id: "outbox-1", operation_id: "leak" }),
    ).toThrow();
    expect(() => decodeMediaProcessingQueueMessage({ outbox_id: "" })).toThrow();
  });

  test("acks only after deterministic create and durable convergence", async () => {
    const harness = queueHarness();
    const result = await consumeMediaProcessingQueueMessage(
      { outbox_id: "outbox-1" },
      { store: harness.store, workflow: harness.workflow, workerId: "queue-worker-1" },
    );
    expect(result).toEqual({ disposition: "ack" });
    expect(harness.calls).toEqual(["claim", "get", "create", "complete"]);
    expect(harness.current().state).toBe("delivered");
  });

  test("duplicate create converges through get without a second identity", async () => {
    const harness = queueHarness({ create: "already_exists" });
    expect(
      await consumeMediaProcessingQueueMessage(
        { outbox_id: "outbox-1" },
        { store: harness.store, workflow: harness.workflow, workerId: "queue-worker-1" },
      ),
    ).toEqual({ disposition: "ack" });
    expect(harness.calls).toEqual(["claim", "get", "create", "get", "complete"]);
  });

  test("persists failure before retry and reaches DLQ on the third attempt", async () => {
    const harness = queueHarness({ create: "throw" });
    const first = await consumeMediaProcessingQueueMessage(
      { outbox_id: "outbox-1" },
      { store: harness.store, workflow: harness.workflow, workerId: "queue-worker-1" },
    );
    expect(first).toEqual({ disposition: "retry", delaySeconds: 15 });
    expect(harness.calls.at(-1)).toBe("fail");

    harness.setCurrent(record({ deliveryAttempts: 2, state: "failed", claimFence: 2 }));
    const third = await consumeMediaProcessingQueueMessage(
      { outbox_id: "outbox-1" },
      { store: harness.store, workflow: harness.workflow, workerId: "queue-worker-1" },
    );
    expect(third).toEqual({ disposition: "dlq" });
    expect(harness.current().state).toBe("exhausted");
  });

  test("invalid payloads and missing authority are sent to DLQ without launch", async () => {
    const harness = queueHarness();
    expect(
      await consumeMediaProcessingQueueMessage(
        { outbox_id: "outbox-1", transcript: "hostile" },
        { store: harness.store, workflow: harness.workflow, workerId: "queue-worker-1" },
      ),
    ).toEqual({ disposition: "dlq" });
    expect(harness.calls).toEqual([]);
  });

  test("rejects a non-deterministic persisted Workflow identity", async () => {
    const harness = queueHarness();
    harness.setCurrent(record({ workflowInstanceId: "media-operation-1-r99" }));
    expect(
      await consumeMediaProcessingQueueMessage(
        { outbox_id: "outbox-1" },
        { store: harness.store, workflow: harness.workflow, workerId: "queue-worker-1" },
      ),
    ).toEqual({ disposition: "dlq" });
    expect(harness.calls).toEqual(["claim", "fail"]);
  });
});
