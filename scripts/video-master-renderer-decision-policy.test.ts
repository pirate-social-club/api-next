import { describe, expect, it } from "bun:test";

import { validateCanonicalSongCoverage } from "./video-master-renderer-decision-policy.ts";

describe("canonical song half-open coverage", () => {
  it("accepts an interval whose exclusive end equals the canonical song duration", () => {
    expect(
      validateCanonicalSongCoverage({
        songDurationSamples: 480_000,
        clipStartSamples: 384_000,
        masterDurationSamples: 96_000,
      }),
    ).toEqual({ accepted: true, clipEndSamples: 480_000 });
  });

  it("rejects a canonical song that is one sample short of the public master", () => {
    expect(
      validateCanonicalSongCoverage({
        songDurationSamples: 479_999,
        clipStartSamples: 384_000,
        masterDurationSamples: 96_000,
      }),
    ).toEqual({ accepted: false, reason: "canonical_song_interval_uncovered" });
  });

  it("fails closed on fractional, negative, zero, and overflowing timelines", () => {
    expect(
      validateCanonicalSongCoverage({
        songDurationSamples: 10.5,
        clipStartSamples: 0,
        masterDurationSamples: 1,
      }),
    ).toEqual({ accepted: false, reason: "invalid_timeline" });
    expect(
      validateCanonicalSongCoverage({
        songDurationSamples: 10,
        clipStartSamples: -1,
        masterDurationSamples: 1,
      }),
    ).toEqual({ accepted: false, reason: "invalid_timeline" });
    expect(
      validateCanonicalSongCoverage({
        songDurationSamples: 10,
        clipStartSamples: 0,
        masterDurationSamples: 0,
      }),
    ).toEqual({ accepted: false, reason: "invalid_timeline" });
    expect(
      validateCanonicalSongCoverage({
        songDurationSamples: Number.MAX_SAFE_INTEGER,
        clipStartSamples: Number.MAX_SAFE_INTEGER,
        masterDurationSamples: 1,
      }),
    ).toEqual({ accepted: false, reason: "canonical_song_interval_uncovered" });
  });
});
