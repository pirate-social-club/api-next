import { describe, expect, test } from "bun:test";
import type { MediaProviderFailure } from "@pirate/application/media-provider-contracts";
import { Cause, Effect, Exit, Result } from "effect";
import {
  asrInput,
  multilingualResponse,
  musicOnlyResponse,
  partialResponse,
} from "../../../../tests/fixtures/media-analysis/elevenlabs-asr/fixtures.ts";
import {
  ELEVENLABS_ASR_HARD_MAX_AUDIO_BYTES,
  ELEVENLABS_ASR_HARD_MAX_PROVIDER_ENTRIES,
  type ElevenLabsAsrAttemptEvidence,
  type ElevenLabsAsrAudioSource,
  type ElevenLabsAsrRequestBody,
  type ElevenLabsAsrTransportRequest,
  type ElevenLabsAsrTransportResponse,
  makeElevenLabsAsrAdapter,
} from "./elevenlabs-asr.ts";

const encoder = new TextEncoder();

function audioSource(
  bytes: Uint8Array = encoder.encode("fixture-audio"),
  declaredLength = bytes.byteLength,
): ElevenLabsAsrAudioSource {
  return {
    byteLength: declaredLength,
    mime_type: "audio/mpeg",
    filename: "song.mp3",
    open: async function* () {
      yield bytes;
    },
  };
}

function response(
  document: unknown,
  overrides: Partial<ElevenLabsAsrTransportResponse> = {},
  chunkSize?: number,
): ElevenLabsAsrTransportResponse {
  const bytes = encoder.encode(JSON.stringify(document));
  return {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
    },
    body: {
      open: async function* () {
        const size = chunkSize ?? bytes.byteLength;
        for (let offset = 0; offset < bytes.byteLength; offset += size) {
          yield bytes.slice(offset, offset + size);
        }
      },
      cancel: () => undefined,
    },
    ...overrides,
  };
}

async function consumeBody(body: ElevenLabsAsrRequestBody): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body.open()) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function providerFailure(
  effect: Effect.Effect<unknown, MediaProviderFailure>,
): Promise<MediaProviderFailure> {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected provider failure");
  const found = Cause.findError(exit.cause);
  if (!Result.isSuccess(found)) throw new Error("expected one provider failure");
  return found.success as MediaProviderFailure;
}

function configured(
  transport: (
    request: ElevenLabsAsrTransportRequest,
  ) => ElevenLabsAsrTransportResponse | PromiseLike<ElevenLabsAsrTransportResponse>,
  overrides: Record<string, unknown> = {},
) {
  return makeElevenLabsAsrAdapter({
    enabled: true,
    api_key: "fixture-secret-key",
    model: "fixture-scribe-model",
    model_revision: "model-revision-2026-08-25",
    adapter_revision: "elevenlabs-asr-adapter-v1",
    enable_logging: false,
    limits: {
      max_audio_bytes: 1_024,
      max_response_bytes: 32_768,
      timeout_ms: 1_000,
    },
    resolve_audio: () => audioSource(),
    random_bytes: (length) => new Uint8Array(length).fill(7),
    evidence_sink: () => undefined,
    transport,
    ...overrides,
  });
}

describe("ElevenLabs ASR adapter", () => {
  test("is disabled by default and performs no I/O", async () => {
    const adapter = makeElevenLabsAsrAdapter();
    const failed = await providerFailure(
      adapter.recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(failed).toEqual({
      _tag: "permanent_rejection",
      retryability: "permanent",
      attempt_id: "attempt-asr-1",
    });
  });

  test("builds a deterministic mixed-language request without a language override", async () => {
    const requests: ElevenLabsAsrTransportRequest[] = [];
    const adapter = configured((request) => {
      requests.push(request);
      return response(multilingualResponse, {}, 17);
    });
    const result = await Effect.runPromise(
      adapter.recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(result.status).toBe("transcript");
    if (result.status !== "transcript") throw new Error("expected transcript");
    expect(result.transcript.transcript).toBe(multilingualResponse.text);
    expect(result.detected_languages).toEqual([{ language_bcp47: "en", confidence: 0.84 }]);
    expect(result.transcript.transcript_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.transcript.transcript_artifact_ref).toMatch(
      /^elevenlabs-asr:\/\/transcript\/[0-9a-f]{64}\/a{64}\/1\/2\/[0-9a-f]{64}$/u,
    );

    const request = requests[0];
    if (request === undefined) throw new Error("expected one transport request");
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text?enable_logging=false");
    expect(request?.headers["xi-api-key"]).toBe("fixture-secret-key");
    const first = await consumeBody(request?.body as ElevenLabsAsrRequestBody);
    const second = await consumeBody(request?.body as ElevenLabsAsrRequestBody);
    expect(first).toEqual(second);
    expect(first.byteLength).toBe(request.body.byteLength);
    const requestText = new TextDecoder().decode(first);
    expect(requestText).toContain('name="model_id"\r\n\r\nfixture-scribe-model');
    expect(requestText).toContain('name="tag_audio_events"\r\n\r\nfalse');
    expect(requestText).toContain('name="timestamps_granularity"\r\n\r\nword');
    expect(requestText).toContain('name="webhook"\r\n\r\nfalse');
    expect(requestText).not.toContain('name="language_code"');
  });

  test("binds transcript artifact references to full immutable lineage and segment identity", async () => {
    const adapter = configured(() => response(multilingualResponse));
    const first = await Effect.runPromise(
      adapter.recognize(asrInput, { signal: new AbortController().signal }),
    );
    const replay = await Effect.runPromise(
      adapter.recognize(asrInput, { signal: new AbortController().signal }),
    );
    if (first.status !== "transcript" || replay.status !== "transcript") {
      throw new Error("expected transcripts");
    }
    expect(replay.transcript.transcript_artifact_ref).toBe(
      first.transcript.transcript_artifact_ref,
    );

    const distinctOperationInput = {
      ...asrInput,
      audio: {
        ...asrInput.audio,
        operation_id: "operation-asr-2",
        audio_artifact_ref: "r2://private/audio/operation-asr-2/revision-1",
      },
      attempt: {
        ...asrInput.attempt,
        attempt_id: "attempt-asr-2",
        request_id: "request-asr-2",
      },
    };
    const distinctOperation = await Effect.runPromise(
      adapter.recognize(distinctOperationInput, { signal: new AbortController().signal }),
    );
    if (distinctOperation.status !== "transcript") throw new Error("expected transcript");
    expect(distinctOperation.transcript.transcript_sha256).toBe(first.transcript.transcript_sha256);
    expect(distinctOperation.transcript.transcript_artifact_ref).not.toBe(
      first.transcript.transcript_artifact_ref,
    );

    const distinctAudioInput = {
      ...asrInput,
      audio: {
        ...asrInput.audio,
        audio_revision: 2,
        canonical_audio_sha256: "b".repeat(64),
        audio_artifact_ref: "r2://private/audio/operation-asr-1/revision-2",
      },
      attempt: {
        ...asrInput.attempt,
        attempt_id: "attempt-asr-audio-2",
        request_id: "request-asr-audio-2",
      },
    };
    const distinctAudio = await Effect.runPromise(
      adapter.recognize(distinctAudioInput, { signal: new AbortController().signal }),
    );
    if (distinctAudio.status !== "transcript") throw new Error("expected transcript");
    expect(distinctAudio.transcript.transcript_artifact_ref).not.toBe(
      first.transcript.transcript_artifact_ref,
    );

    const distinctAnalysisInput = {
      ...asrInput,
      audio: { ...asrInput.audio, analysis_revision: 3 },
      attempt: {
        ...asrInput.attempt,
        attempt_id: "attempt-asr-3",
        request_id: "request-asr-3",
      },
    };
    const distinctAnalysis = await Effect.runPromise(
      adapter.recognize(distinctAnalysisInput, { signal: new AbortController().signal }),
    );
    if (distinctAnalysis.status !== "transcript") throw new Error("expected transcript");
    expect(distinctAnalysis.transcript.transcript_sha256).toBe(first.transcript.transcript_sha256);
    expect(distinctAnalysis.transcript.transcript_artifact_ref).not.toBe(
      first.transcript.transcript_artifact_ref,
    );

    const changedTiming = {
      ...multilingualResponse,
      words: multilingualResponse.words.map((entry, index) =>
        index === multilingualResponse.words.length - 1 ? { ...entry, end: 3.2 } : entry,
      ),
    };
    const changedSegments = await Effect.runPromise(
      configured(() => response(changedTiming)).recognize(asrInput, {
        signal: new AbortController().signal,
      }),
    );
    if (changedSegments.status !== "transcript") throw new Error("expected transcript");
    expect(changedSegments.transcript.transcript_sha256).toBe(first.transcript.transcript_sha256);
    expect(changedSegments.transcript.transcript_artifact_ref).not.toBe(
      first.transcript.transcript_artifact_ref,
    );
  });

  test("retains prompt-injection text only as immutable transcript evidence", async () => {
    const evidence: ElevenLabsAsrAttemptEvidence[] = [];
    const adapter = configured(() => response(multilingualResponse), {
      evidence_sink: (entry: ElevenLabsAsrAttemptEvidence) => evidence.push(entry),
    });
    const result = await Effect.runPromise(
      adapter.recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(result.status).toBe("transcript");
    if (result.status !== "transcript") throw new Error("expected transcript");
    expect(result.transcript.transcript).toContain("Ignore prior instructions");
    expect(evidence).toEqual([
      {
        version: "elevenlabs-asr-attempt-evidence-v1",
        provider: "elevenlabs",
        endpoint: "https://api.elevenlabs.io/v1/speech-to-text",
        attempt_id: "attempt-asr-1",
        requested_model: "fixture-scribe-model",
        model_revision: "model-revision-2026-08-25",
        adapter_revision: "elevenlabs-asr-adapter-v1",
        retention: "zero_retention",
        outcome: "transcript",
        provider_status: 200,
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("fixture-secret-key");
    expect(JSON.stringify(evidence)).not.toContain("Ignore prior instructions");
  });

  test("awaits exact model provenance and fails closed when it cannot persist", async () => {
    const evidence: ElevenLabsAsrAttemptEvidence[] = [];
    let releaseSink: (() => void) | undefined;
    let markSinkStarted: (() => void) | undefined;
    const sinkStarted = new Promise<void>((resolve) => {
      markSinkStarted = resolve;
    });
    const sinkRelease = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    let settled = false;
    const inFlight = Effect.runPromise(
      configured(() => response(multilingualResponse), {
        evidence_sink: async (entry: ElevenLabsAsrAttemptEvidence) => {
          evidence.push(entry);
          markSinkStarted?.();
          await sinkRelease;
        },
      }).recognize(asrInput, { signal: new AbortController().signal }),
    ).finally(() => {
      settled = true;
    });
    await sinkStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseSink?.();
    expect((await inFlight).status).toBe("transcript");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      adapter_revision: "elevenlabs-asr-adapter-v1",
      requested_model: "fixture-scribe-model",
      model_revision: "model-revision-2026-08-25",
    });

    const failed = await providerFailure(
      configured(() => response(multilingualResponse), {
        evidence_sink: async () => {
          throw new Error("fixture persistence failure");
        },
      }).recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(failed).toMatchObject({
      _tag: "provider_unavailable",
      retryability: "retryable",
      attempt_id: "attempt-asr-1",
    });
  });

  test("does not expose a permanent provider outcome when its evidence cannot persist", async () => {
    let evidenceWrites = 0;
    const failed = await providerFailure(
      configured(
        () => ({
          status: 422,
          headers: {},
          body: {
            open: async function* () {
              yield encoder.encode('{"detail":"provider rejection"}');
            },
            cancel: () => undefined,
          },
        }),
        {
          evidence_sink: async () => {
            evidenceWrites += 1;
            throw new Error("fixture persistence failure");
          },
        },
      ).recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(failed).toEqual({
      _tag: "provider_unavailable",
      retryability: "retryable",
      attempt_id: "attempt-asr-1",
    });
    expect(evidenceWrites).toBe(1);
  });

  test("keeps timeout and caller cancellation authoritative through blocked evidence writes", async () => {
    const timeoutSinkStarted = Promise.withResolvers<void>();
    const timeoutSinkRelease = Promise.withResolvers<void>();
    let timeoutSinkAborted = 0;
    const timedOut = providerFailure(
      configured(() => response(multilingualResponse), {
        limits: { max_audio_bytes: 1_024, max_response_bytes: 32_768, timeout_ms: 5 },
        evidence_sink: (_entry: ElevenLabsAsrAttemptEvidence, signal: AbortSignal) => {
          timeoutSinkStarted.resolve();
          signal.addEventListener("abort", () => (timeoutSinkAborted += 1), { once: true });
          return timeoutSinkRelease.promise;
        },
      }).recognize(asrInput, { signal: new AbortController().signal }),
    );
    await timeoutSinkStarted.promise;
    expect(await timedOut).toEqual({
      _tag: "timeout",
      retryability: "retryable",
      attempt_id: "attempt-asr-1",
    });
    expect(timeoutSinkAborted).toBe(1);
    timeoutSinkRelease.resolve();
    await timeoutSinkRelease.promise;

    const cancellationSinkStarted = Promise.withResolvers<void>();
    const cancellationSinkRelease = Promise.withResolvers<void>();
    let cancellationSinkAborted = 0;
    const controller = new AbortController();
    const cancelled = providerFailure(
      configured(() => response(multilingualResponse), {
        evidence_sink: (_entry: ElevenLabsAsrAttemptEvidence, signal: AbortSignal) => {
          cancellationSinkStarted.resolve();
          signal.addEventListener("abort", () => (cancellationSinkAborted += 1), { once: true });
          return cancellationSinkRelease.promise;
        },
      }).recognize(asrInput, { signal: controller.signal }),
    );
    await cancellationSinkStarted.promise;
    controller.abort();
    expect(await cancelled).toEqual({
      _tag: "cancelled",
      retryability: "cancelled",
      attempt_id: "attempt-asr-1",
    });
    expect(cancellationSinkAborted).toBe(1);
    cancellationSinkRelease.resolve();
    await cancellationSinkRelease.promise;
  });

  test("projects music-only output as explicit no-speech evidence", async () => {
    const result = await Effect.runPromise(
      configured(() => response(musicOnlyResponse)).recognize(asrInput, {
        signal: new AbortController().signal,
      }),
    );
    expect(result).toMatchObject({
      status: "no_speech",
      transcript: null,
      detected_languages: [],
      adapter_revision: "elevenlabs-asr-adapter-v1",
    });
    if (result.status !== "no_speech") throw new Error("expected no speech");
    expect(result.evidence_ref).toContain(asrInput.audio.canonical_audio_sha256);
  });

  test("rejects contradictory or absent no-speech evidence as malformed", async () => {
    for (const document of [
      {
        language_code: "en",
        language_probability: 0.99,
        text: "explicit hostile lyrics",
        words: [{ text: "explicit hostile lyrics", start: 0, end: 2, type: "spacing" }],
      },
      {
        language_code: "en",
        language_probability: 0,
        text: "(music) hidden words",
        words: [{ text: "(music)", start: 0, end: 2, type: "audio_event" }],
      },
      {
        language_code: "en",
        language_probability: 0,
        text: "",
        words: [],
      },
      {
        language_code: "en",
        language_probability: 0,
        text: "(music)",
        words: [{ text: "(music)", start: 2, end: 1, type: "audio_event" }],
      },
    ]) {
      expect(
        await providerFailure(
          configured(() => response(document)).recognize(asrInput, {
            signal: new AbortController().signal,
          }),
        ),
      ).toEqual({
        _tag: "malformed_response",
        retryability: "permanent",
        attempt_id: "attempt-asr-1",
      });
    }
  });

  test("creates bounded ordered segments and rejects invalid timing", async () => {
    const first = "a".repeat(3_000);
    const second = "б".repeat(3_000);
    const longResponse = {
      language_code: "ru",
      language_probability: 0.99,
      text: `${first} ${second}`,
      words: [
        { text: first, start: 0, end: 2, type: "word" },
        { text: " ", start: 1.9, end: 2.1, type: "spacing" },
        { text: second, start: 2.1, end: 4.5, type: "word" },
      ],
    };
    const result = await Effect.runPromise(
      configured(() => response(longResponse, {}, 31)).recognize(asrInput, {
        signal: new AbortController().signal,
      }),
    );
    expect(result.status).toBe("transcript");
    if (result.status !== "transcript") throw new Error("expected transcript");
    expect(result.transcript.segments).toHaveLength(2);
    expect(result.transcript.segments[0]?.end_ms).toBeLessThanOrEqual(
      result.transcript.segments[1]?.start_ms as number,
    );
    expect(result.transcript.segments.every(({ text }) => text.length <= 4_096)).toBe(true);

    const overlapping = {
      language_code: "en",
      language_probability: 1,
      text: "one two",
      words: [
        { text: "one", start: 0, end: 1, type: "word" },
        { text: " ", start: 0.9, end: 1.1, type: "spacing" },
        { text: "two", start: 0.8, end: 1.2, type: "word" },
      ],
    };
    expect(
      (
        await providerFailure(
          configured(() => response(overlapping)).recognize(asrInput, {
            signal: new AbortController().signal,
          }),
        )
      )._tag,
    ).toBe("malformed_response");
  });

  test("bounds provider entries separately from aggregated transcript segments", async () => {
    const entries = Array.from({ length: 5_001 }, (_, index) => {
      const start = index * 0.002;
      return [
        { text: "a", start, end: start + 0.001, type: "word" },
        { text: " ", start: start + 0.001, end: start + 0.002, type: "spacing" },
      ];
    }).flat();
    const accepted = await Effect.runPromise(
      configured(
        () =>
          response({
            language_code: "en",
            language_probability: 1,
            text: entries.map(({ text }) => text).join(""),
            words: entries,
          }),
        {
          limits: {
            max_audio_bytes: 1_024,
            max_response_bytes: 2 * 1_024 * 1_024,
            timeout_ms: 5_000,
          },
        },
      ).recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(accepted.status).toBe("transcript");
    if (accepted.status !== "transcript") throw new Error("expected transcript");
    expect(entries.length).toBeGreaterThan(10_000);
    expect(accepted.transcript.segments.length).toBeLessThan(10);

    const hostileEntries = Array.from(
      { length: ELEVENLABS_ASR_HARD_MAX_PROVIDER_ENTRIES + 1 },
      () => ({ text: "x", start: 0, end: 1, type: "word" }),
    );
    const rejected = await providerFailure(
      configured(
        () =>
          response({
            language_code: "en",
            language_probability: 1,
            text: "x",
            words: hostileEntries,
          }),
        {
          limits: {
            max_audio_bytes: 1_024,
            max_response_bytes: 4 * 1_024 * 1_024,
            timeout_ms: 5_000,
          },
        },
      ).recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(rejected._tag).toBe("malformed_response");
  });

  test("rejects multipart filename controls before transport", async () => {
    for (const filename of ["song\r\ninjected.mp3", "song\0.mp3", "song\u0085.mp3"]) {
      let calls = 0;
      const failed = await providerFailure(
        configured(
          () => {
            calls += 1;
            return response(multilingualResponse);
          },
          { resolve_audio: () => ({ ...audioSource(), filename }) },
        ).recognize(asrInput, { signal: new AbortController().signal }),
      );
      expect(failed._tag).toBe("permanent_rejection");
      expect(calls).toBe(0);
    }
  });

  test("uses only contract-valid fallback attempt identifiers", async () => {
    for (const attempt_id of ["attempt\nid", "🙂".repeat(256)]) {
      const failed = await providerFailure(
        makeElevenLabsAsrAdapter().recognize(
          { ...asrInput, attempt: { ...asrInput.attempt, attempt_id } },
          { signal: new AbortController().signal },
        ),
      );
      expect(failed.attempt_id).toBe("invalid-attempt");
      expect(encoder.encode(failed.attempt_id).byteLength).toBeLessThanOrEqual(256);
    }
  });

  test("separates partial output from malformed provider envelopes", async () => {
    expect(
      (
        await providerFailure(
          configured(() => response(partialResponse)).recognize(asrInput, {
            signal: new AbortController().signal,
          }),
        )
      )._tag,
    ).toBe("unparseable_result");
    expect(
      (
        await providerFailure(
          configured(() => response({ ...multilingualResponse, unexpected: "field" })).recognize(
            asrInput,
            { signal: new AbortController().signal },
          ),
        )
      )._tag,
    ).toBe("malformed_response");
    expect(
      (
        await providerFailure(
          configured(() => {
            const bytes = encoder.encode("not-json");
            return response(
              {},
              {
                headers: { "content-type": "application/json" },
                body: {
                  open: async function* () {
                    yield bytes;
                  },
                  cancel: () => undefined,
                },
              },
            );
          }).recognize(asrInput, { signal: new AbortController().signal }),
        )
      )._tag,
    ).toBe("malformed_response");
  });

  test("rejects oversized audio before transport", async () => {
    let calls = 0;
    const failed = await providerFailure(
      configured(
        () => {
          calls += 1;
          return response(multilingualResponse);
        },
        {
          limits: {
            max_audio_bytes: ELEVENLABS_ASR_HARD_MAX_AUDIO_BYTES,
            max_response_bytes: 32_768,
            timeout_ms: 1_000,
          },
          resolve_audio: () => ({
            ...audioSource(),
            byteLength: ELEVENLABS_ASR_HARD_MAX_AUDIO_BYTES + 1,
          }),
        },
      ).recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(failed._tag).toBe("permanent_rejection");
    expect(calls).toBe(0);
  });

  test("bounds declared and streamed response bodies", async () => {
    let cancelled = 0;
    const declared = await providerFailure(
      configured(
        () =>
          response(multilingualResponse, {
            headers: { "content-type": "application/json", "content-length": "999" },
            body: {
              open: async function* () {
                yield encoder.encode("unused");
              },
              cancel: () => {
                cancelled += 1;
              },
            },
          }),
        {
          limits: { max_audio_bytes: 1_024, max_response_bytes: 64, timeout_ms: 1_000 },
        },
      ).recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(declared._tag).toBe("malformed_response");
    expect(cancelled).toBe(1);

    const streamed = await providerFailure(
      configured(
        () => ({
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            open: async function* () {
              yield new Uint8Array(40);
              yield new Uint8Array(40);
            },
            cancel: () => {
              cancelled += 1;
            },
          },
        }),
        {
          limits: { max_audio_bytes: 1_024, max_response_bytes: 64, timeout_ms: 1_000 },
        },
      ).recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(streamed._tag).toBe("malformed_response");
    expect(cancelled).toBe(2);
  });

  test("maps timeout and caller cancellation without accepting late success", async () => {
    const timeout = await providerFailure(
      configured(() => new Promise<ElevenLabsAsrTransportResponse>(() => undefined), {
        limits: { max_audio_bytes: 1_024, max_response_bytes: 32_768, timeout_ms: 5 },
      }).recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(timeout._tag).toBe("timeout");
    expect(timeout.retryability).toBe("retryable");

    const controller = new AbortController();
    controller.abort();
    const cancelled = await providerFailure(
      configured(() => response(multilingualResponse)).recognize(asrInput, {
        signal: controller.signal,
      }),
    );
    expect(cancelled._tag).toBe("cancelled");
    expect(cancelled.retryability).toBe("cancelled");

    let bodyCancelled = 0;
    let markBodyStarted: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    const bodyController = new AbortController();
    const inFlight = providerFailure(
      configured(() => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          open: async function* () {
            markBodyStarted?.();
            await new Promise<never>(() => undefined);
          },
          cancel: () => {
            bodyCancelled += 1;
          },
        },
      })).recognize(asrInput, { signal: bodyController.signal }),
    );
    await bodyStarted;
    bodyController.abort();
    expect((await inFlight)._tag).toBe("cancelled");
    expect(bodyCancelled).toBe(1);
  });

  test("maps throttling, transient status, and permanent rejection without reading bodies", async () => {
    const statusResponse = (status: number, headers: Record<string, string> = {}) => {
      let reads = 0;
      let cancels = 0;
      return {
        counts: () => ({ reads, cancels }),
        value: {
          status,
          headers,
          body: {
            open: async function* () {
              reads += 1;
              yield encoder.encode('{"detail":"secret provider prose"}');
            },
            cancel: () => {
              cancels += 1;
            },
          },
        } satisfies ElevenLabsAsrTransportResponse,
      };
    };
    const throttledResponse = statusResponse(429, { "retry-after": "2.5" });
    const throttled = await providerFailure(
      configured(() => throttledResponse.value).recognize(asrInput, {
        signal: new AbortController().signal,
      }),
    );
    expect(throttled).toMatchObject({
      _tag: "rate_limited",
      retryability: "retryable",
      retry_after_ms: 2_500,
    });
    expect(throttledResponse.counts()).toEqual({ reads: 0, cancels: 1 });

    for (const [status, expected] of [
      [503, "provider_unavailable"],
      [422, "permanent_rejection"],
    ] as const) {
      const provider = statusResponse(status);
      const failed = await providerFailure(
        configured(() => provider.value).recognize(asrInput, {
          signal: new AbortController().signal,
        }),
      );
      expect(failed._tag).toBe(expected);
      expect(JSON.stringify(failed)).not.toContain("secret provider prose");
      expect(provider.counts()).toEqual({ reads: 0, cancels: 1 });
    }
  });

  test("treats truncated audio streams and invalid configuration as permanent", async () => {
    const truncated = await providerFailure(
      configured(
        async (request) => {
          await consumeBody(request.body);
          return response(multilingualResponse);
        },
        {
          resolve_audio: () => audioSource(encoder.encode("short"), 50),
        },
      ).recognize(asrInput, { signal: new AbortController().signal }),
    );
    expect(truncated._tag).toBe("permanent_rejection");

    const invalid = await providerFailure(
      configured(() => response(multilingualResponse), { model_revision: " bad " }).recognize(
        asrInput,
        { signal: new AbortController().signal },
      ),
    );
    expect(invalid._tag).toBe("permanent_rejection");
  });
});
