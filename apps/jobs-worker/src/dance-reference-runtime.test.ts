import { describe, expect, test } from "bun:test";
import type { DanceReferenceWakeupRecord } from "@pirate/application/dance/reference-processing-wakeup";
import { dispatchDanceReferenceWakeups } from "./dance-reference-runtime.ts";

const wakeup = (outboxId: string): DanceReferenceWakeupRecord => ({
  outboxId,
  choreographyId: "choreography-1",
  choreographyRevision: 1,
  effectIdentity: "effect-1",
  revisionStatus: "processing",
  state: "pending",
  deliveryAttempts: 0,
  claimFence: 0,
  eligible: true,
});

describe("Dance reference maintenance", () => {
  test("dispatches only bounded durable outbox identities", async () => {
    const messages: unknown[] = [];
    const limits: number[] = [];
    const result = await dispatchDanceReferenceWakeups(
      {
        listEligibleWakeups: async (limit) => {
          limits.push(limit);
          return [wakeup("outbox-1"), wakeup("outbox-2")];
        },
      },
      {
        send: async (message) => {
          messages.push(message);
        },
      },
      2,
    );
    expect(limits).toEqual([2]);
    expect(messages).toEqual([{ outbox_id: "outbox-1" }, { outbox_id: "outbox-2" }]);
    expect(result).toEqual({ selected: 2, dispatched: 2, failed: 0 });
  });

  test("keeps failed sends eligible for a later reconciliation tick", async () => {
    const result = await dispatchDanceReferenceWakeups(
      { listEligibleWakeups: async () => [wakeup("outbox-failed")] },
      { send: async () => Promise.reject(new Error("fixture Queue failure")) },
    );
    expect(result).toEqual({ selected: 1, dispatched: 0, failed: 1 });
  });
});
