import { describe, expect, test } from "bun:test";
import {
  characterResponse,
  explicitNoSpeechResponse,
  malformedResponse,
  multilingualWordsResponse,
  noSpeechResponse,
  overlappingTimingResponse,
  repeatedWordResponse,
} from "../../../../tests/fixtures/media-alignment/elevenlabs/responses.ts";
import {
  ElevenLabsAlignmentAdapter,
  type ElevenLabsAlignmentInput,
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

function input(overrides: Partial<ElevenLabsAlignmentInput> = {}): ElevenLabsAlignmentInput {
  return {
    request_id: "alignment-request-1",
    operation_id: "operation-1",
    post_id: "post-1",
    audio: {
      audio_revision: 1,
      canonical_audio_sha256: sha,
      bytes: new Uint8Array([1, 2, 3, 4]),
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
): ElevenLabsAlignmentTransportResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

function fakeTransport(
  next:
    | ElevenLabsAlignmentTransportResponse
    | ((
        request: ElevenLabsAlignmentTransportRequest,
      ) => Promise<ElevenLabsAlignmentTransportResponse>),
) {
  const requests: ElevenLabsAlignmentTransportRequest[] = [];
  const transport = async (request: ElevenLabsAlignmentTransportRequest) => {
    requests.push(request);
    return typeof next === "function" ? next(request) : next;
  };
  return { requests, transport };
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
      body: "provider detail must not cross the adapter boundary",
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
        fakeTransport(response({ words: [{ text: "different", start: 0, end: 1, type: "word" }] }))
          .transport,
      ).align(input()),
      await adapter(
        fakeTransport({ status: 503, headers: {}, body: providerBody }).transport,
      ).align(input()),
      await adapter(
        fakeTransport({ status: 401, headers: {}, body: providerBody }).transport,
      ).align(input()),
      await adapter(
        fakeTransport({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: providerBody,
        }).transport,
      ).align(input()),
      await new ElevenLabsAlignmentAdapter({
        enabled: true,
        api_key: "xi-secret-test-key",
        transport: fakeTransport({
          status: 200,
          headers: { "content-type": "application/json" },
          body: providerBody,
        }).transport,
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

  test("builds a deterministic bounded multipart request with the exact transcript", async () => {
    const first = fakeTransport(response(multilingualWordsResponse));
    const second = fakeTransport(response(multilingualWordsResponse));
    await adapter(first.transport).align(input());
    await adapter(second.transport).align(input());

    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(first.requests[0]?.body).toEqual(second.requests[0]?.body);
    expect(first.requests[0]?.method).toBe("POST");
    expect(first.requests[0]?.url).toBe("https://api.elevenlabs.io/v1/forced-alignment");
    expect(first.requests[0]?.headers["xi-api-key"]).toBe("xi-secret-test-key");
    expect(first.requests[0]?.headers["content-type"]).toContain("boundary=");
    const body = new TextDecoder().decode(first.requests[0]?.body);
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
    expect(result.timings.map((timing) => timing.token_index)).toEqual([0, 1, 2, 3]);
    expect(result.timings[2]).toMatchObject({ token_index: 2, start_ms: 500, end_ms: 900 });

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
    ).toEqual([0, 2]);
  });

  test("accepts character timing arrays, including non-Latin combining characters", async () => {
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
    expect(result).toMatchObject({ outcome: "ready", mode: "character" });
    if (result.outcome !== "ready") throw new Error("expected character alignment");
    expect(result.timings.map((timing) => timing.token_index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("maps empty provider timings and explicit no-speech to the closed no-speech outcome", async () => {
    for (const body of [noSpeechResponse, explicitNoSpeechResponse]) {
      const transport = fakeTransport(response(body));
      const result = await adapter(transport.transport).align(input());
      expect(result).toMatchObject({
        alignment: "unavailable",
        outcome: "no_speech",
        reason: "no_speech",
      });
    }
  });

  test("rejects mismatched transcript and invalid or overlapping timings", async () => {
    const mismatch = fakeTransport(
      response({ words: [{ text: "different", start: 0, end: 1, type: "word" }] }),
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

  test("rejects wrong content type and malformed JSON without retaining provider bytes", async () => {
    const wrongType = fakeTransport({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "secret provider body",
    });
    const wrongTypeResult = await adapter(wrongType.transport).align(input());
    expect(wrongTypeResult).toMatchObject({ outcome: "malformed", reason: "malformed_response" });
    expect(JSON.stringify(wrongTypeResult)).not.toContain("secret provider body");

    const malformed = fakeTransport({
      status: 200,
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
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

  test("bounds input and response sizes", async () => {
    const oversizedAudio = input({
      audio: {
        audio_revision: 1,
        canonical_audio_sha256: sha,
        bytes: new Uint8Array(limits.max_audio_bytes + 1),
        mime_type: "audio/mpeg",
      },
    });
    const noCall = fakeTransport(response(multilingualWordsResponse));
    await expect(adapter(noCall.transport).align(oversizedAudio)).resolves.toMatchObject({
      outcome: "permanent",
      reason: "invalid_request",
    });
    expect(noCall.requests).toHaveLength(0);

    const oversizedResponse = fakeTransport({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new Uint8Array(limits.max_response_bytes + 1),
    });
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
    const cancelTransport = fakeTransport(async (request) => {
      cancelSignal = request.signal;
      return new Promise<ElevenLabsAlignmentTransportResponse>(() => undefined);
    });
    const pending = adapter(cancelTransport.transport).align(input({ signal: controller.signal }));
    controller.abort();
    await expect(pending).resolves.toMatchObject({ outcome: "cancelled", reason: "cancelled" });
    expect(cancelSignal?.aborted).toBe(true);
  });

  test("multipart encoding rejects a boundary collision rather than creating ambiguous bytes", () => {
    const body = encodeElevenLabsAlignmentMultipart({
      audio: {
        audio_revision: 1,
        canonical_audio_sha256: sha,
        bytes: new TextEncoder().encode("pirate-elevenlabs-alignment-v1-fixed-boundary"),
        mime_type: "audio/mpeg",
      },
      transcript: "safe",
    });
    expect(body).toBeNull();
  });
});
