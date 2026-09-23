import { describe, expect, test } from "bun:test";
import type {
  SongVideoRenderer,
  SongVideoRenderStore,
} from "@pirate/application/video/song-render";
import {
  executeHostRenderAttempt,
  type HostRenderFacts,
  planHostRenderRequest,
  readHostMode,
} from "./song-video-render-host.ts";
import {
  type HostR2Transport,
  makeHostMasterOutputStore,
  makeHostMasterOutputWriter,
  makeHostMediaReader,
  makeHostR2Adapters,
  readHostR2Credentials,
  readHostR2ReadCredentials,
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

describe("host R2 credentials", () => {
  const output = {
    SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID: "output-key",
    SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY: "output-secret",
  };

  test("uses the output pair for everything when no input pair is set", () => {
    expect(
      readHostR2Credentials({ ...output, SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID: " " }),
    ).toEqual({
      output: { accessKeyId: "output-key", secretAccessKey: "output-secret" },
      input: null,
    });
  });

  test("reads a complete input pair separately from the output pair", () => {
    expect(
      readHostR2Credentials({
        ...output,
        SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID: " input-key ",
        SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY: "input-secret",
      }),
    ).toEqual({
      output: { accessKeyId: "output-key", secretAccessKey: "output-secret" },
      input: { accessKeyId: "input-key", secretAccessKey: "input-secret" },
    });
  });

  test("refuses half an input pair instead of falling back to the output pair", () => {
    expect(() =>
      readHostR2Credentials({ ...output, SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID: "input-key" }),
    ).toThrow("SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY is required");
    expect(() =>
      readHostR2Credentials({
        ...output,
        SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY: "input-secret",
      }),
    ).toThrow("SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID is required");
  });

  test("still requires the output pair", () => {
    expect(() =>
      readHostR2Credentials({
        SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID: "output-key",
        SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID: "input-key",
        SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY: "input-secret",
      }),
    ).toThrow("SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY is required");
  });

  test("signs input reads with the input key and master writes and reads with the output key", async () => {
    const { hex } = await digest(bytes);
    const signedWith: { method: string; path: string; key: string }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      const authorization = new Headers(init.headers).get("authorization") ?? "";
      signedWith.push({
        method: String(init.method),
        path: decodeURIComponent(new URL(url).pathname),
        key: /Credential=([^/]+)\//u.exec(authorization)?.[1] ?? "",
      });
      return init.method === "PUT"
        ? new Response(null, { status: 200, headers: { etag: '"etag-7"' } })
        : new Response(bytes, { status: 200, headers: { etag: '"etag-7"' } });
    };
    const adapters = makeHostR2Adapters({
      accountId: "account-1",
      bucket,
      credentials: {
        output: { accessKeyId: "output-key", secretAccessKey: "output-secret" },
        input: { accessKeyId: "input-key", secretAccessKey: "input-secret" },
      },
      fetch,
    });
    await adapters.mediaReader.read("media://immutable/operation-1/video/1");
    await adapters.writer.writeOnce(masterRef, bytes, hex);
    await adapters.output.read(masterRef);
    expect(signedWith).toEqual([
      { method: "GET", path: `/${bucket}/immutable/operation-1/video/1`, key: "input-key" },
      { method: "PUT", path: `/${bucket}/${physicalKey}`, key: "output-key" },
      { method: "GET", path: `/${bucket}/${physicalKey}`, key: "output-key" },
    ]);
  });

  test("signs every request with the output key when no input pair is configured", async () => {
    const keys: string[] = [];
    const adapters = makeHostR2Adapters({
      accountId: "account-1",
      bucket,
      credentials: {
        output: { accessKeyId: "output-key", secretAccessKey: "output-secret" },
        input: null,
      },
      fetch: async (_url, init) => {
        const authorization = new Headers(init.headers).get("authorization") ?? "";
        keys.push(/Credential=([^/]+)\//u.exec(authorization)?.[1] ?? "");
        return new Response(bytes, { status: 200, headers: { etag: '"etag-7"' } });
      },
    });
    await adapters.mediaReader.read("media://immutable/operation-1/video/1");
    await adapters.output.read(masterRef);
    expect(keys).toEqual(["output-key", "output-key"]);
  });
});

describe("host operation mode", () => {
  const measure = {
    SONG_VIDEO_RENDER_MEASURE_SONG_POST_ID: "song-post-1",
    SONG_VIDEO_RENDER_MEASURE_AUDIO_REVISION: "2",
  };

  test("keeps the existing loop and targeted render selections", () => {
    expect(readHostMode({})).toEqual({ kind: "loop" });
    expect(readHostMode({ SONG_VIDEO_RENDER_PLAN_ID: " plan-1 " })).toEqual({
      kind: "render",
      planId: "plan-1",
    });
    expect(
      readHostMode({
        SONG_VIDEO_RENDER_PLAN_ID: "plan-1",
        SONG_VIDEO_RENDER_ATTEMPT_ID: "attempt-1",
      }),
    ).toEqual({ kind: "render", planId: "plan-1", attemptId: "attempt-1" });
    expect(readHostMode({ SONG_VIDEO_RENDER_ATTEMPT_ID: "attempt-1" })).toEqual({
      kind: "loop",
      attemptId: "attempt-1",
    });
  });

  test("measures one completely named song revision", () => {
    expect(readHostMode(measure)).toEqual({
      kind: "measure",
      target: { songPostId: "song-post-1", audioRevision: 2 },
    });
  });

  test("refuses an incomplete or malformed measurement selector", () => {
    expect(() => readHostMode({ SONG_VIDEO_RENDER_MEASURE_SONG_POST_ID: "song-post-1" })).toThrow(
      "SONG_VIDEO_RENDER_MEASURE_AUDIO_REVISION is required",
    );
    expect(() => readHostMode({ SONG_VIDEO_RENDER_MEASURE_AUDIO_REVISION: "2" })).toThrow(
      "SONG_VIDEO_RENDER_MEASURE_SONG_POST_ID is required",
    );
    for (const revision of ["0", "-1", "1.5", "01", "2e3", "9007199254740993"]) {
      expect(() =>
        readHostMode({ ...measure, SONG_VIDEO_RENDER_MEASURE_AUDIO_REVISION: revision }),
      ).toThrow("SONG_VIDEO_RENDER_MEASURE_AUDIO_REVISION is invalid");
    }
  });

  test("refuses a measurement combined with a render selector", () => {
    expect(() => readHostMode({ ...measure, SONG_VIDEO_RENDER_PLAN_ID: "plan-1" })).toThrow(
      "SONG_VIDEO_RENDER_MEASURE_SONG_POST_ID conflicts with SONG_VIDEO_RENDER_PLAN_ID",
    );
    expect(() => readHostMode({ ...measure, SONG_VIDEO_RENDER_ATTEMPT_ID: "attempt-1" })).toThrow(
      "SONG_VIDEO_RENDER_MEASURE_SONG_POST_ID conflicts with SONG_VIDEO_RENDER_ATTEMPT_ID",
    );
    expect(() =>
      readHostMode({
        SONG_VIDEO_RENDER_MEASURE_AUDIO_REVISION: "2",
        SONG_VIDEO_RENDER_PLAN_ID: "p",
      }),
    ).toThrow("SONG_VIDEO_RENDER_MEASURE_SONG_POST_ID conflicts with SONG_VIDEO_RENDER_PLAN_ID");
  });

  test("a measurement reads with the input pair and needs no writing credential", () => {
    expect(
      readHostR2ReadCredentials({
        SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID: "input-key",
        SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY: "input-secret",
      }),
    ).toEqual({ accessKeyId: "input-key", secretAccessKey: "input-secret" });
    expect(
      readHostR2ReadCredentials({
        SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID: "output-key",
        SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY: "output-secret",
      }),
    ).toEqual({ accessKeyId: "output-key", secretAccessKey: "output-secret" });
    expect(() =>
      readHostR2ReadCredentials({
        SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID: "output-key",
        SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY: "output-secret",
        SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID: "input-key",
      }),
    ).toThrow("SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY is required");
  });
});

describe("host R2 temporary credentials", () => {
  const pairs = {
    SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID: "output-key",
    SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY: "output-secret",
    SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID: "input-key",
    SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY: "input-secret",
  };

  test("carries each session token with its own pair", () => {
    expect(
      readHostR2Credentials({
        ...pairs,
        SONG_VIDEO_RENDER_R2_SESSION_TOKEN: "output-session",
        SONG_VIDEO_RENDER_R2_INPUT_SESSION_TOKEN: "input-session",
      }),
    ).toEqual({
      output: {
        accessKeyId: "output-key",
        secretAccessKey: "output-secret",
        sessionToken: "output-session",
      },
      input: {
        accessKeyId: "input-key",
        secretAccessKey: "input-secret",
        sessionToken: "input-session",
      },
    });
    expect(readHostR2Credentials(pairs)).toEqual({
      output: { accessKeyId: "output-key", secretAccessKey: "output-secret" },
      input: { accessKeyId: "input-key", secretAccessKey: "input-secret" },
    });
  });

  test("a measurement reads with the input session token", () => {
    expect(
      readHostR2ReadCredentials({
        SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID: "input-key",
        SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY: "input-secret",
        SONG_VIDEO_RENDER_R2_INPUT_SESSION_TOKEN: "input-session",
      }),
    ).toEqual({
      accessKeyId: "input-key",
      secretAccessKey: "input-secret",
      sessionToken: "input-session",
    });
  });

  test("refuses an input session token without its pair", () => {
    expect(() =>
      readHostR2Credentials({
        SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID: "output-key",
        SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY: "output-secret",
        SONG_VIDEO_RENDER_R2_INPUT_SESSION_TOKEN: "input-session",
      }),
    ).toThrow("SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID is required");
  });

  test("signs input requests with the input session token and output requests with the output one", async () => {
    const seen: { key: string; token: string | null }[] = [];
    const adapters = makeHostR2Adapters({
      accountId: "account-1",
      bucket,
      credentials: {
        output: {
          accessKeyId: "output-key",
          secretAccessKey: "output-secret",
          sessionToken: "output-session",
        },
        input: {
          accessKeyId: "input-key",
          secretAccessKey: "input-secret",
          sessionToken: "input-session",
        },
      },
      fetch: async (_url, init) => {
        const headers = new Headers(init.headers);
        seen.push({
          key: /Credential=([^/]+)\//u.exec(headers.get("authorization") ?? "")?.[1] ?? "",
          token: headers.get("x-amz-security-token"),
        });
        return new Response(bytes, { status: 200, headers: { etag: '"etag-7"' } });
      },
    });
    await adapters.mediaReader.read("media://immutable/operation-1/video/1");
    await adapters.output.read(masterRef);
    expect(seen).toEqual([
      { key: "input-key", token: "input-session" },
      { key: "output-key", token: "output-session" },
    ]);
  });
});

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
