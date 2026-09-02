import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { DanceAttemptProcessorComposition } from "../../apps/media-processor-worker/src/dance-attempt.ts";
import {
  makeDanceAttemptQueueWorker,
  makeDanceAttemptWorkflowRunner,
} from "../../apps/media-processor-worker/src/dance-attempt.ts";
import type {
  DanceAttemptGraderAdapter,
  DanceAttemptProcessingStore,
} from "../../packages/application/src/dance/attempt-processing.ts";
import type {
  DanceAttemptWakeupRecord,
  DanceAttemptWakeupStore,
} from "../../packages/application/src/dance/attempt-processing-wakeup.ts";
import { makeCloudflareWorkflowEntrypoint } from "../../packages/platform-cf/src/cloudflare-workflow-entrypoint.ts";
import { makeCloudflareDanceAttemptWorkflowLauncher } from "../../packages/platform-cf/src/dance-attempt-processing-cloudflare.ts";

const HASH_A = "11".repeat(32);

const wakeup: DanceAttemptWakeupRecord = {
  attemptId: "attempt-1",
  effectIdentity: "dance-attempt-1",
  inputDigest: HASH_A,
  attemptState: "grading_pending",
  state: "pending",
  deliveryAttempts: 0,
  claimFence: 0,
  eligible: true,
};

function processingStore(
  getWakeup: DanceAttemptWakeupStore["getWakeup"],
): DanceAttemptProcessingStore & DanceAttemptWakeupStore {
  return {
    claim: () => Effect.die(new Error("unexpected processing claim")),
    complete: () => Effect.die(new Error("unexpected processing completion")),
    fail: () => Effect.die(new Error("unexpected processing failure")),
    getWakeup,
    listEligibleWakeups: async () => [],
  };
}

const dormantAdapter: DanceAttemptGraderAdapter = {
  grade: () => Effect.die(new Error("Queue wake-up must not call the grader")),
};

function composition(input: {
  readonly getWakeup: DanceAttemptWakeupStore["getWakeup"];
  readonly createBatch: (
    batch: readonly { readonly id: string; readonly params: unknown }[],
  ) => Promise<readonly unknown[]>;
  readonly adapter?: DanceAttemptGraderAdapter | null;
}): DanceAttemptProcessorComposition {
  const store = processingStore(input.getWakeup);
  const workflow = makeCloudflareDanceAttemptWorkflowLauncher({
    createBatch: input.createBatch,
  });
  return {
    queue: { store, workflow },
    workflow: {
      store,
      adapter: input.adapter === undefined ? dormantAdapter : input.adapter,
      leaseSeconds: 60,
      retryAfterSeconds: 30,
    },
  };
}

function delivery(id: string, body: unknown) {
  const actions: unknown[] = [];
  return {
    message: {
      id,
      body,
      ack: () => actions.push({ disposition: "ack" }),
      retry: (options?: { readonly delaySeconds?: number }) =>
        actions.push({ disposition: "retry", options }),
    },
    actions,
  };
}

describe("Dance attempt Workerd wake-up recovery", () => {
  it("converges duplicate Queue delivery on one deterministic Workflow identity", async () => {
    const created: unknown[] = [];
    let launches = 0;
    const runtime = composition({
      getWakeup: async () => wakeup,
      createBatch: async (batch) => {
        created.push(...batch);
        launches += 1;
        return launches === 1 ? [{}] : [];
      },
    });
    const worker = makeDanceAttemptQueueWorker(() => runtime);
    const first = delivery("delivery-1", { attempt_id: "attempt-1" });
    const duplicate = delivery("delivery-1", { attempt_id: "attempt-1" });

    await worker.queue({ messages: [first.message] }, { DANCE_ATTEMPT_PROCESSING_ENABLED: "true" });
    await worker.queue(
      { messages: [duplicate.message] },
      { DANCE_ATTEMPT_PROCESSING_ENABLED: "true" },
    );

    expect(first.actions).toEqual([{ disposition: "ack" }]);
    expect(duplicate.actions).toEqual([{ disposition: "ack" }]);
    expect(created).toHaveLength(2);
    expect(created[0]).toEqual(created[1]);
    expect(created[0]).toMatchObject({
      id: expect.stringMatching(/^datt-[0-9a-f]{64}$/u),
      params: {
        version: "dance-attempt-workflow-v1",
        attemptId: "attempt-1",
        effectIdentity: "dance-attempt-1",
        inputDigest: HASH_A,
      },
    });
    expect(JSON.stringify(created)).not.toContain("score");
  });

  it("retries one failed delivery without retrying a successful batch peer", async () => {
    const runtime = composition({
      getWakeup: async (attemptId) => {
        if (attemptId === "attempt-broken") throw new Error("transient authority failure");
        return wakeup;
      },
      createBatch: async () => [{}],
    });
    const worker = makeDanceAttemptQueueWorker(() => runtime);
    const failed = delivery("delivery-broken", { attempt_id: "attempt-broken" });
    const accepted = delivery("delivery-accepted", { attempt_id: "attempt-1" });

    await worker.queue(
      { messages: [failed.message, accepted.message] },
      { DANCE_ATTEMPT_PROCESSING_ENABLED: "true" },
    );

    expect(failed.actions).toEqual([{ disposition: "retry", options: { delaySeconds: 15 } }]);
    expect(accepted.actions).toEqual([{ disposition: "ack" }]);
  });

  it("keeps Queue and Workflow execution inert without an injected grader", async () => {
    let resolvedQueue = false;
    const disabledWorker = makeDanceAttemptQueueWorker(() => {
      resolvedQueue = true;
      throw new Error("disabled Dance composition must not resolve");
    });
    const queued = delivery("delivery-1", { attempt_id: "attempt-1" });
    await disabledWorker.queue({ messages: [queued.message] }, {});
    expect(resolvedQueue).toBe(false);
    expect(queued.actions).toEqual([{ disposition: "retry", options: { delaySeconds: 900 } }]);

    let steps = 0;
    let wakeups = 0;
    const runtime = composition({
      getWakeup: async () => {
        wakeups += 1;
        return wakeup;
      },
      createBatch: async () => [{}],
      adapter: null,
    });
    const runner = makeDanceAttemptWorkflowRunner(() => runtime);
    const result = await runner(
      { DANCE_ATTEMPT_PROCESSING_ENABLED: "true" },
      {
        instanceId: "workflow-1",
        payload: {
          version: "dance-attempt-workflow-v1",
          attemptId: "attempt-1",
          effectIdentity: "dance-attempt-1",
          inputDigest: HASH_A,
        },
      },
      {
        do: async () => {
          steps += 1;
          throw new Error("null grader must not start a durable step");
        },
      },
    );
    expect(result).toEqual({ kind: "inert" });
    expect(steps).toBe(0);
    expect(wakeups).toBe(0);
  });

  it("builds an unregistered Workflow entrypoint around the provider-free runner", () => {
    const runtime = composition({
      getWakeup: async () => wakeup,
      createBatch: async () => [{}],
      adapter: null,
    });
    const Entrypoint = makeCloudflareWorkflowEntrypoint(
      makeDanceAttemptWorkflowRunner(() => runtime),
    );
    expect(Entrypoint).toBeTypeOf("function");
  });
});
