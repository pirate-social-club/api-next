import { Effect } from "effect";
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
  it("executes the Effect inside the named step and returns a busy claim", async () => {
    const events: string[] = [];
    const store: DanceReferenceProcessorComposition["workflow"]["store"] = {
      getWakeup: async () => {
        events.push("read");
        return wakeup;
      },
      listEligibleWakeups: async () => [],
      claim: async () => {
        events.push("claim");
        return { kind: "busy" };
      },
      recordPrepared: async () => {
        throw new Error("busy claim must not write preparation");
      },
      complete: async () => {
        throw new Error("busy claim must not complete");
      },
    };
    const composition: DanceReferenceProcessorComposition = {
      queue: { store, workflow: { create: async () => "created" } },
      workflow: {
        store,
        processor: {
          prepareReference: () => Effect.die("busy claim must not prepare"),
          observeReference: () => Effect.die("busy claim must not observe"),
        },
        leaseSeconds: 60,
        adapterId: "fake-reference",
        adapterRevision: "fake-v1",
      },
    };
    const result = await makeDanceReferenceWorkflowRunner(() => composition)(
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
        do: async (name, _options, callback) => {
          events.push(name);
          const value = await callback();
          events.push("step-finished");
          return value;
        },
        sleep: async () => {
          throw new Error("busy claim must not poll");
        },
      },
    );
    expect(result).toEqual({ outcome: "busy" });
    expect(events).toEqual(["dance-reference-processing-0", "read", "claim", "step-finished"]);
  });

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
