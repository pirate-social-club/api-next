import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeProductionStudySpokenServices } from "./study-spoken-production-composition.ts";

describe("Study spoken production composition", () => {
  test("requires storage and keeps captured recovery available without NEW provider authority", () => {
    const bucket = { put: async (_key: string, value: Uint8Array) => ({ size: value.byteLength }) };
    expect(makeProductionStudySpokenServices({})).toBeUndefined();
    expect(
      makeProductionStudySpokenServices({ ELEVENLABS_API_KEY: "fixture-key" }),
    ).toBeUndefined();
    for (const key of [undefined, "", " ", " padded-secret "]) {
      const services = makeProductionStudySpokenServices({
        LEARNER_AUDIO: bucket,
        ...(key === undefined ? {} : { ELEVENLABS_API_KEY: key }),
      });
      expect(services?.bucket).toBe(bucket);
      expect(services?.transcriber).toBeNull();
    }
  });

  test("composes batch transcription and captured storage binding without eager I/O", async () => {
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

    if (study === undefined || study.transcriber === null)
      throw new Error("Study speech must be enabled in this fixture");
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

    // The factory supplies the actual bucket to the fenced protocol. It does
    // not expose a plain archive that could write before captured admission.
    expect(study.bucket).toBeDefined();
    expect("archive" in study).toBe(false);
    expect(storedObjects).toHaveLength(0);
  });

  test("uses stored provider retention for every composition", async () => {
    const urls: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const study = makeProductionStudySpokenServices(
        {
          ELEVENLABS_API_KEY: "fixture-elevenlabs-key",
          LEARNER_AUDIO: { put: async (_key, value) => ({ size: value.byteLength }) },
        },
        {
          study_batch_fetch: async (url) => {
            urls.push(url);
            return Response.json({ text: "Hold on", language_code: "en", language_probability: 1 });
          },
        },
      );
      if (study === undefined || study.transcriber === null)
        throw new Error("Study speech must be enabled in this fixture");
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
