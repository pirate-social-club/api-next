import { describe, expect, test } from "bun:test";
import {
  MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
  type MediaTransformAttempt,
  MediaTransformRequestInvalid,
  type MediaTransformVideoBinding,
  type MediaTransformVideoSource,
} from "@pirate/application/media/transform";
import { VIDEO_POSTER_POLICY_V1 } from "@pirate/domain";
import { Effect } from "effect";
import {
  makeQencodeMediaTransform,
  makeQencodeTaskTransport,
  makeR2QencodeArtifactStore,
  type QencodeArtifactStore,
  type QencodeOutput,
  type QencodeSourceGrantIssuer,
  type QencodeTaskStatus,
  type QencodeTaskTransport,
} from "./qencode-media-transform.ts";

const JOB_ID = "b".repeat(32);
const SOURCE_SHA256 = "a".repeat(64);

const binding: MediaTransformVideoBinding = {
  operationId: "operation-1",
  videoRevision: 1,
  analysisRevision: 1,
  canonicalVideoSha256: SOURCE_SHA256,
  requestId: "request-1",
};

const source: MediaTransformVideoSource = {
  objectKey: "sealed/video/source.mp4",
  sha256: SOURCE_SHA256,
  byteLength: 32_000_000,
  mediaType: "video/mp4",
};

const freshAttempt: MediaTransformAttempt = {
  version: "media-transform-attempt-v1",
  runtimeFence: { submittedAtMs: 1_000, runtimeDeadlineMs: 60_000 },
};

function acceptedAttempt(phase: "allocated" | "started"): MediaTransformAttempt {
  return { ...freshAttempt, providerJobId: JOB_ID, providerJobPhase: phase };
}

function fakeArtifacts(overrides: Partial<QencodeArtifactStore> = {}): QencodeArtifactStore {
  return {
    readJson: async () => ({}),
    seal: async (input) => ({
      artifactRef: input.artifactRef,
      canonicalSha256: "c".repeat(64),
      byteLength: 1024,
    }),
    ...overrides,
  };
}

function fakeGateway(onIssue?: (input: Parameters<QencodeSourceGrantIssuer["issue"]>[0]) => void) {
  return {
    issue: async (input: Parameters<QencodeSourceGrantIssuer["issue"]>[0]) => {
      onIssue?.(input);
      return {
        url: "https://video-source.example.invalid/.well-known/pirate/video-source/v1/grant",
        expiresAtMs: input.expiresAtMs,
      };
    },
  } satisfies QencodeSourceGrantIssuer;
}

function fakeTransport(input: {
  status: QencodeTaskStatus;
  onCreate?: () => void;
  onStart?: (value: Parameters<QencodeTaskTransport["startTask"]>[0]) => void;
  onStatus?: () => void;
}): QencodeTaskTransport {
  return {
    createTask: async () => {
      input.onCreate?.();
      return JOB_ID;
    },
    startTask: async (value) => {
      input.onStart?.(value);
      return "accepted";
    },
    getStatus: async () => {
      input.onStatus?.();
      return input.status;
    },
  };
}

function options(
  transport: QencodeTaskTransport,
  overrides: {
    artifacts?: QencodeArtifactStore;
    sourceGateway?: QencodeSourceGrantIssuer;
  } = {},
) {
  return {
    enabled: true as const,
    apiKey: "test-api-key",
    transport,
    sourceGateway: overrides.sourceGateway ?? fakeGateway(),
    artifacts: overrides.artifacts ?? fakeArtifacts(),
    clock: () => 2_000,
  };
}

describe("Qencode media transform", () => {
  test("uses only the fixed form endpoints and the documented query envelope", async () => {
    const requests: Array<Readonly<{ url: string; body: URLSearchParams }>> = [];
    const responses = [
      { error: 0, token: "access-token" },
      { error: 0, task_token: JOB_ID },
      { error: 0 },
      { error: 0, statuses: { [JOB_ID]: { status: "encoding" } } },
    ];
    const fetcher = async (request: string | URL | Request, init?: RequestInit) => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      requests.push({
        url: String(request),
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      return Response.json(response);
    };
    const transport = makeQencodeTaskTransport(fetcher);
    expect(await transport.createTask("provider-secret")).toBe(JOB_ID);
    expect(
      await transport.startTask({
        taskToken: JOB_ID,
        query: { source: "https://source.example/video", format: [{ output: "metadata" }] },
        payload: "opaque-payload",
      }),
    ).toBe("accepted");
    expect(await transport.getStatus(JOB_ID)).toEqual({ state: "processing" });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.qencode.com/v1/access_token",
      "https://api.qencode.com/v1/create_task",
      "https://api.qencode.com/v1/start_encode2",
      "https://api.qencode.com/v1/status",
    ]);
    expect(requests[0]?.body.get("api_key")).toBe("provider-secret");
    expect(requests[1]?.body.get("token")).toBe("access-token");
    expect(JSON.parse(requests[2]?.body.get("query") ?? "null")).toEqual({
      query: {
        source: "https://source.example/video",
        format: [{ output: "metadata" }],
      },
    });
    expect(requests[3]?.body.get("task_tokens")).toBe(JOB_ID);
  });

  test("rejects a staging placeholder instead of attempting provider work", () => {
    expect(() =>
      makeQencodeMediaTransform({
        ...options(fakeTransport({ status: { state: "not_started" } })),
        apiKey: "PENDING",
      }),
    ).toThrow(MediaTransformRequestInvalid);
  });

  test("allocates and durably returns a task before issuing a source grant", async () => {
    let creates = 0;
    let grants = 0;
    let starts = 0;
    const service = makeQencodeMediaTransform(
      options(
        fakeTransport({
          status: { state: "not_started" },
          onCreate: () => creates++,
          onStart: () => starts++,
        }),
        { sourceGateway: fakeGateway(() => grants++) },
      ),
    );

    const result = await Effect.runPromise(
      service.probe({
        version: "media-transform-video-probe-input-v1",
        binding,
        source,
        attempt: freshAttempt,
      }),
    );

    expect(result).toEqual({
      status: "submitted",
      attempt: { ...freshAttempt, providerJobId: JOB_ID, providerJobPhase: "allocated" },
    });
    expect({ creates, grants, starts }).toEqual({ creates: 1, grants: 0, starts: 0 });
  });

  test("bounds a provider request by the durable runtime deadline", async () => {
    const transport: QencodeTaskTransport = {
      createTask: async (_apiKey, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      startTask: async () => "accepted",
      getStatus: async () => ({ state: "not_started" }),
    };
    const service = makeQencodeMediaTransform(options(transport));
    const result = await Effect.runPromise(
      service.probe({
        version: "media-transform-video-probe-input-v1",
        binding,
        source,
        attempt: {
          version: "media-transform-attempt-v1",
          runtimeFence: { submittedAtMs: 1_000, runtimeDeadlineMs: 2_001 },
        },
      }),
    );

    expect(result).toEqual({
      status: "retryable_failure",
      reason: "timeout",
      attempt: {
        version: "media-transform-attempt-v1",
        runtimeFence: { submittedAtMs: 1_000, runtimeDeadlineMs: 2_001 },
      },
    });
  });

  test("starts an allocated task through the exact-object grant and freezes the query", async () => {
    let issued: Parameters<QencodeSourceGrantIssuer["issue"]>[0] | undefined;
    let started: Parameters<QencodeTaskTransport["startTask"]>[0] | undefined;
    const service = makeQencodeMediaTransform(
      options(
        fakeTransport({
          status: { state: "not_started" },
          onStart: (value) => {
            started = value;
          },
        }),
        {
          sourceGateway: fakeGateway((value) => {
            issued = value;
          }),
        },
      ),
    );

    const result = await Effect.runPromise(
      service.extractVideoAudio({
        version: "media-transform-video-audio-input-v1",
        binding,
        source,
        extractionPolicyVersion: MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
        attempt: acceptedAttempt("allocated"),
      }),
    );

    expect(result.status).toBe("processing");
    expect(result.attempt.providerJobPhase).toBe("started");
    expect(issued).toEqual({
      ...source,
      expiresAtMs: 60_000,
      requestId: binding.requestId,
    });
    expect(started?.taskToken).toBe(JOB_ID);
    expect(started?.query.format).toEqual([
      {
        output: "m4a",
        audio_codec: "aac",
        audio_bitrate: 192,
        audio_sample_rate: 44_100,
        audio_channels_number: 2,
        user_tag: "pirate-audio-v1",
      },
    ]);
    expect(started?.query.source).toStartWith("https://video-source.example.invalid/");
  });

  test("never starts a second job after the persisted started phase", async () => {
    let grants = 0;
    let starts = 0;
    const service = makeQencodeMediaTransform(
      options(
        fakeTransport({
          status: { state: "not_found" },
          onStart: () => starts++,
        }),
        { sourceGateway: fakeGateway(() => grants++) },
      ),
    );

    const result = await Effect.runPromise(
      service.probe({
        version: "media-transform-video-probe-input-v1",
        binding,
        source,
        attempt: acceptedAttempt("started"),
      }),
    );

    expect(result).toEqual({
      status: "retryable_failure",
      reason: "provider",
      attempt: acceptedAttempt("started"),
    });
    expect({ grants, starts }).toEqual({ grants: 0, starts: 0 });
  });

  test("authenticates completion by status and parses the trusted metadata output", async () => {
    const metadataOutput: QencodeOutput = {
      kind: "metadata",
      userTag: "pirate-probe-v1",
      url: "https://storage.qencode.com/job/metadata.json",
      outputFormat: "metadata",
      mediaFacts: {
        codec: null,
        sampleRateHz: null,
        channels: null,
        width: null,
        height: null,
      },
    };
    const service = makeQencodeMediaTransform(
      options(fakeTransport({ status: { state: "completed", outputs: [metadataOutput] } }), {
        artifacts: fakeArtifacts({
          readJson: async () => ({
            format: { duration: "12.8" },
            streams: [
              {
                codec_type: "video",
                codec_name: "h264",
                width: 720,
                height: 1280,
                avg_frame_rate: "30/1",
                has_b_frames: 0,
              },
              { codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2 },
            ],
          }),
        }),
      }),
    );

    const result = await Effect.runPromise(
      service.probe({
        version: "media-transform-video-probe-input-v1",
        binding,
        source,
        attempt: acceptedAttempt("started"),
      }),
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completion");
    expect(result.probe).toEqual({
      evidenceRef: `qencode:metadata:${JOB_ID}`,
      durationMs: 12_800,
      width: 720,
      height: 1280,
      frameRateMillihertz: 30_000,
      videoCodec: "h264",
      audioCodec: "aac",
      hasAudio: true,
    });
    expect(result.attempt.providerJobPhase).toBe("started");
  });

  test("does not mistake source-stream status metadata for the frozen M4A output policy", async () => {
    const service = makeQencodeMediaTransform(
      options(
        fakeTransport({
          status: {
            state: "completed",
            outputs: [
              {
                kind: "audio",
                userTag: "pirate-audio-v1",
                url: "https://storage.qencode.com/job/audio.m4a",
                outputFormat: "m4a",
                mediaFacts: {
                  codec: "aac",
                  sampleRateHz: 48_000,
                  channels: 1,
                  width: null,
                  height: null,
                },
              },
            ],
          },
        }),
      ),
    );

    const result = await Effect.runPromise(
      service.extractVideoAudio({
        version: "media-transform-video-audio-input-v1",
        binding,
        source,
        extractionPolicyVersion: MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
        attempt: acceptedAttempt("started"),
      }),
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completion");
    expect(result.artifact.mediaType).toBe("audio/mp4");
    expect(result.artifact.policyRevision).toBe(MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1);
  });

  test("requests three bounded frame outputs without upscaling the source", async () => {
    let started: Parameters<QencodeTaskTransport["startTask"]>[0] | undefined;
    const service = makeQencodeMediaTransform(
      options(
        fakeTransport({
          status: { state: "not_started" },
          onStart: (value) => {
            started = value;
          },
        }),
      ),
    );

    await Effect.runPromise(
      service.extractVideoFrames({
        version: "media-transform-video-frames-input-v1",
        binding,
        source,
        sourceDurationMs: 10_000,
        sourceDimensions: { width: 320, height: 240 },
        posterTimestampMs: 1_250,
        posterPolicy: VIDEO_POSTER_POLICY_V1,
        attempt: acceptedAttempt("allocated"),
      }),
    );

    expect(started?.query.format).toEqual([
      {
        output: "thumbnail",
        time: 0.125,
        width: 320,
        height: 240,
        image_format: "jpg",
        quality: 82,
        user_tag: "pirate-frame-poster-v1",
      },
      {
        output: "thumbnail",
        time: 0,
        width: 320,
        height: 240,
        image_format: "jpg",
        quality: 82,
        user_tag: "pirate-frame-first-v1",
      },
      {
        output: "thumbnail",
        time: 0.5,
        width: 320,
        height: 240,
        image_format: "jpg",
        quality: 82,
        user_tag: "pirate-frame-midpoint-v1",
      },
    ]);
  });

  test("bounds fixed-endpoint form responses and parses frozen output facts", async () => {
    const requests: Array<Readonly<{ url: string; method: string }>> = [];
    const responses = [
      Response.json({ token: "session-token" }),
      Response.json({ error: 0, task_token: JOB_ID }),
      Response.json({
        error: 0,
        statuses: {
          [JOB_ID]: {
            status: "encoding",
            error: 0,
            status_url: "https://master.qencode.com/v1/status",
          },
        },
      }),
      Response.json({
        error: 0,
        statuses: {
          [JOB_ID]: {
            status: "completed",
            error: 0,
            audios: [
              {
                user_tag: "pirate-audio-v1",
                url: "https://storage.qencode.com/result.m4a",
                output_format: "m4a",
                meta: { codec: "aac", sample_rate: 44_100, channels: 2 },
              },
            ],
          },
        },
      }),
    ];
    const transport = makeQencodeTaskTransport(async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        method: input instanceof Request ? input.method : (init?.method ?? "GET"),
      });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected Qencode request");
      return response;
    });

    await expect(transport.createTask("test-api-key")).resolves.toBe(JOB_ID);
    await expect(transport.getStatus(JOB_ID)).resolves.toMatchObject({
      state: "completed",
      outputs: [
        {
          outputFormat: "m4a",
          mediaFacts: { codec: "aac", sampleRateHz: 44_100, channels: 2 },
        },
      ],
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/access_token",
      "/v1/create_task",
      "/v1/status",
      "/v1/status",
    ]);
    expect(new URL(requests[3]?.url ?? "https://invalid.example").hostname).toBe(
      "master.qencode.com",
    );
    expect(requests.every((request) => request.method === "POST")).toBe(true);

    const oversized = makeQencodeTaskTransport(
      async () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": "3000000" },
        }),
    );
    await expect(oversized.createTask("test-api-key")).rejects.toThrow();
  });

  test("seals one bounded temporary artifact and reuses the first immutable winner", async () => {
    const bytes = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0]);
    let stored: Readonly<{
      key: string;
      size: number;
      httpMetadata: Readonly<{ contentType: string }>;
      customMetadata: Readonly<Record<string, string>>;
    }> | null = null;
    let writes = 0;
    const artifacts = makeR2QencodeArtifactStore(
      {
        head: async () => stored,
        put: async (key, value, putOptions) => {
          writes += 1;
          stored = {
            key,
            size: value.byteLength,
            httpMetadata: putOptions.httpMetadata,
            customMetadata: putOptions.customMetadata,
          };
          return stored;
        },
      },
      async () => new Response(bytes, { headers: { "content-type": "audio/mp4" } }),
    );
    const sealInput = {
      sourceUrl: "https://storage.qencode.com/result.m4a",
      artifactKey: "video-analysis/operation-1/soundtrack.m4a",
      artifactRef: "media://derived/video-analysis/operation-1/soundtrack.m4a",
      mediaType: "audio/mp4" as const,
      maximumBytes: 1_024,
      sourceSha256: SOURCE_SHA256,
      policyRevision: MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
    };

    const first = await artifacts.seal(sealInput);
    expect(await artifacts.seal(sealInput)).toEqual(first);
    expect(first.canonicalSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(writes).toBe(1);
  });

  test("seals the first bounded provider artifact and replays the application-owned object", async () => {
    let stored:
      | Readonly<{
          key: string;
          size: number;
          httpMetadata: Readonly<{ contentType: string }>;
          customMetadata: Readonly<Record<string, string>>;
        }>
      | undefined;
    let downloads = 0;
    const bytes = Uint8Array.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    const store = makeR2QencodeArtifactStore(
      {
        head: async () => stored ?? null,
        put: async (key, value, putOptions) => {
          stored = {
            key,
            size: value.byteLength,
            httpMetadata: putOptions.httpMetadata,
            customMetadata: putOptions.customMetadata,
          };
          return stored;
        },
      },
      async () => {
        downloads += 1;
        return new Response(bytes, {
          headers: { "content-length": String(bytes.byteLength), "content-type": "audio/mp4" },
        });
      },
    );
    const input = {
      sourceUrl: "https://storage.qencode.com/job/audio.m4a",
      artifactKey: "video-analysis/operation/audio.m4a",
      artifactRef: "media://derived/video-analysis/operation/audio.m4a",
      mediaType: "audio/mp4" as const,
      maximumBytes: 1_024,
      sourceSha256: SOURCE_SHA256,
      policyRevision: MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
    };

    const first = await store.seal(input);
    const replay = await store.seal(input);
    expect(replay).toEqual(first);
    expect(downloads).toBe(1);
    expect(stored?.customMetadata.sourceSha256).toBe(SOURCE_SHA256);
    await expect(
      store.seal({ ...input, sourceUrl: "https://attacker.example/audio.m4a" }),
    ).rejects.toThrow("invalid qencode output url");
    await expect(
      store.seal({ ...input, sourceUrl: "https://storage.qencode.com:8443/audio.m4a" }),
    ).rejects.toThrow("invalid qencode output url");
    await expect(
      store.seal({ ...input, sourceUrl: "https://storage.qencode.com/audio.m4a#unexpected" }),
    ).rejects.toThrow("invalid qencode output url");
  });
});
