import { describe, expect, test } from "bun:test";
import type { MediaIdentificationOutcome } from "@pirate/application/media-identification-provider";
import { Effect } from "effect";
import {
  ACRCLOUD_INTERNAL_MAX_REQUEST_BYTES,
  ACRCLOUD_INTERNAL_MAX_TIMEOUT_MS,
  ACRCLOUD_MULTIPART_BOUNDARY,
  type AcrCloudAcceptedLimits,
  type AcrCloudAdapterOptions,
  AcrCloudMultipartBoundaryCollision,
  type AcrCloudTransport,
  AcrCloudTransportFailure,
  buildAcrCloudSignature,
  encodeAcrCloudMultipart,
  makeAcrCloudAdapter,
} from "./acrcloud.ts";

const acceptedLimits: AcrCloudAcceptedLimits = {
  maxSampleBytes: 1024,
  maxRequestBytes: 2048,
  maxResponseBytes: 1024,
  timeoutMs: 100,
};

const input = {
  version: "media-identification-request-v1" as const,
  operationId: "operation-1",
  audioRevision: 3,
  analysisRevision: 2,
  canonicalAudioSha256: "a".repeat(64),
  requestId: "attempt-1",
  sample: {
    bytes: new Uint8Array([1, 2, 3, 4]),
    filename: "sample.wav",
    contentType: "audio/wav",
  },
};

function jsonResponse(value: unknown, status = 200, contentType = "application/json") {
  return {
    status,
    headers: { "content-type": contentType },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function adapter(
  response: ReturnType<typeof jsonResponse> | null,
  options: Readonly<{
    readonly timeoutMs?: number;
    readonly limits?: AcrCloudAcceptedLimits;
    readonly host?: string;
    readonly request?: AcrCloudTransport["request"];
  }> = {},
) {
  return makeAcrCloudAdapter({
    host: options.host ?? "acrcloud.fixture",
    credentials: { accessKey: "fixture-access-key", accessSecret: "fixture-secret" },
    clock: { nowSeconds: () => 1_700_000_000 },
    adapterRevision: "acrcloud-adapter-v1",
    limits: options.limits ?? {
      ...acceptedLimits,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    transport: {
      request:
        options.request ??
        (() => Effect.succeed(response ?? jsonResponse({ status: { code: 1001 } }))),
    },
  });
}

function expectContext(result: MediaIdentificationOutcome) {
  expect(result.context).toEqual({
    version: "media-identification-attempt-context-v1",
    operationId: "operation-1",
    audioRevision: 3,
    analysisRevision: 2,
    canonicalAudioSha256: "a".repeat(64),
    requestId: "attempt-1",
    adapterRevision: "acrcloud-adapter-v1",
  });
  expect(Object.isFrozen(result.context)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(JSON.stringify(result)).not.toContain("sample.wav");
}

async function resultOf(
  response: ReturnType<typeof jsonResponse> | null,
  request = input,
): Promise<MediaIdentificationOutcome> {
  return Effect.runPromise(adapter(response).identify(request));
}

describe("ACRCloud signing and multipart", () => {
  test("signs the exact six-line fixture string", async () => {
    await expect(
      buildAcrCloudSignature(
        "fixture-secret",
        "POST\n/v1/identify\nfixture-access-key\naudio\n1\n1700000000",
      ),
    ).resolves.toBe("fvc8TK9F7gaKQqkKb9/Mu0pS4Ac=");
  });

  test("never places the injected secret in multipart bytes", async () => {
    let body: Uint8Array | undefined;
    let requestId: string | undefined;
    const provider = adapter(null, {
      request: (request) => {
        body = request.body;
        requestId = request.requestId;
        return Effect.succeed(jsonResponse({ status: { code: 1001 } }));
      },
    });
    const result = await Effect.runPromise(provider.identify(input));
    expectContext(result);
    expect(new TextDecoder().decode(body ?? new Uint8Array())).not.toContain("fixture-secret");
    expect(requestId).toBe("attempt-1");
  });

  test("encodes fixed-order fields and exact sample byte count", () => {
    const first = encodeAcrCloudMultipart({
      accessKey: "fixture-access-key",
      timestamp: "1700000000",
      signature: "signature",
      filename: "sample.wav",
      contentType: "audio/wav",
      sampleBytes: input.sample.bytes,
    });
    const second = encodeAcrCloudMultipart({
      accessKey: "fixture-access-key",
      timestamp: "1700000000",
      signature: "signature",
      filename: "sample.wav",
      contentType: "audio/wav",
      sampleBytes: input.sample.bytes,
    });
    expect(first.body).toEqual(second.body);
    expect(first.sampleBytes).toBe(4);
    const text = new TextDecoder().decode(first.body);
    expect(text).toContain('name="access_key"');
    expect(text).toContain('name="sample_bytes"\r\n\r\n4\r\n');
    expect(text).toContain('name="sample"; filename="sample.wav"');
    expect(first.contentType).toBe(`multipart/form-data; boundary=${ACRCLOUD_MULTIPART_BOUNDARY}`);
  });

  test("rejects a fixed-boundary collision in sample and fields", () => {
    const sample = new TextEncoder().encode(ACRCLOUD_MULTIPART_BOUNDARY);
    expect(() =>
      encodeAcrCloudMultipart({
        accessKey: "fixture-access-key",
        timestamp: "1700000000",
        signature: "signature",
        filename: "sample.wav",
        contentType: "audio/wav",
        sampleBytes: sample,
      }),
    ).toThrow(AcrCloudMultipartBoundaryCollision);
    expect(() =>
      encodeAcrCloudMultipart({
        accessKey: ACRCLOUD_MULTIPART_BOUNDARY,
        timestamp: "1700000000",
        signature: "signature",
        filename: "sample.wav",
        contentType: "audio/wav",
        sampleBytes: input.sample.bytes,
      }),
    ).toThrow(AcrCloudMultipartBoundaryCollision);
  });
});

describe("ACRCloud closed outcomes", () => {
  test("retains music evidence and binds the immutable attempt context", async () => {
    const result = await resultOf(
      jsonResponse({
        status: { code: 0 },
        metadata: {
          music: [
            {
              acrid: "music-1",
              title: "Fixture Song",
              artists: [{ name: "Fixture Artist" }],
              score: 97.5,
            },
          ],
        },
      }),
    );
    expect(result).toMatchObject({
      outcome: "retained_reference_match",
      evidence: {
        version: "media-identification-match-evidence-v1",
        provider: "acrcloud",
        matchKind: "music",
        providerMatchId: "music-1",
        title: "Fixture Song",
        artists: ["Fixture Artist"],
        score: 97.5,
      },
    });
    expectContext(result);
  });

  test("retains eligible custom matches and removes video-audio matches", async () => {
    const custom = await resultOf(
      jsonResponse({
        status: { code: 0 },
        metadata: { custom_files: [{ acr_id: "custom-1", name: "Catalog song" }] },
      }),
    );
    expect(custom.outcome).toBe("retained_reference_match");
    expect(custom).toMatchObject({
      evidence: { matchKind: "custom", providerMatchId: "custom-1" },
    });
    expectContext(custom);

    const videoAudio = await resultOf(
      jsonResponse({
        status: { code: 0 },
        metadata: {
          custom_files: [
            { acr_id: "video-1", user_defined: { content_type: "video_audio" } },
            { acr_id: "video-2", content_type: "video_audio" },
          ],
        },
      }),
    );
    expect(videoAudio.outcome).toBe("no_match");
    expectContext(videoAudio);
  });

  test("binds no-match and inconclusive provider decisions", async () => {
    for (const response of [
      jsonResponse({ status: { code: 1001 } }),
      jsonResponse({ status: { code: 0 }, metadata: {} }),
      jsonResponse({ status: { code: 2004 } }),
    ]) {
      const result = await resultOf(response);
      expectContext(result);
    }
    await expect(resultOf(jsonResponse({ status: { code: 1001 } }))).resolves.toMatchObject({
      outcome: "no_match",
    });
    await expect(resultOf(jsonResponse({ status: { code: 2004 } }))).resolves.toMatchObject({
      outcome: "inconclusive_fingerprint",
    });
  });

  test("binds malformed and oversized response outcomes", async () => {
    const malformed = await resultOf({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{not-json"),
    });
    expect(malformed).toMatchObject({
      outcome: "malformed_or_unsupported_response",
      reason: "malformed_json",
    });
    expectContext(malformed);

    const wrongContentType = await resultOf(
      jsonResponse({ status: { code: 0 } }, 200, "text/plain"),
    );
    expect(wrongContentType).toMatchObject({
      outcome: "malformed_or_unsupported_response",
      reason: "wrong_content_type",
    });
    expectContext(wrongContentType);

    const duplicate = await resultOf(
      jsonResponse({
        status: { code: 0 },
        metadata: { music: [{ acrid: "same" }, { acrid: "same" }] },
      }),
    );
    expect(duplicate).toMatchObject({
      outcome: "malformed_or_unsupported_response",
      reason: "duplicate_candidates",
    });
    expectContext(duplicate);

    const oversized = await resultOf({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new Uint8Array(acceptedLimits.maxResponseBytes + 1),
    });
    expect(oversized).toMatchObject({
      outcome: "malformed_or_unsupported_response",
      reason: "response_too_large",
    });
    expectContext(oversized);
  });
});

describe("ACRCloud bounded transport failures", () => {
  test("classifies throttling and transient/permanent HTTP outcomes", async () => {
    for (const [response, expected] of [
      [
        jsonResponse({ status: { code: 429 } }, 429),
        { outcome: "retryable_failure", reason: "throttled" },
      ],
      [
        jsonResponse({ status: { code: 500 } }, 503),
        { outcome: "retryable_failure", reason: "provider" },
      ],
      [
        jsonResponse({ status: { code: 400 } }, 400),
        { outcome: "permanent_provider_rejection", reason: "provider_rejected" },
      ],
      [
        jsonResponse({ status: { code: 413 } }, 413),
        { outcome: "permanent_provider_rejection", reason: "sample_too_large" },
      ],
    ] as const) {
      const result = await resultOf(response);
      expect(result).toMatchObject(expected);
      expectContext(result);
    }
  });

  test("normalizes injected transport errors without exposing their message", async () => {
    const result = await Effect.runPromise(
      adapter(null, {
        request: () => Effect.fail(new AcrCloudTransportFailure({ reason: "network" })),
      }).identify(input),
    );
    expect(result).toMatchObject({ outcome: "retryable_failure", reason: "transport" });
    expectContext(result);
  });

  test("aborts transport on timeout and caller cancellation", async () => {
    let timedOutSignal: AbortSignal | undefined;
    const timedOut = await Effect.runPromise(
      adapter(null, {
        timeoutMs: 5,
        request: ({ signal }) => {
          timedOutSignal = signal;
          return Effect.never;
        },
      }).identify(input),
    );
    expect(timedOut).toMatchObject({ outcome: "retryable_failure", reason: "timeout" });
    expectContext(timedOut);
    expect(timedOutSignal?.aborted).toBe(true);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await Effect.runPromise(
      adapter(null).identify({ ...input, signal: controller.signal }),
    );
    expect(cancelled).toMatchObject({ outcome: "retryable_failure", reason: "cancelled" });
    expectContext(cancelled);

    const inFlightController = new AbortController();
    const inFlight = Effect.runPromise(
      adapter(null, { request: () => Effect.never }).identify({
        ...input,
        signal: inFlightController.signal,
      }),
    );
    setTimeout(() => inFlightController.abort(), 5);
    const inFlightResult = await inFlight;
    expect(inFlightResult).toMatchObject({ outcome: "retryable_failure", reason: "cancelled" });
    expectContext(inFlightResult);
  });
});

describe("ACRCloud pre-transport validation", () => {
  test("rejects malformed immutable request identity without transport", async () => {
    let calls = 0;
    const provider = adapter(null, {
      request: () => {
        calls += 1;
        return Effect.succeed(jsonResponse({ status: { code: 1001 } }));
      },
    });
    const cases = [
      ["invalid_request_version", { version: "media-identification-request-v0" }],
      ["invalid_operation_id", { operationId: "" }],
      ["invalid_operation_id", { operationId: "x".repeat(129) }],
      ["invalid_request_id", { requestId: "request with spaces" }],
      ["invalid_request_id", { requestId: "x".repeat(129) }],
      ["invalid_audio_revision", { audioRevision: 0 }],
      ["invalid_analysis_revision", { analysisRevision: Number.NaN }],
      ["invalid_audio_hash", { canonicalAudioSha256: "A".repeat(64) }],
      ["invalid_sample", { sample: { ...input.sample, bytes: new Uint8Array() } }],
      ["invalid_filename", { sample: { ...input.sample, filename: "bad\nname.wav" } }],
      ["invalid_filename", { sample: { ...input.sample, filename: "x".repeat(129) } }],
      ["invalid_content_type", { sample: { ...input.sample, contentType: "text/plain" } }],
      [
        "invalid_content_type",
        { sample: { ...input.sample, contentType: `audio/${"x".repeat(129)}` } },
      ],
    ] as const;
    for (const [reason, change] of cases) {
      await expect(
        Effect.runPromise(provider.identify({ ...input, ...change } as unknown as typeof input)),
      ).rejects.toMatchObject({
        _tag: "MediaIdentificationRequestInvalid",
        reason,
      });
    }
    expect(calls).toBe(0);
  });

  test("requires injected limits and bounds them by internal memory caps", async () => {
    let calls = 0;
    const base = {
      host: "acrcloud.fixture",
      credentials: { accessKey: "fixture-access-key", accessSecret: "fixture-secret" },
      clock: { nowSeconds: () => 1_700_000_000 },
      adapterRevision: "acrcloud-adapter-v1",
      transport: {
        request: () => {
          calls += 1;
          return Effect.succeed(jsonResponse({ status: { code: 1001 } }));
        },
      },
    };
    for (const limits of [
      undefined,
      { ...acceptedLimits, maxSampleBytes: 0 },
      { ...acceptedLimits, maxRequestBytes: ACRCLOUD_INTERNAL_MAX_REQUEST_BYTES + 1 },
      { ...acceptedLimits, maxResponseBytes: Number.POSITIVE_INFINITY },
      { ...acceptedLimits, timeoutMs: ACRCLOUD_INTERNAL_MAX_TIMEOUT_MS + 1 },
    ]) {
      const provider = makeAcrCloudAdapter({
        ...base,
        ...(limits === undefined ? {} : { limits }),
      } as unknown as AcrCloudAdapterOptions);
      await expect(Effect.runPromise(provider.identify(input))).rejects.toMatchObject({
        _tag: "MediaIdentificationRequestInvalid",
        reason: "invalid_limits",
      });
    }
    for (const adapterRevision of ["", "x".repeat(65)]) {
      const provider = makeAcrCloudAdapter({
        ...base,
        adapterRevision,
        limits: acceptedLimits,
      } as unknown as AcrCloudAdapterOptions);
      await expect(Effect.runPromise(provider.identify(input))).rejects.toMatchObject({
        _tag: "MediaIdentificationRequestInvalid",
        reason: "invalid_adapter_revision",
      });
    }
    expect(calls).toBe(0);
  });

  test("rejects injected boundary collisions before transport", async () => {
    let calls = 0;
    const provider = adapter(null, {
      request: () => {
        calls += 1;
        return Effect.succeed(jsonResponse({ status: { code: 1001 } }));
      },
    });
    await expect(
      Effect.runPromise(
        provider.identify({
          ...input,
          sample: {
            ...input.sample,
            bytes: new TextEncoder().encode(ACRCLOUD_MULTIPART_BOUNDARY),
          },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "MediaIdentificationRequestInvalid",
      reason: "multipart_boundary_collision",
    });
    expect(calls).toBe(0);
  });

  test("rejects hostile host forms without transport", async () => {
    let calls = 0;
    for (const host of [
      "https://user@acrcloud.fixture",
      "https://acrcloud.fixture:443",
      "https://acrcloud.fixture/v1/other",
      "https://acrcloud.fixture/?query=1",
      "https://acrcloud.fixture/#fragment",
      "http://acrcloud.fixture",
    ]) {
      const provider = adapter(null, {
        host,
        request: () => {
          calls += 1;
          return Effect.succeed(jsonResponse({ status: { code: 1001 } }));
        },
      });
      await expect(Effect.runPromise(provider.identify(input))).rejects.toMatchObject({
        _tag: "MediaIdentificationRequestInvalid",
        reason: "invalid_provider_endpoint",
      });
    }
    expect(calls).toBe(0);
  });

  test("rejects accepted sample and request ceilings before transport", async () => {
    let calls = 0;
    const provider = adapter(null, {
      limits: { ...acceptedLimits, maxSampleBytes: 3 },
      request: () => {
        calls += 1;
        return Effect.succeed(jsonResponse({ status: { code: 1001 } }));
      },
    });
    await expect(Effect.runPromise(provider.identify(input))).rejects.toMatchObject({
      _tag: "MediaIdentificationRequestInvalid",
      reason: "invalid_sample",
    });
    const requestLimited = adapter(null, {
      limits: { ...acceptedLimits, maxRequestBytes: 1 },
      request: () => {
        calls += 1;
        return Effect.succeed(jsonResponse({ status: { code: 1001 } }));
      },
    });
    const result = await Effect.runPromise(requestLimited.identify(input));
    expect(result).toMatchObject({
      outcome: "permanent_provider_rejection",
      reason: "sample_too_large",
    });
    expectContext(result);
    expect(calls).toBe(0);
  });
});
