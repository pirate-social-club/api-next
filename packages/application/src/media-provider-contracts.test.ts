import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import {
  type MediaAsrAdapter,
  MediaAsrInput,
  MediaAsrResult,
  MediaBcp47LanguageTag,
  type MediaExplicitnessClassifierAdapter,
  MediaExplicitnessClassifierInput,
  MediaExplicitnessClassifierResult,
  MediaProviderFailure,
  MEDIA_TRANSCRIPT_MAX_LENGTH,
  decodeMediaAsrInput,
  decodeMediaAsrResult,
  decodeMediaExplicitnessClassifierInput,
  decodeMediaExplicitnessClassifierResult,
  isMediaAsrResultBoundToInput,
  isMediaClassifierResultBoundToTranscript,
  isRetryableMediaProviderFailure,
} from "./media-provider-contracts.ts";
import {
  asrInput,
  asrNoSpeechResult,
  asrTranscriptResult,
  attempt,
  audio,
  classifierFailureResults,
  classifierInput,
  classifierResult,
  hostileAuthorityFields,
  hostileTranscript,
  malformedBcp47Tags,
} from "../../../tests/fixtures/media-analysis/contracts/fixtures.ts";

const strictDecode = <A>(schema: Schema.Schema<A>, input: unknown): A =>
  Schema.decodeUnknownSync(
    schema as unknown as Schema.ConstraintDecoder<unknown>,
    { onExcessProperty: "error" },
  )(input) as A;

describe("provider-neutral media analysis contracts", () => {
  test("binds ASR to an immutable audio revision and bounded attempt", () => {
    expect(decodeMediaAsrInput(asrInput)).toMatchObject({
      version: "media-asr-input-v1",
      audio: { audio_revision: 1, analysis_revision: 2 },
      attempt: { attempt_number: 1, timeout_ms: 30_000 },
    });

    expect(() =>
      decodeMediaAsrInput({
        ...asrInput,
        audio: { ...audio, media_bytes: new Uint8Array([1, 2, 3]) },
      }),
    ).toThrow();
    expect(() =>
      decodeMediaAsrInput({
        ...asrInput,
        attempt: { ...attempt, timeout_ms: 120_001 },
      }),
    ).toThrow();
  });

  test("accepts transcript and explicit no-speech as separate ASR outcomes", () => {
    expect(decodeMediaAsrResult(asrTranscriptResult)).toMatchObject({
      status: "transcript",
      transcript: { transcript_artifact_ref: hostileTranscript.transcript_artifact_ref },
    });
    expect(decodeMediaAsrResult(asrNoSpeechResult)).toMatchObject({
      status: "no_speech",
      transcript: null,
      detected_languages: [],
    });
    expect(
      isMediaAsrResultBoundToInput(
        decodeMediaAsrInput(asrInput),
        decodeMediaAsrResult(asrTranscriptResult),
      ),
    ).toBe(true);
    expect(
      isMediaAsrResultBoundToInput(
        decodeMediaAsrInput(asrInput),
        decodeMediaAsrResult({
          ...asrTranscriptResult,
          audio: { ...audio, canonical_audio_sha256: "b".repeat(64) },
        }),
      ),
    ).toBe(false);
    expect(() =>
      decodeMediaAsrResult({
        ...asrNoSpeechResult,
        detected_languages: [{ language_bcp47: "en", confidence: 0.5 }],
      }),
    ).toThrow();
  });

  test("enforces ordered, non-overlapping and bounded transcript segments", () => {
    expect(() =>
      decodeMediaAsrResult({
        ...asrTranscriptResult,
        transcript: {
          ...hostileTranscript,
          segments: [{ start_ms: 100, end_ms: 99, text: "bad" }],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeMediaAsrResult({
        ...asrTranscriptResult,
        transcript: {
          ...hostileTranscript,
          segments: [
            { start_ms: 0, end_ms: 1_000, text: "first" },
            { start_ms: 500, end_ms: 1_500, text: "overlap" },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeMediaAsrResult({
        ...asrTranscriptResult,
        transcript: {
          ...hostileTranscript,
          segments: [{ start_ms: 0, end_ms: 1, text: "x".repeat(4_097) }],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeMediaAsrResult({
        ...asrTranscriptResult,
        transcript: { ...hostileTranscript, transcript: "x".repeat(MEDIA_TRANSCRIPT_MAX_LENGTH + 1) },
      }),
    ).toThrow();
  });

  test("validates canonical BCP47 tags and distinct language evidence", () => {
    for (const tag of ["en", "en-US", "zh-Hant-TW", "sr-Latn", "deu-CH"] as const) {
      expect(Schema.is(MediaBcp47LanguageTag)(tag)).toBe(true);
    }
    for (const tag of malformedBcp47Tags) {
      expect(Schema.is(MediaBcp47LanguageTag)(tag)).toBe(false);
    }
    expect(() =>
      decodeMediaAsrResult({
        ...asrTranscriptResult,
        detected_languages: [
          { language_bcp47: "en", confidence: 0.5 },
          { language_bcp47: "en", confidence: 0.4 },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeMediaExplicitnessClassifierResult({
        ...classifierResult,
        primary_language_bcp47: "en",
        secondary_language_bcp47: "en",
      }),
    ).toThrow();
  });

  test("keeps transcript text inert and rejects authority-shaped fields", () => {
    expect(decodeMediaExplicitnessClassifierInput(classifierInput)).toMatchObject({
      transcript: { transcript: hostileTranscript.transcript },
    });
    for (const field of hostileAuthorityFields) {
      expect(() =>
        decodeMediaExplicitnessClassifierInput({
          ...classifierInput,
          [field]: "forbidden",
        }),
      ).toThrow();
      expect(() =>
        decodeMediaExplicitnessClassifierInput({
          ...classifierInput,
          transcript: { ...hostileTranscript, [field]: "forbidden" },
        }),
      ).toThrow();
    }
  });

  test("keeps classifier failure outcomes distinct and fail closed", () => {
    for (const status of classifierFailureResults) {
      const result = decodeMediaExplicitnessClassifierResult({
        version: "media-explicitness-classifier-result-v1",
        status,
        evidence: [],
        policy_revision: "lyrics-policy-1",
        prompt_revision: "classifier-prompt-1",
        classifier_revision: "classifier-contract-1",
        adapter_revision: "adapter-revision-1",
      });
      expect(result.status).toBe(status);
    }
    expect(decodeMediaExplicitnessClassifierResult(classifierResult)).toMatchObject({
      status: "classified",
      explicitness: "not_explicit",
      primary_language_bcp47: "en",
      secondary_language_bcp47: "ru",
    });
    expect(
      isMediaClassifierResultBoundToTranscript(
        decodeMediaExplicitnessClassifierInput(classifierInput),
        decodeMediaExplicitnessClassifierResult(classifierResult),
      ),
    ).toBe(true);
    expect(
      isMediaClassifierResultBoundToTranscript(
        decodeMediaExplicitnessClassifierInput(classifierInput),
        decodeMediaExplicitnessClassifierResult({
          ...classifierResult,
          evidence: [{ ...classifierResult.evidence[0], segment_index: 10_000 }],
        }),
      ),
    ).toBe(false);
  });

  test("uses a closed retryability taxonomy without provider payload leakage", () => {
    const retryable = [
      { _tag: "timeout", retryability: "retryable" },
      { _tag: "rate_limited", retryability: "retryable", retry_after_ms: 1_000 },
      { _tag: "provider_unavailable", retryability: "retryable" },
    ] as const;
    for (const failure of retryable) {
      const decoded = strictDecode(MediaProviderFailure, { ...failure, attempt_id: "attempt-1" });
      expect(isRetryableMediaProviderFailure(decoded)).toBe(true);
    }
    const permanent = strictDecode(MediaProviderFailure, {
      _tag: "malformed_response",
      retryability: "permanent",
      attempt_id: "attempt-1",
    });
    expect(isRetryableMediaProviderFailure(permanent)).toBe(false);
    expect(() =>
      strictDecode(MediaProviderFailure, {
        _tag: "malformed_response",
        retryability: "retryable",
        attempt_id: "attempt-1",
      }),
    ).toThrow();
    expect(() =>
      strictDecode(MediaProviderFailure, {
        _tag: "provider_unavailable",
        retryability: "retryable",
        attempt_id: "attempt-1",
        raw_provider_response: "must not cross boundary",
      }),
    ).toThrow();
  });

  test("supports compile-time fakes and cancellation through the adapter port", () => {
    const asrFake = {
      recognize: (input: (typeof MediaAsrInput)["Type"], options: { readonly signal: AbortSignal }) =>
        options.signal.aborted
          ? Effect.fail({
              _tag: "cancelled",
              retryability: "cancelled",
              attempt_id: input.attempt.attempt_id,
            } as const)
          : Effect.succeed(decodeMediaAsrResult(asrNoSpeechResult)),
    } satisfies MediaAsrAdapter;
    const classifierFake = {
      classify: (
        _input: (typeof MediaExplicitnessClassifierInput)["Type"],
        _options: { readonly signal: AbortSignal },
      ) => Effect.succeed(decodeMediaExplicitnessClassifierResult(classifierResult)),
    } satisfies MediaExplicitnessClassifierAdapter;

    const controller = new AbortController();
    controller.abort();
    expect(
      Exit.isFailure(
        Effect.runSyncExit(asrFake.recognize(decodeMediaAsrInput(asrInput), { signal: controller.signal })),
      ),
    ).toBe(true);
    expect(
      classifierFake.classify(decodeMediaExplicitnessClassifierInput(classifierInput), {
        signal: controller.signal,
      }),
    ).toBeDefined();
  });
});
