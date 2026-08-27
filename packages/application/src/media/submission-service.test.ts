import { describe, expect, test } from "bun:test";
import type { MediaIngressUploadPresigner } from "@pirate/application";
import { InternalError, NotFound, UploadObjectMissing } from "@pirate/contracts";
import { Effect } from "effect";
import {
  createMediaSubmissionState,
  type MediaSubmissionState,
  transitionMediaSubmission,
} from "../../../domain/src/media-submission.ts";
import type { PersonaRecord } from "../use-cases/personas.ts";
import { MediaSealFailure, type MediaUploadSealer } from "./submission-sealing.ts";
import {
  finalizeMediaSubmission,
  type MediaSubmissionServices,
  type MediaUploadStore,
  mediaSha256Bytes,
  moderateMediaSubmission,
  reserveMediaUpload,
} from "./submission-service.ts";

const actor = { kind: "user" as const, userId: "account_owner" };
const persona: PersonaRecord = {
  persona_id: "persona_media",
  object: "persona",
  status: "active",
  profile: {
    persona_id: "persona_media",
    object: "persona_profile",
    revision: 1,
    display_name: "Media Author",
    avatar_ref: null,
    cover_ref: null,
    bio: null,
    preferred_locale: "en",
    primary_public_handle: "name.media-author",
  },
  wallet_set: { evm: null },
  created_at: "2026-08-26T00:00:00.000Z",
  retired_at: null,
};

const awaitingUpload = (() => {
  const created = createMediaSubmissionState({
    event: "submission_reserved",
    actorId: actor.userId,
    expectedCreationRevision: 0,
    submissionId: "media_submission",
    operationId: "media_operation",
    communityId: "media_community",
    personaId: persona.persona_id,
    title: "Fixture song",
    songType: "original",
    reservationId: "media_reservation",
  });
  const issued = transitionMediaSubmission(created, {
    event: "media_reservation_issued",
    actorId: actor.userId,
    expectedCreationRevision: created.creationRevision,
  });
  if (!issued.ok) throw new Error(issued.rejection._tag);
  return issued.state;
})();

const finalizing = (() => {
  const transition = transitionMediaSubmission(awaitingUpload, {
    event: "finalize_requested",
    actorId: actor.userId,
    expectedCreationRevision: awaitingUpload.creationRevision,
    reservationId: awaitingUpload.reservationId,
  });
  if (!transition.ok) throw new Error(transition.rejection._tag);
  return transition.state;
})();

const lyrics = {
  asrSuggestion: { status: "pending" as const },
  current: { status: "not_bound" as const },
};

const reservation = {
  reservationId: awaitingUpload.reservationId,
  state: "claimed" as const,
  expectedContentType: "audio/mpeg",
  expectedSizeBytes: 4,
  expectedSha256: null,
  expiresAt: "2026-08-26T00:15:00.000Z",
};

const unused = async (): Promise<never> => {
  throw new Error("unused media store method");
};

function storeWith(overrides: Partial<MediaUploadStore>): MediaUploadStore {
  return {
    replayReservation: unused,
    reserve: unused,
    replay: unused,
    createSubmission: unused,
    getViewForAuthor: unused,
    getAuthorContext: unused,
    getViewForModerator: unused,
    getFinalizeContext: unused,
    beginFinalize: unused,
    bindTerms: unused,
    bindLyrics: unused,
    bindReference: unused,
    retry: unused,
    authorCancel: unused,
    moderate: unused,
    finalizeSealed: unused,
    recordFinalizeSourceMissing: unused,
    uploadExpectationMismatch: unused,
    uploadSourcePreconditionFailed: unused,
    recordSealConflict: unused,
    recordMediaFailure: unused,
    ...overrides,
  };
}

function servicesWith(input: {
  readonly store: MediaUploadStore;
  readonly sealer?: MediaUploadSealer;
  readonly presigner?: MediaIngressUploadPresigner["Service"];
}): MediaSubmissionServices {
  return {
    store: input.store,
    personaStore: {
      findOwned: ({ accountId, personaId }) =>
        Effect.succeed(
          accountId === actor.userId && personaId === persona.persona_id ? persona : null,
        ),
    },
    presigner: input.presigner ?? {
      presign: () => Effect.die(new Error("unexpected presign")),
    },
    sealer: input.sealer ?? {
      inspect: unused,
      seal: unused,
    },
    nowIso: () => "2026-08-26T00:01:00.000Z",
  };
}

const finalizeBody = {
  persona_id: persona.persona_id,
  idempotency_key: "finalize-key",
  expected_creation_revision: awaitingUpload.creationRevision,
  reservation_id: awaitingUpload.reservationId,
};

const finalizeContext = (state: MediaSubmissionState = awaitingUpload) => ({
  view: { state, lyrics, updatedAt: "2026-08-26T00:00:30.000Z" },
  reservation,
});

const source = {
  key: `reservations/${awaitingUpload.reservationId}/source`,
  version: "source-version",
  etag: "source-etag",
  size: 4,
  contentType: "audio/mpeg",
  ownerMarker: null,
  sourceVersion: null,
  checksums: {},
};

describe("media submission service upload orchestration", () => {
  test("lets a human owner reach the ledger-backed moderation lookup without global scopes", async () => {
    let lookupActor: unknown = null;
    const services = servicesWith({
      store: storeWith({
        getViewForModerator: async ({ moderatorActor }) => {
          lookupActor = moderatorActor;
          return null;
        },
      }),
    });

    await expect(
      moderateMediaSubmission(
        {
          submissionId: awaitingUpload.submissionId,
          actor,
          body: {
            idempotency_key: "owner-moderation",
            expected_creation_revision: 2,
            action: "block",
            evidence_ref: "owner-moderation-evidence",
            reason_code: "policy_violation",
          },
        },
        services,
      ),
    ).rejects.toBeInstanceOf(NotFound);
    expect(lookupActor).toEqual(actor);
  });

  test("rejects a non-MP3 reservation before presigning or persistence", async () => {
    let presigns = 0;
    let writes = 0;
    const services = servicesWith({
      store: storeWith({
        replayReservation: async () => ({ kind: "none" }),
        reserve: async () => {
          writes += 1;
          throw new Error("must not persist a non-MP3 reservation");
        },
      }),
      presigner: {
        presign: () => {
          presigns += 1;
          return Effect.die(new Error("must not presign a non-MP3 reservation"));
        },
      },
    });

    await expect(
      reserveMediaUpload(
        {
          communityId: "media_community",
          actor,
          body: {
            persona_id: persona.persona_id,
            idempotency_key: "reserve-non-mp3-key",
            track: "song",
            slot: "primary_audio",
            expected_content_type: "audio/wav",
            expected_size_bytes: 4,
          },
        },
        services,
      ),
    ).rejects.toThrow("Public-song v1 accepts MP3 audio only");
    expect(presigns).toBe(0);
    expect(writes).toBe(0);
  });

  test("replays a reservation before invoking the presigner", async () => {
    const document = {
      reservation_id: "media_reservation_replay",
      track: "song" as const,
      slot: "primary_audio" as const,
      status: "awaiting_upload" as const,
      upload: {
        method: "PUT" as const,
        url: "https://opaque.invalid/upload",
        required_headers: [{ name: "content-type", value: "audio/mpeg" }],
        expires_at: "2026-08-26T00:15:00.000Z",
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    let presigns = 0;
    const services = servicesWith({
      store: storeWith({
        replayReservation: async () => ({
          kind: "replay",
          reservationId: document.reservation_id,
          bytes,
          sha256: await mediaSha256Bytes(bytes),
        }),
      }),
      presigner: {
        presign: () => {
          presigns += 1;
          return Effect.die(new Error("must not presign a replay"));
        },
      },
    });

    await expect(
      reserveMediaUpload(
        {
          communityId: "media_community",
          actor,
          body: {
            persona_id: persona.persona_id,
            idempotency_key: "reserve-key",
            track: "song",
            slot: "primary_audio",
            expected_content_type: "audio/mpeg",
            expected_size_bytes: 4,
          },
        },
        services,
      ),
    ).resolves.toEqual(document);
    expect(presigns).toBe(0);
  });

  test("creates a reservation with only the server-owned ingress target", async () => {
    const presignRequests: Array<Parameters<MediaIngressUploadPresigner["Service"]["presign"]>[0]> =
      [];
    let persisted: Parameters<MediaUploadStore["reserve"]>[0] | null = null;
    const services = servicesWith({
      store: storeWith({
        replayReservation: async () => ({ kind: "none" }),
        reserve: async (input) => {
          persisted = input;
          return {
            kind: "created",
            reservationId: input.reservationId,
            bytes: input.responseBytes,
            sha256: input.responseSha256,
          };
        },
      }),
      presigner: {
        presign: (input) => {
          presignRequests.push(input);
          return Effect.succeed({
            url: "https://opaque.invalid/upload",
            requiredHeaders: [{ name: "content-type", value: "audio/mpeg" }],
            expiresAt: "2026-08-26T00:15:00.000Z",
          });
        },
      },
    });

    const result = await reserveMediaUpload(
      {
        communityId: "media_community",
        actor,
        body: {
          persona_id: persona.persona_id,
          idempotency_key: "reserve-key",
          track: "song",
          slot: "primary_audio",
          expected_content_type: "audio/mpeg",
          expected_size_bytes: 4,
        },
      },
      services,
    );

    expect(result).toMatchObject({ status: "awaiting_upload", upload: { method: "PUT" } });
    expect(presignRequests[0]).toMatchObject({
      method: "PUT",
      requiredSignedHeaders: [{ name: "content-type", value: "audio/mpeg" }],
      expiresInSeconds: 900,
    });
    expect(presignRequests[0]?.serverOwnedObjectKey).toBe(
      `reservations/${result.reservation_id}/source`,
    );
    expect(persisted).toMatchObject({
      communityId: "media_community",
      expectedContentType: "audio/mpeg",
      expectedSizeBytes: 4,
      reservationId: result.reservation_id,
    });
    expect(presignRequests[0]).not.toHaveProperty("bucket");
    expect(presignRequests[0]).not.toHaveProperty("endpoint");
  });

  test("fences before sealing and commits one analysis launch", async () => {
    const order: string[] = [];
    let finalization: Parameters<MediaUploadStore["finalizeSealed"]>[0] | null = null;
    const services = servicesWith({
      store: storeWith({
        getFinalizeContext: async () => finalizeContext(),
        replay: async () => ({ kind: "none" }),
        beginFinalize: async () => {
          order.push("fence");
          return {
            kind: "begun",
            submissionId: awaitingUpload.submissionId,
            operationId: awaitingUpload.operationId,
          };
        },
        finalizeSealed: async (input) => {
          order.push("commit");
          finalization = input;
          return { kind: "committed", submissionId: input.submissionId };
        },
      }),
      sealer: {
        inspect: async () => {
          order.push("inspect");
          return { outcome: "ready", source };
        },
        seal: async (input) => {
          order.push("seal");
          return {
            result: {
              outcome: "sealed",
              immutable_ref: input.immutableRef,
              destination_ref: `r2://${input.destinationKey}`,
              etag: "destination-etag",
              version: "destination-version",
              size_bytes: 4,
              canonical_sha256: "a".repeat(64),
            },
          };
        },
      },
    });

    const result = await finalizeMediaSubmission(
      { submissionId: awaitingUpload.submissionId, actor, body: finalizeBody },
      services,
    );

    expect(order).toEqual(["inspect", "fence", "seal", "commit"]);
    expect(result).toMatchObject({ status: "processing", phase: "analysis", audio_revision: 1 });
    expect(finalization).toMatchObject({
      expectedAudioRevision: 0,
      reservationId: awaitingUpload.reservationId,
      outbox: {
        payload: {
          kind: "analysis_launch",
          audio_revision: 1,
          analysis_revision: 0,
          workflow_revision: 1,
        },
      },
    });
  });

  test("records and replays source-missing without a second R2 inspection", async () => {
    let replayBytes: Uint8Array | null = null;
    let inspections = 0;
    const services = servicesWith({
      store: storeWith({
        getFinalizeContext: async () => finalizeContext(),
        replay: async () =>
          replayBytes === null
            ? { kind: "none" }
            : {
                kind: "replay",
                submissionId: awaitingUpload.submissionId,
                operationId: awaitingUpload.operationId,
                bytes: replayBytes,
                sha256: await mediaSha256Bytes(replayBytes),
              },
        recordFinalizeSourceMissing: async (input) => {
          replayBytes = input.responseBytes;
          return { kind: "committed", submissionId: input.submissionId };
        },
      }),
      sealer: {
        inspect: async () => {
          inspections += 1;
          return { outcome: "source_missing" };
        },
        seal: unused,
      },
    });

    await expect(
      finalizeMediaSubmission(
        { submissionId: awaitingUpload.submissionId, actor, body: finalizeBody },
        services,
      ),
    ).rejects.toBeInstanceOf(UploadObjectMissing);
    await expect(
      finalizeMediaSubmission(
        { submissionId: awaitingUpload.submissionId, actor, body: finalizeBody },
        services,
      ),
    ).rejects.toBeInstanceOf(UploadObjectMissing);
    expect(inspections).toBe(1);
  });

  test("treats a missing source after the durable fence as a precondition failure", async () => {
    let preconditionFailure:
      | Parameters<MediaUploadStore["uploadSourcePreconditionFailed"]>[0]
      | null = null;
    const services = servicesWith({
      store: storeWith({
        getFinalizeContext: async () => finalizeContext(finalizing),
        replay: async () => ({ kind: "none" }),
        uploadSourcePreconditionFailed: async (input) => {
          preconditionFailure = input;
          return { kind: "committed", submissionId: input.submissionId };
        },
      }),
      sealer: {
        inspect: async () => ({ outcome: "source_missing" }),
        seal: unused,
      },
    });

    const result = await finalizeMediaSubmission(
      { submissionId: finalizing.submissionId, actor, body: finalizeBody },
      services,
    );

    expect(result).toMatchObject({
      status: "abandoned",
      reason_code: "upload_source_changed_before_finalize",
    });
    expect(preconditionFailure).toMatchObject({
      evidenceRef: `media-source-missing-after-fence:${awaitingUpload.reservationId}`,
    });
  });

  test("rejects an observed expectation mismatch before fencing or sealing", async () => {
    let mismatched: Parameters<MediaUploadStore["uploadExpectationMismatch"]>[0] | null = null;
    let fenced = false;
    const services = servicesWith({
      store: storeWith({
        getFinalizeContext: async () => finalizeContext(),
        replay: async () => ({ kind: "none" }),
        beginFinalize: async () => {
          fenced = true;
          return {
            kind: "begun",
            submissionId: awaitingUpload.submissionId,
            operationId: awaitingUpload.operationId,
          };
        },
        uploadExpectationMismatch: async (input) => {
          mismatched = input;
          return { kind: "committed", submissionId: input.submissionId };
        },
      }),
      sealer: {
        inspect: async () => ({ outcome: "expectation_mismatch" }),
        seal: unused,
      },
    });

    const result = await finalizeMediaSubmission(
      { submissionId: awaitingUpload.submissionId, actor, body: finalizeBody },
      services,
    );

    expect(result).toMatchObject({
      status: "abandoned",
      reason_code: "upload_expectation_mismatch",
    });
    expect(mismatched).toMatchObject({
      evidenceRef: `media-upload-expectation:${awaitingUpload.reservationId}`,
    });
    expect(fenced).toBe(false);
  });

  test("maps the selected-source precondition outcome without a new inspection", async () => {
    let inspections = 0;
    let failures = 0;
    const services = servicesWith({
      store: storeWith({
        getFinalizeContext: async () => finalizeContext(),
        replay: async () => ({ kind: "none" }),
        beginFinalize: async () => ({
          kind: "begun",
          submissionId: awaitingUpload.submissionId,
          operationId: awaitingUpload.operationId,
        }),
        uploadSourcePreconditionFailed: async (input) => {
          failures += 1;
          return { kind: "committed", submissionId: input.submissionId };
        },
      }),
      sealer: {
        inspect: async () => {
          inspections += 1;
          return { outcome: "ready", source };
        },
        seal: async () => ({ result: { outcome: "source_precondition_failed" } }),
      },
    });

    const result = await finalizeMediaSubmission(
      { submissionId: awaitingUpload.submissionId, actor, body: finalizeBody },
      services,
    );

    expect(result).toMatchObject({
      status: "abandoned",
      reason_code: "upload_source_changed_before_finalize",
    });
    expect(inspections).toBe(1);
    expect(failures).toBe(1);
  });

  test("retains post-write expectation and stream failures without launching analysis", async () => {
    const retained = {
      ...source,
      key: "immutable/media_operation/audio/1",
      version: "destination-version",
      etag: "destination-etag",
      ownerMarker: "media_operation",
      sourceVersion: source.version,
    };
    const outcomes: Array<Readonly<{ kind: string; evidenceRef: string }>> = [];
    const run = async (failure: "expectation" | "stream") => {
      const services = servicesWith({
        store: storeWith({
          getFinalizeContext: async () => finalizeContext(),
          replay: async () => ({ kind: "none" }),
          beginFinalize: async () => ({
            kind: "begun",
            submissionId: awaitingUpload.submissionId,
            operationId: awaitingUpload.operationId,
          }),
          uploadExpectationMismatch: async (input) => {
            outcomes.push({ kind: "expectation", evidenceRef: input.evidenceRef });
            return { kind: "committed", submissionId: input.submissionId };
          },
          recordMediaFailure: async (input) => {
            outcomes.push({ kind: "stream", evidenceRef: input.failure.evidenceRef });
            return { kind: "committed", submissionId: input.submissionId };
          },
        }),
        sealer: {
          inspect: async () => ({ outcome: "ready", source }),
          seal: async () => {
            if (failure === "stream") throw new MediaSealFailure("source_stream_failed", retained);
            return { result: { outcome: "expectation_mismatch" }, retainedDestination: retained };
          },
        },
      });
      return finalizeMediaSubmission(
        {
          submissionId: awaitingUpload.submissionId,
          actor,
          body: { ...finalizeBody, idempotency_key: `finalize-${failure}` },
        },
        services,
      );
    };

    await expect(run("expectation")).resolves.toMatchObject({
      status: "abandoned",
      reason_code: "upload_expectation_mismatch",
    });
    await expect(run("stream")).resolves.toMatchObject({
      status: "processing_failed",
      reason_code: "hash_failed",
      retryable: false,
    });
    expect(outcomes).toEqual([
      {
        kind: "expectation",
        evidenceRef:
          "r2-retained-v1:immutable%2Fmedia_operation%2Faudio%2F1:destination-version:destination-etag:4",
      },
      {
        kind: "stream",
        evidenceRef:
          "r2-retained-v1:immutable%2Fmedia_operation%2Faudio%2F1:destination-version:destination-etag:4",
      },
    ]);
  });

  test("records destination conflict without an analysis launch", async () => {
    let conflict: Parameters<MediaUploadStore["recordSealConflict"]>[0] | null = null;
    const services = servicesWith({
      store: storeWith({
        getFinalizeContext: async () => finalizeContext(),
        replay: async () => ({ kind: "none" }),
        beginFinalize: async () => ({
          kind: "begun",
          submissionId: awaitingUpload.submissionId,
          operationId: awaitingUpload.operationId,
        }),
        recordSealConflict: async (input) => {
          conflict = input;
          return { kind: "committed", submissionId: input.submissionId };
        },
      }),
      sealer: {
        inspect: async () => ({ outcome: "ready", source }),
        seal: async () => ({ result: { outcome: "destination_conflict" } }),
      },
    });

    const result = await finalizeMediaSubmission(
      { submissionId: awaitingUpload.submissionId, actor, body: finalizeBody },
      services,
    );

    expect(result).toMatchObject({
      status: "processing_failed",
      reason_code: "upload_seal_conflict",
      retryable: false,
    });
    expect(conflict).toMatchObject({
      failure: { code: "upload_seal_conflict", retryable: false, lastSafePhase: "finalize" },
    });
    expect(conflict).not.toHaveProperty("outbox");
  });

  test("does not persist a terminal failure when sibling convergence is temporarily unverifiable", async () => {
    let writes = 0;
    const services = servicesWith({
      store: storeWith({
        getFinalizeContext: async () => finalizeContext(),
        replay: async () => ({ kind: "none" }),
        beginFinalize: async () => ({
          kind: "begun",
          submissionId: awaitingUpload.submissionId,
          operationId: awaitingUpload.operationId,
        }),
        recordMediaFailure: async () => {
          writes += 1;
          return { kind: "committed", submissionId: awaitingUpload.submissionId };
        },
        recordSealConflict: async () => {
          writes += 1;
          return { kind: "committed", submissionId: awaitingUpload.submissionId };
        },
      }),
      sealer: {
        inspect: async () => ({ outcome: "ready", source }),
        seal: async () => {
          throw new MediaSealFailure("sibling_convergence_unavailable");
        },
      },
    });

    await expect(
      finalizeMediaSubmission(
        { submissionId: awaitingUpload.submissionId, actor, body: finalizeBody },
        services,
      ),
    ).rejects.toBeInstanceOf(InternalError);
    expect(writes).toBe(0);
  });

  test("concurrent same-key sealed outcomes converge on one persisted response", async () => {
    let persisted: Readonly<{ bytes: Uint8Array; sha256: string }> | null = null;
    let commits = 0;
    const services = servicesWith({
      store: storeWith({
        getFinalizeContext: async () => finalizeContext(),
        replay: async () => ({ kind: "none" }),
        beginFinalize: async () => ({
          kind: commits === 0 ? "begun" : "resumed",
          submissionId: awaitingUpload.submissionId,
          operationId: awaitingUpload.operationId,
        }),
        finalizeSealed: async (input) => {
          commits += 1;
          if (persisted === null) {
            persisted = { bytes: input.responseBytes, sha256: input.responseSha256 };
            return { kind: "committed", submissionId: input.submissionId };
          }
          return {
            kind: "replay",
            submissionId: input.submissionId,
            operationId: awaitingUpload.operationId,
            bytes: persisted.bytes,
            sha256: persisted.sha256,
          };
        },
      }),
      sealer: {
        inspect: async () => ({ outcome: "ready", source }),
        seal: async (input) => ({
          result: {
            outcome: "sealed",
            immutable_ref: input.immutableRef,
            destination_ref: `r2://${input.destinationKey}`,
            etag: "shared-etag",
            version: "shared-version",
            size_bytes: 4,
            canonical_sha256: "a".repeat(64),
          },
        }),
      },
    });

    const [first, second] = await Promise.all([
      finalizeMediaSubmission(
        { submissionId: awaitingUpload.submissionId, actor, body: finalizeBody },
        services,
      ),
      finalizeMediaSubmission(
        { submissionId: awaitingUpload.submissionId, actor, body: finalizeBody },
        services,
      ),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "processing", phase: "analysis", audio_revision: 1 });
    expect(commits).toBe(2);
  });
});
