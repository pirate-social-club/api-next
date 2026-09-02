import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeProductionStudySpokenServices } from "./study-spoken-production-composition.ts";

describe("Study spoken production composition", () => {
  test("stays disabled without exact provider authority", () => {
    expect(makeProductionStudySpokenServices({})).toBeUndefined();
    expect(makeProductionStudySpokenServices({ ELEVENLABS_API_KEY: " " })).toBeUndefined();
    expect(
      makeProductionStudySpokenServices({ ELEVENLABS_API_KEY: " padded-secret " }),
    ).toBeUndefined();
  });

  test("composes batch transcription and private archival without eager I/O", async () => {
    const providerRequests: Array<{ url: string; init: RequestInit }> = [];
    const storedObjects: string[] = [];
    const study = makeProductionStudySpokenServices(
      {
        ELEVENLABS_API_KEY: "fixture-elevenlabs-key",
        LEARNER_AUDIO: {
          put: async (key, value) => {
            storedObjects.push(key);
            return { size: value.byteLength };
          },
        },
      },
      {
        study_batch_fetch: async (url, init) => {
          providerRequests.push({ url, init });
          return Response.json({
            text: "Hold on",
            language_code: "en",
            language_probability: 0.98,
          });
        },
      },
    );
    expect(study).toBeDefined();
    expect(providerRequests).toHaveLength(0);
    expect(storedObjects).toHaveLength(0);

    if (study === undefined) throw new Error("Study speech must be enabled in this fixture");
    expect(study.transcriber.providerRetention).toBe("stored");
    await expect(
      Effect.runPromise(
        study.transcriber.transcribe({
          audio: new Uint8Array([1, 2, 3]),
          contentType: "audio/webm",
          languageHint: "en-US",
        }),
      ),
    ).resolves.toMatchObject({ transcript: "Hold on" });
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.url).toContain("enable_logging=true");
    expect(providerRequests[0]?.init.headers).toEqual({
      "xi-api-key": "fixture-elevenlabs-key",
    });

    await expect(
      Effect.runPromise(
        study.archive.store({
          accountId: "account-1",
          attemptRef: "attempt-1",
          audio: new Uint8Array([1, 2, 3]),
          contentType: "audio/webm",
          contentDigest: "a".repeat(64),
        }),
      ),
    ).resolves.toMatchObject({ state: "stored" });
    expect(storedObjects).toHaveLength(1);
  });

  test("uses stored provider retention for every composition", async () => {
    const urls: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const study = makeProductionStudySpokenServices(
        { ELEVENLABS_API_KEY: "fixture-elevenlabs-key" },
        {
          study_batch_fetch: async (url) => {
            urls.push(url);
            return Response.json({ text: "Hold on", language_code: "en", language_probability: 1 });
          },
        },
      );
      if (study === undefined) throw new Error("Study speech must be enabled in this fixture");
      expect(study.transcriber.providerRetention).toBe("stored");
      await Effect.runPromise(
        study.transcriber.transcribe({
          audio: new Uint8Array([1]),
          contentType: "audio/wav",
          languageHint: "en",
        }),
      );
    }
    expect(urls).toHaveLength(4);
    expect(urls.every((url) => url.includes("enable_logging=true"))).toBe(true);
  });
});
