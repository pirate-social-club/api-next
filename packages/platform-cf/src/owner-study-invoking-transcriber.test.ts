import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeOwnerElevenLabsStudyInvokingTranscriber } from "./owner-study-invoking-transcriber.ts";
import { ELEVENLABS_STUDY_BATCH_ENDPOINT } from "./study-spoken-audio.ts";

const input = {
  audio: new Uint8Array([1, 2, 3]),
  contentType: "audio/webm",
  languageHint: "en",
};
test("actual pre-fetch misconfiguration is not_invoked and never sends a request", async () => {
  let calls = 0;
  const adapter = makeOwnerElevenLabsStudyInvokingTranscriber({
    apiKey: "",
    fetch: async () => {
      ++calls;
      throw new Error();
    },
  });
  expect(adapter.available).toBe(false);
  expect(adapter.providerRetention).toBe("stored");
  expect(await Effect.runPromise(adapter.invoke(input))).toEqual({
    state: "failed",
    reason: "misconfigured",
    providerDisposition: "not_invoked",
  });
  expect(calls).toBe(0);
});
test("actual retained adapter keeps stored logging policy and its bounded transcript response", async () => {
  const adapter = makeOwnerElevenLabsStudyInvokingTranscriber({
    apiKey: "fixture-only-key",
    fetch: async (url, init) => {
      expect(url).toBe(ELEVENLABS_STUDY_BATCH_ENDPOINT);
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
      return new Response(
        JSON.stringify({
          text: "I can love you",
          language_code: "en",
          language_probability: 0.99,
        }),
      );
    },
  });
  expect(adapter.providerRetention).toBe("stored");
  expect(adapter.available).toBe(true);
  expect(await Effect.runPromise(adapter.invoke(input))).toEqual({
    state: "completed",
    result: {
      transcript: "I can love you",
      detectedLanguage: "en",
      detectedLanguageConfidence: 0.99,
    },
  });
});
test("observed 429 is conservative unknown; no invented zero-cost negative contract", async () => {
  const adapter = makeOwnerElevenLabsStudyInvokingTranscriber({
    apiKey: "fixture-only-key",
    fetch: async () => new Response("", { status: 429 }),
  });
  expect(await Effect.runPromise(adapter.invoke(input))).toEqual({
    state: "failed",
    reason: "rate-limited",
    providerDisposition: "unknown",
  });
});
test("actual oversize provider response is refused whole and remains unknown after dispatch", async () => {
  const adapter = makeOwnerElevenLabsStudyInvokingTranscriber({
    apiKey: "fixture-only-key",
    fetch: async () => new Response(JSON.stringify({ text: "x".repeat(4097) })),
  });
  expect(await Effect.runPromise(adapter.invoke(input))).toEqual({
    state: "failed",
    reason: "invalid-response",
    providerDisposition: "unknown",
  });
});
test("transport rejection after actual fetch remains unknown", async () => {
  const adapter = makeOwnerElevenLabsStudyInvokingTranscriber({
    apiKey: "fixture-only-key",
    fetch: async () => {
      throw new Error("fixture network interruption");
    },
  });
  expect(await Effect.runPromise(adapter.invoke(input))).toEqual({
    state: "failed",
    reason: "unavailable",
    providerDisposition: "unknown",
  });
});
