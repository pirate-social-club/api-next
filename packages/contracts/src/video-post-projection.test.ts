import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { VideoPostProjectionV1, VideoSoundtrackProjectionV1 } from "./v1.ts";

const exact = { onExcessProperty: "error" } as const;

const originalAudio = {
  track: "video",
  caption: "Original clip",
  caption_dir: "auto",
  caption_lang: null,
  soundtrack: {
    kind: "original_audio",
    original_sound_id: "original-sound-1",
    origin_video_post_id: "post-video-1",
    origin_author_persona_id: "persona-video-1",
  },
  playback: { status: "ready", provider: "stream", playback_ref: "stream-video-1" },
  thumbnail: { status: "ready", artifact_ref: "media://thumbnail/video-1" },
  data_registration: "registered",
  capabilities: { can_post_with_song: false },
} as const;

describe("video Post projection contracts", () => {
  test("round-trips original audio across every public enrichment state", () => {
    const decode = Schema.decodeUnknownSync(VideoPostProjectionV1, exact);
    expect(decode(originalAudio)).toEqual(originalAudio);
    expect(
      decode({
        ...originalAudio,
        caption: null,
        caption_dir: null,
        playback: { status: "pending" },
        thumbnail: { status: "pending" },
        data_registration: "registration_pending",
      }),
    ).toMatchObject({
      playback: { status: "pending" },
      thumbnail: { status: "pending" },
      data_registration: "registration_pending",
    });
  });

  test("keeps song reference exhaustive without the retired verification badge", () => {
    const soundtrack = {
      kind: "song_reference",
      song_reference: {
        song_post_id: "song-post-1",
        song_title: "Referenced song",
        song_author_persona_id: "persona-song-1",
      },
    } as const;
    expect(Schema.decodeUnknownSync(VideoSoundtrackProjectionV1, exact)(soundtrack)).toEqual(
      soundtrack,
    );
    expect(() =>
      Schema.decodeUnknownSync(
        VideoSoundtrackProjectionV1,
        exact,
      )({
        ...soundtrack,
        verification: "confirmed",
      }),
    ).toThrow();
  });

  test.each([
    ["fingerprint", { fingerprint: "private" }],
    ["rights review", { rights_review: "private" }],
    ["ownership", { ownership: "private" }],
    ["moderator", { moderator: "private" }],
    ["override", { override: "private" }],
    ["extraction", { extracted_audio_ref: "private" }],
    ["hash", { canonical_sha256: "a".repeat(64) }],
    ["retention", { retention_policy_revision: 1 }],
  ])("rejects private %s evidence", (_label, evidence) => {
    expect(() =>
      Schema.decodeUnknownSync(VideoPostProjectionV1, exact)({ ...originalAudio, ...evidence }),
    ).toThrow();
  });
});
