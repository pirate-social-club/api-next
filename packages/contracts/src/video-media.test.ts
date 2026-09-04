import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CreateMediaPostSubmission,
  CreateMediaUploadReservation,
  CreateVideoSubmissionV1,
  FinalizeMediaPostSubmission,
  FinalizeVideoUploadV1,
  MediaPostSubmissionV1,
  RenewVideoUploadParts,
  ReserveVideoUploadV1,
  RetryVideoPostSubmissionPoster,
  VideoUploadReservationV1,
} from "./index.ts";

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

const reserveOriginal = {
  persona_id: "persona-video",
  idempotency_key: "reserve-video-1",
  track: "video",
  slot: "primary_video",
  expected_content_type: "video/mp4",
  expected_size_bytes: 8_388_608,
  expected_sha256: "a".repeat(64),
  intent: "original_audio",
} as const;

const reservation = {
  reservation_id: "video-reservation-1",
  track: "video",
  slot: "primary_video",
  status: "awaiting_upload",
  author_persona_id: "persona-video",
  ingest_policy_revision: 1,
  intent: "original_audio",
  upload: {
    method: "MULTIPART",
    upload_id: "r2-upload-1",
    part_size_bytes: 8_388_608,
    part_count: 1,
    parts: [
      {
        part_number: 1,
        url: "https://upload.invalid/part/1",
        expires_at: "2026-09-04T12:00:00.000Z",
      },
    ],
    expires_at: "2026-09-04T12:00:00.000Z",
  },
} as const;

describe("phase-one video media contracts", () => {
  test("keeps original audio and song reference as exact immutable reservation variants", () => {
    expect(decode(ReserveVideoUploadV1, reserveOriginal)).toEqual(reserveOriginal);
    expect(() =>
      decode(ReserveVideoUploadV1, {
        ...reserveOriginal,
        song_post_id: "song-1",
        selected_from: { kind: "library" },
      }),
    ).toThrow();

    const songReference = {
      ...reserveOriginal,
      intent: "song_reference",
      song_post_id: "song-1",
      selected_from: { kind: "feed", origin_post_id: "video-origin-1" },
    } as const;
    expect(decode(ReserveVideoUploadV1, songReference)).toEqual(songReference);
    expect(() =>
      decode(ReserveVideoUploadV1, { ...songReference, selected_from: undefined }),
    ).toThrow();
  });

  test("bounds video declarations before multipart ingress is issued", () => {
    expect(() =>
      decode(ReserveVideoUploadV1, { ...reserveOriginal, expected_content_type: "video/webm" }),
    ).toThrow();
    expect(() =>
      decode(ReserveVideoUploadV1, {
        ...reserveOriginal,
        expected_size_bytes: 500 * 1024 * 1024 + 1,
      }),
    ).toThrow();
    expect(decode(VideoUploadReservationV1, reservation)).toEqual(reservation);
  });

  test("derives intent from the reservation and rejects mutable copies on create", () => {
    const create = {
      persona_id: "persona-video",
      version: "video-start-input-v1",
      video_reservation_id: "video-reservation-1",
      caption: "A short caption",
      idempotency_key: "create-video-1",
    } as const;
    expect(decode(CreateVideoSubmissionV1, create)).toEqual(create);
    expect(() =>
      decode(CreateVideoSubmissionV1, { ...create, intent: "original_audio" }),
    ).toThrow();
    expect(() => decode(CreateVideoSubmissionV1, { ...create, song_post_id: "song-1" })).toThrow();
  });

  test("closes multipart manifests and poster timestamps", () => {
    const finalize = {
      persona_id: "persona-video",
      idempotency_key: "finalize-video-1",
      expected_creation_revision: 1,
      reservation_id: "video-reservation-1",
      parts: [{ part_number: 1, etag: "etag-1" }],
      poster_timestamp_ms: 1_000,
    } as const;
    expect(decode(FinalizeVideoUploadV1, finalize)).toEqual(finalize);
    expect(() => decode(FinalizeVideoUploadV1, { ...finalize, parts: [] })).toThrow();
    expect(() =>
      decode(FinalizeVideoUploadV1, { ...finalize, poster_timestamp_ms: 180_000 }),
    ).toThrow();
  });

  test("exposes the discriminated endpoints and video snapshot", () => {
    const reserveBody = CreateMediaUploadReservation.request?.body;
    const createBody = CreateMediaPostSubmission.request?.body;
    const finalizeBody = FinalizeMediaPostSubmission.request?.body;
    if (reserveBody === undefined || createBody === undefined || finalizeBody === undefined) {
      throw new Error("video endpoint body schemas are missing");
    }
    expect(decode(reserveBody, reserveOriginal)).toEqual(reserveOriginal);
    expect(
      decode(createBody, {
        persona_id: "persona-video",
        version: "video-start-input-v1",
        video_reservation_id: "video-reservation-1",
        idempotency_key: "create-video-1",
      }),
    ).toMatchObject({ version: "video-start-input-v1" });
    expect(
      decode(finalizeBody, {
        persona_id: "persona-video",
        idempotency_key: "finalize-video-1",
        expected_creation_revision: 1,
        reservation_id: "video-reservation-1",
        parts: [{ part_number: 1, etag: '"etag-1"' }],
      }),
    ).toMatchObject({ parts: [{ part_number: 1 }] });
    expect(RenewVideoUploadParts.path).toBe(
      "/media-upload-reservations/:reservationId/parts/renew",
    );
    expect(RetryVideoPostSubmissionPoster.path).toBe(
      "/media-post-submissions/:submissionId/poster-retry",
    );

    const snapshot = {
      submission_id: "video-submission-1",
      author_persona: {
        persona_id: "persona-video",
        object: "persona",
        display_name: "Video creator",
        avatar_ref: null,
        primary_public_handle: "video.creator",
      },
      href: "/media-post-submissions/video-submission-1",
      track: "video",
      intent: "original_audio",
      creation_revision: 1,
      video_revision: 0,
      caption: null,
      status: "processing",
      phase: "awaiting_upload",
      updated_at: "2026-09-04T10:00:00.000Z",
    } as const;
    expect(decode(MediaPostSubmissionV1, snapshot)).toEqual(snapshot);
  });
});
