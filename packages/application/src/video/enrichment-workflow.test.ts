import { expect, test } from "bun:test";
import {
  launchVideoEnrichment,
  runVideoEnrichmentWorkflow,
  VIDEO_ENRICHMENT_POLICY,
  type VideoEnrichmentExecution,
  type VideoEnrichmentExecutionStore,
  type VideoEnrichmentServices,
  videoEnrichmentWorkflowIdentity,
} from "./enrichment-workflow.ts";
import type { VideoStreamClaim } from "./stream-ingest.ts";

function executionFixture(kind: "stream" | "thumbnail" = "stream") {
  let execution: VideoEnrichmentExecution = {
    effectIdentity: "effect-1",
    generation: 0,
    kind,
    startedAtMs: 1,
  };
  let active = true;
  const store: VideoEnrichmentExecutionStore = {
    prepare: async () => (active ? { ...execution } : null),
    active: async (input) => active && input.generation === execution.generation,
    replace: async (input) => {
      if (!active || input.generation !== execution.generation) return null;
      execution = { ...execution, generation: execution.generation + 1 };
      return execution;
    },
  };
  return {
    store,
    get: () => execution,
    finish: () => {
      active = false;
    },
  };
}

test("launch retries lost responses under the same ID, terminal recovery preserves start time", async () => {
  const f = executionFixture();
  const ids: string[] = [];
  let lost = true;
  let state: "present" | "terminal" = "present";
  const services = {
    executions: f.store,
    launcher: {
      create: async (id: string) => {
        ids.push(id);
        if (lost) {
          lost = false;
          throw new Error("lost");
        }
      },
      get: async () => state,
    },
  };
  const message = { kind: "video_enrichment", outbox_id: "effect-1" };
  expect(await launchVideoEnrichment(message, services)).toBe("retry");
  expect(await launchVideoEnrichment(message, services)).toBe("ack");
  expect(ids[0]).toBe(ids[1]);
  state = "terminal";
  expect(await launchVideoEnrichment(message, services)).toBe("ack");
  expect(f.get()).toMatchObject({ generation: 1, startedAtMs: 1 });
  expect(ids.at(-1)).toBe("video-enrichment:effect-1:g1");
  f.finish();
  const count = ids.length;
  expect(await launchVideoEnrichment(message, services)).toBe("ack");
  expect(ids).toHaveLength(count);
});

test("malformed queue messages never reach durable authority or provider launch", async () => {
  const fail = async (): Promise<never> => {
    throw new Error("must not call");
  };
  for (const body of [null, {}, { kind: "video_enrichment", outbox_id: "id", url: "injected" }])
    expect(
      await launchVideoEnrichment(body, {
        executions: { prepare: fail, active: fail, replace: fail },
        launcher: { create: fail, get: fail },
      }),
    ).toBe("ack");
});

test("durable waits recover a lost copy and completion without another encode", async () => {
  const f = executionFixture();
  let now = 1;
  let copies = 0;
  let observations = 0;
  let row: VideoStreamClaim = {
    effectIdentity: "effect-1",
    leaseOwner: "fixture",
    fence: 0,
    revision: 0,
    identity: { operationId: "op", creator: "marker", sourceSha256: "a".repeat(64) },
    sealedSourceRef: "media://immutable/source",
    sourceByteLength: 1234,
    sourceMediaType: "video/mp4",
    authority: {
      submissionId: "s",
      postId: "p",
      creationRevision: 1,
      videoRevision: 1,
      analysisRevision: 1,
    },
    state: { state: "not_started" },
  };
  const services: VideoEnrichmentServices = {
    executions: f.store,
    nowMs: () => now,
    thumbnail: {
      store: { claim: async () => null, complete: async () => false },
      verify: async () => "missing",
    },
    stream: {
      nowMs: () => now,
      deadlines: (at) => ({
        acceptanceDeadlineMs: at + 300_000,
        encodingDeadlineMs: at + 1_800_000,
      }),
      store: {
        claim: async () => ({ ...row }),
        transition: async (_claim, next) => {
          row = { ...row, state: next, revision: row.revision + 1 };
          if (next.state === "ready") {
            f.finish();
            throw new Error("lost completion");
          }
          return { ...row };
        },
      },
      transport: {
        copy: async () => {
          copies++;
          throw new Error("lost copy");
        },
        observe: async () => [
          {
            providerVideoId: "provider",
            creator: "marker",
            sourceSha256: "a".repeat(64),
            encoding: ++observations === 1 ? "pending" : "ready",
            requireSignedURLs: true,
            downloadsEnabled: false,
          },
        ],
      },
    },
  };
  const waits: number[] = [];
  const step = {
    do: async <T>(_name: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch {
        return run();
      }
    },
    sleep: async (_name: string, ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
  expect(
    await runVideoEnrichmentWorkflow(videoEnrichmentWorkflowIdentity(f.get()), step, services),
  ).toEqual({ outcome: "enrichment_complete" });
  expect(copies).toBe(1);
  expect(waits).toEqual([VIDEO_ENRICHMENT_POLICY.pollMs, VIDEO_ENRICHMENT_POLICY.pollMs]);
  expect(row.state.state).toBe("ready");
  if (row.state.state === "ready") expect(row.state.acceptanceDeadlineMs).toBe(300_001);
});

test("an obsolete Workflow generation exits without consuming another effect", async () => {
  const f = executionFixture();
  await f.store.replace(f.get());
  const fail = async (): Promise<never> => {
    throw new Error("must not consume");
  };
  const result = await runVideoEnrichmentWorkflow(
    "video-enrichment:effect-1:g0",
    {
      do: (_name, run) => run(),
      sleep: fail,
    },
    {
      executions: f.store,
      nowMs: () => 1,
      stream: {
        store: { claim: fail, transition: fail },
        transport: { copy: fail, observe: fail },
        nowMs: () => 1,
        deadlines: () => {
          throw new Error("must not consume");
        },
      },
      thumbnail: { store: { claim: fail, complete: fail }, verify: fail },
    },
  );
  expect(result).toEqual({ outcome: "enrichment_complete" });
});
