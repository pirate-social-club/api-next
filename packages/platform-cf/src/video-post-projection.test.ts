import { describe, expect, test } from "bun:test";
import { videoPostProjectionFromRow } from "./video-post-projection.ts";

const projectionRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  video_media_kind: "video",
  video_intent: "original_audio",
  video_caption: "A public caption",
  video_original_sound_id: "original-sound-1",
  video_origin_post_id: "post-video-1",
  video_origin_author_persona_id: "persona-video-1",
  video_stream_state: "bound",
  video_playback_ref: "stream-video-1",
  video_thumbnail_state: "ready",
  video_thumbnail_artifact_ref: "media://thumbnail/video-1",
  video_data_registration_state: "registered",
  ...overrides,
});

describe("video Post projection row mapping", () => {
  test("maps only the public original-audio facts", () => {
    const projection = videoPostProjectionFromRow(
      projectionRow({
        fingerprint: "private-fingerprint",
        rights_review: "private-review",
        ownership: "private-owner",
        moderator: "private-moderator",
        override: "private-override",
        extracted_audio_ref: "private-extraction",
        canonical_sha256: "a".repeat(64),
        retention_policy_revision: 1,
      }),
    );

    expect(projection).toEqual({
      track: "video",
      caption: "A public caption",
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
    });
    const encoded = JSON.stringify(projection);
    for (const value of [
      "private-fingerprint",
      "private-review",
      "private-owner",
      "private-moderator",
      "private-override",
      "private-extraction",
      "a".repeat(64),
    ]) {
      expect(encoded).not.toContain(value);
    }
    expect(encoded).not.toContain("retention_policy_revision");
  });

  test.each(["pending", "signing", "broadcast", "confirming", "reconciliation_required"])(
    "maps DATA %s and unfinished enrichments to pending",
    (dataState) => {
      expect(
        videoPostProjectionFromRow(
          projectionRow({
            video_caption: null,
            video_stream_state: "sending",
            video_playback_ref: null,
            video_thumbnail_state: "failed",
            video_data_registration_state: dataState,
          }),
        ),
      ).toMatchObject({
        caption: null,
        caption_dir: null,
        playback: { status: "pending" },
        thumbnail: { status: "pending" },
        data_registration: "registration_pending",
      });
    },
  );

  test.each(["not_started", "sending", "manual_review"])("maps Stream %s to pending", (state) => {
    expect(
      videoPostProjectionFromRow(
        projectionRow({ video_stream_state: state, video_playback_ref: null }),
      )?.playback,
    ).toEqual({ status: "pending" });
  });

  test.each(["pending", "running", "failed"])("maps thumbnail %s to pending", (state) => {
    expect(
      videoPostProjectionFromRow(projectionRow({ video_thumbnail_state: state }))?.thumbnail,
    ).toEqual({ status: "pending" });
  });

  test("preserves failed DATA registration independently of ready playback", () => {
    expect(
      videoPostProjectionFromRow(projectionRow({ video_data_registration_state: "failed" })),
    ).toMatchObject({ data_registration: "failed", playback: { status: "ready" } });
  });

  test.each(["", " ", " stream-video-1 "])("rejects malformed bound playback ref %j", (ref) => {
    expect(videoPostProjectionFromRow(projectionRow({ video_playback_ref: ref }))).toBeNull();
  });

  test("rejects unsupported and internally inconsistent durable facts", () => {
    expect(
      videoPostProjectionFromRow(projectionRow({ video_intent: "song_reference" })),
    ).toBeNull();
    expect(videoPostProjectionFromRow(projectionRow({ video_playback_ref: null }))).toBeNull();
    expect(
      videoPostProjectionFromRow(
        projectionRow({ video_stream_state: "sending", video_playback_ref: "premature" }),
      ),
    ).toBeNull();
  });
});
