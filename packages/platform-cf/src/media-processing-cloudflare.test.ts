import { describe, expect, test } from "bun:test";
import type { MediaProcessingWorkflowPayload } from "../../application/src/media/processing-contracts.ts";
import {
  applyMediaProcessingQueueDisposition,
  makeCloudflareMediaProcessingWorkflowLauncher,
} from "./media-processing-cloudflare.ts";

const payload: MediaProcessingWorkflowPayload = {
  outboxId: "outbox-1",
  submissionId: "submission-1",
  operationId: "operation-1",
  workflowRevision: 1,
};

describe("Cloudflare media processing adapters", () => {
  test("converges duplicate deterministic Workflow creation", async () => {
    const events: string[] = [];
    const instance = {
      id: "media-operation-1-r1",
      status: async () => ({ status: "running" as const }),
      pause: async () => undefined,
      resume: async () => undefined,
      terminate: async () => undefined,
      restart: async () => undefined,
      sendEvent: async ({ type }: { type: string }) => {
        events.push(`event:${type}`);
      },
    };
    const binding = {
      create: async () => {
        events.push("create");
        throw new Error("instance already exists");
      },
      get: async () => {
        events.push("get");
        return instance;
      },
      createBatch: async () => [],
      getBatch: async () => [],
    };
    const launcher = makeCloudflareMediaProcessingWorkflowLauncher(binding);

    expect(await launcher.create(instance.id, payload)).toBe("already_exists");
    await launcher.notify(instance.id, "decision_wakeup", payload);
    expect(events).toEqual(["create", "get", "get", "event:decision_wakeup"]);
  });

  test("propagates create failure when deterministic identity is still missing", async () => {
    const binding = {
      create: async () => {
        throw new Error("transport unavailable");
      },
      get: async () => {
        throw new Error("missing");
      },
    };
    const launcher = makeCloudflareMediaProcessingWorkflowLauncher(binding);
    await expect(launcher.create("media-operation-1-r1", payload)).rejects.toThrow(
      "transport unavailable",
    );
  });

  test("maps every disposition to exactly one per-message action", () => {
    const actions: string[] = [];
    const message = {
      ack: () => actions.push("ack"),
      retry: (options?: { delaySeconds?: number }) =>
        actions.push(`retry:${options?.delaySeconds ?? "platform-dlq"}`),
    };

    applyMediaProcessingQueueDisposition(message, { disposition: "ack" });
    applyMediaProcessingQueueDisposition(message, { disposition: "retry", delaySeconds: 30 });
    applyMediaProcessingQueueDisposition(message, { disposition: "dlq" });
    expect(actions).toEqual(["ack", "retry:30", "retry:platform-dlq"]);
  });
});
