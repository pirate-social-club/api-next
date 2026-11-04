import { describe, expect, test } from "bun:test";
import {
  CURRENT_SONG_VIDEO_INTERVAL_POLICY,
  checkSongVideoInterval,
  createSongReferenceVideoSubmission,
  SONG_VIDEO_INTERVAL_POLICY_V1,
  SONG_VIDEO_SAMPLE_RATE_HZ,
  songVideoIntervalPolicy,
  VIDEO_INGEST_POLICY_V1,
} from "./video-submission.ts";

const SECOND = SONG_VIDEO_SAMPLE_RATE_HZ;
const SONG = 214 * SECOND;

describe("song-backed video interval", () => {
  test("revision 1 was bounded like the video itself, at 3 to 180 seconds", () => {
    // Derived from the ingest policy rather than restated, so the two cannot
    // drift apart.
    expect(SONG_VIDEO_INTERVAL_POLICY_V1.minClipDurationSamples).toBe(
      (VIDEO_INGEST_POLICY_V1.minDurationMs / 1_000) * SECOND,
    );
    expect(SONG_VIDEO_INTERVAL_POLICY_V1.minClipDurationSamples).toBe(3 * SECOND);
    expect(SONG_VIDEO_INTERVAL_POLICY_V1.maxClipDurationSamples).toBe(180 * SECOND);
  });

  test("revision 2 is current and bounds new intervals to 3 to 15 seconds", () => {
    expect(CURRENT_SONG_VIDEO_INTERVAL_POLICY.policyRevision).toBe(2);
    expect(CURRENT_SONG_VIDEO_INTERVAL_POLICY.minClipDurationSamples).toBe(3 * SECOND);
    expect(CURRENT_SONG_VIDEO_INTERVAL_POLICY.maxClipDurationSamples).toBe(15 * SECOND);
  });

  test("a recorded revision keeps its own bound", () => {
    expect(songVideoIntervalPolicy(1)).toBe(SONG_VIDEO_INTERVAL_POLICY_V1);
    expect(songVideoIntervalPolicy(2)).toBe(CURRENT_SONG_VIDEO_INTERVAL_POLICY);
    expect(songVideoIntervalPolicy(3)).toBeUndefined();
    const thirty = {
      clipStartSamples: 0,
      clipDurationSamples: 30 * SECOND,
      songDurationSamples: SONG,
    };
    expect(checkSongVideoInterval(thirty, SONG_VIDEO_INTERVAL_POLICY_V1).accepted).toBe(true);
    expect(checkSongVideoInterval(thirty)).toEqual({
      accepted: false,
      reason: "interval_too_long",
    });
  });

  test("accepts an interval whose exclusive end is exactly the canonical end", () => {
    const check = checkSongVideoInterval({
      clipStartSamples: SONG - 15 * SECOND,
      clipDurationSamples: 15 * SECOND,
      songDurationSamples: SONG,
    });
    expect(check).toEqual({ accepted: true, clipEndSamples: SONG });
  });

  test("refuses an interval one sample past the canonical end", () => {
    // No tolerance: this is the case a frame-sum estimate of the song's length
    // would get wrong, which is why only a probed duration may be used.
    expect(
      checkSongVideoInterval({
        clipStartSamples: SONG - 15 * SECOND + 1,
        clipDurationSamples: 15 * SECOND,
        songDurationSamples: SONG,
      }),
    ).toEqual({ accepted: false, reason: "canonical_song_interval_uncovered" });
  });

  test("refuses intervals outside the 3 to 15 second bound", () => {
    const at = (clipDurationSamples: number) =>
      checkSongVideoInterval({
        clipStartSamples: 0,
        clipDurationSamples,
        songDurationSamples: SONG,
      });
    expect(at(3 * SECOND - 1)).toEqual({ accepted: false, reason: "interval_too_short" });
    expect(at(3 * SECOND).accepted).toBe(true);
    expect(at(15 * SECOND).accepted).toBe(true);
    expect(at(15 * SECOND + 1)).toEqual({ accepted: false, reason: "interval_too_long" });
  });

  test("is not the Dance segment: a revision-1 reservation of 45 seconds stays valid", () => {
    // Spec 021's 6 to 30 second scored segment is a separate, later choice.
    expect(
      checkSongVideoInterval(
        {
          clipStartSamples: 0,
          clipDurationSamples: 45 * SECOND,
          songDurationSamples: SONG,
        },
        SONG_VIDEO_INTERVAL_POLICY_V1,
      ).accepted,
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

describe("claiming a song-reference reservation", () => {
  const claim = (clipDurationSamples: number, intervalPolicyRevision: number) =>
    createSongReferenceVideoSubmission({
      submissionId: "media-submission-1",
      operationId: "media-operation-1",
      communityId: "community-1",
      actorAccountId: "account-1",
      authorPersonaId: "persona-1",
      reservationId: "reservation-1",
      caption: null,
      authorDeclaredRating: "general",
      songPlan: {
        planId: "plan-1",
        songPostId: "song-post-1",
        songAssetId: "song-asset-1",
        audioRevision: 1,
        canonicalAudioSha256: "a".repeat(64),
        songDurationSamples: SONG,
        clipStartSamples: 0,
        clipDurationSamples,
        intervalPolicyRevision,
      },
    });

  test("judges the interval by the revision its reservation recorded", () => {
    // Reserved before the 15 second rule: a 30 second interval stays valid.
    expect(claim(30 * SECOND, 1).status).toBe("processing");
    // Reserved under revision 2, the same interval could never have been issued.
    expect(() => claim(30 * SECOND, 2)).toThrow("song-reference submission plan is invalid");
    expect(claim(15 * SECOND, 2).status).toBe("processing");
  });

  test("refuses a plan that names no known revision", () => {
    expect(() => claim(10 * SECOND, 99)).toThrow("song-reference submission plan is invalid");
  });
});
