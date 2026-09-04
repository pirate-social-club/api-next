import { describe, expect, test } from "bun:test";
import { BadRequest, IdempotencyConflict } from "@pirate/contracts";
import { Effect } from "effect";
import { createOriginalVideoSubmission } from "../../../domain/src/video-submission.ts";
import type { MediaUploadSealer } from "../media/submission-sealing.ts";
import type { PersonaRecord } from "../use-cases/personas.ts";
import {
  finalizeVideoSubmission,
  normalizeVideoMultipartManifest,
  reserveVideoUpload,
  VIDEO_MULTIPART_PART_SIZE_BYTES,
  type VideoMultipartUploadGateway,
  type VideoPublicationServices,
  type VideoPublicationStore,
  type VideoReservationRecord,
  type VideoSubmissionRecord,
} from "./publication.ts";

const actor = { kind: "user" as const, userId: "account_video" };
const persona: PersonaRecord = {
  persona_id: "persona_video",
  object: "persona",
  status: "active",
  profile: {
    persona_id: "persona_video",
    object: "persona_profile",
    revision: 1,
    display_name: "Video Author",
    avatar_ref: null,
    cover_ref: null,
    bio: null,
    preferred_locale: "en",
    primary_public_handle: "name.video-author",
  },
  wallet_set: { evm: null },
  created_at: "2026-09-04T00:00:00.000Z",
  retired_at: null,
};

const unused = async (): Promise<never> => {
  throw new Error("unused video publication method");
};

function storeWith(overrides: Partial<VideoPublicationStore> = {}): VideoPublicationStore {
  return {
    replayReservation: unused,
    createReservation: unused,
    getReservationForAuthor: unused,
    renewParts: unused,
    createSubmission: unused,
    getSubmissionForAccount: unused,
    getSubmissionByOperation: unused,
    getSubmissionForModerator: unused,
    replayCommand: unused,
    beginFinalize: unused,
    recordMultipartCompleted: unused,
    abandonInvalidManifest: unused,
    finalizeSealed: unused,
    abandonExpectationMismatch: unused,
    commitAnalysisDecision: unused,
    publish: unused,
    retryPoster: unused,
    cancel: unused,
    moderate: unused,
    ...overrides,
  };
}

function multipartWith(
  overrides: Partial<VideoMultipartUploadGateway> = {},
): VideoMultipartUploadGateway {
  return { create: unused, renew: unused, completeOrInspect: unused, abort: unused, ...overrides };
}

function servicesWith(input: {
  store: VideoPublicationStore;
  multipart?: VideoMultipartUploadGateway;
  sealer?: MediaUploadSealer;
}): VideoPublicationServices {
  return {
    store: input.store,
    multipart: input.multipart ?? multipartWith(),
    sealer: input.sealer ?? { inspect: unused, seal: unused },
    personaServices: {
      personaStore: {
        findOwned: ({ accountId, personaId }) =>
          Effect.succeed(
            accountId === actor.userId && personaId === persona.persona_id ? persona : null,
          ),
      },
    },
    nowIso: () => "2026-09-04T00:01:00.000Z",
    randomUuid: (() => {
      const values = [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ];
      return () => values.shift() ?? "00000000-0000-4000-8000-000000000003";
    })(),
  };
}

const originalBody = {
  track: "video" as const,
  slot: "primary_video" as const,
  intent: "original_audio" as const,
  persona_id: persona.persona_id,
  idempotency_key: "reserve-video",
  expected_content_type: "video/mp4" as const,
  expected_size_bytes: VIDEO_MULTIPART_PART_SIZE_BYTES + 1,
};

describe("video publication application", () => {
  test("normalizes one surrounding ETag quote pair and rejects every non-exact manifest", () => {
    expect(
      normalizeVideoMultipartManifest(
        [
          { part_number: 1, etag: '"first"' },
          { part_number: 2, etag: "second" },
        ],
        2,
      ),
    ).toEqual([
      { partNumber: 1, etag: "first" },
      { partNumber: 2, etag: "second" },
    ]);
    expect(normalizeVideoMultipartManifest([{ part_number: 2, etag: "second" }], 1)).toBeNull();
    expect(
      normalizeVideoMultipartManifest(
        [
          { part_number: 1, etag: "first" },
          { part_number: 1, etag: "again" },
        ],
        2,
      ),
    ).toBeNull();
    expect(normalizeVideoMultipartManifest([{ part_number: 1, etag: "bad\nvalue" }], 1)).toBeNull();
  });

  test("returns typed capability-unavailable before creating a song-reference upload", async () => {
    let creates = 0;
    const services = servicesWith({
      store: storeWith({ replayReservation: async () => ({ kind: "none" }) }),
      multipart: multipartWith({
        create: async () => {
          creates += 1;
          return await unused();
        },
      }),
    });
    await expect(
      reserveVideoUpload(
        {
          communityId: "community_video",
          actor,
          body: {
            ...originalBody,
            intent: "song_reference",
            song_post_id: "song_post",
            selected_from: { kind: "library" },
          },
        },
        services,
      ),
    ).rejects.toMatchObject({
      _tag: "BadRequest",
      details: {
        reason_code: "capability_unavailable",
        track: "video",
        capability: "song_reference",
      },
    } satisfies Partial<BadRequest>);
    expect(creates).toBe(0);
  });

  test("issues a fixed-count multipart reservation and preserves its response snapshot", async () => {
    let stored: VideoReservationRecord | null = null;
    const services = servicesWith({
      store: storeWith({
        replayReservation: async () => ({ kind: "none" }),
        createReservation: async (input) => {
          stored = input.record;
          return { kind: "none" };
        },
      }),
      multipart: multipartWith({
        create: async ({ partCount, partSizeBytes }) => ({
          uploadId: "upload-one",
          partCount,
          partSizeBytes,
          expiresAt: "2026-09-04T01:01:00.000Z",
          parts: Array.from({ length: partCount }, (_, index) => ({
            partNumber: index + 1,
            url: `https://upload.invalid/part/${index + 1}`,
            expiresAt: "2026-09-04T01:01:00.000Z",
          })),
        }),
      }),
    });
    const result = await reserveVideoUpload(
      { communityId: "community_video", actor, body: originalBody },
      services,
    );
    expect(result.upload.part_count).toBe(2);
    expect(result.upload.part_size_bytes).toBe(VIDEO_MULTIPART_PART_SIZE_BYTES);
    expect(result.author_persona_id).toBe(persona.persona_id);
    expect(stored).toMatchObject({
      expectedSizeBytes: VIDEO_MULTIPART_PART_SIZE_BYTES + 1,
      uploadId: "upload-one",
      partCount: 2,
      state: "issued",
    });
  });

  test("same reservation key with another intent remains an idempotency conflict", async () => {
    const services = servicesWith({
      store: storeWith({
        replayReservation: async () => ({ kind: "conflict", entityId: "existing-reservation" }),
      }),
    });
    await expect(
      reserveVideoUpload(
        {
          communityId: "community_video",
          actor,
          body: {
            ...originalBody,
            intent: "song_reference",
            song_post_id: "song_post",
            selected_from: { kind: "library" },
          },
        },
        services,
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflict);
  });

  test("malformed finalize aborts the active upload before recording abandonment", async () => {
    const state = createOriginalVideoSubmission({
      submissionId: "media-submission-video",
      operationId: "media-operation-video",
      communityId: "community_video",
      actorAccountId: actor.userId,
      authorPersonaId: persona.persona_id,
      reservationId: "media-reservation-video",
      caption: null,
      authorDeclaredRating: "general",
    });
    const record: VideoSubmissionRecord = {
      state,
      authorPersona: {
        persona_id: persona.persona_id,
        object: "persona",
        display_name: persona.profile.display_name,
        avatar_ref: null,
        primary_public_handle: persona.profile.primary_public_handle,
      },
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    const reservation: VideoReservationRecord = {
      reservationId: state.reservationId,
      communityId: state.communityId,
      actorAccountId: state.actorAccountId,
      authorPersonaId: state.authorPersonaId,
      requestHash: "a".repeat(64),
      expectedContentType: "video/mp4",
      expectedSizeBytes: 20,
      expectedSha256: null,
      ingestPolicyRevision: 1,
      uploadId: "upload-one",
      partSizeBytes: 10,
      partCount: 2,
      expiresAt: "2026-09-04T01:00:00.000Z",
      state: "claimed",
      submissionId: state.submissionId,
      operationId: state.operationId,
      manifest: null,
      responseBytes: new Uint8Array([1]),
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    const events: string[] = [];
    const services = servicesWith({
      store: storeWith({
        getSubmissionForAccount: async () => record,
        replayCommand: async () => ({ kind: "none" }),
        getReservationForAuthor: async () => reservation,
        abandonInvalidManifest: async () => {
          events.push("record");
        },
      }),
      multipart: multipartWith({
        abort: async () => {
          events.push("abort");
        },
      }),
    });
    await expect(
      finalizeVideoSubmission(
        {
          submissionId: state.submissionId,
          actor,
          body: {
            persona_id: persona.persona_id,
            idempotency_key: "finalize-video",
            expected_creation_revision: 1,
            reservation_id: state.reservationId,
            parts: [{ part_number: 1, etag: "only-one" }],
          },
        },
        services,
      ),
    ).rejects.toBeInstanceOf(BadRequest);
    expect(events).toEqual(["abort", "record"]);
  });
});
