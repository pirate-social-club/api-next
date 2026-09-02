import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  ELEVENLABS_STUDY_BATCH_ENDPOINT,
  makeElevenLabsStudyBatchTranscriber,
  makeR2StudyAudioArchive,
  type StudyAudioBucket,
} from "./study-spoken-audio.ts";

describe("Study spoken-audio adapters", () => {
  test("uses one stored Scribe v2 batch request without speaker processing", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transcriber = makeElevenLabsStudyBatchTranscriber({
      apiKey: "fixture-key",
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({
          text: "Hold on",
          language_code: "en",
          language_probability: 0.98,
        });
      },
    });
    await expect(
      Effect.runPromise(
        transcriber.transcribe({
          audio: new Uint8Array([1, 2, 3]),
          contentType: "audio/webm",
          languageHint: "en-US",
        }),
      ),
    ).resolves.toEqual({
      transcript: "Hold on",
      detectedLanguage: "en",
      detectedLanguageConfidence: 0.98,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(ELEVENLABS_STUDY_BATCH_ENDPOINT);
    expect(requests[0]?.init.headers).toEqual({ "xi-api-key": "fixture-key" });
    const body = requests[0]?.init.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("diarize")).toBe("false");
    expect(form.get("language_code")).toBe("en");
    expect(form.has("use_speaker_library")).toBe(false);
  });

  test("bounds provider responses and classifies rate limiting", async () => {
    const rateLimited = makeElevenLabsStudyBatchTranscriber({
      apiKey: "fixture-key",
      fetch: async () => new Response("busy", { status: 429 }),
    });
    await expect(
      Effect.runPromise(
        rateLimited.transcribe({
          audio: new Uint8Array([1]),
          contentType: "audio/ogg",
          languageHint: null,
        }),
      ),
    ).rejects.toMatchObject({ reason: "rate-limited" });
  });

  test("makes archival failure data instead of a grading failure", async () => {
    const failed = makeR2StudyAudioArchive(undefined);
    await expect(
      Effect.runPromise(
        failed.store({
          accountId: "account-1",
          attemptRef: "attempt-1",
          audio: new Uint8Array([1]),
          contentType: "audio/webm",
          contentDigest: "a".repeat(64),
        }),
      ),
    ).resolves.toEqual({ state: "failed", objectRef: null });

    let storedKey = "";
    const bucket: StudyAudioBucket = {
      put: async (key, value) => {
        storedKey = key;
        return { size: value.byteLength };
      },
    };
    const stored = makeR2StudyAudioArchive(bucket);
    await expect(
      Effect.runPromise(
        stored.store({
          accountId: "account-1",
          attemptRef: "attempt-1",
          audio: new Uint8Array([1, 2]),
          contentType: "audio/webm",
          contentDigest: "b".repeat(64),
        }),
      ),
    ).resolves.toEqual({
      state: "stored",
      objectRef: `learner-audio/study/attempt-1/${"b".repeat(64)}`,
    });
    expect(storedKey).toEndWith("b".repeat(64));
  });
});
