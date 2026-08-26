import { describe, expect, test } from "bun:test";
import type {
  MediaProcessingAuthority,
  MediaProcessingStore,
} from "../../../packages/application/src/media/processing-contracts.ts";
import type { MediaProcessingQueueDependencies } from "../../../packages/application/src/media/processing-queue.ts";
import type { MediaProcessingWorkflowDependencies } from "../../../packages/application/src/media/processing-workflow.ts";
import { type MediaProcessingWorkflowStep, makeMediaProcessingWorkflowRunner } from "./index.ts";
import { isMediaProcessingEnabled } from "./posture.ts";

describe("media processor Worker posture", () => {
  test("is disabled by default and requires an exact opt-in", () => {
    expect(isMediaProcessingEnabled(undefined)).toBe(false);
    expect(isMediaProcessingEnabled("false")).toBe(false);
    expect(isMediaProcessingEnabled("TRUE")).toBe(false);
    expect(isMediaProcessingEnabled("true")).toBe(true);
  });

  test("runs identifier-only work inside a durable step", async () => {
    const stepNames: string[] = [];
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
        workflowRevision: 1,
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
    const runner = makeMediaProcessingWorkflowRunner(() => ({
      queue: {} as MediaProcessingQueueDependencies,
      workflow,
    }));
    const step = {
      do: async <T>(_name: string, _options: unknown, callback: () => Promise<T>) => {
        stepNames.push(_name);
        return callback();
      },
      waitForEvent: async () => {
        throw new Error("terminal workflows do not wait");
      },
      sleep: async () => undefined,
    } as MediaProcessingWorkflowStep;

    expect(
      await runner(
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
    ).toEqual({ outcome: "blocked" });
    expect(stepNames).toEqual(["media-processing-0-launch"]);
  });

  test("terminates the publication Workflow and leaves alignment to its next revision", async () => {
    let waits = 0;
    const authority = {
      submissionId: "submission-1",
      operationId: "operation-1",
      workflowRevision: 1,
      status: "published",
      publishedLyricsRevision: 1,
    } as MediaProcessingAuthority;
    const store = {
      getOutbox: async () => ({
        outboxId: "outbox-1",
        eventType: "analysis_launch",
        submissionId: authority.submissionId,
        operationId: authority.operationId,
        workflowRevision: 1,
        workflowInstanceId: "media-operation-1-r1",
        deliveryAttempts: 1,
        state: "delivered",
        claimFence: 1,
        claimOwner: null,
      }),
      loadAuthority: async () => authority,
    } as unknown as MediaProcessingStore;
    const runner = makeMediaProcessingWorkflowRunner(() => ({
      queue: {} as MediaProcessingQueueDependencies,
      workflow: {
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
      },
    }));
    const step = {
      do: async <T>(_name: string, _options: unknown, callback: () => Promise<T>) => callback(),
      waitForEvent: async () => {
        waits += 1;
        throw new Error("published instance must not wait for alignment");
      },
      sleep: async () => undefined,
    } as MediaProcessingWorkflowStep;

    expect(
      await runner(
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
    ).toEqual({ outcome: "published" });
    expect(waits).toBe(0);
  });
});
