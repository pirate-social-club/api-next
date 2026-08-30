import { describe, expect, it } from "vitest";
import type { DanceReferenceProcessorComposition } from "../../apps/media-processor-worker/src/dance-reference.ts";
import {
  makeDanceReferenceQueueWorker,
  makeDanceReferenceWorkflowRunner,
} from "../../apps/media-processor-worker/src/dance-reference.ts";
import type { DanceReferenceProcessorService } from "../../packages/application/src/dance/reference-processing.ts";
import type { DanceReferenceWakeupRecord } from "../../packages/application/src/dance/reference-processing-wakeup.ts";
import { makeCloudflareDanceReferenceWorkflowLauncher } from "../../packages/platform-cf/src/dance-reference-processing-cloudflare.ts";

const wakeup: DanceReferenceWakeupRecord = {
  outboxId: "outbox-1",
  choreographyId: "choreography-1",
  choreographyRevision: 1,
  effectIdentity: "effect-1",
  revisionStatus: "processing",
  state: "pending",
  deliveryAttempts: 0,
  claimFence: 0,
  eligible: true,
};

describe("Dance reference Workerd wake-up", () => {
  it("launches one identifier-only Workflow and acknowledges the Queue delivery", async () => {
    const created: unknown[] = [];
    const launcher = makeCloudflareDanceReferenceWorkflowLauncher({
      createBatch: async (options) => {
        created.push(...options);
        return [{}];
      },
    });
    const processor = {} as DanceReferenceProcessorService;
    const composition = {
      queue: {
        store: {
          getWakeup: async () => wakeup,
          listEligibleWakeups: async () => [],
        },
        workflow: launcher,
      },
      workflow: { processor },
    } as unknown as DanceReferenceProcessorComposition;
    const worker = makeDanceReferenceQueueWorker(() => composition);
    let acknowledged = 0;
    await worker.queue(
      {
        messages: [
          {
            id: "delivery-1",
            body: { outbox_id: "outbox-1" },
            ack: () => {
              acknowledged += 1;
            },
            retry: () => {
              throw new Error("valid wake-up must not retry");
            },
          },
        ],
      },
      { DANCE_REFERENCE_PROCESSING_ENABLED: "true" },
    );
    expect(acknowledged).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: expect.stringMatching(/^dref-[0-9a-f]{64}$/u),
      params: {
        version: "dance-reference-workflow-v1",
        outboxId: "outbox-1",
        choreographyId: "choreography-1",
        choreographyRevision: 1,
        effectIdentity: "effect-1",
      },
    });
    expect(JSON.stringify(created)).not.toContain("score");
  });

  it("keeps Workflow execution inert without an explicitly injected processor", async () => {
    let steps = 0;
    const runner = makeDanceReferenceWorkflowRunner(
      () =>
        ({
          queue: {},
          workflow: { processor: null },
        }) as unknown as DanceReferenceProcessorComposition,
    );
    const result = await runner(
      { DANCE_REFERENCE_PROCESSING_ENABLED: "true" },
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
          steps += 1;
          throw new Error("no processor means no durable execution");
        },
        sleep: async () => undefined,
      },
    );
    expect(result).toEqual({ outcome: "inert" });
    expect(steps).toBe(0);
  });
});
