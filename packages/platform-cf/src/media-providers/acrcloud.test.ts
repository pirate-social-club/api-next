import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  ACRCLOUD_MAX_REQUEST_BYTES,
  ACRCLOUD_MAX_RESPONSE_BYTES,
  ACRCLOUD_MAX_SAMPLE_BYTES,
  type AcrCloudTransport,
  AcrCloudTransportFailure,
  buildAcrCloudSignature,
  encodeAcrCloudMultipart,
  makeAcrCloudAdapter,
} from "./acrcloud.ts";

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
    readonly request?: AcrCloudTransport["request"];
  }> = {},
) {
  return makeAcrCloudAdapter({
    host: "acrcloud.fixture",
    credentials: { accessKey: "fixture-access-key", accessSecret: "fixture-secret" },
    clock: { nowSeconds: () => 1_700_000_000 },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    transport: {
      request:
        options.request ??
        (() => Effect.succeed(response ?? jsonResponse({ status: { code: 1001 } }))),
    },
  });
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
    await Effect.runPromise(provider.identify(input));
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
    expect(first.contentType).toBe("multipart/form-data; boundary=----pirate-acrcloud-v1");
  });
});

describe("ACRCloud closed outcomes", () => {
  test("retains music evidence without making a rights claim", async () => {
    const result = await Effect.runPromise(
      adapter(
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
      ).identify(input),
    );
    expect(result).toEqual({
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
  });

  test("retains eligible custom matches and removes video-audio matches", async () => {
    const custom = await Effect.runPromise(
      adapter(
        jsonResponse({
          status: { code: 0 },
          metadata: { custom_files: [{ acr_id: "custom-1", name: "Catalog song" }] },
        }),
      ).identify(input),
    );
    expect(custom.outcome).toBe("retained_reference_match");
    expect(custom).toMatchObject({
      evidence: { matchKind: "custom", providerMatchId: "custom-1" },
    });

    const videoAudio = await Effect.runPromise(
      adapter(
        jsonResponse({
          status: { code: 0 },
          metadata: {
            custom_files: [
              { acr_id: "video-1", user_defined: { content_type: "video_audio" } },
              { acr_id: "video-2", content_type: "video_audio" },
            ],
          },
        }),
      ).identify(input),
    );
    expect(videoAudio).toEqual({ outcome: "no_match" });
  });

  test("handles no-match, empty, and inconclusive provider decisions", async () => {
    await expect(
      Effect.runPromise(adapter(jsonResponse({ status: { code: 1001 } })).identify(input)),
    ).resolves.toEqual({ outcome: "no_match" });
    await expect(
      Effect.runPromise(
        adapter(jsonResponse({ status: { code: 0 }, metadata: {} })).identify(input),
      ),
    ).resolves.toEqual({ outcome: "no_match" });
    await expect(
      Effect.runPromise(adapter(jsonResponse({ status: { code: 2004 } })).identify(input)),
    ).resolves.toEqual({ outcome: "inconclusive_fingerprint" });
  });

  test("rejects malformed, duplicate, wrong-content-type, and oversized responses", async () => {
    await expect(
      Effect.runPromise(
        adapter({
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode("{not-json"),
        }).identify(input),
      ),
    ).resolves.toEqual({ outcome: "malformed_or_unsupported_response", reason: "malformed_json" });
    await expect(
      Effect.runPromise(
        adapter(jsonResponse({ status: { code: 0 } }, 200, "text/plain")).identify(input),
      ),
    ).resolves.toEqual({
      outcome: "malformed_or_unsupported_response",
      reason: "wrong_content_type",
    });
    await expect(
      Effect.runPromise(
        adapter(
          jsonResponse({
            status: { code: 0 },
            metadata: { music: [{ acrid: "same" }, { acrid: "same" }] },
          }),
        ).identify(input),
      ),
    ).resolves.toEqual({
      outcome: "malformed_or_unsupported_response",
      reason: "duplicate_candidates",
    });
    await expect(
      Effect.runPromise(
        adapter({
          status: 200,
          headers: { "content-type": "application/json" },
          body: new Uint8Array(ACRCLOUD_MAX_RESPONSE_BYTES + 1),
        }).identify(input),
      ),
    ).resolves.toEqual({
      outcome: "malformed_or_unsupported_response",
      reason: "response_too_large",
    });
  });
});

describe("ACRCloud bounded transport failures", () => {
  test("classifies throttling and transient/permanent HTTP outcomes", async () => {
    await expect(
      Effect.runPromise(adapter(jsonResponse({ status: { code: 429 } }, 429)).identify(input)),
    ).resolves.toEqual({ outcome: "retryable_failure", reason: "throttled" });
    await expect(
      Effect.runPromise(adapter(jsonResponse({ status: { code: 500 } }, 503)).identify(input)),
    ).resolves.toEqual({ outcome: "retryable_failure", reason: "provider" });
    await expect(
      Effect.runPromise(adapter(jsonResponse({ status: { code: 400 } }, 400)).identify(input)),
    ).resolves.toEqual({ outcome: "permanent_provider_rejection", reason: "provider_rejected" });
    await expect(
      Effect.runPromise(adapter(jsonResponse({ status: { code: 413 } }, 413)).identify(input)),
    ).resolves.toEqual({ outcome: "permanent_provider_rejection", reason: "sample_too_large" });
  });

  test("normalizes injected transport errors without exposing their message", async () => {
    const result = await Effect.runPromise(
      adapter(null, {
        request: () => Effect.fail(new AcrCloudTransportFailure({ reason: "network" })),
      }).identify(input),
    );
    expect(result).toEqual({ outcome: "retryable_failure", reason: "transport" });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
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
    expect(timedOut).toEqual({ outcome: "retryable_failure", reason: "timeout" });
    expect(timedOutSignal?.aborted).toBe(true);

    const controller = new AbortController();
    controller.abort();
    await expect(
      Effect.runPromise(adapter(null).identify({ ...input, signal: controller.signal })),
    ).resolves.toEqual({ outcome: "retryable_failure", reason: "cancelled" });

    const inFlightController = new AbortController();
    const inFlight = Effect.runPromise(
      adapter(null, {
        request: () => Effect.never,
      }).identify({ ...input, signal: inFlightController.signal }),
    );
    setTimeout(() => inFlightController.abort(), 5);
    await expect(inFlight).resolves.toEqual({ outcome: "retryable_failure", reason: "cancelled" });
  });

  test("rejects a sample before transport and keeps request bytes bounded", async () => {
    let calls = 0;
    const bounded = makeAcrCloudAdapter({
      host: "acrcloud.fixture",
      credentials: { accessKey: "fixture-access-key", accessSecret: "fixture-secret" },
      clock: { nowSeconds: () => 1_700_000_000 },
      transport: {
        request: () => {
          calls += 1;
          return Effect.succeed(jsonResponse({ status: { code: 1001 } }));
        },
      },
    });
    const result = await Effect.runPromise(
      bounded.identify({
        ...input,
        sample: { ...input.sample, bytes: new Uint8Array(ACRCLOUD_MAX_SAMPLE_BYTES + 1) },
      }),
    );
    expect(result).toEqual({ outcome: "permanent_provider_rejection", reason: "sample_too_large" });
    expect(calls).toBe(0);
    expect(ACRCLOUD_MAX_REQUEST_BYTES).toBeGreaterThan(ACRCLOUD_MAX_SAMPLE_BYTES);
  });
});
