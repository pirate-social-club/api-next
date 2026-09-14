import { describe, expect, test } from "bun:test";
import type {
  SongVideoRenderer,
  SongVideoRenderStore,
} from "@pirate/application/video/song-render";
import {
  executeHostRenderAttempt,
  type HostRenderFacts,
  planHostRenderRequest,
} from "./song-video-render-host.ts";
import {
  type HostR2Transport,
  makeHostMasterOutputStore,
  makeHostMasterOutputWriter,
  makeHostMediaReader,
} from "./song-video-render-host-r2.ts";

const bucket = "media-immutable-originals";
const masterRef = "media://immutable/song-video-masters/plan:submission-1/g1";
const physicalKey = "immutable/song-video-masters/plan:submission-1/g1";
const bytes = new TextEncoder().encode("sealed-master-bytes");

async function digest(bytes: Uint8Array): Promise<{ hex: string; base64: string }> {
  const raw = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer),
  );
  return {
    hex: [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    base64: btoa(String.fromCharCode(...raw)),
  };
}

type SentRequest = Parameters<HostR2Transport["send"]>[0];

function makeTransport(respond: (request: SentRequest) => Response) {
  const sent: SentRequest[] = [];
  const transport: HostR2Transport = {
    send: async (request) => {
      sent.push(request);
      return respond(request);
    },
  };
  return { sent, transport };
}

describe("host R2 adapters", () => {
  test("writes once under a conditional put with the measured checksum", async () => {
    const { hex, base64 } = await digest(bytes);
    const fake = makeTransport(
      () =>
        new Response(null, {
          status: 200,
          headers: { etag: "etag-7", "x-amz-version-id": "version-7" },
        }),
    );
    const writer = makeHostMasterOutputWriter({ transport: fake.transport, bucket });
    expect(await writer.writeOnce(masterRef, bytes, hex)).toEqual({ status: "written" });
    expect(fake.sent).toEqual([
      {
        bucket,
        key: physicalKey,
        method: "PUT",
        headers: {
          "content-type": "video/mp4",
          "content-length": String(bytes.byteLength),
          "if-none-match": "*",
          "x-amz-checksum-sha256": base64,
        },
        body: bytes,
      },
    ]);
  });

  test("reports an occupied address and refuses an unaddressable write", async () => {
    const { hex } = await digest(bytes);
    const occupied = makeTransport(() => new Response(null, { status: 412 }));
    expect(
      await makeHostMasterOutputWriter({ transport: occupied.transport, bucket }).writeOnce(
        masterRef,
        bytes,
        hex,
      ),
    ).toEqual({ status: "occupied" });

    const unaddressable = makeTransport(() => new Response(null, { status: 200 }));
    expect(
      makeHostMasterOutputWriter({ transport: unaddressable.transport, bucket }).writeOnce(
        masterRef,
        bytes,
        hex,
      ),
    ).rejects.toThrow("song video output is not addressable");
  });

  test("records the normalized ETag as the object identity", async () => {
    const fake = makeTransport(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { etag: '"etag-7"' },
        }),
    );
    const store = makeHostMasterOutputStore({ transport: fake.transport, bucket });
    // The S3 header quotes the tag; the recorded identity is unquoted, the
    // form the Workers binding reports.
    expect(await store.read(masterRef)).toEqual({
      bytes,
      objectVersion: "etag-7",
      etag: "etag-7",
    });
    expect(await store.readVersion(masterRef, "etag-7")).toEqual(bytes);
    expect(await store.readVersion(masterRef, "etag-6")).toBeNull();
  });

  test("cancels a response it cannot read within the bound", async () => {
    let cancelled = false;
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { "content-length": "999999999999" } },
    );
    const fake = makeTransport(() => oversized);
    const store = makeHostMasterOutputStore({ transport: fake.transport, bucket });
    await expect(store.read(masterRef)).rejects.toThrow("exceeds the read bound");
    expect(cancelled).toBe(true);
  });

  test("reads media by immutable reference", async () => {
    const fake = makeTransport(() => new Response(bytes, { status: 200 }));
    const reader = makeHostMediaReader({ transport: fake.transport, bucket });
    expect(await reader.read("media://immutable/capture/video/1")).toEqual(bytes);
    expect(fake.sent[0]).toMatchObject({ key: "immutable/capture/video/1", method: "GET" });
  });
});

const facts: HostRenderFacts = {
  planId: "plan-1",
  attemptId: "attempt-1",
  generation: 1,
  outputObjectKey: masterRef,
  source: {
    immutableRef: "media://immutable/capture/video/1",
    sha256: "a".repeat(64),
    byteLength: 123,
  },
  song: { assetRef: "asset-song-1", sha256: "b".repeat(64), durationSamples: 480_000 },
  clipStartSamples: 0,
  clipDurationSamples: 240_000,
};

function fakeRenderer(overrides: Partial<SongVideoRenderer> = {}) {
  const calls = { submit: 0, observe: 0 };
  const renderer: SongVideoRenderer = {
    identity: "host-test",
    policyRevision: 1,
    submit: async (request) => {
      calls.submit += 1;
      return overrides.submit === undefined
        ? { status: "submitted" }
        : await overrides.submit(request);
    },
    observe: async (input) => {
      calls.observe += 1;
      return overrides.observe === undefined
        ? { status: "completed" }
        : await overrides.observe(input);
    },
  };
  return { renderer, calls };
}

function fakeStore(outcome: Awaited<ReturnType<SongVideoRenderStore["sealAndAccept"]>>) {
  const calls = { seal: 0 };
  const store = {
    sealAndAccept: async () => {
      calls.seal += 1;
      return outcome;
    },
  } as unknown as SongVideoRenderStore;
  return { store, calls };
}

const accepted = {
  status: "accepted" as const,
  master: {
    masterRevisionId: "master-1",
    attemptId: "attempt-1",
    masterRef,
    masterSha256: "c".repeat(64),
    masterByteLength: 10,
    soundtrackSha256: "d".repeat(64),
  },
};

describe("host render attempt", () => {
  test("plans the render request from the frozen attempt facts", () => {
    expect(planHostRenderRequest(facts)).toEqual({
      outputObjectKey: masterRef,
      source: facts.source,
      song: facts.song,
      clipStartSamples: 0,
      clipDurationSamples: 240_000,
    });
  });

  test("executes one attempt, observes the stored output and seals it", async () => {
    const { renderer, calls } = fakeRenderer();
    const { store, calls: sealCalls } = fakeStore(accepted);
    expect(await executeHostRenderAttempt({ facts, renderer, store })).toEqual({
      status: "accepted",
      masterRevisionId: "master-1",
    });
    expect(calls).toEqual({ submit: 1, observe: 1 });
    expect(sealCalls.seal).toBe(1);
  });

  test("a refused execution does not seal or observe", async () => {
    const { renderer, calls } = fakeRenderer({
      submit: async () => ({ status: "refused", reason: "master_not_exact" }),
    });
    const { store, calls: sealCalls } = fakeStore(accepted);
    expect(await executeHostRenderAttempt({ facts, renderer, store })).toEqual({
      status: "refused",
      reason: "master_not_exact",
    });
    expect(calls).toEqual({ submit: 1, observe: 0 });
    expect(sealCalls.seal).toBe(0);
  });

  test("an uncertain execution stays pending and is never retried or sealed", async () => {
    const { renderer, calls } = fakeRenderer({
      submit: async () => {
        throw new Error("render response lost");
      },
    });
    const { store, calls: sealCalls } = fakeStore(accepted);
    expect(await executeHostRenderAttempt({ facts, renderer, store })).toEqual({
      status: "pending",
    });
    expect(calls).toEqual({ submit: 1, observe: 0 });
    expect(sealCalls.seal).toBe(0);
  });

  test("a submitted execution with no observable output stays pending", async () => {
    const { renderer, calls } = fakeRenderer({
      observe: async () => ({ status: "pending" }),
    });
    const { store, calls: sealCalls } = fakeStore(accepted);
    expect(await executeHostRenderAttempt({ facts, renderer, store })).toEqual({
      status: "pending",
    });
    expect(calls).toEqual({ submit: 1, observe: 1 });
    expect(sealCalls.seal).toBe(0);
  });

  test("a seal refusal is reported and leaves no master", async () => {
    const { renderer } = fakeRenderer();
    const { store, calls } = fakeStore({ status: "refused", reason: "output_not_verified" });
    expect(await executeHostRenderAttempt({ facts, renderer, store })).toEqual({
      status: "refused",
      reason: "output_not_verified",
    });
    expect(calls.seal).toBe(1);
  });
});
