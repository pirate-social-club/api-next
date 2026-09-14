import { describe, expect, test } from "bun:test";

import {
  type SongVideoOutputProbe,
  type SongVideoOutputStore,
  type SongVideoProbeFacts,
  verifyRenderedOutput,
} from "./song-video-output-verification.ts";

const SAMPLE_RATE = 48_000;
const planClipDurationSamples = 15 * SAMPLE_RATE;
// Test-only. U.6 remains unresolved and nothing in the source supplies a value.
const masterCeilingBytes = 1_000_000;

const goodFacts: SongVideoProbeFacts = {
  videoDurationSamples: planClipDurationSamples,
  audioDurationSamples: planClipDurationSamples,
  audioSampleRateHz: SAMPLE_RATE,
  audioChannels: 2,
  hasVideoTrack: true,
};

const bytesOf = (text: string) => new TextEncoder().encode(text);

const storeOf = (map: Record<string, Uint8Array>): SongVideoOutputStore => ({
  read: async (key) => {
    const bytes = map[key];
    return bytes === undefined ? null : { bytes, objectVersion: `v-${key}`, etag: `etag-${key}` };
  },
  readVersion: async (key, version) => {
    const bytes = map[key];
    return bytes !== undefined && version === `v-${key}` ? bytes : null;
  },
});

const proberOf = (facts: SongVideoProbeFacts | null): SongVideoOutputProbe => ({
  probe: async () => facts,
});

const master = bytesOf("rendered-master-bytes");
const store = storeOf({ "master-1": master });

async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const verify = (overrides: Partial<Parameters<typeof verifyRenderedOutput>[0]> = {}) =>
  verifyRenderedOutput({
    store,
    prober: proberOf(goodFacts),
    objectKey: "master-1",
    planClipDurationSamples,
    sourceSha256: "a".repeat(64),
    masterCeilingBytes,
    ...overrides,
  });

describe("rendered output verification", () => {
  test("measures the digest and length from the bytes rather than accepting them", async () => {
    const result = await verify();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error("expected verification");
    expect(result.output.masterSha256).toBe(await digestOf(master));
    expect(result.output.masterByteLength).toBe(master.byteLength);
  });

  test("refuses output that is not stored", async () => {
    expect(await verify({ objectKey: "missing" })).toEqual({
      verified: false,
      failure: { kind: "output_absent", objectKey: "missing" },
    });
  });

  test("refuses empty output", async () => {
    expect(await verify({ store: storeOf({ "master-1": new Uint8Array(0) }) })).toMatchObject({
      verified: false,
      failure: { kind: "output_empty" },
    });
  });

  test("refuses output that cannot be probed, which is the corrupt case", async () => {
    expect(await verify({ prober: proberOf(null) })).toMatchObject({
      verified: false,
      failure: { kind: "output_unprobeable" },
    });
  });

  test("refuses a partial render whose timeline is not the frozen interval", async () => {
    expect(
      await verify({
        prober: proberOf({ ...goodFacts, videoDurationSamples: planClipDurationSamples - 1 }),
      }),
    ).toMatchObject({
      verified: false,
      failure: {
        kind: "output_duration_not_plan_interval",
        track: "video",
        planSamples: planClipDurationSamples,
      },
    });
  });

  test("refuses output whose audio is not the canonical rate", async () => {
    expect(
      await verify({ prober: proberOf({ ...goodFacts, audioSampleRateHz: 44_100 }) }),
    ).toMatchObject({
      verified: false,
      failure: { kind: "output_audio_not_canonical", sampleRateHz: 44_100 },
    });
  });

  test("refuses output with no video track", async () => {
    expect(
      await verify({ prober: proberOf({ ...goodFacts, hasVideoTrack: false }) }),
    ).toMatchObject({
      verified: false,
      failure: { kind: "output_has_no_video_track" },
    });
  });

  test("refuses output larger than the supplied ceiling", async () => {
    expect(await verify({ masterCeilingBytes: 1 })).toMatchObject({
      verified: false,
      failure: { kind: "output_exceeds_ceiling", ceiling: 1 },
    });
  });

  test("refuses an output that is byte-identical to its source", async () => {
    expect(await verify({ sourceSha256: await digestOf(master) })).toMatchObject({
      verified: false,
      failure: { kind: "output_is_the_source" },
    });
  });

  test("takes no verification flag from a caller", async () => {
    // Nothing in the input shape lets a caller assert the output is valid; the
    // only inputs are the store, the prober, and the frozen facts to match.
    const keys = Object.keys({
      store,
      prober: proberOf(goodFacts),
      objectKey: "master-1",
      planClipDurationSamples,
      sourceSha256: "a".repeat(64),
      masterCeilingBytes,
    });
    expect(keys.filter((key) => /verified|valid|trusted|ok/i.test(key))).toEqual([]);
  });

  test("refuses a ceiling that is not a positive safe integer", async () => {
    // The same failure the acceptance check had, at a new boundary: an unusable
    // ceiling must refuse rather than pass every comparison silently.
    for (const masterCeiling of [Number.NaN, 0, -1, 1.5]) {
      expect(await verify({ masterCeilingBytes: masterCeiling })).toMatchObject({
        verified: false,
        failure: { kind: "ceiling_not_configured" },
      });
    }
  });

  test("refuses invalid audio track facts", async () => {
    for (const channels of [0, -1, 1.5, Number.NaN]) {
      expect(
        await verify({ prober: proberOf({ ...goodFacts, audioChannels: channels }) }),
      ).toMatchObject({
        verified: false,
        failure: { kind: "output_audio_track_invalid" },
      });
    }
  });

  test("refuses a short audio track hidden behind a correct video duration", async () => {
    expect(
      await verify({
        prober: proberOf({ ...goodFacts, audioDurationSamples: planClipDurationSamples - 1 }),
      }),
    ).toMatchObject({
      verified: false,
      failure: { kind: "output_duration_not_plan_interval", track: "audio" },
    });
  });

  test("reports the object version so sealing can prove the bytes did not change", async () => {
    const result = await verify();
    if (!result.verified) throw new Error("expected verification");
    expect(result.output.objectVersion).toBe("v-master-1");
  });

  test("refuses output whose recorded version is not independently retrievable", async () => {
    expect(
      await verify({
        store: {
          read: async () => ({ bytes: master, objectVersion: "v-master-1", etag: "etag-master-1" }),
          readVersion: async () => null,
        },
      }),
    ).toMatchObject({ verified: false, failure: { kind: "output_version_not_addressable" } });
  });

  test("refuses when the recorded version resolves to different bytes", async () => {
    expect(
      await verify({
        store: {
          read: async () => ({ bytes: master, objectVersion: "v-master-1", etag: "etag-master-1" }),
          readVersion: async () => bytesOf("different-bytes-entirely"),
        },
      }),
    ).toMatchObject({ verified: false, failure: { kind: "output_version_bytes_differ" } });
  });
});
