import { describe, expect, test } from "bun:test";
import type {
  MediaProcessingAuthority,
  MediaProcessingStore,
} from "../../../packages/application/src/media/processing-contracts.ts";
import type { MediaProcessingQueueDependencies } from "../../../packages/application/src/media/processing-queue.ts";
import type { MediaProcessingWorkflowDependencies } from "../../../packages/application/src/media/processing-workflow.ts";
import { type MediaProcessingWorkflowStep, makeMediaProcessingWorkflowRunner } from "./index.ts";

describe("media workflow Effect boundary", () => {
  test("resolves provider composition inside the durable step", async () => {
    const compositionError = new Error("secret unavailable");
    let insideStep = false;
    let stepCalls = 0;
    const runner = makeMediaProcessingWorkflowRunner(() => {
      expect(insideStep).toBe(true);
      throw compositionError;
    });
    const step = {
      do: async <T>(_name: string, _options: unknown, callback: () => Promise<T>) => {
        stepCalls += 1;
        insideStep = true;
        try {
          return await callback();
        } finally {
          insideStep = false;
        }
      },
      waitForEvent: async () => {
        throw new Error("composition failure must not wait");
      },
      sleep: async () => undefined,
    } as MediaProcessingWorkflowStep;

    await expect(
      runner(
        {},
        {
          instanceId: "media-operation-1-r1",
          payload: {
            outboxId: "outbox-1",
            submissionId: "submission-1",
            operationId: "operation-1",
            workflowRevision: 1,
          },
        },
        step,
      ),
    ).rejects.toBe(compositionError);
    expect(stepCalls).toBe(1);
  });

  test("owns the Promise runtime root inside durable step.do", async () => {
    const authority = {
      submissionId: "submission-1",
      operationId: "operation-1",
      workflowRevision: 1,
      status: "blocked",
    } as MediaProcessingAuthority;
    const store = {
      getOutbox: async () => ({
        outboxId: "outbox-1",
        eventType: "analysis_launch",
        submissionId: authority.submissionId,
        operationId: authority.operationId,
        workflowRevision: authority.workflowRevision,
        workflowInstanceId: "media-operation-1-r1",
        deliveryAttempts: 1,
        state: "delivered",
        claimFence: 1,
        claimOwner: null,
      }),
      loadAuthority: async () => authority,
    } as unknown as MediaProcessingStore;
    const workflow = {
      store,
      providers: null,
      options: {
        enabled: true,
        workerId: "worker-1",
        now: () => 1,
        policyRevision: "policy-v1",
        transformAdapterRevision: "transform-v1",
        metadataAdapterRevision: "metadata-v1",
        classifierTimeoutMs: 1_000,
        transformRuntimeMs: 1_000,
        maximumSampleBytes: 1_000,
      },
    } satisfies MediaProcessingWorkflowDependencies;
    let callbackResult: unknown;
    const runner = makeMediaProcessingWorkflowRunner(() => ({
      queue: {} as MediaProcessingQueueDependencies,
      workflow,
    }));
    const step = {
      do: async <T>(_name: string, _options: unknown, callback: () => Promise<T>) => {
        callbackResult = callback();
        expect(callbackResult).toBeInstanceOf(Promise);
        return callbackResult as Promise<T>;
      },
      waitForEvent: async () => {
        throw new Error("terminal workflows do not wait");
      },
      sleep: async () => undefined,
    } as MediaProcessingWorkflowStep;

    const result = await runner(
      {},
      {
        instanceId: "media-operation-1-r1",
        payload: {
          outboxId: "outbox-1",
          submissionId: "submission-1",
          operationId: "operation-1",
          workflowRevision: 1,
        },
      },
      step,
    );

    expect(result).toEqual({ outcome: "blocked" });
    expect(await (callbackResult as Promise<unknown>)).toEqual({
      eventType: "analysis_launch",
      result: { outcome: "blocked" },
    });
  });
});
