import { describe, expect, test } from "bun:test";
import {
  characterResponse,
  malformedResponse,
  multilingualWordsResponse,
  noSpeechResponse,
  overlappingTimingResponse,
  quantizedTimingResponse,
  repeatedWordResponse,
} from "../../../../tests/fixtures/media-alignment/elevenlabs/responses.ts";
import {
  ElevenLabsAlignmentAdapter,
  type ElevenLabsAlignmentAudioSource,
  type ElevenLabsAlignmentInput,
  type ElevenLabsAlignmentRequestBody,
  type ElevenLabsAlignmentResponseBody,
  type ElevenLabsAlignmentTransportRequest,
  type ElevenLabsAlignmentTransportResponse,
  encodeElevenLabsAlignmentMultipart,
} from "./elevenlabs-alignment.ts";

const sha = "a".repeat(64);
const limits = {
  max_audio_bytes: 25_000_000,
  max_transcript_bytes: 200_000,
  timeout_ms: 500,
  max_response_bytes: 1_048_576,
  max_timings: 10_000,
  max_timing_ms: 86_400_000,
} as const;

const testRandomBytes = (length: number) => new Uint8Array(length).fill(0x2a);

function source(bytes: Uint8Array, chunkSize = bytes.byteLength): ElevenLabsAlignmentAudioSource {
  return {
    byteLength: bytes.byteLength,
    open: async function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
      }
    },
  };
}

function hangingSource(onAbort: () => void): ElevenLabsAlignmentAudioSource {
  return {
    byteLength: 4,
    open: (signal) =>
      (async function* () {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            onAbort();
            reject(new DOMException("cancelled", "AbortError"));
          };
          if (signal?.aborted) {
            abort();
          } else {
            signal?.addEventListener("abort", abort, { once: true });
          }
        });
      })(),
  };
}

async function consumeBody(
  body: ElevenLabsAlignmentRequestBody,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body.open(signal)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  expect(total).toBe(body.byteLength);
  return result;
}

function input(overrides: Partial<ElevenLabsAlignmentInput> = {}): ElevenLabsAlignmentInput {
  return {
    request_id: "alignment-request-1",
    operation_id: "operation-1",
    post_id: "post-1",
    audio: {
      audio_revision: 1,
      canonical_audio_sha256: sha,
      source: source(new Uint8Array([1, 2, 3, 4]), 2),
      mime_type: "audio/mpeg",
      filename: "song.mp3",
    },
    transcript: {
      artifact_ref: "private/transcript-1",
      operation_id: "operation-1",
      audio_revision: 1,
      analysis_revision: 2,
      canonical_audio_sha256: sha,
      transcript: "Привет 世界!",
    },
    ...overrides,
  };
}

function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
  onCancel: () => void = () => undefined,
): ElevenLabsAlignmentTransportResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: responseBody(bytes, undefined, onCancel),
  };
}

function responseBody(
  bytes: Uint8Array,
  chunkSize = bytes.byteLength,
  onCancel: () => void = () => undefined,
): ElevenLabsAlignmentResponseBody {
  return {
    open: async function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
      }
    },
    cancel: onCancel,
  };
}

function hangingResponseBody(onCancel: () => void): ElevenLabsAlignmentResponseBody {
  let release: (() => void) | undefined;
  return {
    open: async function* () {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return;
    },
    cancel: () => {
      onCancel();
      release?.();
    },
  };
}

function rawResponse(
  body: string | Uint8Array,
  status = 200,
  headers: Record<string, string> = {},
): ElevenLabsAlignmentTransportResponse {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return { status, headers, body: responseBody(bytes) };
}

function fakeTransport(
  next:
    | ElevenLabsAlignmentTransportResponse
    | ((
        request: ElevenLabsAlignmentTransportRequest,
      ) => Promise<ElevenLabsAlignmentTransportResponse>),
) {
  const requests: ElevenLabsAlignmentTransportRequest[] = [];
  const consumedBodies: Uint8Array[] = [];
  const transport = async (request: ElevenLabsAlignmentTransportRequest) => {
    requests.push(request);
    consumedBodies.push(await consumeBody(request.body, request.signal));
    return typeof next === "function" ? next(request) : next;
  };
  return { requests, consumedBodies, transport };
}

function adapter(
  transport: (
    request: ElevenLabsAlignmentTransportRequest,
  ) => Promise<ElevenLabsAlignmentTransportResponse>,
  options: Partial<ConstructorParameters<typeof ElevenLabsAlignmentAdapter>[0]> = {},
) {
  return new ElevenLabsAlignmentAdapter({
    enabled: true,
    api_key: "xi-secret-test-key",
    transport,
    limits,
    random_bytes: testRandomBytes,
    ...options,
  });
}

describe("ElevenLabs forced-alignment adapter", () => {
  test("is disabled by default and never calls a transport", async () => {
    let calls = 0;
    const result = await new ElevenLabsAlignmentAdapter({
      transport: async () => {
        calls += 1;
        return response(multilingualWordsResponse);
      },
    }).align(input());

    expect(result).toMatchObject({
      alignment: "unavailable",
      outcome: "disabled",
      reason: "disabled",
    });
    expect(calls).toBe(0);
  });

  test("does not serialize the injected provider secret or retain it in failures", async () => {
    const transport = fakeTransport({
      status: 502,
      headers: { "content-type": "application/json" },
      body: responseBody(
        new TextEncoder().encode("provider detail must not cross the adapter boundary"),
      ),
    });
    const instance = adapter(transport.transport);
    const result = await instance.align(input());
    expect(JSON.stringify(instance)).not.toContain("xi-secret-test-key");
    expect(JSON.stringify(result)).not.toContain("xi-secret-test-key");
    expect(JSON.stringify(result)).not.toContain("provider detail");
  });

  test("never serializes transcript text, provider bodies, or secrets in any outcome", async () => {
    const providerBody = "PROVIDER_BODY_MUST_NOT_CROSS_BOUNDARY";
    const timeoutOutcome = await new ElevenLabsAlignmentAdapter({
      enabled: true,
      api_key: "xi-secret-test-key",
      limits: { ...limits, timeout_ms: 5 },
      transport: async () => new Promise<ElevenLabsAlignmentTransportResponse>(() => undefined),
    }).align(input());
    const cancellationController = new AbortController();
    const cancellationPromise = new ElevenLabsAlignmentAdapter({
      enabled: true,
      api_key: "xi-secret-test-key",
      limits,
      transport: async () => new Promise<ElevenLabsAlignmentTransportResponse>(() => undefined),
    }).align(input({ signal: cancellationController.signal }));
    cancellationController.abort();
    const cancelledOutcome = await cancellationPromise;
    const outcomes = [
      await new ElevenLabsAlignmentAdapter().align(input()),
      await adapter(fakeTransport(response(multilingualWordsResponse)).transport).align(
        input({
          transcript: { ...input().transcript, transcript: "" },
        }),
      ),
      await adapter(fakeTransport(response(multilingualWordsResponse)).transport).align(input()),
      await adapter(
        fakeTransport(
          response({
            ...multilingualWordsResponse,
            characters: [{ text: "different", start: 0, end: 1 }],
            words: [{ text: "different", start: 0, end: 1, loss: 0.1 }],
          }),
        ).transport,
      ).align(input()),
      await adapter(fakeTransport(rawResponse(providerBody, 503)).transport).align(input()),
      await adapter(fakeTransport(rawResponse(providerBody, 401)).transport).align(input()),
      await adapter(
        fakeTransport(rawResponse(providerBody, 200, { "content-type": "text/plain" })).transport,
      ).align(input()),
      await new ElevenLabsAlignmentAdapter({
        enabled: true,
        api_key: "xi-secret-test-key",
        transport: fakeTransport(
          rawResponse(providerBody, 200, { "content-type": "application/json" }),
        ).transport,
      }).align(input()),
      timeoutOutcome,
      cancelledOutcome,
    ];
    const serialized = JSON.stringify(outcomes);
    expect(serialized).not.toContain("Привет");
    expect(serialized).not.toContain("世界");
    expect(serialized).not.toContain("PROVIDER_BODY_MUST_NOT_CROSS_BOUNDARY");
    expect(serialized).not.toContain("xi-secret-test-key");
  });

  test("requires every accepted request limit when enabled", async () => {
    const transport = fakeTransport(response(multilingualWordsResponse));
    const missing = await new ElevenLabsAlignmentAdapter({
      enabled: true,
      api_key: "xi-secret-test-key",
      transport: transport.transport,
    }).align(input());
    expect(missing).toMatchObject({ outcome: "permanent", reason: "configuration" });
    expect(transport.requests).toHaveLength(0);

    const invalid = await new ElevenLabsAlignmentAdapter({
      enabled: true,
      api_key: "xi-secret-test-key",
      transport: transport.transport,
      limits: { ...limits, max_audio_bytes: 0 },
    }).align(input());
    expect(invalid).toMatchObject({ outcome: "permanent", reason: "configuration" });
    expect(transport.requests).toHaveLength(0);
  });

  test("fails closed for empty, oversized, or header-unsafe API keys", async () => {
    for (const api_key of [
      "",
      "key with spaces",
      "key\r\nInjected: true",
      "ключ",
      "x".repeat(4_097),
    ]) {
      const transport = fakeTransport(response(multilingualWordsResponse));
      const result = await new ElevenLabsAlignmentAdapter({
        enabled: true,
        api_key,
        transport: transport.transport,
        limits,
      }).align(input());
      expect(result).toMatchObject({ outcome: "permanent", reason: "configuration" });
      expect(transport.requests).toHaveLength(0);
    }
  });

  test("builds a deterministic bounded multipart request with the exact transcript", async () => {
    const first = fakeTransport(response(multilingualWordsResponse));
    const second = fakeTransport(response(multilingualWordsResponse));
    await adapter(first.transport).align(input());
    await adapter(second.transport).align(input());

    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(first.consumedBodies[0]).toEqual(second.consumedBodies[0]);
    expect(first.requests[0]?.method).toBe("POST");
    expect(first.requests[0]?.url).toBe("https://api.elevenlabs.io/v1/forced-alignment");
    expect(first.requests[0]?.headers["xi-api-key"]).toBe("xi-secret-test-key");
    expect(first.requests[0]?.headers["content-type"]).toContain("boundary=");
    expect(first.requests[0]?.headers["content-length"]).toBe(
      String(first.requests[0]?.body.byteLength),
    );
    const firstBody = await consumeBody(first.requests[0]?.body as ElevenLabsAlignmentRequestBody);
    const secondBody = await consumeBody(
      second.requests[0]?.body as ElevenLabsAlignmentRequestBody,
    );
    expect(firstBody).toEqual(secondBody);
    const body = new TextDecoder().decode(firstBody);
    expect(body).toContain('name="file"; filename="song.mp3"');
    expect(body).toContain('name="text"');
    expect(body).toContain("Привет 世界!");
  });

  test("accepts multilingual Unicode and preserves repeated word positions", async () => {
    const multilingual = fakeTransport(response(multilingualWordsResponse));
    const result = await adapter(multilingual.transport).align(input());
    expect(result).toMatchObject({
      outcome: "ready",
      mode: "word",
      context: { audio_revision: 1, analysis_revision: 2 },
    });
    expect(JSON.stringify(result)).not.toContain("Привет");
    expect(JSON.stringify(result)).not.toContain("世界");
    if (result.outcome !== "ready") throw new Error("expected ready alignment");
    expect(result.timings.map((timing) => timing.token_index)).toEqual([0, 1]);
    expect(result.timings[1]).toMatchObject({ token_index: 1, start_ms: 500, end_ms: 1000 });

    const repeatedInput = input({
      transcript: {
        artifact_ref: "private/transcript-repeat",
        operation_id: "operation-1",
        audio_revision: 1,
        analysis_revision: 3,
        canonical_audio_sha256: sha,
        transcript: "go go",
      },
    });
    const repeated = fakeTransport(response(repeatedWordResponse));
    const repeatedResult = await adapter(repeated.transport).align(repeatedInput);
    expect(repeatedResult).toMatchObject({ outcome: "ready", mode: "word" });
    if (repeatedResult.outcome !== "ready") throw new Error("expected repeated alignment");
    expect(
      repeatedResult.timings
        .filter((timing) => timing.kind === "word")
        .map((timing) => timing.token_index),
    ).toEqual([0, 1]);
  });

  test("validates combined character and word timings for non-Latin combining characters", async () => {
    const transport = fakeTransport(response(characterResponse));
    const result = await adapter(transport.transport).align(
      input({
        transcript: {
          artifact_ref: "private/transcript-hindi",
          operation_id: "operation-1",
          audio_revision: 1,
          analysis_revision: 4,
          canonical_audio_sha256: sha,
          transcript: "नमस्ते",
        },
      }),
    );
    expect(result).toMatchObject({ outcome: "ready", mode: "word" });
    if (result.outcome !== "ready") throw new Error("expected character alignment");
    expect(result.timings.map((timing) => timing.token_index)).toEqual([0]);
  });

  test("does not call an empty provider response no-speech for a non-empty transcript", async () => {
    const transport = fakeTransport(response(noSpeechResponse));
    const result = await adapter(transport.transport).align(input());
    expect(result).toMatchObject({
      alignment: "unavailable",
      outcome: "malformed",
      reason: "malformed_response",
    });
    expect(transport.requests).toHaveLength(1);

    const whitespaceTransport = fakeTransport(response(noSpeechResponse));
    const whitespaceResult = await adapter(whitespaceTransport.transport).align(
      input({ transcript: { ...input().transcript, transcript: " " } }),
    );
    expect(whitespaceResult).toMatchObject({
      outcome: "malformed",
      reason: "malformed_response",
    });
    expect(whitespaceTransport.requests).toHaveLength(1);
  });

  test("accepts documented zero-duration entries and clamps millisecond quantization overlap", async () => {
    const transport = fakeTransport(response(quantizedTimingResponse));
    const result = await adapter(transport.transport).align(
      input({
        transcript: {
          artifact_ref: "private/transcript-quantized",
          operation_id: "operation-1",
          audio_revision: 1,
          analysis_revision: 3,
          canonical_audio_sha256: sha,
          transcript: "go go",
        },
      }),
    );
    expect(result).toMatchObject({ outcome: "ready", mode: "word" });
    if (result.outcome !== "ready") throw new Error("expected quantized alignment");
    expect(result.timings).toEqual([
      { token_index: 0, text_length: 2, start_ms: 0, end_ms: 200, kind: "word" },
      { token_index: 1, text_length: 2, start_ms: 200, end_ms: 400, kind: "word" },
    ]);
  });

  test("rejects mismatched transcript and invalid or overlapping timings", async () => {
    const mismatch = fakeTransport(
      response({
        ...multilingualWordsResponse,
        characters: [{ text: "different", start: 0, end: 1 }],
        words: [{ text: "different", start: 0, end: 1, loss: 0.1 }],
      }),
    );
    const mismatchResult = await adapter(mismatch.transport).align(input());
    expect(mismatchResult).toMatchObject({
      outcome: "transcript_mismatch",
      reason: "transcript_mismatch",
    });
    expect(JSON.stringify(mismatchResult)).not.toContain("Привет");
    expect(JSON.stringify(mismatchResult)).not.toContain("xi-secret-test-key");

    for (const body of [malformedResponse, overlappingTimingResponse]) {
      const transport = fakeTransport(response(body));
      const result = await adapter(transport.transport).align(
        body === overlappingTimingResponse
          ? input({
              transcript: {
                artifact_ref: "private/transcript-repeat",
                operation_id: "operation-1",
                audio_revision: 1,
                analysis_revision: 3,
                canonical_audio_sha256: sha,
                transcript: "go go",
              },
            })
          : input(),
      );
      expect(result.outcome).toBe("malformed");
      if (result.outcome === "ready") throw new Error("expected malformed alignment");
      expect(["malformed_response", "invalid_timing"]).toContain(result.reason);
    }
  });

  test("rejects the retired flat character-only response shape", async () => {
    const legacy = fakeTransport(
      response({
        characters: ["Привет"],
        character_start_times_seconds: [0],
        character_end_times_seconds: [1],
      }),
    );
    await expect(adapter(legacy.transport).align(input())).resolves.toMatchObject({
      outcome: "malformed",
      reason: "malformed_response",
    });
  });

  test("rejects negative root or per-word loss values", async () => {
    const rootLoss = fakeTransport(response({ ...multilingualWordsResponse, loss: -0.1 }));
    await expect(adapter(rootLoss.transport).align(input())).resolves.toMatchObject({
      outcome: "malformed",
      reason: "malformed_response",
    });
    const wordLoss = fakeTransport(
      response({
        ...multilingualWordsResponse,
        words: multilingualWordsResponse.words.map((word, index) =>
          index === 0 ? { ...word, loss: -0.1 } : word,
        ),
      }),
    );
    await expect(adapter(wordLoss.transport).align(input())).resolves.toMatchObject({
      outcome: "malformed",
      reason: "malformed_response",
    });
  });

  test("rejects wrong content type and malformed JSON without retaining provider bytes", async () => {
    const wrongType = fakeTransport(
      rawResponse("secret provider body", 200, { "content-type": "text/plain" }),
    );
    const wrongTypeResult = await adapter(wrongType.transport).align(input());
    expect(wrongTypeResult).toMatchObject({ outcome: "malformed", reason: "malformed_response" });
    expect(JSON.stringify(wrongTypeResult)).not.toContain("secret provider body");

    const malformed = fakeTransport(
      rawResponse("not-json", 200, { "content-type": "application/json" }),
    );
    const malformedResult = await adapter(malformed.transport).align(input());
    expect(malformedResult).toMatchObject({ outcome: "malformed", reason: "malformed_response" });
  });

  test("classifies throttling/transient and permanent provider statuses", async () => {
    const throttled = fakeTransport(
      response({ error: "slow down" }, 429, { "retry-after": "2.5" }),
    );
    await expect(adapter(throttled.transport).align(input())).resolves.toMatchObject({
      outcome: "retryable",
      reason: "rate_limited",
      provider_status: 429,
      retry_after_seconds: 2.5,
    });
    const transient = fakeTransport(response({ error: "unavailable" }, 503));
    await expect(adapter(transient.transport).align(input())).resolves.toMatchObject({
      outcome: "retryable",
      reason: "provider_unavailable",
    });
    const rejected = fakeTransport(response({ error: "bad key" }, 401));
    await expect(adapter(rejected.transport).align(input())).resolves.toMatchObject({
      outcome: "permanent",
      reason: "provider_rejected",
      provider_status: 401,
    });
  });

  test("cancels an unused provider body on non-success status", async () => {
    let cancelled = false;
    const transport = fakeTransport({
      status: 503,
      headers: { "content-type": "application/json" },
      body: responseBody(new TextEncoder().encode("discard me"), undefined, () => {
        cancelled = true;
      }),
    });
    const result = await adapter(transport.transport).align(input());
    expect(result).toMatchObject({ outcome: "retryable", reason: "provider_unavailable" });
    expect(cancelled).toBe(true);
  });

  test("bounds input and response sizes", async () => {
    const oversizedAudio = input({
      audio: {
        audio_revision: 1,
        canonical_audio_sha256: sha,
        source: source(new Uint8Array(limits.max_audio_bytes + 1)),
        mime_type: "audio/mpeg",
      },
    });
    const noCall = fakeTransport(response(multilingualWordsResponse));
    await expect(adapter(noCall.transport).align(oversizedAudio)).resolves.toMatchObject({
      outcome: "permanent",
      reason: "invalid_request",
    });
    expect(noCall.requests).toHaveLength(0);

    const oversizedResponse = fakeTransport(
      rawResponse(new Uint8Array(limits.max_response_bytes + 1), 200, {
        "content-type": "application/json",
      }),
    );
    await expect(adapter(oversizedResponse.transport).align(input())).resolves.toMatchObject({
      outcome: "malformed",
      reason: "oversized_response",
    });
  });

  test("returns timeout and cancellation while aborting the injected transport", async () => {
    let timeoutSignal: AbortSignal | undefined;
    const timeoutTransport = fakeTransport(async (request) => {
      timeoutSignal = request.signal;
      return new Promise<ElevenLabsAlignmentTransportResponse>(() => undefined);
    });
    await expect(
      adapter(timeoutTransport.transport, { limits: { ...limits, timeout_ms: 5 } }).align(input()),
    ).resolves.toMatchObject({ outcome: "timeout", reason: "timeout" });
    expect(timeoutSignal?.aborted).toBe(true);

    const controller = new AbortController();
    let cancelSignal: AbortSignal | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const cancelTransport = fakeTransport(async (request) => {
      cancelSignal = request.signal;
      resolveStarted?.();
      return new Promise<ElevenLabsAlignmentTransportResponse>(() => undefined);
    });
    const pending = adapter(cancelTransport.transport).align(input({ signal: controller.signal }));
    await started;
    controller.abort();
    await expect(pending).resolves.toMatchObject({ outcome: "cancelled", reason: "cancelled" });
    expect(cancelSignal?.aborted).toBe(true);

    let timeoutLateBodyCancelled = false;
    let resolveTimeoutLateResponse:
      | ((response: ElevenLabsAlignmentTransportResponse) => void)
      | undefined;
    let resolveTimeoutLateStarted: (() => void) | undefined;
    const timeoutLateStarted = new Promise<void>((resolve) => {
      resolveTimeoutLateStarted = resolve;
    });
    const timeoutLateResponse = response(
      multilingualWordsResponse,
      200,
      {},
      () => (timeoutLateBodyCancelled = true),
    );
    const timeoutLateTransport = async () => {
      resolveTimeoutLateStarted?.();
      return new Promise<ElevenLabsAlignmentTransportResponse>((resolve) => {
        resolveTimeoutLateResponse = resolve;
      });
    };
    const timeoutLatePending = adapter(timeoutLateTransport, {
      limits: { ...limits, timeout_ms: 5 },
    }).align(input());
    await timeoutLateStarted;
    await expect(timeoutLatePending).resolves.toMatchObject({
      outcome: "timeout",
      reason: "timeout",
    });
    resolveTimeoutLateResponse?.(timeoutLateResponse);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(timeoutLateBodyCancelled).toBe(true);

    let cancellationLateBodyCancelled = false;
    let resolveCancellationLateResponse:
      | ((response: ElevenLabsAlignmentTransportResponse) => void)
      | undefined;
    let resolveCancellationLateStarted: (() => void) | undefined;
    const cancellationLateStarted = new Promise<void>((resolve) => {
      resolveCancellationLateStarted = resolve;
    });
    const cancellationLateResponse = response(
      multilingualWordsResponse,
      200,
      {},
      () => (cancellationLateBodyCancelled = true),
    );
    const cancellationLateTransport = async () => {
      resolveCancellationLateStarted?.();
      return new Promise<ElevenLabsAlignmentTransportResponse>((resolve) => {
        resolveCancellationLateResponse = resolve;
      });
    };
    const cancellationController = new AbortController();
    const cancellationLatePending = adapter(cancellationLateTransport).align(
      input({ signal: cancellationController.signal }),
    );
    await cancellationLateStarted;
    cancellationController.abort();
    await expect(cancellationLatePending).resolves.toMatchObject({
      outcome: "cancelled",
      reason: "cancelled",
    });
    resolveCancellationLateResponse?.(cancellationLateResponse);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(cancellationLateBodyCancelled).toBe(true);
  });

  test("timeout aborts a multipart source that has not produced its first chunk", async () => {
    let sourceAborted = false;
    const transport = fakeTransport(response(multilingualWordsResponse));
    const result = await adapter(transport.transport, {
      limits: { ...limits, timeout_ms: 5 },
    }).align(
      input({ audio: { ...input().audio, source: hangingSource(() => (sourceAborted = true)) } }),
    );
    expect(result).toMatchObject({ outcome: "timeout", reason: "timeout" });
    expect(sourceAborted).toBe(true);
  });

  test("timeout aborts a response body that hangs after headers", async () => {
    let cancelled = false;
    const transport = fakeTransport({
      status: 200,
      headers: { "content-type": "application/json" },
      body: hangingResponseBody(() => {
        cancelled = true;
      }),
    });
    const result = await adapter(transport.transport, {
      limits: { ...limits, timeout_ms: 5 },
    }).align(input());
    expect(result).toMatchObject({ outcome: "timeout", reason: "timeout" });
    expect(cancelled).toBe(true);
  });

  test("multipart encoding rejects a boundary collision rather than creating ambiguous bytes", async () => {
    const boundary = `pirate-elevenlabs-alignment-${"2a".repeat(18)}`;
    const body = encodeElevenLabsAlignmentMultipart({
      audio: {
        audio_revision: 1,
        canonical_audio_sha256: sha,
        source: source(new TextEncoder().encode(boundary)),
        mime_type: "audio/mpeg",
      },
      transcript: "safe",
      random_bytes: testRandomBytes,
    });
    expect(body).not.toBeNull();
    if (body === null) throw new Error("expected a replayable body");
    await expect(consumeBody(body)).rejects.toThrow("boundary_collision");
  });
});
