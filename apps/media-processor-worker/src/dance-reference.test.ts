import { describe, expect, test } from "bun:test";
import type { DanceReferenceProcessorComposition } from "./dance-reference.ts";
import {
  makeDanceReferenceQueueWorker,
  makeDanceReferenceWorkflowRunner,
} from "./dance-reference.ts";

describe("Dance reference processor posture", () => {
  test("retains Queue authority without resolving composition while disabled", async () => {
    let resolved = false;
    let retryOptions: unknown;
    const worker = makeDanceReferenceQueueWorker(() => {
      resolved = true;
      throw new Error("disabled Dance composition must not resolve");
    });
    await worker.queue(
      {
        messages: [
          {
            id: "delivery-1",
            body: { outbox_id: "outbox-1" },
            ack: () => {
              throw new Error("disabled Dance queue must not acknowledge");
            },
            retry: (options) => {
              retryOptions = options;
            },
          },
        ],
      },
      {},
    );
    expect(resolved).toBe(false);
    expect(retryOptions).toEqual({ delaySeconds: 900 });
  });

  test("keeps an enabled flag inert without an explicitly injected processor", async () => {
    let retryOptions: unknown;
    const composition = {
      queue: {},
      workflow: { processor: null },
    } as unknown as DanceReferenceProcessorComposition;
    const worker = makeDanceReferenceQueueWorker(() => composition);
    await worker.queue(
      {
        messages: [
          {
            id: "delivery-1",
            body: { outbox_id: "outbox-1" },
            ack: () => {
              throw new Error("missing processor must not acknowledge");
            },
            retry: (options) => {
              retryOptions = options;
            },
          },
        ],
      },
      { DANCE_REFERENCE_PROCESSING_ENABLED: "true" },
    );
    expect(retryOptions).toEqual({ delaySeconds: 900 });

    let resolved = false;
    const runner = makeDanceReferenceWorkflowRunner(() => {
      resolved = true;
      return composition;
    });
    const result = await runner(
      {},
      {
        instanceId: "workflow-1",
        payload: {
          version: "dance-reference-workflow-v1",
          outboxId: "outbox-1",
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          effectIdentity: "effect-1",
        },
      },
      {
        do: async () => {
          throw new Error("disabled Workflow must not start a durable step");
        },
        sleep: async () => undefined,
      },
    );
    expect(result).toEqual({ outcome: "inert" });
    expect(resolved).toBe(false);
  });
});
