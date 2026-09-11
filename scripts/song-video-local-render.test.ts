import { describe, expect, test } from "bun:test";
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
  return {
    identity: "ffmpeg-test-v1",
    policyRevision: 1,
    render: async () => ({
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
    }),
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
    const renderer = makeLocalSongVideoRenderer({ engine: fakeEngine(masterBytes), output: store });
    expect(await renderer.submit(request)).toEqual({ status: "submitted" });
    // The reconciliation never replaces the object it read.
    expect(await store.read(outputObjectKey)).toEqual(before);
  });

  test("refuses an occupied address holding another execution's bytes", async () => {
    const store = makeLocalVersionedMasterStore();
    const foreign = new TextEncoder().encode("another-master");
    await store.writeOnce(outputObjectKey, foreign, await sha256Hex(foreign));
    const renderer = makeLocalSongVideoRenderer({
      engine: fakeEngine(new TextEncoder().encode("our-master")),
      output: store,
    });
    expect(await renderer.submit(request)).toEqual({
      status: "refused",
      reason: "output_conflict",
    });
    expect((await store.read(outputObjectKey))?.bytes).toEqual(foreign);
    // A recorded refusal names this address and outranks the object there.
    expect(await renderer.observe({ outputObjectKey })).toEqual({
      status: "refused",
      reason: "output_conflict",
    });
  });

  test("a lost write acknowledgement is observed and reconciled by identity", async () => {
    const store = makeLocalVersionedMasterStore();
    const masterBytes = new TextEncoder().encode("rendered-master");
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
    const renderer = makeLocalSongVideoRenderer({
      engine: fakeEngine(masterBytes),
      output: writer,
    });
    await expect(renderer.submit(request)).rejects.toThrow("output write response lost");
    // The stage observes the stored output rather than rendering again.
    expect(await renderer.observe({ outputObjectKey })).toEqual({ status: "completed" });
    // A reconciliation run at the same address accepts the stored identity.
    expect(await renderer.submit(request)).toEqual({ status: "submitted" });
    expect((await store.read(outputObjectKey))?.bytes).toEqual(masterBytes);
  });
});
