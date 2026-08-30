import { describe, expect, test } from "bun:test";
import type { DanceReferenceWakeupRecord } from "./reference-processing-wakeup.ts";
import { consumeDanceReferenceQueueMessage } from "./reference-processing-wakeup.ts";

const wakeup = (
  overrides: Partial<DanceReferenceWakeupRecord> = {},
): DanceReferenceWakeupRecord => ({
  outboxId: "outbox-1",
  choreographyId: "choreography-1",
  choreographyRevision: 1,
  effectIdentity: "effect-1",
  revisionStatus: "processing",
  state: "pending",
  deliveryAttempts: 0,
  claimFence: 0,
  eligible: true,
  ...overrides,
});

describe("Dance reference Queue wake-up", () => {
  test("launches a closed persisted-identity payload", async () => {
    const launches: unknown[] = [];
    const disposition = await consumeDanceReferenceQueueMessage(
      { outbox_id: "outbox-1" },
      "delivery-1",
      {
        store: {
          getWakeup: async () => wakeup(),
          listEligibleWakeups: async () => [],
        },
        workflow: {
          create: async (instanceId, payload) => {
            launches.push({ instanceId, payload });
            return "created";
          },
        },
      },
    );
    expect(disposition).toEqual({ disposition: "ack" });
    expect(launches).toEqual([
      {
        instanceId: "dance-reference-delivery-1",
        payload: {
          version: "dance-reference-workflow-v1",
          outboxId: "outbox-1",
          choreographyId: "choreography-1",
          choreographyRevision: 1,
          effectIdentity: "effect-1",
        },
      },
    ]);
  });

  test("rejects payload authority and acknowledges a no-longer-eligible wake-up", async () => {
    let launches = 0;
    const dependencies = {
      store: {
        getWakeup: async () => wakeup({ state: "running", claimFence: 1, eligible: false }),
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
      await consumeDanceReferenceQueueMessage(
        { outbox_id: "outbox-1", score: 10_000 },
        "delivery-1",
        dependencies,
      ),
    ).toEqual({ disposition: "dlq" });
    expect(
      await consumeDanceReferenceQueueMessage(
        { outbox_id: "outbox-1" },
        "delivery-2",
        dependencies,
      ),
    ).toEqual({ disposition: "ack" });
    expect(launches).toBe(0);
  });
});
