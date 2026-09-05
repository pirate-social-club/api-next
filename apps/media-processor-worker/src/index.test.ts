import { describe, expect, test } from "bun:test";
import type {
  VideoAnalysisOutboxRecord,
  VideoAnalysisQueueDependencies,
} from "@pirate/application/video/analysis-queue";
import { makeCloudflareVideoAnalysisWorkflowLauncher } from "@pirate/platform-cf/video-analysis-workflow-cloudflare";
import type {
  MediaProcessingAuthority,
  MediaProcessingStore,
} from "../../../packages/application/src/media/processing-contracts.ts";
import type { MediaProcessingQueueDependencies } from "../../../packages/application/src/media/processing-queue.ts";
import type { MediaProcessingWorkflowDependencies } from "../../../packages/application/src/media/processing-workflow.ts";
import {
  type MediaProcessingWorkflowStep,
  makeMediaProcessingWorkflowRunner,
  makeMediaProcessorQueueWorker,
} from "./index.ts";
import { isMediaProcessingEnabled } from "./posture.ts";

describe("media processor Worker posture", () => {
  test("drill 3 launch boundary: accepted create with lost response converges through the queue Worker", async () => {
    let row: VideoAnalysisOutboxRecord = {
      effectIdentity: "video-analysis:operation:v1:c1",
      submissionId: "submission",
      operationId: "operation",
      videoRevision: 1,
      creationRevision: 1,
      canonicalVideoSha256: "a".repeat(64),
      state: "pending",
      launchAttempts: 0,
      continuation: 0,
      claimOwner: null,
      claimFence: 0,
      workflowInstanceId: null,
      instanceMissing: false,
    };
    const instances = new Set<string>();
    let launches = 0;
    const launcher = makeCloudflareVideoAnalysisWorkflowLauncher(
      {
        get: async () => ({ status: async () => ({ status: "running" }) }),
        createBatch: async ([input]) => {
          if (!input) throw new Error("missing launch");
          expect(input.params).toEqual({ effectIdentity: row.effectIdentity });
          if (instances.has(input.id)) return [];
          instances.add(input.id);
          launches += 1;
          throw new Error("accepted response lost");
        },
      },
      () => false,
    );
    const videoAnalysis: VideoAnalysisQueueDependencies = {
      launcher,
      workerId: "worker",
      runtime: {
        store: {
          getSubmissionByOperation: async () => ({
            state: {
              videoRevision: 1,
              creationRevision: 1,
              video: { canonicalSha256: "a".repeat(64) },
              status: "processing",
              decision: null,
            },
          }),
        },
      } as unknown as VideoAnalysisQueueDependencies["runtime"],
      outbox: {
        get: async () => row,
        claim: async () => {
          row = {
            ...row,
            state: "launching",
            launchAttempts: row.launchAttempts + 1,
            claimOwner: "worker",
            claimFence: row.claimFence + 1,
          };
          return row;
        },
        markRetryWait: async () => {
          row = { ...row, state: "retry_wait", claimOwner: null };
          return true;
        },
        markLaunched: async (_claim, id) => {
          row = { ...row, state: "launched", workflowInstanceId: id, claimOwner: null };
          return true;
        },
        markExhausted: async () => {
          throw new Error("must not exhaust");
        },
        markInstanceMissing: async () => {
          throw new Error("not a sweep");
        },
      },
    };
    const worker = makeMediaProcessorQueueWorker(() => ({
      queue: {} as MediaProcessingQueueDependencies,
      workflow: {} as MediaProcessingWorkflowDependencies,
      videoAnalysis,
    }));
    const actions: string[] = [];
    const batch = {
      messages: [
        {
          body: { kind: "video_analysis", outbox_id: row.effectIdentity },
          ack: () => actions.push("ack"),
          retry: () => actions.push("retry"),
        },
      ],
    };
    await worker.queue(batch, {});
    await worker.queue(batch, {});
    await worker.queue(batch, {});
    expect(actions).toEqual(["retry", "ack", "ack"]);
    expect(launches).toBe(1);
    expect(row.launchAttempts).toBe(2);
    expect(row.workflowInstanceId).toMatch(/^vaw-[0-9a-f]{64}$/u);
  });

  test("is disabled by default and requires an exact opt-in", () => {
    expect(isMediaProcessingEnabled(undefined)).toBe(false);
    expect(isMediaProcessingEnabled("false")).toBe(false);
    expect(isMediaProcessingEnabled("TRUE")).toBe(false);
    expect(isMediaProcessingEnabled("true")).toBe(true);
  });

  test("routes video identities away from the song workflow and retries until composed", async () => {
    const actions: string[] = [];
    const worker = makeMediaProcessorQueueWorker(() => ({
      queue: {} as MediaProcessingQueueDependencies,
      workflow: {} as MediaProcessingWorkflowDependencies,
    }));
    await worker.queue(
      {
        messages: [
          {
            body: { kind: "video_analysis", outbox_id: "video-analysis-1" },
            ack: () => actions.push("ack"),
            retry: (options) => actions.push(`retry:${options?.delaySeconds ?? 0}`),
          },
        ],
      },
      {},
    );
    expect(actions).toEqual(["retry:30"]);
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
