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

const hostileFixtures = (await Bun.file(
  new URL("../../../../tests/fixtures/media-acr/hostile-fixtures.json", import.meta.url),
).json()) as {
  readonly multipart: Readonly<{
    readonly fixed_boundary: string;
    readonly boundary_collision_sample_ascii: string;
  }>;
  readonly signature: Readonly<{
    readonly string_to_sign: string;
    readonly expected_signature: string;
  }>;
  readonly responses: Readonly<Record<string, unknown>>;
  readonly stream_lifecycle: Readonly<{
    readonly headers_then_hanging_body: Readonly<{
      readonly status: number;
      readonly content_type: string;
      readonly provider_code: number;
    }>;
    readonly early_status_never_settling_cancel: Readonly<{
      readonly status: number;
      readonly content_type: string;
      readonly provider_code: number;
    }>;
    readonly hanging_body_never_settling_cancel: Readonly<{
      readonly status: number;
      readonly content_type: string;
      readonly provider_code: number;
    }>;
  }>;
};

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

function streamBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function hangingBody(bytes: Uint8Array): {
  readonly body: ReadableStream<Uint8Array>;
  readonly isCancelled: () => boolean;
} {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, isCancelled: () => cancelled };
}

function neverSettlingCancelBody(bytes?: Uint8Array): {
  readonly body: ReadableStream<Uint8Array>;
  readonly isCancelled: () => boolean;
} {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes !== undefined) controller.enqueue(bytes);
    },
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  return { body, isCancelled: () => cancelled };
}

function unreadBody(): {
  readonly body: ReadableStream<Uint8Array>;
  readonly isCancelled: () => boolean;
} {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, isCancelled: () => cancelled };
}

async function expectBodyReleased(
  body: ReadableStream<Uint8Array>,
  isCancelled: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (isCancelled() && !body.locked) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(isCancelled()).toBe(true);
  expect(body.locked).toBe(false);
}

function jsonResponse(value: unknown, status = 200, contentType = "application/json") {
  return {
    status,
    headers: { "content-type": contentType },
    body: streamBody(new TextEncoder().encode(JSON.stringify(value))),
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
    host: options.host ?? "identify-eu-west-1.acrcloud.com",
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
      buildAcrCloudSignature("fixture-secret", hostileFixtures.signature.string_to_sign),
    ).resolves.toBe(hostileFixtures.signature.expected_signature);
  });

  test("never places the injected secret in multipart bytes", async () => {
    let body: Uint8Array | undefined;
    let requestId: string | undefined;
    let redirect: string | undefined;
    let url: string | undefined;
    const provider = adapter(null, {
      request: (request) => {
        body = request.body;
        requestId = request.requestId;
        redirect = request.redirect;
        url = request.url;
        return Effect.succeed(jsonResponse({ status: { code: 1001 } }));
      },
    });
    const result = await Effect.runPromise(provider.identify(input));
    expectContext(result);
    expect(new TextDecoder().decode(body ?? new Uint8Array())).not.toContain("fixture-secret");
    expect(requestId).toBe("attempt-1");
    expect(redirect).toBe("error");
    expect(url).toBe("https://identify-eu-west-1.acrcloud.com/v1/identify");
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
    expect(first.contentType).toBe(
      `multipart/form-data; boundary=${hostileFixtures.multipart.fixed_boundary}`,
    );
  });

  test("rejects a fixed-boundary collision in sample and fields", () => {
    const sample = new TextEncoder().encode(
      hostileFixtures.multipart.boundary_collision_sample_ascii,
    );
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
        accessKey: hostileFixtures.multipart.fixed_boundary,
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
    if (result.outcome === "retained_reference_match") {
      expect(Object.isFrozen(result.evidence)).toBe(true);
      expect(Object.isFrozen(result.evidence.artists)).toBe(true);
    }
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
      body: streamBody(new TextEncoder().encode("{not-json")),
    });
    expect(malformed).toMatchObject({
      outcome: "malformed_or_unsupported_response",
      reason: "malformed_json",
    });
    expectContext(malformed);

    for (const contentType of ["text/plain", "application/jsonx"]) {
      const wrongContentType = await resultOf(
        jsonResponse({ status: { code: 0 } }, 200, contentType),
      );
      expect(wrongContentType).toMatchObject({
        outcome: "malformed_or_unsupported_response",
        reason: "wrong_content_type",
      });
      expectContext(wrongContentType);
    }
    const parameterizedJson = await resultOf(
      jsonResponse({ status: { code: 1001 } }, 200, "application/json ; charset=utf-8"),
    );
    expect(parameterizedJson).toMatchObject({ outcome: "no_match" });
    expectContext(parameterizedJson);

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
      body: streamBody(new Uint8Array(acceptedLimits.maxResponseBytes + 1)),
    });
    expect(oversized).toMatchObject({
      outcome: "malformed_or_unsupported_response",
      reason: "response_too_large",
    });
    expectContext(oversized);
  });

  test("enforces the response ceiling while consuming the injected stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(acceptedLimits.maxResponseBytes + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await resultOf({
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    });
    expect(result).toMatchObject({
      outcome: "malformed_or_unsupported_response",
      reason: "response_too_large",
    });
    expectContext(result);
    expect(cancelled).toBe(true);
  });

  test("cancels and releases streams for every early response decision", async () => {
    const cases = [
      [99, "application/json", "malformed_or_unsupported_response", "unsupported_shape"],
      [429, "application/json", "retryable_failure", "throttled"],
      [408, "application/json", "retryable_failure", "provider"],
      [500, "application/json", "retryable_failure", "provider"],
      [400, "application/json", "permanent_provider_rejection", "provider_rejected"],
      [401, "application/json", "permanent_provider_rejection", "unauthorized"],
      [200, "application/jsonx", "malformed_or_unsupported_response", "wrong_content_type"],
    ] as const;
    for (const [status, contentType, outcome, reason] of cases) {
      const tracked = unreadBody();
      const result = await resultOf({
        status,
        headers: { "content-type": contentType },
        body: tracked.body,
      });
      expect(result).toMatchObject({ outcome, reason });
      expectContext(result);
      await expectBodyReleased(tracked.body, tracked.isCancelled);
    }

    let cancelRejected = false;
    const rejectingBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelRejected = true;
        throw new Error("fixture cancellation failure");
      },
    });
    const rejectedCancelResult = await resultOf({
      status: 429,
      headers: { "content-type": "application/json" },
      body: rejectingBody,
    });
    expect(rejectedCancelResult).toMatchObject({
      outcome: "retryable_failure",
      reason: "throttled",
    });
    expectContext(rejectedCancelResult);
    expect(cancelRejected).toBe(true);
    expect(rejectingBody.locked).toBe(false);
  });

  test("preserves an early status outcome when body cancellation never settles", async () => {
    const fixture = hostileFixtures.stream_lifecycle.early_status_never_settling_cancel;
    const tracked = neverSettlingCancelBody();
    const result = await resultOf({
      status: fixture.status,
      headers: { "content-type": fixture.content_type },
      body: tracked.body,
    });
    expect(result).toMatchObject({ outcome: "retryable_failure", reason: "throttled" });
    expectContext(result);
    expect(tracked.isCancelled()).toBe(true);
    expect(tracked.body.locked).toBe(false);
  });

  test("maps every documented provider status code through the closed outcome union", async () => {
    const cases = [
      ["provider_throttled_count", "retryable_failure", "throttled"],
      ["provider_throttled_qps", "retryable_failure", "throttled"],
      ["provider_service_error", "retryable_failure", "provider"],
      ["provider_recognition_error", "retryable_failure", "provider"],
      ["provider_wrong_access_key", "permanent_provider_rejection", "unauthorized"],
      ["provider_invalid_signature", "permanent_provider_rejection", "unauthorized"],
      ["provider_unknown", "retryable_failure", "provider"],
    ] as const;
    for (const [fixtureName, outcome, reason] of cases) {
      const result = await resultOf(jsonResponse(hostileFixtures.responses[fixtureName]));
      expect(result).toMatchObject({ outcome, reason });
      expectContext(result);
    }
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

  test("cancels and releases a hanging response body on adapter timeout", async () => {
    const fixture = hostileFixtures.stream_lifecycle.headers_then_hanging_body;
    const tracked = hangingBody(
      new TextEncoder().encode(JSON.stringify({ status: { code: fixture.provider_code } })),
    );
    const response = {
      status: fixture.status,
      headers: { "content-type": fixture.content_type },
      body: tracked.body,
    };
    const result = await Effect.runPromise(
      adapter(null, {
        timeoutMs: 5,
        request: () => Effect.succeed(response),
      }).identify(input),
    );
    expect(result).toMatchObject({ outcome: "retryable_failure", reason: "timeout" });
    expectContext(result);
    await expectBodyReleased(tracked.body, tracked.isCancelled);
  });

  test("cancels and releases a hanging response body on caller cancellation", async () => {
    const fixture = hostileFixtures.stream_lifecycle.headers_then_hanging_body;
    const tracked = hangingBody(
      new TextEncoder().encode(JSON.stringify({ status: { code: fixture.provider_code } })),
    );
    const response = {
      status: fixture.status,
      headers: { "content-type": fixture.content_type },
      body: tracked.body,
    };
    const controller = new AbortController();
    const running = Effect.runPromise(
      adapter(null, { request: () => Effect.succeed(response) }).identify({
        ...input,
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 5);
    const result = await running;
    expect(result).toMatchObject({ outcome: "retryable_failure", reason: "cancelled" });
    expectContext(result);
    await expectBodyReleased(tracked.body, tracked.isCancelled);
  });

  test("preserves timeout and caller cancellation with a never-settling body cancel", async () => {
    const fixture = hostileFixtures.stream_lifecycle.hanging_body_never_settling_cancel;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ status: { code: fixture.provider_code } }),
    );
    const timedOutBody = neverSettlingCancelBody(bytes);
    const timedOut = await Effect.runPromise(
      adapter(null, {
        timeoutMs: 5,
        request: () =>
          Effect.succeed({
            status: fixture.status,
            headers: { "content-type": fixture.content_type },
            body: timedOutBody.body,
          }),
      }).identify(input),
    );
    expect(timedOut).toMatchObject({ outcome: "retryable_failure", reason: "timeout" });
    expectContext(timedOut);
    expect(timedOutBody.isCancelled()).toBe(true);
    expect(timedOutBody.body.locked).toBe(false);

    const callerBody = neverSettlingCancelBody(bytes);
    const controller = new AbortController();
    const running = Effect.runPromise(
      adapter(null, {
        request: () =>
          Effect.succeed({
            status: fixture.status,
            headers: { "content-type": fixture.content_type },
            body: callerBody.body,
          }),
      }).identify({ ...input, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 5);
    const cancelled = await running;
    expect(cancelled).toMatchObject({ outcome: "retryable_failure", reason: "cancelled" });
    expectContext(cancelled);
    expect(callerBody.isCancelled()).toBe(true);
    expect(callerBody.body.locked).toBe(false);
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
      host: "identify-eu-west-1.acrcloud.com",
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
      "https://user@identify-eu-west-1.acrcloud.com",
      "https://identify-eu-west-1.acrcloud.com:443",
      "https://identify-eu-west-1.acrcloud.com/v1/other",
      "https://identify-eu-west-1.acrcloud.com/",
      "identify-eu-west-1.acrcloud.com/",
      "https://identify-eu-west-1.acrcloud.com/?query=1",
      "https://identify-eu-west-1.acrcloud.com/#fragment",
      "http://identify-eu-west-1.acrcloud.com",
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

  test("snapshots validated configuration and request metadata before async work", async () => {
    let release!: (response: ReturnType<typeof jsonResponse>) => void;
    let captured: { readonly url: string; readonly body: Uint8Array } | undefined;
    const gate = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      release = resolve;
    });
    const credentials = { accessKey: "fixture-access-key", accessSecret: "fixture-secret" };
    const mutableInput = {
      ...input,
      sample: { ...input.sample, bytes: new Uint8Array(input.sample.bytes) },
    };
    const options = {
      host: "identify-eu-west-1.acrcloud.com",
      credentials,
      clock: { nowSeconds: () => 1_700_000_000 },
      adapterRevision: "acrcloud-adapter-v1",
      limits: { ...acceptedLimits },
      transport: {
        request: (request: Parameters<NonNullable<AcrCloudTransport["request"]>>[0]) => {
          captured = { url: request.url, body: request.body };
          return gate;
        },
      },
    };
    const provider = makeAcrCloudAdapter(options);
    const pending = provider.identify(mutableInput);

    mutableInput.operationId = "mutated-operation";
    mutableInput.requestId = "mutated-request";
    mutableInput.sample.filename = "mutated.wav";
    mutableInput.sample.bytes[0] = 9;
    credentials.accessKey = "mutated-access-key";
    options.host = "identify-us-west-2.acrcloud.com";
    options.adapterRevision = "mutated-revision";
    options.limits.maxRequestBytes = 1;

    const running = Effect.runPromise(pending);
    release(jsonResponse({ status: { code: 1001 } }));
    const result = await running;
    expectContext(result);
    expect(captured?.url).toBe("https://identify-eu-west-1.acrcloud.com/v1/identify");
    expect(new TextDecoder().decode(captured?.body ?? new Uint8Array())).toContain(
      "fixture-access-key",
    );
  });
});
