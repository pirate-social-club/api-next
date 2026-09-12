import { describe, expect, test } from "bun:test";
import {
  checkSongVideoInterval,
  SONG_VIDEO_INTERVAL_POLICY_V1,
  SONG_VIDEO_SAMPLE_RATE_HZ,
  VIDEO_INGEST_POLICY_V1,
} from "./video-submission.ts";

const SECOND = SONG_VIDEO_SAMPLE_RATE_HZ;
const SONG = 214 * SECOND;

describe("song-backed video interval", () => {
  test("is bounded like the video itself, at 3 to 180 seconds", () => {
    // Derived from the ingest policy rather than restated, so the two cannot
    // drift apart.
    expect(SONG_VIDEO_INTERVAL_POLICY_V1.minClipDurationSamples).toBe(
      (VIDEO_INGEST_POLICY_V1.minDurationMs / 1_000) * SECOND,
    );
    expect(SONG_VIDEO_INTERVAL_POLICY_V1.minClipDurationSamples).toBe(3 * SECOND);
    expect(SONG_VIDEO_INTERVAL_POLICY_V1.maxClipDurationSamples).toBe(180 * SECOND);
  });

  test("accepts an interval whose exclusive end is exactly the canonical end", () => {
    const check = checkSongVideoInterval({
      clipStartSamples: SONG - 30 * SECOND,
      clipDurationSamples: 30 * SECOND,
      songDurationSamples: SONG,
    });
    expect(check).toEqual({ accepted: true, clipEndSamples: SONG });
  });

  test("refuses an interval one sample past the canonical end", () => {
    // No tolerance: this is the case a frame-sum estimate of the song's length
    // would get wrong, which is why only a probed duration may be used.
    expect(
      checkSongVideoInterval({
        clipStartSamples: SONG - 30 * SECOND + 1,
        clipDurationSamples: 30 * SECOND,
        songDurationSamples: SONG,
      }),
    ).toEqual({ accepted: false, reason: "canonical_song_interval_uncovered" });
  });

  test("refuses intervals outside the 3 to 180 second bound", () => {
    const at = (clipDurationSamples: number) =>
      checkSongVideoInterval({
        clipStartSamples: 0,
        clipDurationSamples,
        songDurationSamples: SONG,
      });
    expect(at(3 * SECOND - 1)).toEqual({ accepted: false, reason: "interval_too_short" });
    expect(at(3 * SECOND).accepted).toBe(true);
    expect(at(180 * SECOND).accepted).toBe(true);
    expect(at(180 * SECOND + 1)).toEqual({ accepted: false, reason: "interval_too_long" });
  });

  test("is not the Dance segment: 45 seconds is a valid song-backed interval", () => {
    // Spec 021's 6 to 30 second scored segment is a separate, later choice.
    expect(
      checkSongVideoInterval({
        clipStartSamples: 0,
        clipDurationSamples: 45 * SECOND,
        songDurationSamples: SONG,
      }).accepted,
    ).toBe(true);
  });

  test("fails closed on fractional, negative, empty and overflowing input", () => {
    for (const input of [
      { clipStartSamples: 0.5, clipDurationSamples: 10 * SECOND, songDurationSamples: SONG },
      { clipStartSamples: -1, clipDurationSamples: 10 * SECOND, songDurationSamples: SONG },
      { clipStartSamples: 0, clipDurationSamples: 0, songDurationSamples: SONG },
      { clipStartSamples: 0, clipDurationSamples: 10 * SECOND, songDurationSamples: 0 },
      {
        clipStartSamples: Number.MAX_SAFE_INTEGER,
        clipDurationSamples: 10 * SECOND,
        songDurationSamples: SONG,
      },
    ]) {
      const check = checkSongVideoInterval(input);
      expect(check.accepted).toBe(false);
    }
  });
});
