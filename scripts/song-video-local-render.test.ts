import { describe, expect, test } from "bun:test";
import type { SongVideoExecutionRecord } from "@pirate/application/video/song-render";
import {
  makeLocalSongVideoRenderer,
  makeLocalVersionedMasterStore,
} from "./song-video-local-render.ts";

const outputObjectKey = "media://immutable/song-video-masters/plan:submission-1/g1";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fakeEngine(masterBytes: Uint8Array) {
  const calls = { render: 0 };
  return {
    calls,
    engine: {
      identity: "ffmpeg-test-v1",
      policyRevision: 1,
      render: async () => {
        calls.render += 1;
        return {
          ok: true as const,
          masterBytes,
          masterSha256: await sha256Hex(masterBytes),
          facts: {
            videoDurationSamples: 1,
            audioDurationSamples: 1,
            audioSampleRateHz: 48_000,
            audioChannels: 2,
            hasVideoTrack: true,
          },
          soundtrackSha256: "a".repeat(64),
        };
      },
    },
  };
}

function makeEvidence() {
  const records = new Map<string, SongVideoExecutionRecord>();
  return {
    records,
    evidence: {
      recordExecution: async (key: string, record: SongVideoExecutionRecord) => {
        const existing = records.get(key);
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(record)) {
            throw new Error("song video execution evidence conflict");
          }
          return;
        }
        records.set(key, record);
      },
      executionEvidence: async (key: string) => records.get(key) ?? null,
    },
  };
}

const request = {
  outputObjectKey,
  source: {
    immutableRef: "media://immutable/capture/video/1",
    sha256: "b".repeat(64),
    byteLength: 10,
  },
  song: { assetRef: "asset-song-1", sha256: "c".repeat(64), durationSamples: 10 },
  clipStartSamples: 0,
  clipDurationSamples: 10,
};

describe("local host render output", () => {
  test("keeps the first write and reports later writes as occupied", async () => {
    const store = makeLocalVersionedMasterStore();
    const first = new TextEncoder().encode("first");
    const second = new TextEncoder().encode("second");
    expect(await store.writeOnce(outputObjectKey, first, await sha256Hex(first))).toEqual({
      status: "written",
    });
    expect(await store.writeOnce(outputObjectKey, second, await sha256Hex(second))).toEqual({
      status: "occupied",
    });
    expect((await store.read(outputObjectKey))?.bytes).toEqual(first);
  });

  test("accepts an occupied address only when its bytes are this execution's output", async () => {
    const store = makeLocalVersionedMasterStore();
    const masterBytes = new TextEncoder().encode("rendered-master");
    await store.writeOnce(outputObjectKey, masterBytes, await sha256Hex(masterBytes));
    const before = await store.read(outputObjectKey);
    const { engine } = fakeEngine(masterBytes);
    const renderer = makeLocalSongVideoRenderer({
      engine,
      output: store,
      evidence: makeEvidence().evidence,
    });
    expect(await renderer.submit(request)).toEqual({ status: "submitted" });
    // The reconciliation never replaces the object it read.
    expect(await store.read(outputObjectKey)).toEqual(before);
  });

  test("refuses an occupied address holding another execution's bytes", async () => {
    const store = makeLocalVersionedMasterStore();
    const foreign = new TextEncoder().encode("another-master");
    await store.writeOnce(outputObjectKey, foreign, await sha256Hex(foreign));
    const { engine, calls } = fakeEngine(new TextEncoder().encode("our-master"));
    const { evidence } = makeEvidence();
    const renderer = makeLocalSongVideoRenderer({ engine, output: store, evidence });
    expect(await renderer.submit(request)).toEqual({
      status: "refused",
      reason: "output_conflict",
    });
    expect((await store.read(outputObjectKey))?.bytes).toEqual(foreign);
    // The refusal is derived from retained evidence, not from renderer state.
    const recreated = makeLocalSongVideoRenderer({ engine, output: store, evidence });
    expect(await recreated.observe({ outputObjectKey })).toEqual({
      status: "refused",
      reason: "output_conflict",
    });
    expect(calls.render).toBe(1);
  });

  test("a lost write acknowledgement is observed from stored bytes without rendering again", async () => {
    const store = makeLocalVersionedMasterStore();
    const masterBytes = new TextEncoder().encode("rendered-master");
    const { evidence } = makeEvidence();
    const { engine, calls } = fakeEngine(masterBytes);
    let acknowledgementLost = false;
    const writer = {
      ...store,
      writeOnce: async (key: string, bytes: Uint8Array, sha: string) => {
        const outcome = await store.writeOnce(key, bytes, sha);
        if (!acknowledgementLost) {
          // The bytes are stored; the response never arrives.
          acknowledgementLost = true;
          throw new Error("output write response lost");
        }
        return outcome;
      },
    };
    const renderer = makeLocalSongVideoRenderer({ engine, output: writer, evidence });
    await expect(renderer.submit(request)).rejects.toThrow("output write response lost");
    // A recreated renderer reads the same evidence and reaches the same answer:
    // the stored bytes match the recorded output, so the attempt completed.
    const recreated = makeLocalSongVideoRenderer({ engine, output: writer, evidence });
    expect(await recreated.observe({ outputObjectKey })).toEqual({ status: "completed" });
    expect((await store.read(outputObjectKey))?.bytes).toEqual(masterBytes);
    expect(calls.render).toBe(1);
  });

  test("foreign bytes with a lost acknowledgement stay unresolved after recreation", async () => {
    const store = makeLocalVersionedMasterStore();
    const foreign = new TextEncoder().encode("another-master");
    await store.writeOnce(outputObjectKey, foreign, await sha256Hex(foreign));
    const { evidence } = makeEvidence();
    const { engine, calls } = fakeEngine(new TextEncoder().encode("our-master"));
    let acknowledgementLost = false;
    const writer = {
      ...store,
      writeOnce: async () => {
        // The address is occupied; the host never learns the outcome.
        acknowledgementLost = true;
        throw new Error("output write response lost");
      },
    };
    const renderer = makeLocalSongVideoRenderer({ engine, output: writer, evidence });
    await expect(renderer.submit(request)).rejects.toThrow("output write response lost");
    expect(acknowledgementLost).toBe(true);
    const recreated = makeLocalSongVideoRenderer({ engine, output: store, evidence });
    // Presence is not identity: the stored bytes do not match the recorded
    // output, so this address is refused rather than observed as completed.
    expect(await recreated.observe({ outputObjectKey })).toEqual({
      status: "refused",
      reason: "output_conflict",
    });
    expect((await store.read(outputObjectKey))?.bytes).toEqual(foreign);
    expect(calls.render).toBe(1);
  });

  test("missing evidence stays unresolved even when the address holds bytes", async () => {
    const store = makeLocalVersionedMasterStore();
    const bytes = new TextEncoder().encode("foreign-bytes");
    await store.writeOnce(outputObjectKey, bytes, await sha256Hex(bytes));
    const { engine, calls } = fakeEngine(new TextEncoder().encode("our-master"));
    const renderer = makeLocalSongVideoRenderer({
      engine,
      output: store,
      evidence: makeEvidence().evidence,
    });
    expect(await renderer.observe({ outputObjectKey })).toEqual({ status: "pending" });
    expect(calls.render).toBe(0);
  });
});
