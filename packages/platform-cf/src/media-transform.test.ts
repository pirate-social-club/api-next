import { describe, expect, test } from "bun:test";
import type {
  MediaTransformAudioSampleInput,
  MediaTransformProbeInput,
} from "@pirate/application/media/transform";
import { MediaTransformRequestInvalid } from "@pirate/application/media/transform";
import { Effect } from "effect";
import {
  disabledTransloaditMediaTransform,
  makeTransloaditMediaTransform,
  signTransloaditParams,
  type TransloaditLimits,
  type TransloaditTransport,
  type TransloaditTransportRequest,
  type TransloaditTransportResponse,
} from "./media-transform.ts";

const fixtures = (await Bun.file(
  new URL("../../../tests/fixtures/media-transform/transloadit/statuses.json", import.meta.url),
).json()) as {
  readonly probe_cases: readonly Readonly<{
    readonly name: string;
    readonly file: Readonly<Record<string, unknown>>;
    readonly expected_container: string;
    readonly expected_codec: string;
    readonly expected_bitrate_mode: string;
  }>[];
  readonly hostile_metadata: Readonly<Record<string, unknown>>;
};

const jobId = "a".repeat(32);
const secondJobId = "b".repeat(32);
const templates = {
  probe: "1".repeat(32),
  samplePrimary: "2".repeat(32),
  sampleAlternate: "3".repeat(32),
};
const limits: TransloaditLimits = {
  maxRequestBytes: 16_384,
  maxResponseBytes: 16_384,
  maxSampleBytes: 1_000_000,
  requestTimeoutMs: 100,
  maxAssemblyRuntimeMs: 60_000,
};
const binding = {
  operationId: "operation-1",
  audioRevision: 3,
  analysisRevision: 2,
  canonicalAudioSha256: "c".repeat(64),
  requestId: "attempt-1",
};
const probeInput: MediaTransformProbeInput = {
  version: "media-transform-probe-input-v1",
  binding,
  source: { objectKey: "media/sealed/operation-1/audio-r3" },
};
const sampleInput: MediaTransformAudioSampleInput = {
  version: "media-transform-audio-sample-input-v1",
  binding,
  source: { objectKey: "media/sealed/operation-1/audio-r3" },
  sourceDurationMs: 60_000,
  variant: "primary",
};

function streamBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function hangingBody(): Readonly<{
  readonly body: ReadableStream<Uint8Array>;
  readonly cancelled: () => boolean;
}> {
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return { body, cancelled: () => wasCancelled };
}

function response(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = { "content-type": "application/json" },
): TransloaditTransportResponse {
  return {
    status,
    headers,
    body: streamBody(new TextEncoder().encode(JSON.stringify(value))),
  };
}

function completed(file: unknown, step: "probe" | "sample" = "probe", id = jobId): unknown {
  return {
    ok: "ASSEMBLY_COMPLETED",
    assembly_id: id,
    execution_duration: 1.25,
    warnings: [],
    results: { [step]: [file] },
  };
}

function executing(id = jobId): unknown {
  return { ok: "ASSEMBLY_EXECUTING", assembly_id: id, warnings: [] };
}

function adapter(
  request: TransloaditTransport["request"],
  overrides: Readonly<{ readonly limits?: TransloaditLimits; readonly clock?: () => number }> = {},
) {
  return makeTransloaditMediaTransform({
    enabled: true,
    adapterRevision: "transloadit-v1",
    credentials: {
      authKey: "fixture-auth-key-0000000000000000",
      authSecret: "fixture-auth-secret-never-project",
    },
    templates,
    limits: overrides.limits ?? limits,
    clock: overrides.clock ?? (() => 1_700_000_000_000),
    transport: { request },
  });
}

function paramsFrom(request: TransloaditTransportRequest): Readonly<Record<string, unknown>> {
  const text = new TextDecoder().decode(request.body ?? new Uint8Array());
  const marker = 'name="params"\r\n\r\n';
  const start = text.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const valueStart = start + marker.length;
  const end = text.indexOf("\r\n--", valueStart);
  expect(end).toBeGreaterThan(valueStart);
  return JSON.parse(text.slice(valueStart, end)) as Readonly<Record<string, unknown>>;
}

function fixtureAdapter(value: unknown) {
  return adapter(() => response(value));
}

describe("disabled Transloadit composition", () => {
  test("is inert by default for transform and deletion", async () => {
    expect(await Effect.runPromise(disabledTransloaditMediaTransform.probe(probeInput))).toEqual({
      status: "unavailable",
      reason: "disabled",
    });
    expect(
      await Effect.runPromise(disabledTransloaditMediaTransform.extractAudioSample(sampleInput)),
    ).toEqual({ status: "unavailable", reason: "disabled" });
    expect(
      await Effect.runPromise(
        disabledTransloaditMediaTransform.deleteJob({
          version: "media-transform-delete-input-v1",
          requestId: "attempt-1",
          providerJobId: jobId,
        }),
      ),
    ).toEqual({ status: "unavailable", reason: "disabled" });
  });

  test("does not call an injected transport unless explicitly enabled", async () => {
    let calls = 0;
    const service = makeTransloaditMediaTransform({
      transport: {
        request: () => {
          calls += 1;
          return response(executing());
        },
      },
    });
    await Effect.runPromise(service.probe(probeInput));
    expect(calls).toBe(0);
  });
});

describe("fixed Transloadit submission", () => {
  test("uses only a fixed template, bounded server fields, HMAC, and no callback or steps", async () => {
    let captured: TransloaditTransportRequest | undefined;
    const service = adapter((request) => {
      captured = request;
      return response(executing());
    });
    const outcome = await Effect.runPromise(service.probe(probeInput));
    expect(outcome.status).toBe("submitted");
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("https://api2.transloadit.com/assemblies");
    expect(captured?.redirect).toBe("error");
    const params = paramsFrom(captured as TransloaditTransportRequest);
    expect(params.template_id).toBe(templates.probe);
    expect(params).not.toHaveProperty("steps");
    expect(params).not.toHaveProperty("notify_url");
    expect(JSON.stringify(params)).not.toContain("http://");
    expect(JSON.stringify(params)).not.toContain("https://");
    const body = new TextDecoder().decode(captured?.body ?? new Uint8Array());
    expect(body).toContain("sha384:");
    expect(body).not.toContain("fixture-auth-secret-never-project");
    expect(JSON.stringify(outcome)).not.toContain("fixture-auth");
  });

  test("derives a stable nonce so a lost create response can be safely retried", async () => {
    const bodies: Uint8Array[] = [];
    const service = adapter((request) => {
      bodies.push(request.body ?? new Uint8Array());
      return response(executing());
    });
    await Effect.runPromise(service.probe(probeInput));
    await Effect.runPromise(service.probe(probeInput));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    const first = paramsFrom({
      requestId: "fixture",
      method: "POST",
      url: "https://api2.transloadit.com/assemblies",
      headers: {},
      body: bodies[0] ?? new Uint8Array(),
      signal: new AbortController().signal,
      redirect: "error",
    });
    expect((first.auth as { nonce: string }).nonce).toHaveLength(64);
  });

  test("signs params with official SHA-384 HMAC format", async () => {
    const signature = await signTransloaditParams("0123456789abcdef", '{"fixture":true}');
    expect(signature).toMatch(/^sha384:[a-f0-9]{96}$/u);
  });

  test("rejects caller URLs and path traversal before transport", async () => {
    let calls = 0;
    const service = adapter(() => {
      calls += 1;
      return response(executing());
    });
    for (const objectKey of [
      "https://hostile.invalid/audio.mp3",
      "media/../secret",
      "/root/audio",
    ]) {
      const effect = service.probe({ ...probeInput, source: { objectKey } });
      await expect(Effect.runPromise(effect)).rejects.toBeInstanceOf(MediaTransformRequestInvalid);
    }
    expect(calls).toBe(0);
  });
});

describe("probe", () => {
  for (const fixture of fixtures.probe_cases) {
    test(`accepts ${fixture.name}`, async () => {
      const result = await Effect.runPromise(
        fixtureAdapter(completed(fixture.file)).probe(probeInput),
      );
      expect(result.status).toBe("completed");
      if (result.status !== "completed") return;
      expect(String(result.probe.container)).toBe(fixture.expected_container);
      expect(String(result.probe.tracks[0]?.codec)).toBe(fixture.expected_codec);
      expect(String(result.probe.tracks[0]?.bitrateMode)).toBe(fixture.expected_bitrate_mode);
      expect(Object.isFrozen(result.probe)).toBe(true);
      expect(Object.isFrozen(result.probe.tracks)).toBe(true);
      expect(result.context).toMatchObject({
        operationId: "operation-1",
        audioRevision: 3,
        analysisRevision: 2,
        canonicalAudioSha256: "c".repeat(64),
        adapterRevision: "transloadit-v1",
      });
    });
  }

  test("distinguishes the exact duration boundary from an over-limit rejection", async () => {
    const exact = fixtures.probe_cases.find((fixture) => fixture.name === "exact_sixty_minutes");
    expect(exact).toBeDefined();
    const accepted = await Effect.runPromise(
      fixtureAdapter(completed(exact?.file)).probe(probeInput),
    );
    expect(accepted.status).toBe("completed");
    const over = {
      ...(exact?.file ?? {}),
      meta: { ...((exact?.file.meta as Record<string, unknown>) ?? {}), duration: 3600.001 },
    };
    const rejected = await Effect.runPromise(fixtureAdapter(completed(over)).probe(probeInput));
    expect(rejected).toMatchObject({ status: "rejected", reason: "duration_exceeded" });
  });

  test("does not project hostile tags or metadata", async () => {
    const result = await Effect.runPromise(
      fixtureAdapter(completed(fixtures.hostile_metadata)).probe(probeInput),
    );
    expect(result.status).toBe("completed");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("TRANSLOADIT_AUTH_SECRET");
    expect(serialized).not.toContain("script");
  });

  test("ignores an oversized embedded tag while retaining bounded probe facts", async () => {
    const base = fixtures.probe_cases[0]?.file ?? {};
    const withOversizedTag = {
      ...base,
      meta: { ...(base.meta as Record<string, unknown>), artist: "x".repeat(8_192) },
    };
    const result = await Effect.runPromise(
      fixtureAdapter(completed(withOversizedTag)).probe(probeInput),
    );
    expect(result.status).toBe("completed");
    expect(JSON.stringify(result)).not.toContain("x".repeat(512));
  });

  test("rejects unsupported codecs and corrupt headers without inventing facts", async () => {
    const base = fixtures.probe_cases[0]?.file ?? {};
    const unsupported = {
      ...base,
      meta: { ...(base.meta as Record<string, unknown>), audio_codec: "wmav2" },
    };
    const unsupportedResult = await Effect.runPromise(
      fixtureAdapter(completed(unsupported)).probe(probeInput),
    );
    expect(unsupportedResult).toMatchObject({ status: "rejected", reason: "unsupported_codec" });
    const corrupt = { ext: "mp3", mime: "audio/mpeg", size: 10, meta: {} };
    const corruptResult = await Effect.runPromise(
      fixtureAdapter(completed(corrupt)).probe(probeInput),
    );
    expect(corruptResult).toMatchObject({
      status: "malformed_response",
      reason: "unsupported_shape",
    });
  });

  test("resumes by polling the retained assembly id and never resubmits", async () => {
    const requests: TransloaditTransportRequest[] = [];
    const service = adapter((request) => {
      requests.push(request);
      return response(completed(fixtures.probe_cases[0]?.file, "probe", jobId));
    });
    const result = await Effect.runPromise(
      service.probe({ ...probeInput, resume: { providerJobId: jobId } }),
    );
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(`https://api2.transloadit.com/assemblies/${jobId}`);
    expect(requests[0]?.body).toBeUndefined();
  });

  test("reports a provider assembly id mismatch as malformed evidence", async () => {
    const result = await Effect.runPromise(
      adapter(() => response(completed(fixtures.probe_cases[0]?.file, "probe", secondJobId))).probe(
        {
          ...probeInput,
          resume: { providerJobId: jobId },
        },
      ),
    );
    expect(result).toMatchObject({ status: "malformed_response", reason: "unsupported_shape" });
  });
});

describe("normalized ACR sample extraction", () => {
  function sampleFile(durationSeconds: number, size = 250_000): unknown {
    return {
      ext: "wav",
      mime: "audio/wav",
      size,
      meta: {
        duration: durationSeconds,
        audio_codec: "pcm_s16le",
        audio_channels: 1,
        audio_samplerate: 44100,
      },
    };
  }

  test("selects fixed primary and alternate templates with deterministic windows", async () => {
    const requests: TransloaditTransportRequest[] = [];
    const service = adapter((request) => {
      requests.push(request);
      return response(executing(requests.length === 1 ? jobId : secondJobId));
    });
    await Effect.runPromise(service.extractAudioSample(sampleInput));
    await Effect.runPromise(service.extractAudioSample({ ...sampleInput, variant: "alternate" }));
    const primary = paramsFrom(requests[0] as TransloaditTransportRequest);
    const alternate = paramsFrom(requests[1] as TransloaditTransportRequest);
    expect(primary.template_id).toBe(templates.samplePrimary);
    expect(alternate.template_id).toBe(templates.sampleAlternate);
    expect(primary.fields).toMatchObject({
      sample_variant: "primary",
      sample_offset_seconds: 12,
      sample_duration_seconds: 12,
      output_object_key: "media-transform/operation-1/audio-r3/analysis-r2/attempt-1/primary.wav",
    });
    expect(alternate.fields).toMatchObject({
      sample_variant: "alternate",
      sample_offset_seconds: 36,
      sample_duration_seconds: 12,
      output_object_key: "media-transform/operation-1/audio-r3/analysis-r2/attempt-1/alternate.wav",
    });
  });

  test("accepts a normalized bounded sample and binds its server-derived object key", async () => {
    const result = await Effect.runPromise(
      fixtureAdapter(completed(sampleFile(12), "sample")).extractAudioSample(sampleInput),
    );
    expect(result).toMatchObject({
      status: "completed",
      providerJobId: jobId,
      artifact: {
        contentType: "audio/wav",
        byteLength: 250_000,
        offsetMs: 12_000,
        durationMs: 12_000,
        variant: "primary",
      },
    });
    if (result.status === "completed") {
      expect(result.artifact.objectKey).toBe(
        "media-transform/operation-1/audio-r3/analysis-r2/attempt-1/primary.wav",
      );
    }
  });

  test("uses the whole input for sub-ten-second audio", async () => {
    const shortInput = { ...sampleInput, sourceDurationMs: 8_250 } as const;
    let request: TransloaditTransportRequest | undefined;
    const service = adapter((value) => {
      request = value;
      return response(completed(sampleFile(8.25), "sample"));
    });
    const result = await Effect.runPromise(service.extractAudioSample(shortInput));
    expect(result).toMatchObject({
      status: "completed",
      artifact: { offsetMs: 0, durationMs: 8_250 },
    });
    expect(paramsFrom(request as TransloaditTransportRequest).fields).toMatchObject({
      sample_offset_seconds: 0,
      sample_duration_seconds: 8.25,
    });
  });

  test("rejects oversized or non-normalized provider output", async () => {
    const oversized = await Effect.runPromise(
      fixtureAdapter(
        completed(sampleFile(12, limits.maxSampleBytes + 1), "sample"),
      ).extractAudioSample(sampleInput),
    );
    expect(oversized).toMatchObject({ status: "rejected", reason: "output_too_large" });
    const wrongCodec = {
      ...(sampleFile(12) as Record<string, unknown>),
      meta: { ...((sampleFile(12) as Record<string, unknown>).meta as object), audio_codec: "mp3" },
    };
    const wrong = await Effect.runPromise(
      fixtureAdapter(completed(wrongCodec, "sample")).extractAudioSample(sampleInput),
    );
    expect(wrong).toMatchObject({ status: "rejected", reason: "unsupported_codec" });
  });
});

describe("bounds, cancellation, and deletion", () => {
  test("classifies wrong content type, malformed JSON, and oversized bodies", async () => {
    const wrongType = adapter(() => response({}, 200, { "content-type": "text/html" }));
    expect(await Effect.runPromise(wrongType.probe(probeInput))).toMatchObject({
      status: "malformed_response",
      reason: "wrong_content_type",
    });
    const malformed = adapter(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: streamBody(new TextEncoder().encode("{")),
    }));
    expect(await Effect.runPromise(malformed.probe(probeInput))).toMatchObject({
      status: "malformed_response",
      reason: "malformed_json",
    });
    const tinyLimits = { ...limits, maxResponseBytes: 64 };
    const oversized = adapter(
      () =>
        response({
          ok: "ASSEMBLY_EXECUTING",
          assembly_id: jobId,
          padding: "x".repeat(200),
        }),
      {
        limits: tinyLimits,
      },
    );
    expect(await Effect.runPromise(oversized.probe(probeInput))).toMatchObject({
      status: "malformed_response",
      reason: "response_too_large",
    });
  });

  test("times out a hung response body and cancels it", async () => {
    const hanging = hangingBody();
    const service = adapter(
      () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: hanging.body,
      }),
      { limits: { ...limits, requestTimeoutMs: 10 } },
    );
    const result = await Effect.runPromise(service.probe(probeInput));
    expect(result).toMatchObject({ status: "retryable_failure", reason: "timeout" });
    for (let index = 0; index < 20 && !hanging.cancelled(); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(hanging.cancelled()).toBe(true);
  });

  test("honors caller cancellation even when transport never settles", async () => {
    const controller = new AbortController();
    const service = adapter(() => new Promise<TransloaditTransportResponse>(() => undefined));
    const promise = Effect.runPromise(service.probe({ ...probeInput, signal: controller.signal }));
    controller.abort();
    expect(await promise).toMatchObject({ status: "retryable_failure", reason: "cancelled" });
  });

  test("surfaces Retry-After and redacts provider prose", async () => {
    const service = adapter(() =>
      response({ error: "secret provider prose" }, 429, {
        "content-type": "application/json",
        "retry-after": "7",
      }),
    );
    const result = await Effect.runPromise(service.probe(probeInput));
    expect(result).toMatchObject({
      status: "retryable_failure",
      reason: "throttled",
      retryAfterMs: 7_000,
    });
    expect(JSON.stringify(result)).not.toContain("provider prose");
  });

  test("deletes only the fixed assembly endpoint and handles replay-safe not-found", async () => {
    const requests: TransloaditTransportRequest[] = [];
    const statuses = [200, 404];
    const service = adapter((request) => {
      requests.push(request);
      return response({ ok: "ASSEMBLY_COMPLETED", assembly_id: jobId }, statuses.shift());
    });
    const input = {
      version: "media-transform-delete-input-v1" as const,
      requestId: "cleanup-1",
      providerJobId: jobId,
    };
    expect(await Effect.runPromise(service.deleteJob(input))).toEqual({
      status: "deleted",
      providerJobId: jobId,
    });
    expect(await Effect.runPromise(service.deleteJob(input))).toEqual({
      status: "rejected",
      reason: "job_not_found",
      providerJobId: jobId,
    });
    expect(requests.every((request) => request.method === "DELETE")).toBe(true);
    expect(
      requests.every(
        (request) => request.url === `https://api2.transloadit.com/assemblies/${jobId}`,
      ),
    ).toBe(true);
  });

  test("fails closed on invalid configuration without calling transport", async () => {
    let calls = 0;
    const service = makeTransloaditMediaTransform({
      enabled: true,
      adapterRevision: "transloadit-v1",
      credentials: { authKey: "short", authSecret: "short" },
      templates,
      limits,
      clock: () => 0,
      transport: {
        request: () => {
          calls += 1;
          return response(executing());
        },
      },
    });
    await expect(Effect.runPromise(service.probe(probeInput))).rejects.toBeInstanceOf(
      MediaTransformRequestInvalid,
    );
    expect(calls).toBe(0);
  });
});
