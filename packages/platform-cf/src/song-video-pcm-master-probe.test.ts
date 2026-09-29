import { describe, expect, test } from "bun:test";
import { pcmSongVideoMasterProbe } from "./song-video-pcm-master-probe.ts";

const fixture = async () =>
  new Uint8Array(
    await Bun.file(
      new URL("./song-video-master-verifier/fixtures/master.mp4", import.meta.url),
    ).arrayBuffer(),
  );

describe("PCM master probe for Worker sealing", () => {
  test("measures a master against the frozen interval", async () => {
    expect(await pcmSongVideoMasterProbe.probe(await fixture(), 150_000)).toEqual({
      videoDurationSamples: 150_000,
      audioDurationSamples: 150_000,
      audioSampleRateHz: 48_000,
      audioChannels: 2,
      hasVideoTrack: true,
    });
  });

  test("refuses a wrong-duration or damaged master", async () => {
    expect(await pcmSongVideoMasterProbe.probe(await fixture(), 150_001)).toBeNull();
    expect(await pcmSongVideoMasterProbe.probe(new Uint8Array([1, 2, 3]), 150_000)).toBeNull();
  });
});
