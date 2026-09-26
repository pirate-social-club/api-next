import { describe, expect, test } from "bun:test";
import { BadRequest, type Conflict, IdempotencyConflict } from "@pirate/contracts";
import { Effect } from "effect";
import {
  attachImmutableVideo,
  createOriginalVideoSubmission,
} from "../../../domain/src/video-submission.ts";
import type { MediaUploadSealer } from "../media/submission-sealing.ts";
import type { PersonaRecord } from "../use-cases/personas.ts";
import {
  cancelVideoSubmission,
  createVideoSubmission,
  finalizeVideoSubmission,
  normalizeVideoMultipartManifest,
  projectVideoSubmission,
  reserveVideoUpload,
  retryVideoSubmission,
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
  community_binding: null,
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
    getReservationForAccount: unused,
    getReservationSongPlan: unused,
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
    recordProcessingFailure: unused,
    publish: unused,
    observeSongReferencePolicy: unused,
    attachSongVideoMaster: unused,
    publishSongReference: unused,
    retryPoster: unused,
    retryTechnical: unused,
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
      runEffect: (effect, signal) =>
        Effect.runPromise(effect, signal === undefined ? undefined : { signal }),
      personaStore: {
        findOwned: ({ accountId, personaId }) =>
          Effect.succeed(
            accountId === actor.userId &&
              [persona.persona_id, "persona_video_second"].includes(personaId)
              ? {
                  ...persona,
                  persona_id: personaId,
                  profile: { ...persona.profile, persona_id: personaId },
                }
              : null,
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

/** An original-audio reservation as issued before every video had to use a song. */
function originalReservation(state: VideoReservationRecord["state"]): VideoReservationRecord {
  return {
    reservationId: "media-reservation-video",
    intent: "original_audio",
    communityId: "community_video",
    actorAccountId: actor.userId,
    authorPersonaId: persona.persona_id,
    requestHash: "a".repeat(64),
    expectedContentType: "video/mp4",
    expectedSizeBytes: 10,
    expectedSha256: null,
    ingestPolicyRevision: 1,
    uploadId: "upload-one",
    partSizeBytes: VIDEO_MULTIPART_PART_SIZE_BYTES,
    partCount: 1,
    expiresAt: "2026-09-04T01:00:00.000Z",
    state,
    submissionId: state === "issued" ? null : "media-submission-video",
    operationId: state === "issued" ? null : "media-operation-video",
    manifest: null,
    responseBytes: new Uint8Array([1]),
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}

describe("video publication application", () => {
  test("rejects claiming a reservation through another owned persona", async () => {
    const reservation: VideoReservationRecord = {
      reservationId: "media-reservation-video",
      intent: "original_audio",
      communityId: "community_video",
      actorAccountId: actor.userId,
      authorPersonaId: persona.persona_id,
      requestHash: "a".repeat(64),
      expectedContentType: "video/mp4",
      expectedSizeBytes: 10,
      expectedSha256: null,
      ingestPolicyRevision: 1,
      uploadId: "upload-one",
      partSizeBytes: VIDEO_MULTIPART_PART_SIZE_BYTES,
      partCount: 1,
      expiresAt: "2026-09-04T01:00:00.000Z",
      state: "issued",
      submissionId: null,
      operationId: null,
      manifest: null,
      responseBytes: new Uint8Array([1]),
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    const services = servicesWith({
      store: storeWith({ getReservationForAccount: async () => reservation }),
    });
    await expect(
      createVideoSubmission(
        {
          communityId: reservation.communityId,
          actor,
          body: {
            version: "video-start-input-v1",
            persona_id: "persona_video_second",
            video_reservation_id: reservation.reservationId,
            idempotency_key: "claim-with-second-persona",
          },
        },
        services,
      ),
    ).rejects.toMatchObject({
      _tag: "Conflict",
      details: { reason_code: "reservation_persona_required" },
    } satisfies Partial<Conflict>);
  });

  test("refuses to start a new submission from an unused original-audio reservation", async () => {
    // Issued before every video had to reference a song; starting it would
    // create a new original-audio video, so it is refused and simply expires.
    let creates = 0;
    const services = servicesWith({
      store: storeWith({
        getReservationForAccount: async () => originalReservation("issued"),
        createSubmission: async () => {
          creates += 1;
          return { kind: "none" };
        },
      }),
    });
    await expect(
      createVideoSubmission(
        {
          communityId: "community_video",
          actor,
          body: {
            version: "video-start-input-v1",
            persona_id: persona.persona_id,
            video_reservation_id: "media-reservation-video",
            idempotency_key: "claim-original",
          },
        },
        services,
      ),
    ).rejects.toMatchObject({
      _tag: "BadRequest",
      details: { reason_code: "song_reference_required", track: "video" },
    } satisfies Partial<BadRequest>);
    expect(creates).toBe(0);
  });

  test("an original-audio reservation already started keeps its claimed-reservation answer", async () => {
    const services = servicesWith({
      store: storeWith({ getReservationForAccount: async () => originalReservation("claimed") }),
    });
    await expect(
      createVideoSubmission(
        {
          communityId: "community_video",
          actor,
          body: {
            version: "video-start-input-v1",
            persona_id: persona.persona_id,
            video_reservation_id: "media-reservation-video",
            idempotency_key: "claim-original-again",
          },
        },
        services,
      ),
    ).rejects.toMatchObject({ _tag: "Conflict" });
  });

  test("reconciliation projects unconfirmed and refuses retry; membership recovery uses publication-only retry", async () => {
    const initial = createOriginalVideoSubmission({
      submissionId: "media-submission-video",
      operationId: "media-operation-video",
      communityId: "community_video",
      actorAccountId: actor.userId,
      authorPersonaId: persona.persona_id,
      reservationId: "media-reservation-video",
      caption: null,
      authorDeclaredRating: "general",
    });
    let record: VideoSubmissionRecord = {
      state: {
        ...initial,
        status: "processing_failed",
        phase: null,
        failureCode: "transform_failed",
        reconciliationRequired: true,
      },
      eventSequence: 1,
      updatedAt: "2026-09-06T00:00:00.000Z",
      authorPersona: {
        persona_id: persona.persona_id,
        object: "persona",
        display_name: "Video Author",
        avatar_ref: null,
        primary_public_handle: null,
      },
    };
    expect(projectVideoSubmission(record)).toMatchObject({
      reason_code: "provider_submission_unconfirmed",
      retryable: false,
    });
    let refused = true;
    const services = servicesWith({
      store: storeWith({
        getSubmissionForAccount: async () => record,
        retryTechnical: async () => (refused ? { kind: "membership_required" } : { kind: "none" }),
      }),
    });
    const input = {
      submissionId: initial.submissionId,
      actor,
      body: {
        persona_id: persona.persona_id,
        idempotency_key: "membership-retry",
        expected_creation_revision: 1,
      },
    };
    await expect(retryVideoSubmission(input, services)).rejects.toMatchObject({
      details: { reason_code: "retry_not_allowed" },
    });
    // A video the v1 sampled-frame gate could not clear is terminal: not
    // retryable in its projection, and a retry is refused.
    const gateRecord: VideoSubmissionRecord = {
      ...record,
      state: {
        ...record.state,
        reconciliationRequired: false,
        failureCode: "safety_gate_unresolved",
      },
    };
    record = gateRecord;
    expect(projectVideoSubmission(gateRecord)).toMatchObject({
      reason_code: "publication_failed",
      retryable: false,
    });
    await expect(retryVideoSubmission(input, services)).rejects.toMatchObject({
      details: { reason_code: "retry_not_allowed" },
    });
    const membershipRecord: VideoSubmissionRecord = {
      ...record,
      state: { ...record.state, reconciliationRequired: false, failureCode: "membership_required" },
    };
    record = membershipRecord;
    expect(projectVideoSubmission(membershipRecord)).toMatchObject({
      reason_code: "membership_required",
      retryable: true,
    });
    await expect(retryVideoSubmission(input, services)).rejects.toMatchObject({
      details: { reason_code: "membership_required" },
    });
    refused = false;
    expect(await retryVideoSubmission(input, services)).toMatchObject({
      status: "processing",
      phase: "publish",
      creation_revision: 2,
    });
    expect(
      projectVideoSubmission({
        ...membershipRecord,
        state: { ...membershipRecord.state, retryCount: 3 },
      }),
    ).toMatchObject({ retryable: false });
  });

  test("an unresolved moderation dispatch can only be abandoned without retry or claim replacement", async () => {
    const initial = createOriginalVideoSubmission({
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
      state: {
        ...initial,
        videoRevision: 1,
        video: {
          videoRevision: 1,
          immutableRef: "media://immutable/media-operation-video/video/1",
          canonicalSha256: "a".repeat(64),
          contentType: "video/mp4",
          sizeBytes: 100,
        },
        status: "processing_failed",
        phase: null,
        failureCode: "provider_submission_unconfirmed",
        reconciliationRequired: true,
      },
      eventSequence: 2,
      updatedAt: "2026-09-06T00:00:00.000Z",
      authorPersona: {
        persona_id: persona.persona_id,
        object: "persona",
        display_name: "Video Author",
        avatar_ref: null,
        primary_public_handle: null,
      },
    };
    let cancelled: Parameters<VideoPublicationStore["cancel"]>[0] | undefined;
    let cancelOutcome: Awaited<ReturnType<VideoPublicationStore["cancel"]>> = { kind: "none" };
    let multipartAborts = 0;
    const services = servicesWith({
      store: storeWith({
        getSubmissionForAccount: async () => record,
        cancel: async (input) => {
          cancelled = input;
          return cancelOutcome;
        },
      }),
      multipart: multipartWith({
        abort: async () => {
          multipartAborts += 1;
        },
      }),
    });

    expect(
      await cancelVideoSubmission(
        {
          submissionId: record.state.submissionId,
          actor,
          body: {
            persona_id: persona.persona_id,
            idempotency_key: "abandon-unresolved-video",
            expected_creation_revision: 1,
          },
        },
        services,
      ),
    ).toMatchObject({
      status: "abandoned",
      reason_code: "author_abandoned_unresolved_provider",
    });
    expect(cancelled).toMatchObject({
      expectedCreationRevision: 1,
      idempotencyKey: "abandon-unresolved-video",
      submission: {
        status: "processing_failed",
        failureCode: "provider_submission_unconfirmed",
        reconciliationRequired: true,
      },
    });
    expect(multipartAborts).toBe(0);

    cancelOutcome = { kind: "conflict", entityId: record.state.submissionId };
    await expect(
      cancelVideoSubmission(
        {
          submissionId: record.state.submissionId,
          actor,
          body: {
            persona_id: persona.persona_id,
            idempotency_key: "abandon-unresolved-video",
            expected_creation_revision: 1,
          },
        },
        services,
      ),
    ).rejects.toMatchObject({ _tag: "IdempotencyConflict" });
  });

  test("routes a technical retry back to analysis with the sealed revision retained", async () => {
    const initial = createOriginalVideoSubmission({
      submissionId: "media-submission-video",
      operationId: "media-operation-video",
      communityId: "community_video",
      actorAccountId: actor.userId,
      authorPersonaId: persona.persona_id,
      reservationId: "media-reservation-video",
      caption: null,
      authorDeclaredRating: "general",
    });
    const failed = {
      ...attachImmutableVideo(initial, {
        videoRevision: 1,
        immutableRef: "media://immutable/media-operation-video/video/1",
        canonicalSha256: "a".repeat(64),
        contentType: "video/mp4" as const,
        sizeBytes: 100,
      }),
      status: "processing_failed" as const,
      phase: null,
      failureCode: "probe_failed" as const,
    };
    let retried = false;
    const services = servicesWith({
      store: storeWith({
        getSubmissionForAccount: async () => ({
          state: failed,
          eventSequence: 1,
          authorPersona: {
            persona_id: persona.persona_id,
            object: "persona",
            display_name: persona.profile.display_name,
            avatar_ref: null,
            primary_public_handle: persona.profile.primary_public_handle,
          },
          updatedAt: "2026-09-04T00:00:00.000Z",
        }),
        retryTechnical: async () => {
          retried = true;
          return { kind: "none" };
        },
      }),
    });
    const result = await retryVideoSubmission(
      {
        submissionId: failed.submissionId,
        actor,
        body: {
          persona_id: persona.persona_id,
          idempotency_key: "retry-probe",
          expected_creation_revision: 1,
        },
      },
      services,
    );
    expect(retried).toBe(true);
    expect(result).toMatchObject({ status: "processing", phase: "analysis", video_revision: 1 });
  });

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
            audio_revision: 1,
            clip_start_samples: 0,
            clip_duration_samples: 30 * 48_000,
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

  test("refuses a new original-audio reservation before any upload exists", async () => {
    let creates = 0;
    let stored = 0;
    const services = servicesWith({
      store: storeWith({
        replayReservation: async () => ({ kind: "none" }),
        createReservation: async () => {
          stored += 1;
          return { kind: "none" };
        },
      }),
      multipart: multipartWith({
        create: async () => {
          creates += 1;
          return await unused();
        },
      }),
    });
    await expect(
      reserveVideoUpload({ communityId: "community_video", actor, body: originalBody }, services),
    ).rejects.toMatchObject({
      _tag: "BadRequest",
      message: "A new video must use a song",
      details: { reason_code: "song_reference_required", track: "video" },
    } satisfies Partial<BadRequest>);
    expect(creates).toBe(0);
    expect(stored).toBe(0);
  });

  test("a retry of an original-audio reservation issued before the rule returns its snapshot", async () => {
    const issued = {
      reservation_id: "media-reservation-video",
      track: "video",
      slot: "primary_video",
      intent: "original_audio",
      status: "awaiting_upload",
      author_persona_id: persona.persona_id,
      ingest_policy_revision: 1,
      upload: {
        method: "MULTIPART",
        upload_id: "upload-one",
        part_size_bytes: VIDEO_MULTIPART_PART_SIZE_BYTES,
        part_count: 2,
        expires_at: "2026-09-04T01:06:21.000Z",
        parts: [1, 2].map((part_number) => ({
          part_number,
          url: `https://upload.invalid/part/${part_number}`,
          expires_at: "2026-09-04T01:01:00.000Z",
        })),
      },
    };
    let creates = 0;
    const services = servicesWith({
      store: storeWith({
        replayReservation: async () => ({
          kind: "replay",
          bytes: new TextEncoder().encode(JSON.stringify(issued)),
          entityId: issued.reservation_id,
        }),
      }),
      multipart: multipartWith({
        create: async () => {
          creates += 1;
          return await unused();
        },
      }),
    });
    const result = await reserveVideoUpload(
      { communityId: "community_video", actor, body: originalBody },
      services,
    );
    expect(result).toMatchObject({
      reservation_id: issued.reservation_id,
      intent: "original_audio",
    });
    expect(creates).toBe(0);
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
            audio_revision: 1,
            clip_start_samples: 0,
            clip_duration_samples: 30 * 48_000,
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
      eventSequence: 1,
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
      intent: "original_audio",
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

  test("upload inspection mismatch returns an honest terminal snapshot and replays without another inspection", async () => {
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
    let record: VideoSubmissionRecord = {
      state,
      eventSequence: 1,
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
      intent: "original_audio",
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
      expiresAt: "2099-09-04T01:00:00.000Z",
      state: "claimed",
      submissionId: state.submissionId,
      operationId: state.operationId,
      manifest: [
        { partNumber: 1, etag: "one" },
        { partNumber: 2, etag: "two" },
      ],
      responseBytes: new Uint8Array([1]),
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    let stored: Uint8Array | null = null;
    let inspected = 0;
    const services = servicesWith({
      store: storeWith({
        getSubmissionForAccount: async () => record,
        replayCommand: async () =>
          stored === null
            ? { kind: "none" }
            : { kind: "replay", bytes: stored, entityId: state.submissionId },
        getReservationForAuthor: async () => reservation,
        beginFinalize: async () => ({ reservation, alreadyCompleted: true }),
        abandonExpectationMismatch: async (input) => {
          stored = input.responseBytes;
          record = {
            ...record,
            state: {
              ...state,
              status: "abandoned",
              phase: null,
              abandonmentReason: "upload_expectation_mismatch",
            },
          };
          return { kind: "none" };
        },
      }),
      sealer: {
        inspect: async () => {
          inspected += 1;
          return { outcome: "expectation_mismatch" };
        },
        seal: unused,
      },
    });
    const input = {
      submissionId: state.submissionId,
      actor,
      body: {
        persona_id: persona.persona_id,
        idempotency_key: "finalize-video",
        expected_creation_revision: 1,
        reservation_id: state.reservationId,
        parts: [
          { part_number: 1, etag: "one" },
          { part_number: 2, etag: "two" },
        ],
      },
    };
    expect(await finalizeVideoSubmission(input, services)).toMatchObject({
      status: "abandoned",
      reason_code: "upload_expectation_mismatch",
    });
    expect(await finalizeVideoSubmission(input, services)).toMatchObject({
      status: "abandoned",
      reason_code: "upload_expectation_mismatch",
    });
    expect(inspected).toBe(1);
  });
});
